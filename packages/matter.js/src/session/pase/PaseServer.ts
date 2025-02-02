/**
 * @license
 * Copyright 2022-2023 Project CHIP Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import BN from "bn.js";
import { MatterDevice } from "../../MatterDevice.js";
import { MatterFlowError, UnexpectedDataError } from "../../common/MatterError.js";
import { Crypto } from "../../crypto/Crypto.js";
import { PbkdfParameters, Spake2p } from "../../crypto/Spake2p.js";
import { Logger } from "../../log/Logger.js";
import { MessageExchange } from "../../protocol/MessageExchange.js";
import { ProtocolHandler } from "../../protocol/ProtocolHandler.js";
import { ProtocolStatusCode, SECURE_CHANNEL_PROTOCOL_ID } from "../../protocol/securechannel/SecureChannelMessages.js";
import { ChannelStatusResponseError } from "../../protocol/securechannel/SecureChannelMessenger.js";
import { Time, Timer } from "../../time/Time.js";
import { ByteArray } from "../../util/ByteArray.js";
import { UNDEFINED_NODE_ID } from "../SessionManager.js";
import { DEFAULT_PASSCODE_ID, PaseServerMessenger, SPAKE_CONTEXT } from "./PaseMessenger.js";

const logger = Logger.get("PaseServer");

const PASE_PAIRING_TIMEOUT_MS = 60_000;
const PASE_COMMISSIONING_MAX_ERRORS = 20;

export class MaximumPasePairingErrorsReachedError extends MatterFlowError {}

export class PaseServer implements ProtocolHandler<MatterDevice> {
    private pairingTimer: Timer | undefined;
    private pairingErrors = 0;

    static async fromPin(setupPinCode: number, pbkdfParameters: PbkdfParameters) {
        const { w0, L } = await Spake2p.computeW0L(pbkdfParameters, setupPinCode);
        return new PaseServer(w0, L, pbkdfParameters);
    }

    static fromVerificationValue(verificationValue: ByteArray, pbkdfParameters?: PbkdfParameters) {
        const w0 = new BN(verificationValue.slice(0, 32));
        const L = verificationValue.slice(32, 32 + 65);
        return new PaseServer(w0, L, pbkdfParameters);
    }

    constructor(
        private readonly w0: BN,
        private readonly L: ByteArray,
        private readonly pbkdfParameters?: PbkdfParameters,
    ) {}

    getId(): number {
        return SECURE_CHANNEL_PROTOCOL_ID;
    }

    async onNewExchange(exchange: MessageExchange<MatterDevice>) {
        const messenger = new PaseServerMessenger(exchange);
        try {
            await this.handlePairingRequest(exchange.session.getContext(), messenger);
        } catch (error) {
            this.pairingErrors++;
            logger.error("An error occurred during the PASE commissioning.", error);

            // if we received a ChannelStatusResponseError we do not need to send one back, so just cancel pairing
            const sendError = !(error instanceof ChannelStatusResponseError);
            await this.cancelPairing(messenger, sendError);

            if (this.pairingErrors >= PASE_COMMISSIONING_MAX_ERRORS) {
                throw new MaximumPasePairingErrorsReachedError(
                    `Pase server: Too many errors during PASE commissioning, aborting commissioning window`,
                );
            }
        }
    }

    private async handlePairingRequest(server: MatterDevice, messenger: PaseServerMessenger) {
        // When a Commissioner is either in the process of establishing a PASE session with the Commissionee or has
        // successfully established a session, the Commissionee SHALL NOT accept any more requests for new PASE
        // sessions until session establishment fails or the successfully established PASE session is terminated on
        // the commissioning channel.
        if (server.existsOpenPaseSession()) {
            throw new MatterFlowError(
                "Pase server: Pairing already in progress (PASE session exists), ignoring new exchange.",
            );
        }

        if (this.pairingTimer !== undefined && this.pairingTimer.isRunning) {
            throw new MatterFlowError(
                "Pase server: Pairing already in progress (PASE establishment Timer running), ignoring new exchange.",
            );
        }

        logger.info(`Received pairing request from ${messenger.getChannelName()}.`);

        this.pairingTimer = Time.getTimer(PASE_PAIRING_TIMEOUT_MS, () => this.cancelPairing(messenger)).start();

        const sessionId = server.getNextAvailableSessionId();
        const random = Crypto.getRandom();

        // Read pbkdRequest and send pbkdResponse
        const {
            requestPayload,
            request: { random: peerRandom, mrpParameters, passcodeId, hasPbkdfParameters, sessionId: peerSessionId },
        } = await messenger.readPbkdfParamRequest();
        if (passcodeId !== DEFAULT_PASSCODE_ID) {
            throw new UnexpectedDataError(`Unsupported passcode ID ${passcodeId}.`);
        }
        const responsePayload = await messenger.sendPbkdfParamResponse({
            peerRandom,
            random,
            sessionId,
            mrpParameters,
            pbkdfParameters: hasPbkdfParameters ? undefined : this.pbkdfParameters,
        });

        // Process pake1 and send pake2
        const spake2p = Spake2p.create(Crypto.hash([SPAKE_CONTEXT, requestPayload, responsePayload]), this.w0);
        const { x: X } = await messenger.readPasePake1();
        const Y = spake2p.computeY();
        const { Ke, hAY, hBX } = await spake2p.computeSecretAndVerifiersFromX(this.L, X, Y);
        await messenger.sendPasePake2({ y: Y, verifier: hBX });

        // Read and process pake3
        const { verifier } = await messenger.readPasePake3();
        if (!verifier.equals(hAY)) {
            throw new UnexpectedDataError("Received incorrect key confirmation from the initiator.");
        }

        // All good! Creating the secure PASE session
        await server.createSecureSession(
            sessionId,
            undefined /* fabric */,
            UNDEFINED_NODE_ID,
            peerSessionId,
            Ke,
            new ByteArray(0),
            false,
            false,
            mrpParameters?.idleRetransTimeoutMs,
            mrpParameters?.activeRetransTimeoutMs,
        );
        logger.info(`Session ${sessionId} created with ${messenger.getChannelName()}.`);

        await messenger.sendSuccess();
        await messenger.close();

        this.pairingTimer?.stop();
        this.pairingTimer = undefined;
    }

    async cancelPairing(messenger: PaseServerMessenger, sendError = true) {
        this.pairingTimer?.stop();
        this.pairingTimer = undefined;

        if (sendError) {
            await messenger.sendError(ProtocolStatusCode.InvalidParam);
        }
        await messenger.close();
    }
}
