import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
    encryptChunk,
    importCaptureKey,
} from "../../../extensions/recorder/lib/chunk-crypto.js";
import { decryptRecorderChunk } from "../../lib/recording-sessions/chunk-crypto";

describe("recorder chunk wire format", () => {
    it("decrypts a browser Web Crypto chunk on the server and rejects index and tag changes", async () => {
        const rawKey = randomBytes(32);
        const clientRecordingId = "5c21c9a8-b924-44cc-bbc8-6c2c1f486522";
        const key = await importCaptureKey(rawKey.toString("base64"));
        const encrypted = await encryptChunk(
            key,
            clientRecordingId,
            7,
            new Blob(["meeting audio"]),
        );
        const envelope = Buffer.from(await encrypted.arrayBuffer());
        const input = { envelope, key: rawKey, clientRecordingId, index: 7 };

        expect(decryptRecorderChunk(input).toString()).toBe("meeting audio");
        expect(decryptRecorderChunk(input).toString()).toBe("meeting audio");
        expect(() => decryptRecorderChunk({ ...input, index: 8 })).toThrow();

        const tampered = Buffer.from(envelope);
        tampered[tampered.length - 1] ^= 1;
        expect(() =>
            decryptRecorderChunk({ ...input, envelope: tampered }),
        ).toThrow();
    });
});
