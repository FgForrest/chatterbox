import { createDecipheriv } from "node:crypto";

const VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
export const CHUNK_ENVELOPE_OVERHEAD = 1 + NONCE_BYTES + TAG_BYTES;

/** Authenticate and decrypt one versioned recorder chunk. */
export function decryptRecorderChunk(input: {
    envelope: Buffer;
    key: Buffer;
    clientRecordingId: string;
    index: number;
}): Buffer {
    const { envelope, key, clientRecordingId, index } = input;
    if (envelope.length <= CHUNK_ENVELOPE_OVERHEAD || envelope[0] !== VERSION) {
        throw new Error("Invalid encrypted chunk envelope");
    }
    const nonce = envelope.subarray(1, 1 + NONCE_BYTES);
    const encrypted = envelope.subarray(1 + NONCE_BYTES, -TAG_BYTES);
    const tag = envelope.subarray(-TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(
        Buffer.from(`chatterbox-recorder-v1:${clientRecordingId}:${index}`),
    );
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}
