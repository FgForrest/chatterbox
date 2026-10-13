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
        },
        action: { onClicked: event("actionClicked") },
        commands: { onCommand: event("command") },
        alarms: { onAlarm: event("alarm") },
        notifications: { onClicked: event("notificationClicked") },
        tabs: {
            onUpdated: event("tabUpdated"),
            onRemoved: event("tabRemoved"),
        },
    };
    return {
        listeners,
        sessionValues,
        readToken: vi.fn(),
        listChunkIndices: vi.fn(),
    };
});

vi.mock("../../../extensions/recorder/lib/token-vault.js", () => ({
    readToken: harness.readToken,
}));
vi.mock("../../../extensions/recorder/lib/settings.js", () => ({
    getSettings: vi.fn(async () => ({
        dataUseAcknowledgedAt: "2026-10-13T00:00:00.000Z",
        serverUrl: "https://example.com",
    })),
    isPaired: vi.fn(async () => true),
    anyPlatformAuto: vi.fn(() => false),
    effectivePlatformModes: vi.fn(() => ({})),
    effectiveQuietSeconds: vi.fn(() => 30),
}));
vi.mock("../../../extensions/recorder/lib/chunk-store.js", () => ({
    createLocalSession: vi.fn(),
    deleteLocalSession: vi.fn(),
    listChunkIndices: harness.listChunkIndices,
    listLocalSessions: vi.fn(async () => []),
    readChunk: vi.fn(),
    readLocalMeta: vi.fn(async () => null),
    totalBufferedBytes: vi.fn(async () => 0),
}));

import "../../../extensions/recorder/service-worker.js";

beforeEach(() => {
    delete harness.sessionValues.recordingState;
    harness.readToken.mockReset();
    harness.listChunkIndices.mockReset().mockResolvedValue([]);
});

describe("recorder token-vault failures", () => {
    it("does not enter the picker when the token cannot be read", async () => {
        harness.readToken.mockRejectedValue(new Error("Re-pair recorder"));
        const response = await new Promise((resolve) => {
            harness.listeners.message(
                { type: "start-recording", payload: {} },
                {},
                resolve,
            );
        });

        expect(response).toEqual({ ok: false, error: "Re-pair recorder" });
        expect(harness.sessionValues.recordingState).toBeUndefined();
    });

    it("leaves finalizing and exposes the vault error", async () => {
        harness.sessionValues.recordingState = {
            state: "recording",
            sessionId: "session-1",
            bufferId: "session-1",
            tabId: null,
            stopped: false,
            chunkCount: 0,
            uploaded: [0],
            blocked: false,
            stopReason: "user",
        };
        harness.readToken
            .mockResolvedValueOnce("recorder-token")
            .mockRejectedValueOnce(new Error("Re-pair recorder"));

        harness.listeners.message(
            {
                type: "recording-stopped",
                sessionId: "session-1",
                chunkCount: 1,
            },
            {},
            () => {},
        );

        await vi.waitFor(() => {
            expect(harness.sessionValues.recordingState).toMatchObject({
                state: "error",
                stopped: true,
                error: "Re-pair recorder",
            });
        });
    });
});
