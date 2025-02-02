/**
 * @license
 * Copyright 2022-2023 Project CHIP Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    Attribute,
    AttributeJsType,
    Command,
    Event,
    RequestType,
    ResponseType,
    TlvNoResponse,
} from "../../cluster/Cluster.js";
import { resolveAttributeName, resolveCommandName, resolveEventName } from "../../cluster/ClusterHelper.js";
import { ImplementationError, MatterFlowError, UnexpectedDataError } from "../../common/MatterError.js";
import { AttributeId } from "../../datatype/AttributeId.js";
import { ClusterId } from "../../datatype/ClusterId.js";
import { EndpointNumber } from "../../datatype/EndpointNumber.js";
import { EventId } from "../../datatype/EventId.js";
import { NodeId } from "../../datatype/NodeId.js";
import { Logger } from "../../log/Logger.js";
import { MatterController } from "../../MatterController.js";
import { MessageExchange } from "../../protocol/MessageExchange.js";
import { ProtocolHandler } from "../../protocol/ProtocolHandler.js";
import { TypeFromSchema } from "../../tlv/TlvSchema.js";
import { ExchangeProvider } from "../ExchangeManager.js";
import { DecodedAttributeReportValue, normalizeAndDecodeReadAttributeReport } from "./AttributeDataDecoder.js";
import { DecodedEventData, DecodedEventReportValue, normalizeAndDecodeReadEventReport } from "./EventDataDecoder.js";
import {
    DataReport,
    IncomingInteractionClientMessenger,
    InteractionClientMessenger,
    ReadRequest,
    StatusResponseError,
} from "./InteractionMessenger.js";
import { StatusCode, TlvAttributeReport, TlvEventFilter, TlvEventReport } from "./InteractionProtocol.js";
import {
    attributePathToId,
    clusterPathToId,
    INTERACTION_MODEL_REVISION,
    INTERACTION_PROTOCOL_ID,
} from "./InteractionServer.js";

const logger = Logger.get("InteractionClient");

const REQUEST_ALL = [{}];
const DEFAULT_TIMED_REQUEST_TIMEOUT_MS = 10_000; // 10 seconds
const DEFAULT_MINIMUM_RESPONSE_TIMEOUT_WITH_FAILSAFE_MS = 30_000; // 30 seconds

export interface AttributeStatus {
    path: {
        nodeId?: NodeId;
        endpointId?: EndpointNumber;
        clusterId?: ClusterId;
        attributeId?: AttributeId;
    };
    status: StatusCode;
}

export class SubscriptionClient implements ProtocolHandler<MatterController> {
    constructor(private readonly subscriptionListeners: Map<number, (dataReport: DataReport) => void>) {}

    getId() {
        return INTERACTION_PROTOCOL_ID;
    }

    async onNewExchange(exchange: MessageExchange<MatterController>) {
        const messenger = new IncomingInteractionClientMessenger(exchange);
        const dataReport = await messenger.readDataReport();
        const subscriptionId = dataReport.subscriptionId;
        if (subscriptionId === undefined) {
            await messenger.sendStatus(StatusCode.InvalidSubscription);
            throw new UnexpectedDataError("Invalid Data report without Subscription ID");
        }
        const listener = this.subscriptionListeners.get(subscriptionId);
        if (listener === undefined) {
            await messenger.sendStatus(StatusCode.InvalidSubscription);
            logger.info(`Received data for unknown subscription ID ${subscriptionId}. Cancel this subscription.`);
            await messenger.close();
            return;
        }
        await messenger.sendStatus(StatusCode.Success);
        await messenger.close();

        listener(dataReport);
    }
}

export class InteractionClient {
    private readonly subscriptionListeners = new Map<number, (dataReport: DataReport) => void>();
    private readonly subscribedLocalValues = new Map<string, any>();
    private readonly subscribedClusterDataVersions = new Map<string, number>();

    constructor(private readonly exchangeProvider: ExchangeProvider) {
        // TODO: Right now we potentially add multiple handlers for the same protocol, We need to fix this
        this.exchangeProvider.addProtocolHandler(new SubscriptionClient(this.subscriptionListeners));
    }

    async getAllAttributes(
        options: {
            dataVersionFilters?: { endpointId: EndpointNumber; clusterId: ClusterId; dataVersion: number }[];
            isFabricFiltered?: boolean;
        } = {},
    ): Promise<DecodedAttributeReportValue<any>[]> {
        const { dataVersionFilters, isFabricFiltered } = options;
        return (
            await this.getMultipleAttributesAndEvents({
                attributes: REQUEST_ALL,
                dataVersionFilters,
                isFabricFiltered,
            })
        ).attributeReports;
    }

    async getAllEvents(
        options: {
            eventFilters?: TypeFromSchema<typeof TlvEventFilter>[];
            isFabricFiltered?: boolean;
        } = {},
    ): Promise<DecodedEventReportValue<any>[]> {
        const { eventFilters, isFabricFiltered } = options;
        return (await this.getMultipleAttributesAndEvents({ events: REQUEST_ALL, eventFilters, isFabricFiltered }))
            .eventReports;
    }

    async getAllAttributesAndEvents(
        options: {
            dataVersionFilters?: {
                endpointId: EndpointNumber;
                clusterId: ClusterId;
                dataVersion: number;
            }[];
            eventFilters?: TypeFromSchema<typeof TlvEventFilter>[];
            isFabricFiltered?: boolean;
        } = {},
    ): Promise<{
        attributeReports: DecodedAttributeReportValue<any>[];
        eventReports: DecodedEventReportValue<any>[];
    }> {
        const { dataVersionFilters, eventFilters, isFabricFiltered } = options;
        return this.getMultipleAttributesAndEvents({
            attributes: REQUEST_ALL,
            events: REQUEST_ALL,
            eventFilters,
            dataVersionFilters,
            isFabricFiltered,
        });
    }

    async getMultipleAttributes(
        options: {
            attributes?: { endpointId?: EndpointNumber; clusterId?: ClusterId; attributeId?: AttributeId }[];
            dataVersionFilters?: { endpointId: EndpointNumber; clusterId: ClusterId; dataVersion: number }[];
            isFabricFiltered?: boolean;
        } = {},
    ): Promise<DecodedAttributeReportValue<any>[]> {
        const { attributes, dataVersionFilters, isFabricFiltered } = options;
        return (await this.getMultipleAttributesAndEvents({ attributes, dataVersionFilters, isFabricFiltered }))
            .attributeReports;
    }

    async getMultipleEvents(
        options: {
            events?: { endpointId?: EndpointNumber; clusterId?: ClusterId; eventId?: EventId }[];
            eventFilters?: TypeFromSchema<typeof TlvEventFilter>[];
            isFabricFiltered?: boolean;
        } = {},
    ): Promise<DecodedEventReportValue<any>[]> {
        const { events, eventFilters, isFabricFiltered } = options;
        return (await this.getMultipleAttributesAndEvents({ events, eventFilters, isFabricFiltered })).eventReports;
    }

    async getMultipleAttributesAndEvents(
        options: {
            attributes?: { endpointId?: EndpointNumber; clusterId?: ClusterId; attributeId?: AttributeId }[];
            dataVersionFilters?: { endpointId: EndpointNumber; clusterId: ClusterId; dataVersion: number }[];
            events?: { endpointId?: EndpointNumber; clusterId?: ClusterId; eventId?: EventId }[];
            eventFilters?: TypeFromSchema<typeof TlvEventFilter>[];
            isFabricFiltered?: boolean;
        } = {},
    ): Promise<{
        attributeReports: DecodedAttributeReportValue<any>[];
        eventReports: DecodedEventReportValue<any>[];
    }> {
        const {
            attributes: attributeRequests,
            dataVersionFilters,
            events: eventRequests,
            eventFilters,
            isFabricFiltered = true,
        } = options;
        if (attributeRequests === undefined && eventRequests === undefined) {
            throw new ImplementationError("When reading attributes and events, at least one must be specified.");
        }

        const readPathsCount = (attributeRequests?.length ?? 0) + (eventRequests?.length ?? 0);
        if (readPathsCount > 9) {
            logger.debug(
                "Read interactions with more then 9 paths might be not allowed by the device. Consider splitting then into several read requests.",
            );
        }

        return this.withMessenger<{
            attributeReports: DecodedAttributeReportValue<any>[];
            eventReports: DecodedEventReportValue<any>[];
        }>(async messenger => {
            return await this.processReadRequest(messenger, {
                attributeRequests,
                dataVersionFilters: dataVersionFilters?.map(({ endpointId, clusterId, dataVersion }) => ({
                    path: { endpointId, clusterId },
                    dataVersion,
                })),
                eventRequests,
                eventFilters,
                isFabricFiltered,
                interactionModelRevision: INTERACTION_MODEL_REVISION,
            });
        });
    }

    async getAttribute<A extends Attribute<any, any>>(options: {
        endpointId: EndpointNumber;
        clusterId: ClusterId;
        attribute: A;
        isFabricFiltered?: boolean;
        alwaysRequestFromRemote?: boolean;
    }): Promise<AttributeJsType<A> | undefined> {
        const { endpointId, clusterId, attribute, alwaysRequestFromRemote = false, isFabricFiltered } = options;
        const response = await this.getAttributeWithVersion({
            endpointId,
            clusterId,
            attribute,
            alwaysRequestFromRemote,
            isFabricFiltered,
        });
        return response?.value;
    }

    async getAttributeWithVersion<A extends Attribute<any, any>>(options: {
        endpointId: EndpointNumber;
        clusterId: ClusterId;
        attribute: A;
        isFabricFiltered?: boolean;
        alwaysRequestFromRemote?: boolean;
    }): Promise<{ value: AttributeJsType<A>; version: number } | undefined> {
        const { endpointId, clusterId, attribute, alwaysRequestFromRemote = false, isFabricFiltered } = options;
        const { id: attributeId } = attribute;
        if (!alwaysRequestFromRemote) {
            const value = this.subscribedLocalValues.get(attributePathToId({ endpointId, clusterId, attributeId }));
            const version = this.subscribedClusterDataVersions.get(clusterPathToId({ endpointId, clusterId }));
            if (value !== undefined && version !== undefined) {
                return { value, version } as { value: AttributeJsType<A>; version: number };
            }
        }

        const { attributeReports } = await this.getMultipleAttributesAndEvents({
            attributes: [{ endpointId, clusterId, attributeId }],
            isFabricFiltered,
        });

        if (attributeReports.length === 0) {
            return undefined;
        }
        if (attributeReports.length > 1) {
            throw new UnexpectedDataError("Unexpected response with more then one attribute");
        }
        return { value: attributeReports[0].value, version: attributeReports[0].version };
    }

    async getEvent<T, E extends Event<T, any>>(options: {
        endpointId: EndpointNumber;
        clusterId: ClusterId;
        event: E;
        minimumEventNumber?: number | bigint;
        isFabricFiltered?: boolean;
    }): Promise<DecodedEventData<T>[] | undefined> {
        const { endpointId, clusterId, event, minimumEventNumber, isFabricFiltered = true } = options;
        const { id: eventId } = event;
        const response = await this.getMultipleAttributesAndEvents({
            events: [{ endpointId, clusterId, eventId }],
            eventFilters: minimumEventNumber !== undefined ? [{ eventMin: minimumEventNumber }] : undefined,
            isFabricFiltered,
        });
        return response?.eventReports[0]?.events;
    }

    private async processReadRequest(
        messenger: InteractionClientMessenger,
        request: ReadRequest,
    ): Promise<{ attributeReports: DecodedAttributeReportValue<any>[]; eventReports: DecodedEventReportValue<any>[] }> {
        const { attributeRequests, eventRequests } = request;
        logger.debug(
            `Sending read request to ${messenger.getExchangeChannelName()} for attributes ${attributeRequests
                ?.map(path => resolveAttributeName(path))
                .join(", ")} and events ${eventRequests?.map(path => resolveEventName(path)).join(", ")}`,
        );
        // Send read request and combine all (potentially chunked) responses
        let response = await messenger.sendReadRequest(request);
        const attributeReports = new Array<TypeFromSchema<typeof TlvAttributeReport>>();
        const eventReports = new Array<TypeFromSchema<typeof TlvEventReport>>();

        while (true) {
            if (response.attributeReports !== undefined) {
                attributeReports.push(...response.attributeReports);
            }
            if (response.eventReports !== undefined) {
                eventReports.push(...response.eventReports);
            }
            if (!response.suppressResponse) {
                await messenger.sendStatus(StatusCode.Success);
            }
            if (!response.moreChunkedMessages) break;
            response = await messenger.readDataReport();
        }

        // Normalize and decode the response
        const normalizedResult = {
            attributeReports: normalizeAndDecodeReadAttributeReport(attributeReports),
            eventReports: normalizeAndDecodeReadEventReport(eventReports),
        };
        logger.debug(
            `Received read response with attributes ${normalizedResult.attributeReports
                .map(({ path, value }) => `${resolveAttributeName(path)} = ${Logger.toJSON(value)}`)
                .join(", ")} and events ${normalizedResult.eventReports
                .map(({ path, events }) => `${resolveEventName(path)} = ${Logger.toJSON(events)}`)
                .join(", ")}`,
        );
        return normalizedResult;
    }

    async setAttribute<T>(options: {
        attributeData: {
            endpointId: EndpointNumber;
            clusterId: ClusterId;
            attribute: Attribute<T, any>;
            value: T;
            dataVersion?: number;
        };
        asTimedRequest?: boolean;
        timedRequestTimeoutMs?: number;
        suppressResponse?: boolean;
    }): Promise<void> {
        const { attributeData, asTimedRequest, timedRequestTimeoutMs, suppressResponse } = options;
        const { endpointId, clusterId, attribute, value, dataVersion } = attributeData;
        const response = await this.setMultipleAttributes({
            attributes: [{ endpointId, clusterId, attribute, value, dataVersion }],
            asTimedRequest,
            timedRequestTimeoutMs,
            suppressResponse,
        });

        // Response contains Status error if there was an error on write
        if (response.length) {
            const {
                path: { endpointId, clusterId, attributeId },
                status,
            } = response[0];
            if (status !== undefined && status !== StatusCode.Success) {
                throw new StatusResponseError(
                    `Error setting attribute ${endpointId}/${clusterId}/${attributeId}`,
                    status,
                );
            }
        }
    }

    async setMultipleAttributes(options: {
        attributes: {
            endpointId: EndpointNumber;
            clusterId: ClusterId;
            attribute: Attribute<any, any>;
            value: any;
            dataVersion?: number;
        }[];
        asTimedRequest?: boolean;
        timedRequestTimeoutMs?: number;
        suppressResponse?: boolean;
    }): Promise<AttributeStatus[]> {
        const {
            attributes,
            asTimedRequest,
            timedRequestTimeoutMs = DEFAULT_TIMED_REQUEST_TIMEOUT_MS,
            suppressResponse = false,
        } = options;
        return this.withMessenger<AttributeStatus[]>(async messenger => {
            logger.debug(
                `Sending write request: ${attributes
                    .map(
                        ({ endpointId, clusterId, attribute: { id }, value, dataVersion }) =>
                            `${resolveAttributeName({ endpointId, clusterId, attributeId: id })} = ${Logger.toJSON(
                                value,
                            )} (version=${dataVersion}`,
                    )
                    .join(", ")}`,
            );
            const writeRequests = attributes.map(
                ({ endpointId, clusterId, attribute: { id, schema }, value, dataVersion }) => ({
                    path: { endpointId, clusterId, attributeId: id },
                    data: schema.encodeTlv(value),
                    dataVersion,
                }),
            );
            const timedRequest =
                attributes.some(({ attribute: { timed } }) => timed) ||
                asTimedRequest === true ||
                options.timedRequestTimeoutMs !== undefined;
            if (timedRequest) {
                await messenger.sendTimedRequest(timedRequestTimeoutMs);
            }
            const response = await messenger.sendWriteCommand({
                suppressResponse,
                timedRequest,
                writeRequests,
                moreChunkedMessages: false,
                interactionModelRevision: INTERACTION_MODEL_REVISION,
            });
            if (response === undefined) {
                if (!suppressResponse) {
                    throw new MatterFlowError(`No response received from write interaction but expected.`);
                }
                return [];
            }
            return response.writeResponses
                .flatMap(
                    ({ status: { status, clusterStatus }, path: { nodeId, endpointId, clusterId, attributeId } }) => {
                        return {
                            path: { nodeId, endpointId, clusterId, attributeId },
                            status: status ?? clusterStatus ?? StatusCode.Failure,
                        };
                    },
                )
                .filter(({ status }) => status !== StatusCode.Success);
        });
    }

    async subscribeAttribute<A extends Attribute<any, any>>(options: {
        endpointId: EndpointNumber;
        clusterId: ClusterId;
        attribute: A;
        minIntervalFloorSeconds: number;
        maxIntervalCeilingSeconds: number;
        isFabricFiltered?: boolean;
        knownDataVersion?: number;
        keepSubscriptions?: boolean;
        listener?: (value: AttributeJsType<A>, version: number) => void;
    }): Promise<void> {
        const {
            endpointId,
            clusterId,
            attribute,
            minIntervalFloorSeconds,
            maxIntervalCeilingSeconds,
            isFabricFiltered = true,
            listener,
            knownDataVersion,
            keepSubscriptions = true,
        } = options;
        return this.withMessenger<void>(async messenger => {
            const { id: attributeId } = attribute;
            logger.debug(
                `Sending subscribe request for attribute: ${resolveAttributeName({
                    endpointId,
                    clusterId,
                    attributeId,
                })}`,
            );
            const {
                report,
                subscribeResponse: { subscriptionId },
            } = await messenger.sendSubscribeRequest({
                interactionModelRevision: INTERACTION_MODEL_REVISION,
                attributeRequests: [{ endpointId, clusterId, attributeId }],
                dataVersionFilters:
                    knownDataVersion !== undefined
                        ? [{ path: { endpointId, clusterId }, dataVersion: knownDataVersion }]
                        : undefined,
                keepSubscriptions,
                minIntervalFloorSeconds,
                maxIntervalCeilingSeconds,
                isFabricFiltered,
            });

            const subscriptionListener = (dataReport: DataReport) => {
                if (!Array.isArray(dataReport.attributeReports) || !dataReport.attributeReports.length) {
                    logger.debug("Subscription result empty");
                    return;
                }

                const data = normalizeAndDecodeReadAttributeReport(dataReport.attributeReports);

                if (data.length === 0) {
                    throw new MatterFlowError("Subscription result reporting undefined/no value not specified");
                }
                if (data.length > 1) {
                    throw new UnexpectedDataError("Unexpected response with more then one attribute");
                }
                const {
                    path: { endpointId, clusterId, attributeId },
                    value,
                    version,
                } = data[0];
                if (value === undefined)
                    throw new MatterFlowError("Subscription result reporting undefined value not specified.");

                this.subscribedLocalValues.set(attributePathToId({ endpointId, clusterId, attributeId }), value);
                this.subscribedClusterDataVersions.set(clusterPathToId({ endpointId, clusterId }), version);
                listener?.(value, version);
            };
            this.subscriptionListeners.set(subscriptionId, subscriptionListener);
            subscriptionListener(report);
            return;
        });
    }

    async subscribeEvent<T, E extends Event<T, any>>(options: {
        endpointId: EndpointNumber;
        clusterId: ClusterId;
        event: E;
        minIntervalFloorSeconds: number;
        maxIntervalCeilingSeconds: number;
        isUrgent?: boolean;
        minimumEventNumber?: number | bigint;
        isFabricFiltered?: boolean;
        listener?: (value: DecodedEventData<T>) => void;
    }): Promise<void> {
        return this.withMessenger<void>(async messenger => {
            const {
                endpointId,
                clusterId,
                event,
                minIntervalFloorSeconds,
                maxIntervalCeilingSeconds,
                isUrgent,
                minimumEventNumber,
                isFabricFiltered = true,
                listener,
            } = options;
            const { id: eventId } = event;
            logger.debug(
                `Sending subscribe request for event: ${resolveEventName({ endpointId, clusterId, eventId })}`,
            );
            const {
                report,
                subscribeResponse: { subscriptionId },
            } = await messenger.sendSubscribeRequest({
                interactionModelRevision: INTERACTION_MODEL_REVISION,
                eventRequests: [{ endpointId, clusterId, eventId, isUrgent }],
                eventFilters: minimumEventNumber !== undefined ? [{ eventMin: minimumEventNumber }] : undefined,
                keepSubscriptions: true,
                minIntervalFloorSeconds,
                maxIntervalCeilingSeconds,
                isFabricFiltered,
            });

            const subscriptionListener = (dataReport: DataReport) => {
                if (!Array.isArray(dataReport.eventReports) || !dataReport.eventReports.length) {
                    logger.debug("Subscription result empty");
                    return;
                }

                const data = normalizeAndDecodeReadEventReport(dataReport.eventReports);

                if (data.length === 0) {
                    throw new MatterFlowError("Received empty subscription result value.");
                }
                if (data.length > 1) {
                    throw new UnexpectedDataError("Unexpected response with more then one attribute.");
                }
                const { events } = data[0];
                if (events === undefined)
                    throw new MatterFlowError("Subscription result reporting undefined value not specified.");

                events.forEach(event => listener?.(event));
            };
            this.subscriptionListeners.set(subscriptionId, subscriptionListener);
            subscriptionListener(report);
            return;
        });
    }

    async subscribeAllAttributesAndEvents(options: {
        minIntervalFloorSeconds: number;
        maxIntervalCeilingSeconds: number;
        attributeListener?: (data: DecodedAttributeReportValue<any>) => void;
        eventListener?: (data: DecodedEventReportValue<any>) => void;
        isUrgent?: boolean;
        keepSubscriptions?: boolean;
        isFabricFiltered?: boolean;
        eventFilters?: TypeFromSchema<typeof TlvEventFilter>[];
        dataVersionFilters?: { endpointId: EndpointNumber; clusterId: ClusterId; dataVersion: number }[];
    }): Promise<{
        attributeReports?: DecodedAttributeReportValue<any>[];
        eventReports?: DecodedEventReportValue<any>[];
    }> {
        const {
            minIntervalFloorSeconds,
            maxIntervalCeilingSeconds,
            attributeListener,
            eventListener,
            isUrgent,
            keepSubscriptions = true,
            isFabricFiltered = true,
            eventFilters,
            dataVersionFilters,
        } = options;
        return this.subscribeMultipleAttributesAndEvents({
            attributes: REQUEST_ALL,
            events: [{ isUrgent }],
            minIntervalFloorSeconds,
            maxIntervalCeilingSeconds,
            keepSubscriptions,
            isFabricFiltered,
            attributeListener,
            eventListener,
            eventFilters,
            dataVersionFilters,
        });
    }

    async subscribeMultipleAttributesAndEvents(options: {
        attributes: { endpointId?: EndpointNumber; clusterId?: ClusterId; attributeId?: AttributeId }[];
        events: { endpointId?: EndpointNumber; clusterId?: ClusterId; eventId?: EventId; isUrgent?: boolean }[];
        minIntervalFloorSeconds: number;
        maxIntervalCeilingSeconds: number;
        keepSubscriptions?: boolean;
        isFabricFiltered?: boolean;
        attributeListener?: (data: DecodedAttributeReportValue<any>) => void;
        eventListener?: (data: DecodedEventReportValue<any>) => void;
        eventFilters?: TypeFromSchema<typeof TlvEventFilter>[];
        dataVersionFilters?: { endpointId: EndpointNumber; clusterId: ClusterId; dataVersion: number }[];
    }): Promise<{
        attributeReports?: DecodedAttributeReportValue<any>[];
        eventReports?: DecodedEventReportValue<any>[];
    }> {
        const {
            attributes: attributeRequests,
            events: eventRequests,
            minIntervalFloorSeconds,
            maxIntervalCeilingSeconds,
            keepSubscriptions = true,
            isFabricFiltered = true,
            attributeListener,
            eventListener,
            eventFilters,
            dataVersionFilters,
        } = options;

        const subscriptionPathsCount = (attributeRequests?.length ?? 0) + (eventRequests?.length ?? 0);
        if (subscriptionPathsCount > 3) {
            logger.debug("Subscribe interactions with more then 3 paths might be not allowed by the device.");
        }

        return this.withMessenger<{
            attributeReports?: DecodedAttributeReportValue<any>[];
            eventReports?: DecodedEventReportValue<any>[];
        }>(async messenger => {
            logger.debug(
                `Sending subscribe request: attributes: ${attributeRequests
                    .map(path => resolveAttributeName(path))
                    .join(", ")} and events: ${eventRequests.map(path => resolveEventName(path)).join(", ")}`,
            );
            const {
                report,
                subscribeResponse: { subscriptionId, maxInterval },
            } = await messenger.sendSubscribeRequest({
                interactionModelRevision: INTERACTION_MODEL_REVISION,
                attributeRequests,
                eventRequests,
                keepSubscriptions,
                minIntervalFloorSeconds,
                maxIntervalCeilingSeconds,
                isFabricFiltered,
                eventFilters,
                dataVersionFilters: dataVersionFilters?.map(({ endpointId, clusterId, dataVersion }) => ({
                    path: { endpointId, clusterId },
                    dataVersion,
                })),
            });
            logger.info(
                `Subscription successfully initialized with ID ${subscriptionId} and maxInterval ${maxInterval}s.`,
            );

            const subscriptionListener = (dataReport: {
                attributeReports?: DecodedAttributeReportValue<any>[];
                eventReports?: DecodedEventReportValue<any>[];
            }) => {
                if (
                    (!Array.isArray(dataReport.attributeReports) || !dataReport.attributeReports.length) &&
                    (!Array.isArray(dataReport.eventReports) || !dataReport.eventReports.length)
                ) {
                    logger.debug("Subscription result empty");
                    return;
                }
                const { attributeReports, eventReports } = dataReport;

                if (attributeReports !== undefined) {
                    attributeReports.forEach(data => {
                        const {
                            path: { endpointId, clusterId, attributeId },
                            value,
                            version,
                        } = data;
                        logger.debug(
                            `Received attribute update: ${resolveAttributeName({
                                endpointId,
                                clusterId,
                                attributeId,
                            })} = ${Logger.toJSON(value)} (version=${version})`,
                        );
                        if (value === undefined) throw new MatterFlowError("Received empty subscription result value.");
                        this.subscribedLocalValues.set(
                            attributePathToId({ endpointId, clusterId, attributeId }),
                            value,
                        );
                        this.subscribedClusterDataVersions.set(clusterPathToId({ endpointId, clusterId }), version);
                        attributeListener?.(data);
                    });
                }

                if (eventReports !== undefined) {
                    eventReports.forEach(data => {
                        logger.debug(
                            `Received event update: ${resolveEventName(data.path)}: ${Logger.toJSON(data.events)}`,
                        );
                        eventListener?.(data);
                    });
                }
            };
            this.subscriptionListeners.set(subscriptionId, dataReport => {
                subscriptionListener({
                    attributeReports:
                        dataReport.attributeReports !== undefined
                            ? normalizeAndDecodeReadAttributeReport(dataReport.attributeReports)
                            : undefined,
                    eventReports:
                        dataReport.eventReports !== undefined
                            ? normalizeAndDecodeReadEventReport(dataReport.eventReports)
                            : undefined,
                });
            });

            const seedReport = {
                attributeReports:
                    report.attributeReports !== undefined
                        ? normalizeAndDecodeReadAttributeReport(report.attributeReports)
                        : undefined,
                eventReports:
                    report.eventReports !== undefined
                        ? normalizeAndDecodeReadEventReport(report.eventReports)
                        : undefined,
            };
            subscriptionListener(seedReport);
            return seedReport;
        });
    }

    async invoke<C extends Command<any, any, any>>(options: {
        endpointId: EndpointNumber;
        clusterId: ClusterId;
        request: RequestType<C>;
        command: C;
        asTimedRequest?: boolean;
        timedRequestTimeoutMs?: number;
        useExtendedFailSafeMessageResponseTimeout?: boolean;
    }): Promise<ResponseType<C>> {
        const {
            endpointId,
            clusterId,
            request,
            command: { requestId, requestSchema, responseId, responseSchema, optional, timed },
            asTimedRequest,
            timedRequestTimeoutMs = DEFAULT_TIMED_REQUEST_TIMEOUT_MS,
            useExtendedFailSafeMessageResponseTimeout = false,
        } = options;
        const timedRequest = timed || asTimedRequest === true || options.timedRequestTimeoutMs !== undefined;

        return this.withMessenger<ResponseType<C>>(async messenger => {
            logger.debug(
                `Invoking command: ${resolveCommandName({
                    endpointId,
                    clusterId,
                    commandId: requestId,
                })} with ${Logger.toJSON(request)}`,
            );
            const commandFields = requestSchema.encodeTlv(request);

            if (timedRequest) {
                await messenger.sendTimedRequest(timedRequestTimeoutMs);
            }

            const invokeResponse = await messenger.sendInvokeCommand(
                {
                    invokeRequests: [{ commandPath: { endpointId, clusterId, commandId: requestId }, commandFields }],
                    timedRequest,
                    suppressResponse: false,
                    interactionModelRevision: INTERACTION_MODEL_REVISION,
                },
                useExtendedFailSafeMessageResponseTimeout
                    ? DEFAULT_MINIMUM_RESPONSE_TIMEOUT_WITH_FAILSAFE_MS
                    : undefined,
            );
            if (invokeResponse === undefined) {
                throw new MatterFlowError("No response received from invoke interaction but expected.");
            }
            const { invokeResponses } = invokeResponse;
            if (invokeResponses.length === 0) {
                throw new MatterFlowError("Received invoke response with no invoke results.");
            }
            const { command, status } = invokeResponses[0];
            if (status !== undefined) {
                const resultCode = status.status.status;
                if (resultCode !== StatusCode.Success)
                    throw new StatusResponseError(
                        `Received non-success result: ${resultCode}`,
                        resultCode ?? StatusCode.Failure,
                        status.status.clusterStatus,
                    );
                if ((responseSchema as any) !== TlvNoResponse)
                    throw new MatterFlowError("A response was expected for this command.");
                return undefined as unknown as ResponseType<C>; // ResponseType is void, force casting the empty result
            }
            if (command !== undefined) {
                const {
                    commandPath: { commandId },
                    commandFields,
                } = command;
                if (commandId !== responseId) {
                    throw new MatterFlowError(
                        `Received invoke response with unexpected command ID ${commandId}, expected ${responseId}.`,
                    );
                }
                if (commandFields === undefined) {
                    if ((responseSchema as any) !== TlvNoResponse)
                        throw new MatterFlowError(`A response was expected for command ${requestId}.`);
                    return undefined as unknown as ResponseType<C>; // ResponseType is void, force casting the empty result
                }
                const response = responseSchema.decodeTlv(commandFields);
                logger.debug(
                    `Received invoke response: ${resolveCommandName({
                        endpointId,
                        clusterId,
                        commandId: requestId,
                    })} with ${Logger.toJSON(response)})}`,
                );
                return response;
            }
            if (optional) {
                return undefined as ResponseType<C>; // ResponseType allows undefined for optional commands
            }
            throw new MatterFlowError("Received invoke response with no result nor response.");
        });
    }

    // TODO Add to ClusterClient when needed/when Group communication is implemented
    async invokeWithSuppressedResponse<C extends Command<any, any, any>>(options: {
        endpointId: EndpointNumber;
        clusterId: ClusterId;
        request: RequestType<C>;
        command: C;
        asTimedRequest?: boolean;
        timedRequestTimeoutMs?: number;
    }): Promise<void> {
        const {
            endpointId,
            clusterId,
            request,
            command: { requestId, requestSchema, timed },
            asTimedRequest,
            timedRequestTimeoutMs = DEFAULT_TIMED_REQUEST_TIMEOUT_MS,
        } = options;
        const timedRequest = timed || asTimedRequest === true || options.timedRequestTimeoutMs !== undefined;

        return this.withMessenger<void>(async messenger => {
            logger.debug(
                `Invoking command with suppressedResponse: ${resolveCommandName({
                    endpointId,
                    clusterId,
                    commandId: requestId,
                })} with ${Logger.toJSON(request)}`,
            );
            const commandFields = requestSchema.encodeTlv(request);

            if (timedRequest) {
                await messenger.sendTimedRequest(timedRequestTimeoutMs);
            }

            const invokeResponse = await messenger.sendInvokeCommand({
                invokeRequests: [{ commandPath: { endpointId, clusterId, commandId: requestId }, commandFields }],
                timedRequest,
                suppressResponse: true,
                interactionModelRevision: INTERACTION_MODEL_REVISION,
            });
            if (invokeResponse !== undefined) {
                throw new MatterFlowError(
                    "Response received from invoke interaction but none expected because response is suppressed.",
                );
            }

            logger.debug(
                `Invoke successful: ${resolveCommandName({
                    endpointId,
                    clusterId,
                    commandId: requestId,
                })}`,
            );
        });
    }

    private async withMessenger<T>(invoke: (messenger: InteractionClientMessenger) => Promise<T>): Promise<T> {
        const messenger = new InteractionClientMessenger(this.exchangeProvider);
        try {
            return await invoke(messenger);
        } finally {
            await messenger.close();
        }
    }

    get session() {
        return this.exchangeProvider.session;
    }
}
