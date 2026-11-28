import { afterEach, describe, expect, it, vi } from "vitest";
import cs from "../../../extensions/recorder/_locales/cs/messages.json";
import en from "../../../extensions/recorder/_locales/en/messages.json";
import { createSealedSession } from "../../../extensions/recorder/lib/api.js";
import {
    exceedsCaptureLimits,
    lowCaptureStorage,
    rememberCapturePersistence,
} from "../../../extensions/recorder/lib/capture-storage.js";
import { encryptChunk } from "../../../extensions/recorder/lib/chunk-crypto.js";
import { pendingRecordingStatus } from "../../../extensions/recorder/lib/pending-recordings.js";
import {
    decodeSealedBytes,
    deriveSealedKey,
    offlineConfig,
    sealCapture,
    sealedRecipient,
    validSessionLimit,
} from "../../../extensions/recorder/lib/sealed-recording.js";
import vectors from "../fixtures/recorder-sealed-vectors.json";

const settings = { serverUrl: "https://recorder.example", hasApiKey: true };
const config = {
    account: { id: "original-account" },
    features: { offlineRecording: 1 },
    offlineKey: {
        kid: vectors.kid,
        alg: "ECDH-P256-HKDF-SHA256-A256GCM",
        publicKey: vectors.recipient.publicKey,
    },
};

afterEach(() => vi.unstubAllGlobals());

describe("offline capture capability", () => {
    it("uses the released path until a valid P-256 key is cached", async () => {
        expect(
            sealedRecipient({
                ...settings,
                serverDefaults: await offlineConfig({}, settings),
            }),
        ).toBeNull();
        const serverDefaults = await offlineConfig(config, settings);
        expect(sealedRecipient({ ...settings, serverDefaults })).toEqual(
            expect.objectContaining(config.offlineKey),
        );
        expect(
            sealedRecipient({ ...settings, serverDefaults, unreachable: true }),
        ).toEqual(serverDefaults.offlineRecipient);
    });

    it("honors a reachable rollback and only trusts the selected account and origin", async () => {
        const original = {
            ...settings,
            serverDefaults: await offlineConfig(config, settings),
        };
        const rolledBack = await offlineConfig({}, original);
        expect(rolledBack.offlineRecipient).toEqual(
            original.serverDefaults.offlineRecipient,
        );
        expect(
            sealedRecipient({ ...original, serverDefaults: rolledBack }),
        ).toBeNull();
        expect(
            sealedRecipient({
                ...original,
                serverUrl: "https://other.example",
            }),
        ).toBeNull();
        expect(sealedRecipient({ ...original, hasApiKey: false })).toBeNull();
        const switched = await offlineConfig(
            { ...config, offlineKey: null, account: { id: "other-account" } },
            original,
        );
        expect(switched.offlineRecipient).toBeNull();
        expect(switched.accountId).toBe("other-account");
    });

    it.each([
        "broken",
        "AAAA",
        `${vectors.recipient.publicKey}=`,
    ])("rejects malformed SPKI %s without erasing a valid cached key", async (publicKey) => {
        const broken = {
            ...config,
            offlineKey: { ...config.offlineKey, kid: "invalid-key", publicKey },
        };
        expect(
            (await offlineConfig(broken, settings)).offlineRecipient,
        ).toBeNull();
        const original = await offlineConfig(config, settings);
        const latest = await offlineConfig(broken, {
            ...settings,
            serverDefaults: original,
        });
        expect(latest.offlineRecipient).toEqual(original.offlineRecipient);
    });

    it.each([
        [2_000_000_000, 2_000_000_000],
        [0, null],
        [1.5, null],
        ["2000000000", null],
        [2 ** 53, null],
        [undefined, null],
    ])("accepts only a positive safe integer session limit (%j)", (value, expected) => {
        expect(validSessionLimit(value)).toBe(expected);
    });
});

it("reproduces the server vector through the host key derivation and v1 chunk envelope", async () => {
    const privateKey = await crypto.subtle.importKey(
        "pkcs8",
        decodeSealedBytes(vectors.ephemeral.privateKey),
        { name: "ECDH", namedCurve: "P-256" },
        false,
        ["deriveBits"],
    );
    const key = await deriveSealedKey(
        vectors.recipient,
        privateKey,
        decodeSealedBytes(vectors.salt),
        vectors.kid,
        vectors.clientRecordingId,
    );
    expect(key.extractable).toBe(false);
    expect(key.usages).toEqual(["encrypt"]);
    const nonce = decodeSealedBytes(vectors.chunk.envelope).slice(1, 13);
    const result = await encryptChunk(
        key,
        vectors.clientRecordingId,
        vectors.chunk.index,
        new Blob([decodeSealedBytes(vectors.chunk.plaintext)]),
        nonce,
    );
    expect(Buffer.from(await result.arrayBuffer()).toString("base64url")).toBe(
        vectors.chunk.envelope,
    );
    const fresh = await sealCapture(
        config.offlineKey,
        vectors.clientRecordingId,
    );
    expect(fresh.key.extractable).toBe(false);
    expect(decodeSealedBytes(fresh.sealing.ephemeralPublicKey)).toHaveLength(
        65,
    );
    expect(decodeSealedBytes(fresh.sealing.salt)).toHaveLength(16);
});

describe("sealed create response", () => {
    const auth = { serverUrl: settings.serverUrl, apiKey: "test-key" };
    const body = { encryption: { protocol: 2, kid: vectors.kid } };

    it.each([
        [1, vectors.kid],
        [2, "wrong-kid"],
    ])("rejects an echo of protocol %s and kid %s", async (protocol, kid) => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                Response.json({
                    id: "example",
                    status: "open",
                    encryption: { protocol, kid },
                }),
            ),
        );
        await expect(createSealedSession(auth, body)).rejects.toMatchObject({
            detail: { kind: "foreign-response" },
        });
    });

    it.each([
        404, 405,
    ])("preserves a %s from a rolled-back server", async (status) => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("legacy route", { status })),
        );
        await expect(createSealedSession(auth, body)).rejects.toMatchObject({
            kind: "capability",
            status,
        });
    });
});

describe("browser storage", () => {
    it.each([
        [57_599_999, true],
        [57_600_000, false],
        [undefined, false],
    ])("warns with %s free bytes without blocking capture", async (quota, low) => {
        vi.stubGlobal("navigator", {
            storage: { estimate: vi.fn(async () => ({ quota, usage: 0 })) },
        });
        expect(await lowCaptureStorage()).toBe(low);
    });

    it("accepts index 9999 and rejects index 10000 even with bytes available", () => {
        expect(exceedsCaptureLimits(9_999, 100, 100)).toBe(false);
        expect(exceedsCaptureLimits(10_000, 99, 100)).toBe(true);
        expect(exceedsCaptureLimits(9_999, 101, 100)).toBe(true);
    });

    it("requests persistence once and refreshes the recorded answer", async () => {
        const cache = {};
        const persist = vi.fn(async () => false);
        const persisted = vi
            .fn()
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);
        vi.stubGlobal("navigator", { storage: { persist, persisted } });
        vi.stubGlobal("chrome", {
            storage: {
                local: {
                    get: async () => cache,
                    set: async (values) => Object.assign(cache, values),
                },
            },
        });
        await rememberCapturePersistence();
        await rememberCapturePersistence();
        expect(persist).toHaveBeenCalledOnce();
        expect(cache.recorderStoragePersistence).toEqual({
            requested: true,
            persisted: true,
        });
    });
});

describe.each([
    ["en", en],
    ["cs", cs],
])("pending recordings in %s", (_language, catalog) => {
    it("shows waiting, sending, refusal reasons, age and another connection", () => {
        vi.stubGlobal("chrome", {
            i18n: {
                getMessage: (name, values) =>
                    catalog[name]?.message.replace(
                        /\$(\d)/g,
                        (_, idx) => [values].flat()[Number(idx) - 1],
                    ),
            },
        });
        const pairing = {
            serverOrigin: settings.serverUrl,
            accountId: "original-account",
        };
        const original = {
            ...settings,
            serverDefaults: { accountId: pairing.accountId },
        };
        const meta = {
            protocol: 2,
            pairing,
            startedAt: "2026-11-20T10:00:00Z",
            chunkCount: 302,
            uploadedParts: 96,
        };
        const now = Date.parse("2026-11-28T10:00:00Z");
        expect(pendingRecordingStatus(meta, original, true, now)).toMatchObject(
            {
                title: catalog.offlineWaiting.message,
                local: true,
                days: 8,
            },
        );
        expect(
            pendingRecordingStatus(
                { ...meta, serverSessionId: "sealed" },
                original,
                false,
                now,
            ).title,
        ).toBe(
            catalog.offlineSending.message
                .replace("$1", "96")
                .replace("$2", "302"),
        );
        for (const [code, message] of [
            ["STORAGE_QUOTA_EXCEEDED", catalog.offlineStorageRefused.message],
            ["OFFLINE_KEY_UNAVAILABLE", catalog.offlineKeyRefused.message],
            ["OTHER", "Example server message"],
        ]) {
            expect(
                pendingRecordingStatus(
                    {
                        ...meta,
                        refusal: { code, message: "Example server message" },
                    },
                    original,
                    false,
                    now,
                ),
            ).toMatchObject({
                title: catalog.offlineRefused.message,
                reason: message,
            });
        }
        expect(
            pendingRecordingStatus(
                meta,
                { ...original, serverDefaults: { accountId: "other" } },
                false,
                now,
            ),
        ).toMatchObject({
            other: true,
            title: catalog.offlineOtherConnection.message,
        });
    });
});
