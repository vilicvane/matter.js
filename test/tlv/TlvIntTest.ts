/**
 * @license
 * Copyright 2022 Project CHIP Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "assert";
import { TlvUInt64, TlvUInt } from "../../src/tlv/TlvUInt";
import { arrayBufferFromHex, arrayBufferToHex } from "../../src/util/ArrayBuffer";

describe("TlvUInt", () => {

    context("encode", () => {
        it("encodes an 1 byte unsigned int using in TLV", () => {
            const result = TlvUInt64.encode(1);

            assert.strictEqual(arrayBufferToHex(result), "0401");
        });

        it("encodes a 2 bytes unsigned int using in TLV", () => {
            const result = TlvUInt64.encode(0x0100);

            assert.strictEqual(arrayBufferToHex(result), "050001");
        });

        it("encodes a 4 bytes unsigned int using in TLV", () => {
            const result = TlvUInt64.encode(0x01000000);

            assert.strictEqual(arrayBufferToHex(result), "0600000001");
        });

        it("encodes an 8 bytes unsigned int using in TLV", () => {
            const result = TlvUInt64.encode(BigInt(0x01000000000000));

            assert.strictEqual(arrayBufferToHex(result), "070000000000000100");
        });
    });

    context("decode", () => {
        it("decodes an 1 byte unsigned int using in TLV", () => {
            const result = TlvUInt64.decode(arrayBufferFromHex("0401"));

            assert.strictEqual(result, 1);
        });

        it("decodes a 2 bytes unsigned int using in TLV", () => {
            const result = TlvUInt64.decode(arrayBufferFromHex("050001"));

            assert.strictEqual(result, 0x0100);
        });

        it("decodes a 4 bytes unsigned int using in TLV", () => {
            const result = TlvUInt64.decode(arrayBufferFromHex("0600000001"));

            assert.strictEqual(result, 0x01000000);
        });

        it("decodes an 8 bytes unsigned int using in TLV", () => {
            const result = TlvUInt64.decode(arrayBufferFromHex("070000000000000100"));

            assert.strictEqual(result, BigInt(0x01000000000000));
        });
    });

    context("validate", () => {
        const BoundedUint = TlvUInt({ min: 5, max: 10 });

        it("validates a value between min and max", () => {
            BoundedUint.validate(6);
        });

        it("throws an error if the value is too low", () => {
            assert.throws(() => {
                BoundedUint.validate(1);
            });
        });

        it("throws an error if the value is too high", () => {
            assert.throws(() => {
                BoundedUint.validate(12);
            });
        });
    });
});
