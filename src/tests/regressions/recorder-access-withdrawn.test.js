import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
    const listeners = {};
    const sessionValues = {};
    const event = (name) => ({
        addListener: vi.fn((listener) => {
            listeners[name] = listener;
        }),
    });
    globalThis.chrome = {
        i18n: { getMessage: (key) => key },
        storage: {
            local: { setAccessLevel: vi.fn(async () => {}) },
            session: {
                get: vi.fn(async (key) => ({ [key]: sessionValues[key] })),
                set: vi.fn(async (values) =>
                    Object.assign(sessionValues, values),
                ),
                remove: vi.fn(async (key) => {
                    delete sessionValues[key];
                }),
            },
            onChanged: event("storageChanged"),
        },
        runtime: {
            onMessage: event("message"),
            onMessageExternal: event("externalMessage"),
            onStartup: event("startup"),
            onInstalled: event("installed"),
            sendMessage: vi.fn(async () => {}),
            getContexts: vi.fn(async () => []),
            getManifest: vi.fn(() => ({ version: "0.2.0" })),
            getURL: vi.fn((path) => `chrome-extension://test/${path}`),
        },
        action: {
            onClicked: event("actionClicked"),
            setTitle: vi.fn(async () => {}),
            setBadgeText: vi.fn(async () => {}),
            setBadgeBackgroundColor: vi.fn(async () => {}),
        },
        commands: { onCommand: event("command") },
        alarms: { onAlarm: event("alarm"), create: vi.fn(async () => {}) },
        notifications: {
            onClicked: event("notificationClicked"),
            clear: vi.fn(async () => {}),
            create: vi.fn(async () => "notice"),
        },
        offscreen: { createDocument: vi.fn(async () => {}) },
        tabCapture: { getMediaStreamId: vi.fn() },
        windows: {
            create: vi.fn(),
            get: vi.fn(async () => ({ id: 77 })),
            remove: vi.fn(async () => {}),
            update: vi.fn(async () => {}),
            onRemoved: event("windowRemoved"),
        },
        tabs: {
            get: vi.fn(async (id) => ({ id, url: "http://localhost:3555" })),
            query: vi.fn(async () => []),
            update: vi.fn(async () => {}),
            create: vi.fn(async () => {}),
            onUpdated: event("tabUpdated"),
            onRemoved: event("tabRemoved"),
        },
    };
    return {
        listeners,
        sessionValues,
        uploadChunk: vi.fn(),
        getSession: vi.fn(),
        completeSession: vi.fn(),
        createLocalSession: vi.fn(),
        deleteLocalSession: vi.fn(),
        readLocalMeta: vi.fn(),
    };
});

vi.mock("../../../extensions/recorder/lib/token-vault.js", () => ({
    readToken: vi.fn(async () => "op_recorder-key"),
}));
vi.mock("../../../extensions/recorder/lib/settings.js", () => ({
    getSettings: vi.fn(async () => ({
        dataUseAcknowledgedAt: "2026-10-13T00:00:00.000Z",
        serverUrl: "https://chatterbox.example",
        hasApiKey: true,
        serverDefaults: { encryptedRecordingProtocol: 1 },
    })),
    isPaired: vi.fn(async () => true),
    anyPlatformAuto: vi.fn(() => false),
    effectivePlatformModes: vi.fn(() => ({})),
    effectiveQuietSeconds: vi.fn(() => 30),
}));
vi.mock("../../../extensions/recorder/lib/chunk-store.js", () => ({
    createLocalSession: harness.createLocalSession,
    deleteLocalSession: harness.deleteLocalSession,
    listChunkIndices: vi.fn(async () => [0, 1]),
    listLocalSessions: vi.fn(async () => []),
    readChunk: vi.fn(async () => new Blob(["encrypted"])),
    readLocalMeta: harness.readLocalMeta,
    totalBufferedBytes: vi.fn(async () => 0),
}));
vi.mock("../../../extensions/recorder/lib/api.js", () => ({
    abortSession: vi.fn(),
    completeSession: harness.completeSession,
    createSession: vi.fn(),
    getSession: harness.getSession,
    recoverSession: vi.fn(),
    sha256Hex: vi.fn(async () => "0".repeat(64)),
    uploadChunk: harness.uploadChunk,
}));

import "../../../extensions/recorder/service-worker.js";

function httpError(status, code) {
    const error = new Error(`server said ${status}`);
    error.status = status;
    error.code = code;
    return error;
}

function retry() {
    return new Promise((resolve) => {
        harness.listeners.message({ type: "retry-upload" }, {}, resolve);
    });
}

beforeEach(() => {
    harness.sessionValues.recordingState = {
        state: "error",
        sessionId: "session-1",
        bufferId: "session-1",
        stopped: true,
        chunkCount: 2,
        uploaded: [0],
        blocked: false,
        stopReason: "user",
    };
    harness.uploadChunk.mockReset();
    harness.completeSession.mockReset().mockResolvedValue({ job_id: "job-1" });
    harness.getSession.mockReset().mockResolvedValue({
        id: "session-1",
        status: "open",
        received_chunks: [0],
    });
    harness.createLocalSession.mockReset();
    harness.deleteLocalSession.mockReset();
    harness.readLocalMeta.mockReset().mockResolvedValue({
        serverUrl: "https://chatterbox.example",
        retryAttempt: 0,
        nextRetryAt: null,
    });
    chrome.alarms.create.mockClear();
});

describe("recorder when the holder's access is withdrawn", () => {
    it("keeps the encrypted buffer, explains it, and finishes after a retry once access is back", async () => {
        harness.uploadChunk.mockRejectedValueOnce(
            httpError(403, "ACCESS_NOT_GRANTED"),
        );
        expect(await retry()).toEqual({ ok: true });
        expect(harness.sessionValues.recordingState).toMatchObject({
            state: "error",
            blocked: true,
            error: "accessWithdrawn",
            uploaded: [0],
        });
        expect(harness.deleteLocalSession).not.toHaveBeenCalled();
        expect(harness.completeSession).not.toHaveBeenCalled();

        harness.uploadChunk.mockResolvedValue(undefined);
        harness.getSession.mockResolvedValueOnce({
            id: "session-1",
            status: "open",
            received_chunks: [0],
        });
        harness.getSession.mockResolvedValue({
            id: "session-1",
            status: "completing",
        });
        expect(await retry()).toEqual({ ok: true });
        expect(harness.uploadChunk).toHaveBeenLastCalledWith(
            expect.anything(),
            "session-1",
            1,
            expect.anything(),
            expect.any(String),
        );
        expect(harness.completeSession).toHaveBeenCalledOnce();
        expect(harness.sessionValues.recordingState.uploaded).toEqual([0, 1]);
    });

    it("waits and retries by itself while the server cannot verify access", async () => {
        harness.uploadChunk.mockRejectedValueOnce(
            httpError(503, "ACCESS_UNVERIFIABLE"),
        );
        expect(await retry()).toEqual({ ok: true });
        expect(harness.sessionValues.recordingState).toMatchObject({
            blocked: false,
            uploadNotice: "accessUnverifiable",
        });
        expect(chrome.alarms.create).toHaveBeenCalled();
        expect(harness.createLocalSession).toHaveBeenCalledWith(
            "session-1",
            expect.objectContaining({ retryAttempt: 1 }),
        );
        expect(harness.deleteLocalSession).not.toHaveBeenCalled();
    });

    it("asks for a new pairing when the key itself is refused", async () => {
        harness.uploadChunk.mockRejectedValueOnce(
            httpError(401, "UNAUTHORIZED"),
        );
        await retry();
        expect(harness.sessionValues.recordingState).toMatchObject({
            state: "error",
            blocked: true,
            error: "keyRejected",
        });
        expect(harness.deleteLocalSession).not.toHaveBeenCalled();
    });
});
