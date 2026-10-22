import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    clearPairing,
    refreshServerConfig,
} from "../../../extensions/recorder/lib/pairing.js";
import { createRecorderExtensionClient } from "../../lib/recorder-extension/client";

const harness = vi.hoisted(() => {
    const listeners = {};
    const sessionValues = {};
    const localMetas = new Map();
    const event = (name) => ({
        addListener: vi.fn((listener) => {
            listeners[name] = listener;
        }),
    });
    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {
            permissions: { query: vi.fn(async () => ({ state: "granted" })) },
        },
    });
    globalThis.chrome = {
        i18n: { getMessage: (key) => key },
        storage: {
            local: {
                get: vi.fn(async () => ({ installationId: "installation-1" })),
                remove: vi.fn(async () => {}),
                set: vi.fn(async () => {}),
                setAccessLevel: vi.fn(async () => {}),
            },
            session: {
                get: vi.fn(async (key) => ({ [key]: sessionValues[key] })),
                set: vi.fn(async (values) =>
                    Object.assign(sessionValues, values),
                ),
                remove: vi.fn(async (key) => {
                    for (const entry of [key].flat())
                        delete sessionValues[entry];
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
            setPopup: vi.fn(async () => {}),
            setTitle: vi.fn(async () => {}),
            setBadgeText: vi.fn(async () => {}),
            setBadgeBackgroundColor: vi.fn(async () => {}),
        },
        commands: { onCommand: event("command") },
        alarms: {
            get: vi.fn(async () => null),
            clear: vi.fn(async () => {}),
            onAlarm: event("alarm"),
            create: vi.fn(async () => {}),
        },
        permissions: {
            onAdded: event("permissionsAdded"),
            onRemoved: event("permissionsRemoved"),
            contains: vi.fn(async () => true),
        },
        scripting: {
            getRegisteredContentScripts: vi.fn(async () => []),
            unregisterContentScripts: vi.fn(async () => {}),
            registerContentScripts: vi.fn(async () => {}),
            updateContentScripts: vi.fn(async () => {}),
            executeScript: vi.fn(async () => {}),
        },
        notifications: {
            onButtonClicked: event("notificationButton"),
            onClicked: event("notificationClicked"),
            clear: vi.fn(async () => {}),
            create: vi.fn(async () => "notice"),
        },
        offscreen: {
            createDocument: vi.fn(async () => {}),
            closeDocument: vi.fn(async () => {}),
        },
        tabCapture: { getMediaStreamId: vi.fn() },
        windows: {
            getLastFocused: vi.fn(async () => ({
                left: 0,
                top: 0,
                width: 1200,
                height: 900,
            })),
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
        localMetas,
        readLocalMeta: vi.fn(async (id) => localMetas.get(id) ?? null),
        listLocalSessions: vi.fn(async () => [...localMetas.keys()]),
        recoverSession: vi.fn(),
        readToken: vi.fn(),
        getSettings: vi.fn(),
        platformModes: vi.fn(() => ({})),
        saveSettings: vi.fn(),
        listChunkIndices: vi.fn(),
        getRecorderConfig: vi.fn(),
        createSession: vi.fn(),
        completeSession: vi.fn(),
        createLocalSession: vi.fn(),
        getSession: vi.fn(),
        deleteLocalSession: vi.fn(),
    };
});

vi.mock("../../../extensions/recorder/lib/token-vault.js", () => ({
    readToken: harness.readToken,
    clearToken: vi.fn(async () => {}),
}));
vi.mock("../../../extensions/recorder/lib/settings.js", () => ({
    getSettings: harness.getSettings,
    saveSettings: harness.saveSettings,
    isPaired: vi.fn(async () => true),
    anyPlatformAuto: vi.fn(() => false),
    effectiveNoticeText: vi.fn(() => "Inform participants."),
    effectivePlatformModes: harness.platformModes,
    effectiveQuietSeconds: vi.fn(() => 30),
}));

const defaultSettings = {
    dataUseAcknowledgedAt: "2026-10-13T00:00:00.000Z",
    serverUrl: "https://example.com",
    hasApiKey: true,
    serverDefaults: { encryptedRecordingProtocol: 1 },
    folderId: null,
};
vi.mock("../../../extensions/recorder/lib/chunk-store.js", () => ({
    createLocalSession: harness.createLocalSession,
    deleteLocalSession: harness.deleteLocalSession,
    listChunkIndices: harness.listChunkIndices,
    listLocalSessions: harness.listLocalSessions,
    readChunk: vi.fn(),
    readLocalMeta: harness.readLocalMeta,
    totalBufferedBytes: vi.fn(async () => 0),
}));
vi.mock("../../../extensions/recorder/lib/api.js", () => ({
    abortSession: vi.fn(async () => {}),
    getRecorderConfig: harness.getRecorderConfig,
    completeSession: harness.completeSession,
    createSession: harness.createSession,
    getSession: harness.getSession,
    recoverSession: harness.recoverSession,
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
    navigator.permissions.query.mockResolvedValue({ state: "granted" });
    for (const key of Object.keys(harness.sessionValues))
        delete harness.sessionValues[key];
    chrome.scripting.getRegisteredContentScripts
        .mockReset()
        .mockResolvedValue([]);
    chrome.scripting.unregisterContentScripts.mockClear();
    chrome.permissions.contains.mockReset().mockResolvedValue(true);
    chrome.action.setBadgeText.mockClear();
    delete harness.sessionValues.recorderStartRequest;
    delete harness.sessionValues.armedTabs;
    harness.platformModes.mockReset().mockReturnValue({});
    chrome.tabs.get.mockReset().mockImplementation(async (id) => ({
        id,
        url: "http://localhost:3555",
    }));
    delete harness.sessionValues.recordingState;
    delete chrome.runtime.lastError;
    harness.readToken.mockReset();
    harness.getSettings.mockReset().mockResolvedValue(defaultSettings);
    harness.saveSettings.mockReset().mockResolvedValue(undefined);
    harness.listChunkIndices.mockReset().mockResolvedValue([]);
    harness.getRecorderConfig.mockReset();
    chrome.storage.local.set.mockClear();
    harness.createSession.mockReset();
    harness.completeSession.mockReset();
    harness.localMetas.clear();
    harness.listLocalSessions
        .mockReset()
        .mockImplementation(async () => [...harness.localMetas.keys()]);
    harness.readLocalMeta
        .mockReset()
        .mockImplementation(async (id) => harness.localMetas.get(id) ?? null);
    harness.recoverSession.mockReset();
    harness.createLocalSession
        .mockReset()
        .mockImplementation(async (id, meta) =>
            harness.localMetas.set(id, meta),
        );
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
                    payload: {
                        noticeAcknowledgedAt: "2026-10-19T00:00:00Z",
                        tabId: 7,
                        platformHint: "meet",
                    },
                },
                { url: "chrome-extension://test/popup/popup.html" },
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
                {
                    type: "start-recording",
                    payload: {
                        noticeAcknowledgedAt: "2026-10-19T00:00:00Z",
                        tabId: 7,
                        forceDesktop: true,
                    },
                },
                { url: "chrome-extension://test/popup/popup.html" },
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
                { url: "chrome-extension://test/popup/popup.html" },
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
                { url: "chrome-extension://test/popup/popup.html" },
                resolve,
            );
        });
        await vi.waitFor(() =>
            expect(harness.readToken).toHaveBeenCalledTimes(1),
        );
        const second = await new Promise((resolve) => {
            harness.listeners.message(
                { type: "start-recording", payload: {} },
                { url: "chrome-extension://test/popup/popup.html" },
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
                    payload: {
                        noticeAcknowledgedAt: "2026-10-19T00:00:00Z",
                        tabId: 7,
                        platformHint: "meet",
                    },
                },
                { url: "chrome-extension://test/popup/popup.html" },
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
                {
                    type: "start-recording",
                    payload: {
                        noticeAcknowledgedAt: "2026-10-19T00:00:00Z",
                        tabId: 7,
                        forceDesktop: true,
                    },
                },
                { url: "chrome-extension://test/popup/popup.html" },
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
                {
                    type: "start-recording",
                    payload: {
                        noticeAcknowledgedAt: "2026-10-19T00:00:00Z",
                        tabId: 7,
                        forceDesktop: true,
                    },
                },
                { url: "chrome-extension://test/popup/popup.html" },
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
                {
                    type: "start-recording",
                    payload: {
                        noticeAcknowledgedAt: "2026-10-19T00:00:00Z",
                        tabId: 7,
                        forceDesktop: true,
                    },
                },
                { url: "chrome-extension://test/popup/popup.html" },
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
                {
                    type: "start-recording",
                    payload: {
                        noticeAcknowledgedAt: "2026-10-19T00:00:00Z",
                        tabId: 7,
                        forceDesktop: true,
                    },
                },
                { url: "chrome-extension://test/popup/popup.html" },
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
                {
                    type: "start-recording",
                    payload: {
                        noticeAcknowledgedAt: "2026-10-19T00:00:00Z",
                        tabId: 7,
                        forceDesktop: true,
                    },
                },
                { url: "chrome-extension://test/popup/popup.html" },
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
                {
                    type: "start-recording",
                    payload: {
                        noticeAcknowledgedAt: "2026-10-19T00:00:00Z",
                        tabId: 7,
                        forceDesktop: true,
                    },
                },
                { url: "chrome-extension://test/popup/popup.html" },
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
                    payload: {
                        noticeAcknowledgedAt: "2026-10-19T00:00:00Z",
                        tabId: 7,
                        platformHint: "google-meet",
                    },
                },
                { url: "chrome-extension://test/popup/popup.html" },
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
                    { url: "chrome-extension://test/popup/popup.html" },
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
                    { url: "chrome-extension://test/popup/popup.html" },
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

function message(
    input,
    sender = { url: "chrome-extension://test/popup/popup.html" },
) {
    return new Promise((resolve) =>
        harness.listeners.message(input, sender, resolve),
    );
}

async function requestStart() {
    navigator.permissions.query.mockResolvedValue({ state: "prompt" });
    harness.readToken.mockResolvedValue("recorder-token");
    expect(
        await message({
            type: "start-recording",
            payload: {
                tabId: 7,
                platformHint: "google-meet",
                noticeAcknowledgedAt: "2026-10-19T00:00:00Z",
            },
        }),
    ).toEqual({ ok: true, pending: true });
    return harness.sessionValues.recorderStartRequest;
}

async function resumeRequest(request, withoutMicrophone = false) {
    return message(
        { type: "resume-recording", requestId: request.id, withoutMicrophone },
        {
            url: `chrome-extension://test/request/request.html?requestId=${request.id}`,
            tab: { windowId: 77 },
        },
    );
}

describe("microphone start gate", () => {
    it("opens a visible request before creating any server session and resumes after grant", async () => {
        const request = await requestStart();
        expect(chrome.windows.create).toHaveBeenCalledWith(
            expect.objectContaining({
                url: expect.stringContaining(
                    "/request/request.html?requestId=",
                ),
            }),
        );
        expect(harness.createSession).not.toHaveBeenCalled();
        expect(chrome.tabCapture.getMediaStreamId).not.toHaveBeenCalled();
        navigator.permissions.query.mockResolvedValue({ state: "granted" });
        expect(await resumeRequest(request)).toEqual({
            ok: true,
            pending: true,
        });
        expect(chrome.windows.create).toHaveBeenLastCalledWith(
            expect.objectContaining({
                url: expect.stringContaining("/picker/picker.html?requestId="),
            }),
        );
        harness.createSession.mockResolvedValue({
            id: "mic-session",
            encryption: { protocol: 1, key: "capture-key" },
        });
        expect(await pickerMessage("desktop-capture-ready")).toEqual({
            ok: true,
        });
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                target: "desktop-recorder",
                type: "start",
                payload: expect.objectContaining({ withoutMicrophone: false }),
            }),
        );
    });

    it("requires an explicit choice before recording without a microphone", async () => {
        const request = await requestStart();
        expect(await resumeRequest(request)).toEqual({
            ok: false,
            error: "micWarning",
        });
        expect(await resumeRequest(request, true)).toEqual({
            ok: true,
            pending: true,
        });
        harness.createSession.mockResolvedValue({
            id: "no-mic-session",
            encryption: { protocol: 1, key: "capture-key" },
        });
        expect(await pickerMessage("desktop-capture-ready")).toEqual({
            ok: true,
        });
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                target: "desktop-recorder",
                type: "start",
                payload: expect.objectContaining({ withoutMicrophone: true }),
            }),
        );
    });

    it("refuses an unrelated page or a navigated meeting tab when resuming", async () => {
        const request = await requestStart();
        expect(
            (
                await message(
                    {
                        type: "resume-recording",
                        requestId: request.id,
                        withoutMicrophone: true,
                    },
                    { url: "https://attacker.example", tab: { windowId: 77 } },
                )
            ).ok,
        ).toBe(false);
        chrome.tabs.get.mockResolvedValue({
            id: 7,
            url: "https://attacker.example",
        });
        expect((await resumeRequest(request, true)).ok).toBe(false);
    });

    it("includes the live microphone permission in both ping channels", async () => {
        navigator.permissions.query.mockResolvedValue({ state: "denied" });
        expect(await message({ type: "riffado-recorder-ping" })).toMatchObject({
            micPermission: "denied",
            installed: true,
            channel: "content",
        });
        const reply = await new Promise((resolve) =>
            harness.listeners.externalMessage(
                { type: "riffado-recorder-ping" },
                { url: "http://localhost" },
                resolve,
            ),
        );
        expect(reply).toMatchObject({
            micPermission: "denied",
            channel: "external",
        });
    });

    it("rejects pairing before consent on both channels", async () => {
        harness.getSettings.mockResolvedValue({
            ...defaultSettings,
            dataUseAcknowledgedAt: null,
        });
        const pair = {
            type: "riffado-recorder-pair",
            serverUrl: "https://example.com",
            apiKey: "op_test",
        };
        expect(await message(pair, { url: "https://example.com" })).toEqual({
            ok: false,
            error: "dataUseRequired",
        });
        const reply = await new Promise((resolve) =>
            harness.listeners.externalMessage(
                pair,
                { url: "https://example.com" },
                resolve,
            ),
        );
        expect(reply).toEqual({ ok: false, error: "dataUseRequired" });
        expect(harness.sessionValues.pendingPairing).toBeUndefined();
    });
});

describe("meeting notification actions", () => {
    async function detectMeeting() {
        harness.getSettings.mockResolvedValue({
            ...defaultSettings,
            nudgeEnabled: true,
        });
        harness.platformModes.mockReturnValue({
            "google-meet": { mode: "prompt" },
        });
        const tab = {
            id: 7,
            url: "https://meet.google.com/abc-defg-hij",
            audible: true,
        };
        chrome.tabs.get.mockResolvedValue(tab);
        await harness.listeners.tabUpdated(7, { status: "complete" }, tab);
        return tab;
    }

    it("offers Record with consent and Not now; Record opens Chrome's sharing dialog", async () => {
        await detectMeeting();
        expect(chrome.notifications.create).toHaveBeenCalledWith(
            "nudge:7",
            expect.objectContaining({
                title: "meetingRecordQuestion",
                contextMessage: expect.any(String),
                buttons: [{ title: "recordWithConsent" }, { title: "notNow" }],
            }),
        );
        harness.readToken.mockResolvedValue("recorder-token");
        harness.listeners.notificationButton("nudge:7", 0);
        await vi.waitFor(() =>
            expect(chrome.windows.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    url: expect.stringContaining(
                        "/picker/picker.html?requestId=",
                    ),
                }),
            ),
        );
        expect(harness.sessionValues.recordingState).toMatchObject({
            state: "awaiting-picker",
            captureMode: "desktop",
            tabId: 7,
            noticeAcknowledgedAt: expect.any(String),
        });
        expect(harness.sessionValues.recorderStartRequest).toBeUndefined();
        expect(harness.createSession).not.toHaveBeenCalled();
    });

    it("Record with the mic not yet allowed opens the microphone step with consent given", async () => {
        await detectMeeting();
        navigator.permissions.query.mockResolvedValue({ state: "prompt" });
        harness.readToken.mockResolvedValue("recorder-token");
        harness.listeners.notificationButton("nudge:7", 0);
        await vi.waitFor(() =>
            expect(harness.sessionValues.recorderStartRequest).toBeDefined(),
        );
        const request = harness.sessionValues.recorderStartRequest;
        expect(request.input).toMatchObject({
            tabId: 7,
            platformHint: "google-meet",
            noticeAcknowledgedAt: expect.any(String),
        });
        expect(harness.createSession).not.toHaveBeenCalled();
    });

    it("Not now suppresses further prompts for this tab", async () => {
        const tab = await detectMeeting();
        chrome.notifications.create.mockClear();
        harness.listeners.notificationButton("nudge:7", 1);
        await vi.waitFor(() =>
            expect(harness.sessionValues.armedTabs[7].nudged).toBe(true),
        );
        await harness.listeners.tabUpdated(7, { status: "complete" }, tab);
        await harness.listeners.tabUpdated(7, { audible: true }, tab);
        expect(chrome.notifications.create).not.toHaveBeenCalled();
        expect(chrome.windows.create).not.toHaveBeenCalled();
    });
});

describe("Chrome site access event", () => {
    it("registers and injects on permissions.onAdded without toolbar invocation", async () => {
        chrome.tabs.query.mockResolvedValue([
            { id: 7, url: "https://example.com/dashboard" },
        ]);
        chrome.scripting.registerContentScripts.mockClear();
        chrome.scripting.executeScript.mockClear();
        harness.listeners.permissionsAdded({
            origins: ["https://example.com/*"],
        });
        await vi.waitFor(() =>
            expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
                target: { tabId: 7 },
                files: ["content-pairing.js"],
            }),
        );
        expect(chrome.scripting.registerContentScripts).toHaveBeenCalledWith([
            expect.objectContaining({ matches: ["https://example.com/*"] }),
        ]);
    });
});

describe("review recording lifecycle fixes", () => {
    it.each([
        "unavailable",
        "unknown",
    ])("accepts a recent page grant when the worker permission query is %s", async (state) => {
        const request = await requestStart();
        if (state === "unavailable")
            navigator.permissions.query.mockRejectedValue(
                new Error("Unavailable in worker"),
            );
        else
            navigator.permissions.query.mockResolvedValue({ state: "unknown" });
        expect(await resumeRequest(request)).toMatchObject({
            ok: false,
            error: "micWarning",
        });
        harness.sessionValues.microphoneGrantAt = Date.now();
        expect(await resumeRequest(request)).toMatchObject({ ok: true });
        expect(harness.sessionValues.recordingState.withoutMicrophone).toBe(
            false,
        );
    });
    it.each([
        "expired",
        "denied",
        "prompt",
    ])("does not accept a page marker when %s", async (reason) => {
        const request = await requestStart();
        harness.sessionValues.microphoneGrantAt =
            Date.now() - (reason === "expired" ? 6 * 60 * 1000 : 0);
        if (reason === "expired")
            navigator.permissions.query.mockRejectedValue(new Error("worker"));
        else navigator.permissions.query.mockResolvedValue({ state: reason });
        expect(await resumeRequest(request)).toMatchObject({
            ok: false,
            error: "micWarning",
        });
    });
    it.each([
        [
            "https://app.zoom.us/wc/123/join?pwd=SECRET",
            "https://app.zoom.us/wc/123/start?pwd=SECRET",
        ],
        [
            "https://teams.microsoft.com/meet/123?prejoin=true",
            "https://teams.microsoft.com/meet/123?joined=true",
        ],
    ])("resumes after joining the same meeting: %s", async (before, after) => {
        chrome.tabs.get.mockResolvedValue({ id: 7, url: before });
        const request = await requestStart();
        chrome.tabs.get.mockResolvedValue({ id: 7, url: after });
        expect(await resumeRequest(request, true)).toMatchObject({ ok: true });
    });
    it("localizes a closed meeting tab", async () => {
        const request = await requestStart();
        chrome.tabs.get.mockRejectedValue(new Error("No tab with id: 7"));
        expect(await resumeRequest(request, true)).toEqual({
            ok: false,
            error: "meetingTabClosed",
        });
    });
    it("keeps a failed start request retryable until it succeeds", async () => {
        const request = await requestStart();
        chrome.windows.create.mockRejectedValueOnce(
            new Error("Temporary failure"),
        );
        expect(await resumeRequest(request, true)).toEqual({
            ok: false,
            error: "Temporary failure",
        });
        expect(harness.sessionValues.recorderStartRequest).toEqual(request);
        expect(await resumeRequest(request, true)).toMatchObject({ ok: true });
        expect(harness.sessionValues.recorderStartRequest).toBeUndefined();
    });
    it("keeps the mic gate for auto invocation", async () => {
        navigator.permissions.query.mockResolvedValue({ state: "prompt" });
        harness.getSettings.mockResolvedValue({
            ...defaultSettings,
            autoModeAcknowledgedAt: "2026-10-19T00:00:00Z",
        });
        harness.readToken.mockResolvedValue("token");
        harness.listeners.actionClicked({
            id: 7,
            url: "https://meet.google.com/abc-defg-hij",
        });
        await vi.waitFor(() =>
            expect(harness.sessionValues.recorderStartRequest).toBeDefined(),
        );
        expect(harness.sessionValues.recorderStartRequest.input.auto).toBe(
            true,
        );
        expect(harness.createSession).not.toHaveBeenCalled();
    });
    it("omits micPermission and installationId before consent on both ping channels", async () => {
        harness.getSettings.mockResolvedValue({
            ...defaultSettings,
            dataUseAcknowledgedAt: null,
        });
        expect(await message({ type: "riffado-recorder-ping" })).toMatchObject({
            micPermission: undefined,
            installationId: undefined,
        });
        const reply = await new Promise((resolve) =>
            harness.listeners.externalMessage(
                { type: "riffado-recorder-ping" },
                { url: "http://localhost" },
                resolve,
            ),
        );
        expect(reply.micPermission).toBeUndefined();
        expect(reply.installationId).toBeUndefined();
    });
    it("blocks presence details and proposals from unrelated or stale relays", async () => {
        const sender = { url: "https://unrelated.example/", tab: { id: 7 } };
        expect(
            await message({ type: "riffado-recorder-ping" }, sender),
        ).toEqual({ installed: true, unreachable: true, channel: "content" });
        expect(
            await message(
                {
                    type: "riffado-recorder-pair",
                    serverUrl: "https://unrelated.example",
                    apiKey: "key",
                },
                sender,
            ),
        ).toEqual({ ok: false, error: "serverAccessDenied" });
        chrome.permissions.contains.mockResolvedValue(false);
        expect(
            await message(
                { type: "riffado-recorder-ping" },
                { url: "https://example.com" },
            ),
        ).toEqual({ installed: true, unreachable: true, channel: "content" });
    });
    it("persists a named microphone failure and requests a persistent notification", async () => {
        harness.sessionValues.recordingState = {
            state: "recording",
            sessionId: "mic-fail",
            tabId: 7,
        };
        harness.listeners.message(
            {
                type: "mic-unavailable",
                sessionId: "mic-fail",
                errorName: "NotReadableError",
            },
            {},
            () => {},
        );
        await vi.waitFor(() =>
            expect(harness.sessionValues.recordingState.micWarning).toBe(
                "micUnavailableBody",
            ),
        );
        expect(chrome.notifications.create).toHaveBeenCalledWith(
            "mic:mic-fail",
            expect.objectContaining({
                requireInteraction: true,
                message: "micUnavailableBody",
            }),
        );
        expect(harness.sessionValues.recordingState.state).toBe("recording");
    });
});

describe("relay ping availability", () => {
    const origin = "https://example.com";
    const sender = { url: `${origin}/dashboard`, tab: { id: 7 } };
    const ping = { type: "riffado-recorder-ping" };

    it.each([
        "disconnect",
        "expired setup",
    ])("detects installed-unreachable and offers no pairing after %s", async (reason) => {
        vi.useFakeTimers();
        try {
            const disconnected = {
                ...defaultSettings,
                serverUrl: "",
                hasApiKey: false,
            };
            if (reason === "expired setup")
                harness.getSettings.mockResolvedValue(disconnected);
            chrome.tabs.get.mockResolvedValue({ id: 7, url: sender.url });
            harness.sessionValues.recorderSetupFlow = {
                origin,
                tabId: 7,
                createdAt: Date.now(),
            };
            expect(await message(ping, sender)).toMatchObject({
                installed: true,
                installationId: "installation-1",
            });
            if (reason === "disconnect") {
                chrome.storage.local.remove.mockImplementationOnce(async () => {
                    harness.getSettings.mockResolvedValue(disconnected);
                });
                await clearPairing();
                expect(harness.sessionValues.recorderSetupFlow).toBeUndefined();
            } else {
                harness.getSettings.mockResolvedValue(disconnected);
                harness.sessionValues.recorderSetupFlow.createdAt -=
                    15 * 60 * 1000;
            }
            expect(await message(ping, sender)).toEqual({
                installed: true,
                unreachable: true,
                channel: "content",
            });
            let listener;
            const postMessage = vi.fn((input) => {
                void message(input, sender).then((reply) =>
                    listener({
                        origin,
                        data: { type: "riffado-recorder-present", ...reply },
                    }),
                );
            });
            const client = createRecorderExtensionClient({
                origin,
                postMessage,
                addMessageListener(callback) {
                    listener = callback;
                    return () => {};
                },
                probeImage: async () => true,
            });
            expect(await client.detect("test")).toEqual({
                kind: "installed-unreachable",
            });
            expect(postMessage).toHaveBeenCalledExactlyOnceWith(ping, origin);
            expect(harness.sessionValues.pendingPairing).toBeUndefined();
        } finally {
            vi.clearAllTimers();
            vi.useRealTimers();
        }
    });

    it.each([
        {},
        { url: "about:blank" },
        { url: "file:///tmp/page.html" },
        { url: "chrome-extension://other/popup/popup.html" },
        { url: "chrome-extension://test.evil/popup/popup.html" },
        { url: "malformed" },
    ])("withholds presence details from an unrecognized non-web sender: %j", async (sender) => {
        expect(await message(ping, sender)).toEqual({
            installed: true,
            unreachable: true,
            channel: "content",
        });
    });

    it("allows the extension's own pages", async () => {
        expect(
            await message(ping, {
                url: chrome.runtime.getURL("options/options.html"),
            }),
        ).toMatchObject({
            installed: true,
            installationId: "installation-1",
            micPermission: "granted",
        });
    });
});

describe("badge and notification review", () => {
    const meeting = {
        id: 7,
        windowId: 3,
        url: "https://meet.google.com/abc-defg-hij",
        audible: false,
    };
    it("shows no microphone badge before consent", async () => {
        navigator.permissions.query.mockResolvedValue({ state: "prompt" });
        harness.getSettings.mockResolvedValue({
            ...defaultSettings,
            dataUseAcknowledgedAt: null,
        });
        await harness.listeners.tabUpdated(7, { status: "complete" }, meeting);
        expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({
            tabId: 7,
            text: "",
        });
        expect(chrome.action.setBadgeText).not.toHaveBeenCalledWith(
            expect.objectContaining({ text: "MIC!" }),
        );
    });
    it("keeps REC? on armed meeting tabs even without a mic", async () => {
        navigator.permissions.query.mockResolvedValue({ state: "prompt" });
        harness.platformModes.mockReturnValue({
            "google-meet": { mode: "prompt" },
        });
        await harness.listeners.tabUpdated(7, { status: "complete" }, meeting);
        expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({
            tabId: 7,
            text: "REC?",
        });
        expect(chrome.action.setBadgeText).not.toHaveBeenCalledWith(
            expect.objectContaining({ text: "MIC!" }),
        );
    });
    it.each([
        false,
        true,
    ])("honors persisted reminder dismissal=%s on ordinary tabs", async (dismissed) => {
        navigator.permissions.query.mockResolvedValue({ state: "prompt" });
        harness.getSettings.mockResolvedValue({
            ...defaultSettings,
            micReminderDismissed: dismissed,
        });
        await harness.listeners.tabUpdated(
            7,
            { status: "complete" },
            { ...meeting, url: "https://other.example" },
        );
        expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({
            tabId: 7,
            text: dismissed ? "" : "MIC!",
        });
    });
    it("preserves a recording badge during reevaluation", async () => {
        harness.sessionValues.recordingState = {
            state: "finalizing",
            tabId: 7,
        };
        await harness.listeners.tabUpdated(7, { status: "complete" }, meeting);
        expect(chrome.action.setBadgeText).not.toHaveBeenCalled();
    });
    it("focuses the meeting on notification body click without opening a recording window", async () => {
        chrome.tabs.get.mockResolvedValue(meeting);
        await harness.listeners.notificationClicked("nudge:7");
        expect(chrome.tabs.update).toHaveBeenCalledWith(7, { active: true });
        expect(chrome.windows.update).toHaveBeenCalledWith(3, {
            focused: true,
        });
        expect(chrome.windows.create).not.toHaveBeenCalled();
        expect(harness.sessionValues.recorderStartRequest).toBeUndefined();
    });
});

describe("restricted Chrome site access events", () => {
    it.each([
        "https://*/*",
        "https://*.example.com/*",
        "https://unrelated.example/*",
    ])("ignores %s without querying unrelated tabs", async (pattern) => {
        chrome.scripting.registerContentScripts.mockClear();
        chrome.scripting.executeScript.mockClear();
        await harness.listeners.permissionsAdded({ origins: [pattern] });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(chrome.scripting.registerContentScripts).not.toHaveBeenCalled();
        expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
        expect(chrome.tabs.query).not.toHaveBeenCalled();
    });
    it("unregisters relays when host access is removed", async () => {
        chrome.permissions.contains.mockResolvedValue(false);
        chrome.scripting.getRegisteredContentScripts.mockResolvedValue([
            { id: "riffado-pairing-https", matches: ["https://example.com/*"] },
        ]);
        harness.listeners.permissionsRemoved({
            origins: ["https://example.com/*"],
        });
        await vi.waitFor(() =>
            expect(
                chrome.scripting.unregisterContentScripts,
            ).toHaveBeenCalledWith({ ids: ["riffado-pairing-https"] }),
        );
    });
});

describe("recorder 0.6.0 tab and folder targets", () => {
    async function start(payload = {}) {
        harness.readToken.mockResolvedValue("recorder-token");
        harness.createSession.mockResolvedValue({
            id: "target-session",
            encryption: { protocol: 1, key: "capture-key" },
        });
        chrome.tabCapture.getMediaStreamId.mockImplementation(
            (_options, callback) => callback("stream-id"),
        );
        return message({
            type: "start-recording",
            payload: {
                tabId: 7,
                noticeAcknowledgedAt: "2026-10-19T00:00:00Z",
                ...payload,
            },
        });
    }

    function enableFolders() {
        harness.getSettings.mockResolvedValue({
            ...defaultSettings,
            folderId: "start",
            folderLabel: "Private / Start",
            serverDefaults: {
                encryptedRecordingProtocol: 1,
                recordingFolderOverride: true,
            },
        });
    }

    async function finish() {
        harness.listChunkIndices.mockResolvedValue([0]);
        harness.completeSession.mockResolvedValue({ job_id: "job-1" });
        harness.getSession.mockResolvedValue({ status: "completing" });
        harness.sessionValues.recordingState.uploaded = [0];
        harness.listeners.message(
            {
                type: "recording-stopped",
                sessionId: harness.sessionValues.recordingState.sessionId,
                chunkCount: 1,
            },
            {},
            () => {},
        );
        await vi.waitFor(() =>
            expect(harness.sessionValues.recordingState).toMatchObject({
                state: "finalizing",
                jobId: "job-1",
            }),
        );
    }

    it("captures a popup tab without a platform, ignores meeting end and silence, and stops when the tab closes", async () => {
        expect(await start({ auto: true })).toEqual({
            ok: true,
            sessionId: "target-session",
        });
        expect(chrome.tabCapture.getMediaStreamId).toHaveBeenCalledWith(
            { targetTabId: 7 },
            expect.any(Function),
        );
        expect(harness.sessionValues.recordingState).toMatchObject({
            captureMode: "tab",
            platformHint: null,
            autoStarted: false,
        });
        await harness.listeners.tabUpdated(
            7,
            { url: "https://example.test/next", audible: false },
            { id: 7, url: "https://example.test/next" },
        );
        expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ target: "offscreen", type: "stop" }),
        );
        await harness.listeners.tabRemoved(7);
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
            target: "offscreen",
            type: "stop",
            payload: undefined,
        });
        expect(harness.sessionValues.recordingState.stopReason).toBe(
            "tab-closed",
        );
    });

    it("rejects starts from other extension pages even if they claim to be a popup", async () => {
        expect(
            await message(
                {
                    type: "start-recording",
                    payload: { fromPopup: true, tabId: 7 },
                },
                { url: chrome.runtime.getURL("options/options.html") },
            ),
        ).toEqual({ ok: false, error: "unrecognizedSender" });
        expect(harness.createSession).not.toHaveBeenCalled();
    });

    it.each([
        null,
        "",
    ])("falls back for a non-meeting tab when Chrome returns %j", async (streamId) => {
        harness.readToken.mockResolvedValue("recorder-token");
        harness.createSession.mockResolvedValue({
            id: "fallback-session",
            encryption: { protocol: 1, key: "capture-key" },
        });
        chrome.tabCapture.getMediaStreamId.mockImplementation(
            (_options, callback) => callback(streamId),
        );
        expect(
            await message({
                type: "start-recording",
                payload: {
                    tabId: 7,
                    noticeAcknowledgedAt: "2026-10-19T00:00:00Z",
                },
            }),
        ).toEqual({ ok: true, pending: true });
        expect(harness.deleteLocalSession).toHaveBeenCalledWith(
            "fallback-session",
        );
        expect(harness.sessionValues.recordingState.captureMode).toBe(
            "desktop",
        );
    });

    it.each([
        "tab",
        "desktop",
    ])("persists a changed folder from the %s view in state, durable metadata, preferences, and completion", async (captureMode) => {
        enableFolders();
        await start({ forceDesktop: captureMode === "desktop" });
        let sender = { url: chrome.runtime.getURL("popup/popup.html") };
        if (captureMode === "desktop") {
            await pickerMessage("desktop-capture-ready");
            sender = {
                url: chrome.windows.create.mock.calls.at(-1)[0].url,
                tab: { windowId: 77 },
            };
        }
        expect(harness.localMetas.get("target-session")).toMatchObject({
            folderId: "start",
            recordingFolderOverride: true,
        });
        expect(
            await message(
                {
                    type: "set-recording-folder",
                    sessionId: "target-session",
                    folderId: "changed",
                    folderLabel: "Private / Changed",
                },
                sender,
            ),
        ).toEqual({ ok: true });
        expect(harness.sessionValues.recordingState).toMatchObject({
            folderId: "changed",
            startFolderId: "start",
        });
        expect(harness.localMetas.get("target-session")).toMatchObject({
            folderId: "changed",
            startFolderId: "start",
        });
        expect(harness.saveSettings).toHaveBeenLastCalledWith({
            folderId: "changed",
            folderLabel: "Private / Changed",
        });
        await finish();
        expect(harness.completeSession).toHaveBeenCalledWith(
            expect.anything(),
            "target-session",
            expect.objectContaining({ folderId: "changed" }),
        );
    });

    it("sends null for File later", async () => {
        enableFolders();
        await start();
        await message({
            type: "set-recording-folder",
            sessionId: "target-session",
            folderId: null,
            folderLabel: null,
        });
        await finish();
        expect(harness.completeSession.mock.calls[0][2].folderId).toBeNull();
    });

    it("keeps an older server's start folder and omits the completion override", async () => {
        await start();
        expect(
            (
                await message({
                    type: "set-recording-folder",
                    sessionId: "target-session",
                    folderId: "changed",
                })
            ).ok,
        ).toBe(false);
        await finish();
        expect(harness.completeSession.mock.calls[0][2]).not.toHaveProperty(
            "folderId",
        );
    });

    it("retries completion without a rejected folder and restores the start target", async () => {
        enableFolders();
        await start();
        await message({
            type: "set-recording-folder",
            sessionId: "target-session",
            folderId: "deleted",
            folderLabel: "Private / Deleted",
        });
        harness.completeSession.mockRejectedValueOnce(
            Object.assign(new Error("Folder unavailable"), {
                status: 400,
                field: "folderId",
            }),
        );
        await finish();
        expect(harness.completeSession).toHaveBeenCalledTimes(2);
        expect(harness.completeSession.mock.calls[0][2].folderId).toBe(
            "deleted",
        );
        expect(harness.completeSession.mock.calls[1][2]).not.toHaveProperty(
            "folderId",
        );
        expect(harness.localMetas.get("target-session").folderId).toBe("start");
        expect(harness.sessionValues.recordingState.folderId).toBe("start");
    });

    it("does not retry unrelated completion failures", async () => {
        enableFolders();
        await start();
        harness.sessionValues.recordingState = {
            ...harness.sessionValues.recordingState,
            stopped: true,
            uploaded: [0],
            chunkCount: 1,
        };
        harness.listChunkIndices.mockResolvedValue([0]);
        harness.completeSession.mockRejectedValue(
            Object.assign(new Error("Invalid count"), {
                status: 400,
                field: "chunkCount",
            }),
        );
        harness.readToken.mockResolvedValue("recorder-token");
        harness.getSession.mockResolvedValue({
            id: "target-session",
            status: "open",
            received_chunks: [0],
        });
        await message({ type: "retry-upload" });
        expect(harness.completeSession).toHaveBeenCalledOnce();
        expect(harness.sessionValues.recordingState).toMatchObject({
            state: "error",
            error: "Invalid count",
        });
    });

    it.each([
        "open",
        "failed",
    ])("restores a changed target after browser restart with a %s session", async (status) => {
        enableFolders();
        harness.readToken.mockResolvedValue("recorder-token");
        harness.localMetas.set("buffer-1", {
            serverUrl: "https://example.com",
            folderId: "changed",
            folderLabel: "Private / Changed",
            startFolderId: "start",
            recordingFolderOverride: true,
            serverSessionId: "old-session",
        });
        harness.listChunkIndices.mockResolvedValue([0]);
        harness.getSession
            .mockResolvedValueOnce({
                id: "old-session",
                status,
                received_chunks: [0],
            })
            .mockResolvedValue({ status: "completing" });
        harness.recoverSession.mockResolvedValue({
            id: "replacement",
            status: "open",
            received_chunks: [0],
        });
        harness.completeSession.mockResolvedValue({ job_id: "recovered-job" });
        harness.listeners.startup();
        await vi.waitFor(() =>
            expect(harness.completeSession).toHaveBeenCalledWith(
                expect.anything(),
                status === "open" ? "old-session" : "replacement",
                expect.objectContaining({ folderId: "changed" }),
            ),
        );
        expect(harness.localMetas.get("buffer-1").folderId).toBe("changed");
        await vi.waitFor(() =>
            expect(harness.sessionValues.recordingState.jobId).toBe(
                "recovered-job",
            ),
        );
    });
});

describe("recorder folder capability refresh", () => {
    it.each([
        true,
        undefined,
    ])("remembers server folder support %j", async (supported) => {
        harness.readToken.mockResolvedValue("recorder-token");
        harness.getRecorderConfig.mockResolvedValue({
            encrypted_recording_protocol: 1,
            recording_folder_override: supported,
        });
        expect(await refreshServerConfig()).toBe(true);
        expect(chrome.storage.local.set).toHaveBeenCalledWith({
            serverDefaults: expect.objectContaining({
                encryptedRecordingProtocol: 1,
                recordingFolderOverride: supported === true,
            }),
        });
    });
});
