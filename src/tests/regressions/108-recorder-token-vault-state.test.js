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
        readToken: vi.fn(),
        getSettings: vi.fn(),
        saveSettings: vi.fn(),
        listChunkIndices: vi.fn(),
        createSession: vi.fn(),
        completeSession: vi.fn(),
        createLocalSession: vi.fn(),
        getSession: vi.fn(),
        deleteLocalSession: vi.fn(),
    };
});

vi.mock("../../../extensions/recorder/lib/token-vault.js", () => ({
    readToken: harness.readToken,
}));
vi.mock("../../../extensions/recorder/lib/settings.js", () => ({
    getSettings: harness.getSettings,
    saveSettings: harness.saveSettings,
    isPaired: vi.fn(async () => true),
    anyPlatformAuto: vi.fn(() => false),
    effectivePlatformModes: vi.fn(() => ({})),
    effectiveQuietSeconds: vi.fn(() => 30),
}));

const defaultSettings = {
    dataUseAcknowledgedAt: "2026-10-13T00:00:00.000Z",
    serverUrl: "https://example.com",
    serverDefaults: { encryptedRecordingProtocol: 1 },
    folderId: null,
};
vi.mock("../../../extensions/recorder/lib/chunk-store.js", () => ({
    createLocalSession: harness.createLocalSession,
    deleteLocalSession: harness.deleteLocalSession,
    listChunkIndices: harness.listChunkIndices,
    listLocalSessions: vi.fn(async () => []),
    readChunk: vi.fn(),
    readLocalMeta: vi.fn(async () => null),
    totalBufferedBytes: vi.fn(async () => 0),
}));
vi.mock("../../../extensions/recorder/lib/api.js", () => ({
    abortSession: vi.fn(),
    completeSession: harness.completeSession,
    createSession: harness.createSession,
    getSession: harness.getSession,
    recoverSession: vi.fn(),
    sha256Hex: vi.fn(),
    uploadChunk: vi.fn(),
}));

import "../../../extensions/recorder/service-worker.js";

async function pickerMessage(type, error) {
    const url = chrome.windows.create.mock.calls.at(-1)[0].url;
    const requestId = new URL(url).searchParams.get("requestId");
    return new Promise((resolve) => {
        harness.listeners.message(
            { type, requestId, error },
            { url, tab: { windowId: 77 } },
            resolve,
        );
    });
}

beforeEach(() => {
    delete harness.sessionValues.recordingState;
    delete chrome.runtime.lastError;
    harness.readToken.mockReset();
    harness.getSettings.mockReset().mockResolvedValue(defaultSettings);
    harness.saveSettings.mockReset().mockResolvedValue(undefined);
    harness.listChunkIndices.mockReset().mockResolvedValue([]);
    harness.createSession.mockReset();
    harness.completeSession.mockReset();
    harness.createLocalSession.mockReset();
    harness.getSession.mockReset();
    harness.deleteLocalSession.mockReset();
    chrome.offscreen.createDocument.mockReset().mockResolvedValue(undefined);
    chrome.windows.create.mockReset();
    chrome.windows.create.mockResolvedValue({ id: 77 });
    chrome.windows.get.mockReset().mockResolvedValue({ id: 77 });
    chrome.windows.remove.mockReset().mockResolvedValue(undefined);
    chrome.windows.update.mockReset().mockResolvedValue(undefined);
    chrome.tabs.query.mockReset().mockResolvedValue([]);
    chrome.tabs.update.mockReset().mockResolvedValue(undefined);
    chrome.tabs.create.mockReset().mockResolvedValue(undefined);
    chrome.notifications.create.mockReset().mockResolvedValue("notice");
    chrome.alarms.create.mockReset().mockResolvedValue(undefined);
    chrome.runtime.sendMessage.mockReset().mockResolvedValue({ ok: true });
    chrome.tabCapture.getMediaStreamId.mockReset();
});

describe("recorder token-vault failures", () => {
    it("drops a rejected remembered folder and starts without it", async () => {
        harness.getSettings.mockImplementation(async () => ({
            ...defaultSettings,
            folderId: "folder-1",
        }));
        harness.readToken.mockResolvedValue("recorder-token");
        const rejected = new Error("This folder is unavailable");
        rejected.status = 400;
        rejected.field = "folderId";
        harness.createSession
            .mockRejectedValueOnce(rejected)
            .mockResolvedValueOnce({
                id: "session-folder-fallback",
                encryption: { protocol: 1, key: "capture-key" },
            });
        chrome.tabCapture.getMediaStreamId.mockImplementation(
            (_options, callback) => callback("stream-id"),
        );

        const response = await new Promise((resolve) => {
            harness.listeners.message(
                {
                    type: "start-recording",
                    payload: { tabId: 7, platformHint: "meet" },
                },
                {},
                resolve,
            );
        });

        expect(response).toEqual({
            ok: true,
            sessionId: "session-folder-fallback",
        });
        expect(harness.createSession).toHaveBeenCalledTimes(2);
        expect(harness.createSession.mock.calls[0][1]).toMatchObject({
            folderId: "folder-1",
        });
        expect(harness.createSession.mock.calls[1][1]).not.toHaveProperty(
            "folderId",
        );
        expect(harness.saveSettings).toHaveBeenCalledWith({
            folderId: null,
            folderLabel: null,
        });
    });

    it("shows an error when the folder fallback session also fails", async () => {
        harness.getSettings.mockImplementation(async () => ({
            ...defaultSettings,
            folderId: "folder-1",
        }));
        harness.readToken.mockResolvedValue("recorder-token");
        const rejected = new Error("This folder is unavailable");
        rejected.status = 400;
        rejected.field = "folderId";
        harness.createSession
            .mockRejectedValueOnce(rejected)
            .mockRejectedValueOnce(new Error("Fallback session failed"));

        await new Promise((resolve) => {
            harness.listeners.message(
                { type: "start-recording", payload: { tabId: 7 } },
                {},
                resolve,
            );
        });

        const response = await pickerMessage("desktop-capture-ready");

        expect(response).toEqual({
            ok: false,
            error: "Fallback session failed",
        });
        expect(harness.createSession).toHaveBeenCalledTimes(2);
        expect(harness.sessionValues.recordingState).toMatchObject({
            state: "error",
            error: "Fallback session failed",
        });
    });

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

    it("rejects a second start while the first is waiting for its token", async () => {
        let rejectFirst;
        harness.readToken.mockImplementationOnce(
            () =>
                new Promise((_, reject) => {
                    rejectFirst = reject;
                }),
        );
        const first = new Promise((resolve) => {
            harness.listeners.message(
                { type: "start-recording", payload: {} },
                {},
                resolve,
            );
        });
        await vi.waitFor(() =>
            expect(harness.readToken).toHaveBeenCalledTimes(1),
        );
        const second = await new Promise((resolve) => {
            harness.listeners.message(
                { type: "start-recording", payload: {} },
                {},
                resolve,
            );
        });

        expect(second).toEqual({ ok: false, error: "alreadyInProgress" });
        expect(harness.readToken).toHaveBeenCalledTimes(1);
        rejectFirst(new Error("Re-pair recorder"));
        expect(await first).toEqual({ ok: false, error: "Re-pair recorder" });
        expect(harness.sessionValues.recordingState).toBeUndefined();
    });

    it("discards an empty session when offscreen startup fails", async () => {
        harness.readToken.mockResolvedValue("recorder-token");
        harness.createSession.mockResolvedValue({
            id: "session-2",
            encryption: { protocol: 1, key: "capture-key" },
        });
        chrome.offscreen.createDocument.mockRejectedValue(
            new Error("Offscreen unavailable"),
        );
        const response = await new Promise((resolve) => {
            harness.listeners.message(
                {
                    type: "start-recording",
                    payload: { tabId: 7, platformHint: "meet" },
                },
                {},
                resolve,
            );
        });

        expect(response).toEqual({ ok: false, error: "Offscreen unavailable" });
        expect(harness.sessionValues.recordingState).toMatchObject({
            state: "error",
            sessionId: null,
            error: "Offscreen unavailable",
        });
    });

    it("opens an extension-owned picker window for desktop capture", async () => {
        harness.readToken.mockResolvedValue("recorder-token");

        const response = await new Promise((resolve) => {
            harness.listeners.message(
                { type: "start-recording", payload: { tabId: 7 } },
                {},
                resolve,
            );
        });

        expect(response).toEqual({ ok: true, pending: true });
        expect(chrome.windows.create).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "popup",
                url: expect.stringContaining(
                    "chrome-extension://test/picker/picker.html?requestId=",
                ),
            }),
        );
        expect(harness.createSession).not.toHaveBeenCalled();
        expect(harness.sessionValues.recordingState).toMatchObject({
            state: "awaiting-picker",
            captureMode: "desktop",
            captureWindowId: 77,
        });
    });

    it("handles a picker error from durable state after the start request has ended", async () => {
        harness.readToken.mockResolvedValue("recorder-token");
        await new Promise((resolve) => {
            harness.listeners.message(
                { type: "start-recording", payload: { tabId: 7 } },
                {},
                resolve,
            );
        });
        const response = await pickerMessage(
            "desktop-picker-error",
            "Picker unavailable",
        );

        expect(response).toEqual({ ok: true });
        expect(harness.createSession).not.toHaveBeenCalled();
        expect(harness.sessionValues.recordingState).toMatchObject({
            state: "error",
            error: "Picker unavailable",
        });
    });

    it("starts desktop capture after the page has already opened the stream", async () => {
        harness.readToken.mockResolvedValue("recorder-token");
        harness.createSession.mockResolvedValue({
            id: "desktop-session",
            encryption: { protocol: 1, key: "capture-key" },
        });
        await new Promise((resolve) => {
            harness.listeners.message(
                { type: "start-recording", payload: { tabId: 7 } },
                {},
                resolve,
            );
        });

        const response = await pickerMessage("desktop-capture-ready");

        expect(response).toEqual({ ok: true });
        expect(harness.createSession).toHaveBeenCalledOnce();
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                target: "desktop-recorder",
                type: "start",
                payload: expect.objectContaining({
                    sessionId: "desktop-session",
                    captureMode: "desktop",
                }),
            }),
        );
        expect(chrome.offscreen.createDocument).not.toHaveBeenCalled();
        expect(harness.sessionValues.recordingState).toMatchObject({
            state: "recording",
            sessionId: "desktop-session",
            captureWindowId: 77,
        });
    });

    it("keeps and focuses the desktop window while its recording is saved", async () => {
        harness.sessionValues.recordingState = {
            state: "recording",
            sessionId: "desktop-session",
            bufferId: "desktop-session",
            captureMode: "desktop",
            captureWindowId: 77,
            pickerRequestId: "request-1",
            stopped: false,
            chunkCount: 0,
            uploaded: [0],
            blocked: false,
            stopReason: "user",
        };
        harness.listChunkIndices.mockResolvedValue([0]);
        harness.readToken.mockResolvedValue("recorder-token");
        harness.completeSession.mockResolvedValue({ job_id: "job-1" });
        harness.getSession.mockResolvedValue({ status: "completing" });

        harness.listeners.message(
            {
                type: "recording-stopped",
                sessionId: "desktop-session",
                chunkCount: 1,
            },
            {},
            () => {},
        );

        await vi.waitFor(() =>
            expect(harness.sessionValues.recordingState).toMatchObject({
                state: "finalizing",
                stopped: true,
                chunkCount: 1,
                captureWindowId: 77,
            }),
        );
        expect(chrome.windows.update).toHaveBeenCalledWith(77, {
            state: "normal",
            focused: true,
        });
        expect(chrome.windows.remove).not.toHaveBeenCalled();
    });

    it("marks a failed desktop start before closing its window", async () => {
        harness.readToken.mockResolvedValue("recorder-token");
        harness.createSession.mockResolvedValue({
            id: "failed-desktop-session",
            encryption: { protocol: 1, key: "capture-key" },
        });
        harness.listChunkIndices.mockResolvedValue([0]);
        chrome.runtime.sendMessage.mockImplementation(async (message) =>
            message.target === "desktop-recorder" && message.type === "start"
                ? { ok: false, error: "Capture failed" }
                : { ok: true },
        );
        chrome.windows.remove.mockImplementation(async (windowId) => {
            expect(harness.sessionValues.recordingState).toMatchObject({
                state: "error",
                sessionId: "failed-desktop-session",
                stopped: true,
                blocked: true,
                captureWindowId: null,
            });
            await harness.listeners.windowRemoved(windowId);
        });
        await new Promise((resolve) => {
            harness.listeners.message(
                { type: "start-recording", payload: { tabId: 7 } },
                {},
                resolve,
            );
        });

        expect(await pickerMessage("desktop-capture-ready")).toEqual({
            ok: false,
            error: "Capture failed",
        });
        expect(chrome.windows.remove).toHaveBeenCalledWith(77);
        expect(harness.deleteLocalSession).not.toHaveBeenCalled();
        expect(harness.sessionValues.recordingState).toMatchObject({
            state: "error",
            sessionId: "failed-desktop-session",
            stopped: true,
            blocked: true,
            error: "Capture failed",
        });
    });

    it("clears the waiting state when the picker window closes", async () => {
        harness.readToken.mockResolvedValue("recorder-token");
        await new Promise((resolve) => {
            harness.listeners.message(
                { type: "start-recording", payload: { tabId: 7 } },
                {},
                resolve,
            );
        });
        await harness.listeners.windowRemoved(77);

        await vi.waitFor(() =>
            expect(harness.sessionValues.recordingState).toBeUndefined(),
        );
        expect(harness.createSession).not.toHaveBeenCalled();
    });

    it("clears a stale picker state when the worker missed the window-close event", async () => {
        harness.readToken.mockResolvedValue("recorder-token");
        await new Promise((resolve) => {
            harness.listeners.message(
                { type: "start-recording", payload: { tabId: 7 } },
                {},
                resolve,
            );
        });
        chrome.windows.get.mockRejectedValue(new Error("Window not found"));

        const response = await new Promise((resolve) => {
            harness.listeners.message({ type: "get-state" }, {}, resolve);
        });

        expect(response.state.state).toBe("idle");
        expect(harness.sessionValues.recordingState).toBeUndefined();
    });

    it("falls back to a desktop recorder window when tab capture is unavailable", async () => {
        harness.readToken.mockResolvedValue("recorder-token");
        harness.createSession.mockResolvedValue({
            id: "session-3",
            encryption: { protocol: 1, key: "capture-key" },
        });
        chrome.tabCapture.getMediaStreamId.mockImplementation(
            (_options, callback) => callback(null),
        );
        const response = await new Promise((resolve) => {
            harness.listeners.message(
                {
                    type: "start-recording",
                    payload: { tabId: 7, platformHint: "google-meet" },
                },
                {},
                resolve,
            );
        });

        expect(response).toEqual({ ok: true, pending: true });
        expect(harness.sessionValues.recordingState).toMatchObject({
            state: "awaiting-picker",
            sessionId: null,
            captureWindowId: 77,
        });
    });

    it("shows completion only after server storage and navigates the open app tab", async () => {
        vi.useFakeTimers();
        try {
            harness.sessionValues.recordingState = {
                state: "finalizing",
                sessionId: "session-4",
                bufferId: "session-4",
                tabId: 7,
                stopped: true,
                chunkCount: 2,
                uploaded: [0, 1],
                blocked: false,
                jobId: "job-4",
            };
            harness.readToken.mockResolvedValue("recorder-token");
            harness.getSession
                .mockResolvedValueOnce({ status: "completing" })
                .mockResolvedValueOnce({
                    status: "completed",
                    recording_id: "recording-4",
                });
            chrome.tabs.query.mockResolvedValue([
                { id: 3, url: "https://other.example/home", active: true },
                { id: 7, url: "https://example.com/settings", windowId: 9 },
            ]);

            const waiting = new Promise((resolve) => {
                harness.listeners.message(
                    { type: "check-finalization" },
                    {},
                    resolve,
                );
            });
            expect(await waiting).toEqual({ ok: true });
            expect(chrome.alarms.create).toHaveBeenCalledWith(
                expect.any(String),
                { delayInMinutes: 0.5 },
            );
            expect(harness.sessionValues.recordingState.state).toBe(
                "finalizing",
            );

            const finished = new Promise((resolve) => {
                harness.listeners.message(
                    { type: "check-finalization" },
                    {},
                    resolve,
                );
            });
            await vi.advanceTimersByTimeAsync(0);
            expect(harness.sessionValues.recordingState).toMatchObject({
                state: "completed",
                recordingUrl:
                    "https://example.com/dashboard?recording=recording-4",
                partial: false,
            });
            expect(harness.deleteLocalSession).toHaveBeenCalledWith(
                "session-4",
            );
            expect(chrome.tabs.update).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(3900);
            expect(await finished).toEqual({ ok: true });
            expect(chrome.tabs.update).toHaveBeenCalledWith(7, {
                url: "https://example.com/dashboard?recording=recording-4",
                active: true,
            });
            expect(harness.sessionValues.recordingState).toBeUndefined();
        } finally {
            vi.useRealTimers();
        }
    });

    it("keeps the buffer and never shows success when completion lacks a recording ID", async () => {
        harness.sessionValues.recordingState = {
            state: "finalizing",
            sessionId: "session-5",
            bufferId: "session-5",
            stopped: true,
            chunkCount: 1,
            uploaded: [0],
            blocked: false,
        };
        harness.readToken.mockResolvedValue("recorder-token");
        harness.getSession.mockResolvedValue({
            status: "completed",
            recording_id: null,
        });

        const response = await new Promise((resolve) => {
            harness.listeners.message({ type: "retry-upload" }, {}, resolve);
        });

        expect(response).toEqual({ ok: true });
        expect(harness.sessionValues.recordingState.state).toBe("error");
        expect(harness.deleteLocalSession).not.toHaveBeenCalled();
        expect(chrome.tabs.update).not.toHaveBeenCalled();
    });
});
