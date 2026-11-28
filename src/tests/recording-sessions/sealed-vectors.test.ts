import {
    createECDH,
    createHash,
    createPrivateKey,
    createPublicKey,
    webcrypto,
} from "node:crypto";
import { expect, it, vi } from "vitest";
import { decryptRecorderChunk } from "@/lib/recording-sessions/chunk-crypto";
import {
    deriveSealedCaptureKey,
    parseSealedCapture,
} from "@/lib/recording-sessions/offline-key";
import vector from "@/tests/fixtures/recorder-sealed-vectors.json";

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/env", () => ({ env: {} }));

const bytes = (value: string) =>
    Uint8Array.from(Buffer.from(value, "base64url"));
const base64url = (value: Uint8Array | ArrayBuffer) =>
    Buffer.from(new Uint8Array(value)).toString("base64url");

function p256(label: string) {
    const ecdh = createECDH("prime256v1");
    const scalar = createHash("sha256").update(label).digest();
    ecdh.setPrivateKey(scalar);
    const point = ecdh.getPublicKey();
    const key = createPrivateKey({
        format: "jwk",
        key: {
            kty: "EC",
            crv: "P-256",
            d: base64url(scalar),
            x: base64url(point.subarray(1, 33)),
            y: base64url(point.subarray(33)),
        },
    });
    return {
        point: base64url(point),
        spki: base64url(
            createPublicKey(key).export({ type: "spki", format: "der" }),
        ),
        pkcs8: base64url(key.export({ type: "pkcs8", format: "der" })),
    };
}

async function generateVector() {
    const recipient = p256("recorder-vector-recipient");
    const ephemeral = p256("recorder-vector-ephemeral");
    const kid = "vector-key";
    const clientRecordingId = "ec51af65-a7ac-486d-8c7a-8d90af3326dc";
    const salt = Uint8Array.from({ length: 16 }, (_, index) => index);
    const encoder = new TextEncoder();
    const hkdfInfo = encoder.encode(
        `chatterbox-recorder-offline-v1:${kid}:${clientRecordingId}`,
    );
    const { subtle } = webcrypto;
    const ecdh = { name: "ECDH", namedCurve: "P-256" };
    const publicKey = await subtle.importKey(
        "spki",
        bytes(recipient.spki),
        ecdh,
        false,
        [],
    );
    const privateKey = await subtle.importKey(
        "pkcs8",
        bytes(ephemeral.pkcs8),
        ecdh,
        false,
        ["deriveBits"],
    );
    const secret = await subtle.deriveBits(
        { name: "ECDH", public: publicKey },
        privateKey,
        256,
    );
    const inputKey = await subtle.importKey("raw", secret, "HKDF", false, [
        "deriveBits",
    ]);
    const derivedKey = await subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt, info: hkdfInfo },
        inputKey,
        256,
    );
    const aes = await subtle.importKey("raw", derivedKey, "AES-GCM", false, [
        "encrypt",
    ]);
    const index = 7;
    const aad = encoder.encode(
        `chatterbox-recorder-v1:${clientRecordingId}:${index}`,
    );
    const plaintext = encoder.encode("recorder vector audio bytes");
    const iv = Uint8Array.from({ length: 12 }, (_, offset) => 17 + offset);
    const ciphertext = await subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        aes,
        plaintext,
    );
    return {
        recipient: { publicKey: recipient.spki, privateKey: recipient.pkcs8 },
        ephemeral: { publicKey: ephemeral.point, privateKey: ephemeral.pkcs8 },
        salt: base64url(salt),
        kid,
        clientRecordingId,
        derivedKey: base64url(derivedKey),
        hkdfInfo: base64url(hkdfInfo),
        chunk: {
            index,
            aad: base64url(aad),
            plaintext: base64url(plaintext),
            envelope: base64url(
                Uint8Array.of(1, ...iv, ...new Uint8Array(ciphertext)),
            ),
        },
    };
}

const descriptor = {
    protocol: 2,
    kid: vector.kid,
    ephemeralPublicKey: vector.ephemeral.publicKey,
    salt: vector.salt,
} as const;

it("reproduces the checked-in recorder vector with WebCrypto", async () => {
    expect(await generateVector()).toEqual(vector);
});

it("derives the WebCrypto key and authenticates the unchanged chunk envelope", () => {
    const key = deriveSealedCaptureKey(
        Buffer.from(vector.recipient.privateKey, "base64url"),
        parseSealedCapture(descriptor),
        vector.clientRecordingId,
    );
    expect(base64url(key)).toBe(vector.derivedKey);
    const envelope = Buffer.from(vector.chunk.envelope, "base64url");
    const chunk = {
        key,
        envelope,
        clientRecordingId: vector.clientRecordingId,
        index: vector.chunk.index,
    };
    expect(base64url(decryptRecorderChunk(chunk))).toBe(vector.chunk.plaintext);
    expect(() =>
        decryptRecorderChunk({ ...chunk, index: chunk.index + 1 }),
    ).toThrow();
    envelope[13] ^= 1;
    expect(() => decryptRecorderChunk(chunk)).toThrow();
});

it.each([
    { protocol: 1 },
    { salt: `${vector.salt}==` },
    { salt: Buffer.alloc(15).toString("base64url") },
    { salt: `${vector.salt.slice(0, -1)}x` },
    { ephemeralPublicKey: `${vector.ephemeral.publicKey}=` },
    { ephemeralPublicKey: Buffer.alloc(33, 2).toString("base64url") },
    { ephemeralPublicKey: Buffer.alloc(65, 3).toString("base64url") },
])("rejects a malformed descriptor %o", (patch) => {
    expect(() => parseSealedCapture({ ...descriptor, ...patch })).toThrow(
        expect.objectContaining({ statusCode: 400, code: "INVALID_INPUT" }),
    );
});

it("rejects an uncompressed point outside the curve", () => {
    const point = Buffer.alloc(65);
    point[0] = 4;
    const sealed = parseSealedCapture({
        ...descriptor,
        ephemeralPublicKey: base64url(point),
    });
    expect(() =>
        deriveSealedCaptureKey(
            Buffer.from(vector.recipient.privateKey, "base64url"),
            sealed,
            vector.clientRecordingId,
        ),
    ).toThrow(
        expect.objectContaining({ statusCode: 400, code: "INVALID_INPUT" }),
    );
});
