import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSession } from "../../../extensions/recorder/lib/api.js";
import {
    listChunkIndices,
    listLocalSessions,
} from "../../../extensions/recorder/lib/chunk-store.js";
import { MEETING_PROMPT_SCRIPT_ID } from "../../../extensions/recorder/lib/meeting-prompt.js";
import { meetingTarget } from "../../../extensions/recorder/lib/meeting-target.js";
import { MEETING_PROMPT_ORIGINS } from "../../../extensions/recorder/lib/platforms.js";
import { readToken } from "../../../extensions/recorder/lib/token-vault.js";

const h = vi.hoisted(() => {
    const listeners = {};
    const local = {};
    const session = {};
    const tabs = new Map();
    const scripts = new Map();
    const metas = new Map();
    const event = (name) => ({
        addListener: (listener) => {
            listeners[name] = listener;
        },
    });
    const area = (values) => ({
        get: vi.fn(async () => ({ ...values })),
        set: vi.fn(async (patch) => Object.assign(values, patch)),
        remove: vi.fn(async (keys) => {
            for (const key of [keys].flat()) delete values[key];
        }),
        setAccessLevel: vi.fn(async () => {}),
    });
    const data = {
        listeners,
        local,
        session,
        tabs,
        scripts,
        metas,
        granted: true,
        visible: true,
        search: vi.fn(async () => [{ id: "new", label: "Private / Aurora" }]),
        lookup: vi.fn(async () => []),
        createSession: vi.fn(async () => ({
            id: "session-1",
            encryption: { protocol: 1, key: "secret-capture-key" },
        })),
    };
    globalThis.chrome = {
        i18n: { getMessage: (key) => key },
        storage: {
            local: area(local),
            session: area(session),
            onChanged: event("storage"),
        },
        runtime: {
            id: "test",
            getURL: (path) => `chrome-extension://test/${path}`,
            getManifest: () => ({ version: "0.7.0" }),
            sendMessage: vi.fn(async () => ({ ok: true })),
            getContexts: vi.fn(async () => []),
            openOptionsPage: vi.fn(async () => {}),
            onMessage: event("message"),
            onMessageExternal: event("external"),
            onInstalled: event("installed"),
            onStartup: event("startup"),
        },
        permissions: {
            contains: vi.fn(async () => data.granted),
            onAdded: event("added"),
            onRemoved: event("removed"),
        },
        scripting: {
            getRegisteredContentScripts: vi.fn(async () => [
                ...scripts.values(),
            ]),
            registerContentScripts: vi.fn(async (entries) => {
                for (const entry of entries) scripts.set(entry.id, entry);
            }),
            updateContentScripts: vi.fn(async (entries) => {
                for (const entry of entries) scripts.set(entry.id, entry);
            }),
            unregisterContentScripts: vi.fn(async ({ ids }) => {
                for (const id of ids) scripts.delete(id);
            }),
            executeScript: vi.fn(async () => []),
        },
        tabs: {
            get: vi.fn(async (id) => tabs.get(id) ?? null),
            query: vi.fn(async (query) =>
                [...tabs.values()].filter(
                    (tab) =>
                        !query.url ||
                        query.url.some((pattern) => {
                            const host = new URL(pattern.replace("*.", ""))
                                .hostname;
                            const url = new URL(tab.url);
                            return (
                                url.protocol === "https:" &&
                                (url.hostname === host ||
                                    url.hostname.endsWith(`.${host}`))
                            );
                        }),
                ),
            ),
            sendMessage: vi.fn(async () => ({ visible: data.visible })),
            create: vi.fn(async () => ({})),
            update: vi.fn(async () => ({})),
            onUpdated: event("updated"),
            onRemoved: event("tabRemoved"),
        },
        action: {
            setPopup: vi.fn(async () => {}),
            setBadgeText: vi.fn(async () => {}),
            setTitle: vi.fn(async () => {}),
            setBadgeBackgroundColor: vi.fn(async () => {}),
            getUserSettings: vi.fn(async () => ({ isOnToolbar: true })),
            onClicked: event("clicked"),
        },
        commands: {
            getAll: vi.fn(async () => [
                { name: "toggle-recording", shortcut: "Alt+Shift+R" },
            ]),
            onCommand: event("command"),
        },
        notifications: {
            create: vi.fn(async () => "notice"),
            clear: vi.fn(async () => {}),
            onClicked: event("notificationClicked"),
            onButtonClicked: event("notificationButton"),
        },
        alarms: {
            get: vi.fn(async () => null),
            create: vi.fn(async () => {}),
            clear: vi.fn(async () => {}),
            onAlarm: event("alarm"),
        },
        windows: {
            onRemoved: event("windowRemoved"),
            getLastFocused: vi.fn(async () => null),
            create: vi.fn(async () => ({ id: 77 })),
        },
        tabCapture: {
            getMediaStreamId: vi.fn((_input, callback) => callback("stream-1")),
        },
        offscreen: {
            createDocument: vi.fn(async () => {}),
            closeDocument: vi.fn(async () => {}),
        },
    };
    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {
            permissions: { query: vi.fn(async () => ({ state: "granted" })) },
        },
    });
    return data;
});
vi.mock("../../../extensions/recorder/lib/token-vault.js", () => ({
    readToken: vi.fn(async () => "private-recorder-token"),
}));
vi.mock("../../../extensions/recorder/lib/chunk-store.js", () => ({
    createLocalSession: vi.fn(async (id, meta) => h.metas.set(id, meta)),
    deleteLocalSession: vi.fn(async () => {}),
    listChunkIndices: vi.fn(async () => []),
    listLocalSessions: vi.fn(async () => []),
    readChunk: vi.fn(),
    readLocalMeta: vi.fn(async (id) => h.metas.get(id)),
    totalBufferedBytes: vi.fn(async () => 0),
}));
vi.mock("../../../extensions/recorder/lib/api.js", () => ({
    abortSession: vi.fn(async () => {}),
    completeSession: vi.fn(),
    createSession: h.createSession,
    getSession: vi.fn(),
    getRecorderFolder: h.lookup,
    recoverSession: vi.fn(),
    searchRecorderFolders: h.search,
    sha256Hex: vi.fn(),
    uploadChunk: vi.fn(),
}));
import "../../../extensions/recorder/service-worker.js";
const meeting = {
    id: 7,
    windowId: 3,
    url: "https://meet.google.com/abc-defg-hij",
    audible: true,
};
const sender = () => ({
    id: "test",
    frameId: 0,
    url: h.tabs.get(7).url,
    tab: { id: 7 },
});
const extension = {
    id: "test",
    url: "chrome-extension://test/popup/popup.html",
};
const message = (input, from = sender()) =>
    new Promise((resolve) => h.listeners.message(input, from, resolve));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
    await settle();
    vi.clearAllMocks();
    for (const store of [h.local, h.session])
        for (const key of Object.keys(store)) delete store[key];
    h.tabs.clear();
    h.scripts.clear();
    h.metas.clear();
    h.granted = true;
    h.visible = true;
    chrome.tabs.sendMessage.mockImplementation(async () => ({
        visible: h.visible,
    }));
    Object.assign(h.local, {
        dataUseAcknowledgedAt: "2026-10-20T12:00:00Z",
        encryptedApiKey: { ciphertext: "test" },
        serverUrl: "https://recorder.example",
        nudgeEnabled: true,
        serverDefaults: {
            encryptedRecordingProtocol: 1,
            recordingFolderOverride: true,
            autoRecordPlatforms: [],
        },
    });
    h.tabs.set(7, { ...meeting });
    chrome.commands.getAll.mockResolvedValue([
        { name: "toggle-recording", shortcut: "Alt+Shift+R" },
    ]);
    chrome.action.getUserSettings.mockResolvedValue({ isOnToolbar: true });
    h.createSession.mockResolvedValue({
        id: "session-1",
        encryption: { protocol: 1, key: "secret-capture-key" },
    });
});
afterEach(settle);
async function arm() {
    await h.listeners.updated(7, { status: "complete" }, h.tabs.get(7));
}
async function start() {
    await arm();
    h.listeners.clicked(h.tabs.get(7));
    await vi.waitFor(() =>
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({ target: "offscreen", type: "start" }),
        ),
    );
    await settle();
}

describe("meeting-site permission lifecycle", () => {
    it("registers a persistent isolated top-frame script and injects only matching open sites on grant", async () => {
        h.tabs.set(8, { id: 8, url: "https://other.example/" });
        h.listeners.added({ origins: MEETING_PROMPT_ORIGINS });
        await vi.waitFor(() =>
            expect(h.scripts.has(MEETING_PROMPT_SCRIPT_ID)).toBe(true),
        );
        expect(h.scripts.get(MEETING_PROMPT_SCRIPT_ID)).toMatchObject({
            matches: MEETING_PROMPT_ORIGINS,
            allFrames: false,
            persistAcrossSessions: true,
            world: "ISOLATED",
            js: ["popup/folder-combobox-shared.js", "content-meeting.js"],
        });
        await vi.waitFor(() =>
            expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
                target: { tabId: 7, frameIds: [0] },
                files: [
                    "popup/folder-combobox-shared.js",
                    "content-meeting.js",
                ],
            }),
        );
        expect(
            chrome.scripting.executeScript.mock.calls.some(
                ([input]) => input.target.tabId === 8,
            ),
        ).toBe(false);
        expect(h.local.meetingPromptOfferDismissed).toBe(true);
        h.listeners.added({ origins: MEETING_PROMPT_ORIGINS });
        await settle();
        expect(chrome.scripting.registerContentScripts).toHaveBeenCalledOnce();
        expect(chrome.scripting.updateContentScripts).toHaveBeenCalled();
    });
    it("unregisters, hides the open banner and restores the popup when access is removed", async () => {
        h.listeners.added({ origins: MEETING_PROMPT_ORIGINS });
        await vi.waitFor(() =>
            expect(h.session.armedTabs?.[7]?.promptVisible).toBe(true),
        );
        h.granted = false;
        h.listeners.removed({ origins: MEETING_PROMPT_ORIGINS });
        await vi.waitFor(() =>
            expect(h.scripts.has(MEETING_PROMPT_SCRIPT_ID)).toBe(false),
        );
        await vi.waitFor(() =>
            expect(chrome.action.setPopup).toHaveBeenLastCalledWith({
                tabId: 7,
                popup: "popup/popup.html",
            }),
        );
        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
            7,
            { type: "meeting-banner", view: "hidden" },
            { frameId: 0 },
        );
    });
    it.each([
        "startup",
        "installed",
    ])("reconciles on %s without opening a window or tab", async (event) => {
        h.listeners[event]({ reason: "update" });
        await vi.waitFor(() =>
            expect(h.scripts.has(MEETING_PROMPT_SCRIPT_ID)).toBe(true),
        );
        await settle();
        expect(chrome.tabs.create).not.toHaveBeenCalled();
        expect(chrome.windows.create).not.toHaveBeenCalled();
    });
    it("keeps non-banner platforms on the notification path without expanding optional grants", async () => {
        h.local.platformModes = { jitsi: "prompt" };
        h.tabs.set(7, { ...meeting, url: "https://meet.jit.si/Aurora" });
        await arm();
        expect(chrome.notifications.create).toHaveBeenCalled();
        expect(MEETING_PROMPT_ORIGINS).toHaveLength(7);
        expect(
            MEETING_PROMPT_ORIGINS.some((pattern) =>
                /slack|jit\.si/.test(pattern),
            ),
        ).toBe(false);
    });
});

describe("meeting prompt and one-click recording", () => {
    it("replaces the notification and disables the popup only after the banner acknowledges visibility", async () => {
        await arm();
        expect(chrome.notifications.create).not.toHaveBeenCalled();
        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
            7,
            expect.objectContaining({
                view: "prompt",
                shortcut: "Alt+Shift+R",
                notice: expect.any(String),
            }),
            { frameId: 0 },
        );
        expect(chrome.action.setPopup).toHaveBeenLastCalledWith({
            tabId: 7,
            popup: "",
        });
        expect(h.session.armedTabs[7].promptVisible).toBe(true);
    });
    it.each([
        "hidden",
        "missing",
        "error",
    ])("shows a notification fallback when the banner response is %s", async (result) => {
        if (result === "error")
            chrome.tabs.sendMessage.mockRejectedValueOnce(
                new Error("No receiver"),
            );
        else
            chrome.tabs.sendMessage.mockResolvedValueOnce(
                result === "hidden" ? { visible: false } : undefined,
            );
        await arm();
        expect(chrome.action.setPopup).toHaveBeenLastCalledWith({
            tabId: 7,
            popup: "popup/popup.html",
        });
        expect(chrome.notifications.create).toHaveBeenCalledWith(
            "nudge:7",
            expect.anything(),
        );
        expect(h.session.armedTabs[7].promptVisible).toBe(false);
        chrome.notifications.clear.mockClear();
        expect(await message({ type: "meeting-banner-ready" })).toEqual({
            ok: true,
        });
        expect(chrome.notifications.clear).toHaveBeenCalledWith("nudge:7");
        expect(chrome.action.setPopup).toHaveBeenLastCalledWith({
            tabId: 7,
            popup: "",
        });
    });
    it("sends unpinned instructions and the actual assigned shortcut, omitting an empty shortcut", async () => {
        chrome.action.getUserSettings.mockResolvedValue({ isOnToolbar: false });
        chrome.commands.getAll.mockResolvedValue([
            { name: "toggle-recording", shortcut: "" },
        ]);
        await arm();
        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
            7,
            expect.objectContaining({
                view: "prompt",
                pinned: false,
                shortcut: "",
            }),
            { frameId: 0 },
        );
    });
    it.each([
        "clicked",
        "command",
    ])("starts tab capture from %s using the visible notice as consent", async (invocation) => {
        await arm();
        if (invocation === "clicked") h.listeners.clicked(h.tabs.get(7));
        else await h.listeners.command("toggle-recording");
        await vi.waitFor(() =>
            expect(chrome.tabCapture.getMediaStreamId).toHaveBeenCalled(),
        );
        await settle();
        expect(h.createSession).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                noticeAcknowledgedAt: expect.any(String),
            }),
        );
        expect(h.session.recordingState.state).toBe("recording");
        expect(h.session.recordingState.autoStarted).toBe(false);
        expect(chrome.action.setPopup).toHaveBeenLastCalledWith({
            tabId: 7,
            popup: "popup/popup.html",
        });
        chrome.alarms.create.mockClear();
        await h.listeners.updated(
            7,
            { audible: false },
            { ...h.tabs.get(7), audible: false },
        );
        expect(chrome.alarms.create).not.toHaveBeenCalled();
        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
            7,
            expect.objectContaining({ view: "recording" }),
            { frameId: 0 },
        );
        expect(chrome.windows.create).not.toHaveBeenCalled();
        const payloads = JSON.stringify(chrome.tabs.sendMessage.mock.calls);
        expect(payloads).not.toContain("secret-capture-key");
        expect(payloads).not.toContain("private-recorder-token");
        expect(payloads).not.toContain("https://recorder.example");
    });
    it("dismisses for this meeting and restores the popup without prompting again", async () => {
        await arm();
        expect(await message({ type: "meeting-banner-dismiss" })).toEqual({
            ok: true,
        });
        expect(chrome.action.setPopup).toHaveBeenLastCalledWith({
            tabId: 7,
            popup: "popup/popup.html",
        });
        chrome.tabs.sendMessage.mockClear();
        await arm();
        expect(
            chrome.tabs.sendMessage.mock.calls.some(
                ([, payload]) => payload.view === "prompt",
            ),
        ).toBe(false);
    });
    it("hides and restores the popup on disarm, and prompts again for a different meeting", async () => {
        await arm();
        h.tabs.set(7, { ...meeting, url: "https://meet.google.com/" });
        await arm();
        expect(h.session.armedTabs[7]).toBeUndefined();
        expect(chrome.action.setPopup).toHaveBeenLastCalledWith({
            tabId: 7,
            popup: "popup/popup.html",
        });
        h.tabs.set(7, {
            ...meeting,
            url: "https://meet.google.com/xyz-abcd-efg",
        });
        await arm();
        expect(h.session.armedTabs[7].promptVisible).toBe(true);
    });
    it("does not prompt for a muted tab or when nudges are disabled", async () => {
        h.tabs.get(7).audible = false;
        await arm();
        h.tabs.get(7).audible = true;
        h.local.nudgeEnabled = false;
        await arm();
        expect(
            chrome.tabs.sendMessage.mock.calls.some(
                ([, payload]) => payload.view === "prompt",
            ),
        ).toBe(false);
        expect(chrome.notifications.create).not.toHaveBeenCalled();
    });
    it("starts the existing desktop fallback from the banner with consent", async () => {
        await arm();
        expect(await message({ type: "meeting-banner-dialog" })).toEqual({
            ok: true,
        });
        expect(chrome.windows.create).toHaveBeenCalledWith(
            expect.objectContaining({
                url: expect.stringContaining("picker/picker.html?requestId="),
            }),
        );
        expect(chrome.tabCapture.getMediaStreamId).not.toHaveBeenCalled();
        expect(chrome.action.setPopup).toHaveBeenLastCalledWith({
            tabId: 7,
            popup: "popup/popup.html",
        });
        expect(
            Number.isFinite(
                Date.parse(h.session.recordingState.noticeAcknowledgedAt),
            ),
        ).toBe(true);
    });
    it("restores the popup and shows the error if a one-click start fails", async () => {
        h.createSession.mockRejectedValueOnce(
            new Error("Server refused capture"),
        );
        await arm();
        h.listeners.clicked(h.tabs.get(7));
        await vi.waitFor(() =>
            expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
                7,
                expect.objectContaining({
                    view: "error",
                    state: expect.objectContaining({
                        error: "Server refused capture",
                    }),
                }),
                { frameId: 0 },
            ),
        );
        expect(chrome.action.setPopup).toHaveBeenLastCalledWith({
            tabId: 7,
            popup: "popup/popup.html",
        });
    });
});

describe("meeting banner errors before capture starts", () => {
    it.each([
        "clicked",
        "dialog",
    ])("shows a token-vault error from %s and restores the popup", async (control) => {
        await arm();
        readToken.mockRejectedValueOnce(
            new Error("Reconnect the recorder key"),
        );
        if (control === "clicked") h.listeners.clicked(h.tabs.get(7));
        else
            expect(
                await message({ type: "meeting-banner-dialog" }),
            ).toMatchObject({ ok: false });
        await vi.waitFor(() =>
            expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
                7,
                expect.objectContaining({
                    view: "error",
                    state: { error: "Reconnect the recorder key" },
                }),
                { frameId: 0 },
            ),
        );
        expect(chrome.action.setPopup).toHaveBeenLastCalledWith({
            tabId: 7,
            popup: "popup/popup.html",
        });
        expect(chrome.windows.create).not.toHaveBeenCalled();
    });
});

describe("meeting banner senders and recording controls", () => {
    it.each([
        { id: "other" },
        { frameId: 1 },
        { tab: { id: 8 } },
        { url: "https://other.example/" },
        { url: "https://meet.google.com/xyz-abcd-efg" },
        { url: "https://meet.google.com/" },
    ])("rejects an invalid sender %j", async (override) => {
        await start();
        for (const type of [
            "get-folders",
            "set-recording-folder",
            "stop-recording",
            "meeting-banner-dialog",
            "meeting-banner-dismiss",
            "meeting-banner-ready",
        ]) {
            expect(
                await message(
                    {
                        type,
                        q: "Aurora",
                        sessionId: "session-1",
                        folderId: null,
                    },
                    { ...sender(), ...override },
                ),
            ).toMatchObject({ ok: false });
        }
        expect(h.search).not.toHaveBeenCalled();
    });
    it("allows folder search and writes only for the current recording tab and session", async () => {
        await start();
        expect(await message({ type: "get-folders", q: "Aurora" })).toEqual({
            ok: true,
            folders: [{ id: "new", label: "Private / Aurora" }],
        });
        expect(
            await message({
                type: "set-recording-folder",
                sessionId: "wrong",
                folderId: "new",
            }),
        ).toMatchObject({ ok: false, error: "folderChangeFailed" });
        expect(
            await message({
                type: "set-recording-folder",
                sessionId: "session-1",
                folderId: "new",
                folderLabel: "Private / Aurora",
            }),
        ).toEqual({ ok: true });
        expect(h.metas.get("session-1").folderId).toBe("new");
        expect(h.local.folderId).toBe("new");
        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
            7,
            expect.objectContaining({
                view: "recording",
                state: expect.objectContaining({ folderId: "new" }),
            }),
            { frameId: 0 },
        );
    });
    it("rejects folder access when the server or the session lacks override support", async () => {
        await start();
        h.local.serverDefaults.recordingFolderOverride = false;
        expect(
            await message({ type: "get-folders", q: "Aurora" }),
        ).toMatchObject({ ok: false });
        expect(
            await message({
                type: "set-recording-folder",
                sessionId: "session-1",
                folderId: null,
            }),
        ).toMatchObject({ ok: false });
        h.local.serverDefaults.recordingFolderOverride = true;
        h.session.recordingState.recordingFolderOverride = false;
        expect(
            await message({
                type: "set-recording-folder",
                sessionId: "session-1",
                folderId: null,
            }),
        ).toMatchObject({ ok: false });
    });
    it("stops through the existing capture host and restores the popup when stopped", async () => {
        await start();
        expect(
            await message({ type: "stop-recording", sessionId: "wrong" }),
        ).toMatchObject({ ok: false });
        expect(
            await message({ type: "stop-recording", sessionId: "session-1" }),
        ).toEqual({ ok: true });
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
            target: "offscreen",
            type: "stop",
            payload: undefined,
        });
        h.session.recordingState.stopped = true;
        expect(await message({ type: "meeting-banner-ready" })).toEqual({
            ok: true,
        });
        expect(chrome.action.setPopup).toHaveBeenLastCalledWith({
            tabId: 7,
            popup: "popup/popup.html",
        });
        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
            7,
            expect.objectContaining({ view: "stopped" }),
            { frameId: 0 },
        );
    });
    it("does not expose other internal messages or state to meeting content scripts", async () => {
        await arm();
        for (const type of [
            "get-state",
            "get-armed",
            "start-recording",
            "refresh-config",
            "capture-error",
            "levels",
            "discard-session",
        ]) {
            expect(await message({ type })).toMatchObject({
                ok: false,
                error: "unrecognizedSender",
            });
        }
        expect(await message({ type: "get-state" }, extension)).toHaveProperty(
            "state",
        );
    });
    it("rejects navigation and permission revocation even if the old script is still running", async () => {
        await start();
        const old = sender();
        h.tabs.set(7, { ...meeting, url: "https://other.example/" });
        expect(
            await message(
                { type: "stop-recording", sessionId: "session-1" },
                old,
            ),
        ).toMatchObject({ ok: false });
        h.tabs.set(7, { ...meeting });
        h.granted = false;
        expect(
            await message({ type: "get-folders", q: "Aurora" }, old),
        ).toMatchObject({ ok: false });
    });
});

describe("meeting prompt lifecycle boundaries", () => {
    it.each([
        false,
        true,
    ])("keeps auto mode's existing one-click consent with banner access=%s", async (granted) => {
        h.granted = granted;
        h.local.platformModes = { "google-meet": "auto" };
        h.local.autoModeAcknowledgedAt = "2026-10-20T12:00:00Z";
        await arm();
        expect(chrome.action.setPopup).toHaveBeenLastCalledWith({
            tabId: 7,
            popup: "",
        });
        h.listeners.clicked(h.tabs.get(7));
        await vi.waitFor(() => expect(h.createSession).toHaveBeenCalled());
        await settle();
        expect(h.createSession.mock.calls[0][1].noticeAcknowledgedAt).toBe(
            h.local.autoModeAcknowledgedAt,
        );
        expect(h.session.recordingState.autoStarted).toBe(true);
        expect(chrome.action.setPopup).toHaveBeenLastCalledWith({
            tabId: 7,
            popup: "",
        });
        await h.listeners.updated(
            7,
            { audible: false },
            { ...h.tabs.get(7), audible: false },
        );
        expect(chrome.alarms.create).toHaveBeenCalledWith(
            "quiet:7",
            expect.anything(),
        );
    });
    it("hides a manually started pill on access removal even when the tab is not armed", async () => {
        h.local.platformModes = { "google-meet": "off" };
        expect(
            await message(
                {
                    type: "start-recording",
                    payload: {
                        tabId: 7,
                        noticeAcknowledgedAt: "2026-10-20T12:00:00Z",
                    },
                },
                extension,
            ),
        ).toMatchObject({ ok: true });
        expect(h.session.armedTabs?.[7]).toBeUndefined();
        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
            7,
            expect.objectContaining({ view: "recording" }),
            { frameId: 0 },
        );
        chrome.tabs.sendMessage.mockClear();
        h.granted = false;
        h.listeners.removed({ origins: MEETING_PROMPT_ORIGINS });
        await vi.waitFor(() =>
            expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
                7,
                { type: "meeting-banner", view: "hidden" },
                { frameId: 0 },
            ),
        );
    });
});

describe("nudges while a different tab is recording", () => {
    it.each([
        false,
        true,
    ])("preserves the existing nudge trigger with banner access=%s", async (granted) => {
        h.granted = granted;
        h.session.recordingState = {
            state: "recording",
            sessionId: "other-session",
            tabId: 8,
        };
        await arm();
        if (granted)
            expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
                7,
                expect.objectContaining({ view: "prompt" }),
                { frameId: 0 },
            );
        else
            expect(chrome.notifications.create).toHaveBeenCalledWith(
                "nudge:7",
                expect.anything(),
            );
        expect(h.session.recordingState.sessionId).toBe("other-session");
    });
});

describe("fallback meeting notifications", () => {
    it("keeps the notification, appends the offer, and opens the options switch on body click", async () => {
        h.granted = false;
        await arm();
        expect(chrome.notifications.create).toHaveBeenCalledWith(
            "nudge:7",
            expect.objectContaining({
                message: "meetingRecordBody\nmeetingPromptNotificationHint",
            }),
        );
        await h.listeners.notificationClicked("nudge:7");
        expect(chrome.tabs.create).toHaveBeenCalledWith({
            url: "chrome-extension://test/options/options.html#meeting-prompt",
        });
        expect(chrome.windows.create).not.toHaveBeenCalled();
    });
});

describe("meeting banner review regressions", () => {
    it.each([
        "capture",
        "vault",
    ])("remembers dismissal of a %s error across tab updates, reevaluation and readiness", async (failure) => {
        await arm();
        const error = new Error("Aurora capture unavailable");
        if (failure === "capture") h.createSession.mockRejectedValueOnce(error);
        else readToken.mockRejectedValueOnce(error);
        h.listeners.clicked(h.tabs.get(7));
        await vi.waitFor(() =>
            expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
                7,
                expect.objectContaining({ view: "error" }),
                { frameId: 0 },
            ),
        );
        await settle();
        expect(await message({ type: "meeting-banner-dismiss" })).toEqual({
            ok: true,
        });
        expect(h.session.armedTabs[7].errorDismissed).toBe(true);
        chrome.tabs.sendMessage.mockClear();
        await arm();
        expect(await message({ type: "reevaluate-tabs" }, extension)).toEqual({
            ok: true,
        });
        expect(await message({ type: "meeting-banner-ready" })).toEqual({
            ok: true,
        });
        expect(
            chrome.tabs.sendMessage.mock.calls.some(
                ([, payload]) => payload.view === "error",
            ),
        ).toBe(false);
        expect(
            chrome.tabs.sendMessage.mock.calls.some(
                ([, payload]) => payload.view === "prompt",
            ),
        ).toBe(false);
    });
    it("remembers dismissal of an error from a manual start on an unarmed meeting tab", async () => {
        h.local.platformModes = { "google-meet": "off" };
        h.createSession.mockRejectedValueOnce(
            new Error("Aurora capture unavailable"),
        );
        expect(
            await message(
                {
                    type: "start-recording",
                    payload: {
                        tabId: 7,
                        noticeAcknowledgedAt: "2026-10-20T12:00:00Z",
                    },
                },
                extension,
            ),
        ).toMatchObject({ ok: false });
        expect(h.session.armedTabs?.[7]).toBeUndefined();
        expect(await message({ type: "meeting-banner-dismiss" })).toEqual({
            ok: true,
        });
        chrome.tabs.sendMessage.mockClear();
        expect(await message({ type: "meeting-banner-ready" })).toEqual({
            ok: true,
        });
        expect(
            chrome.tabs.sendMessage.mock.calls.some(
                ([, payload]) => payload.view === "error",
            ),
        ).toBe(false);
    });
    it("does not message or write session storage for an unarmed ordinary tab update", async () => {
        h.tabs.set(9, { id: 9, url: "https://news.example/" });
        await h.listeners.updated(9, { status: "complete" }, h.tabs.get(9));
        expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
        expect(chrome.storage.session.set).not.toHaveBeenCalled();
    });
    it.each([
        "prompt",
        "off",
    ])("hides the pill while preserving REC and the title after leaving a meeting with mode %s", async (mode) => {
        h.local.platformModes = { "google-meet": mode };
        if (mode === "prompt") await start();
        else
            await message(
                {
                    type: "start-recording",
                    payload: {
                        tabId: 7,
                        noticeAcknowledgedAt: "2026-10-20T12:00:00Z",
                    },
                },
                extension,
            );
        chrome.action.setBadgeText.mockClear();
        chrome.action.setTitle.mockClear();
        chrome.tabs.sendMessage.mockClear();
        h.tabs.set(7, { ...meeting, url: "https://news.example/" });
        await arm();
        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
            7,
            { type: "meeting-banner", view: "hidden" },
            { frameId: 0 },
        );
        expect(chrome.action.setBadgeText).not.toHaveBeenCalled();
        expect(chrome.action.setTitle).not.toHaveBeenCalled();
        expect(h.session.recordingState.state).toBe("recording");
        expect(h.session.recordingState.stopped).toBe(false);
    });
    it("re-arms meetings and resumes a pending upload when content-script registration throws", async () => {
        const error = new Error("Registration unavailable");
        const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
        chrome.scripting.registerContentScripts.mockRejectedValueOnce(error);
        listLocalSessions.mockResolvedValueOnce(["buffer-aurora"]);
        listChunkIndices.mockResolvedValueOnce([0]);
        getSession.mockResolvedValueOnce({
            status: "open",
            received_chunks: [0],
        });
        h.metas.set("buffer-aurora", {
            serverUrl: "https://recorder.example",
            serverSessionId: "pending-aurora",
            nextRetryAt: new Date(Date.now() + 60_000).toISOString(),
        });
        try {
            h.listeners.startup();
            await vi.waitFor(() =>
                expect(h.session.recordingState?.sessionId).toBe(
                    "pending-aurora",
                ),
            );
            await settle();
            expect(h.session.armedTabs[7].platformId).toBe("google-meet");
            expect(h.session.recordingState).toMatchObject({
                bufferId: "buffer-aurora",
                stopped: true,
                stopReason: "browser-closed",
            });
            expect(chrome.alarms.create).toHaveBeenCalledWith(
                "upload-retry",
                expect.objectContaining({ when: expect.any(Number) }),
            );
            expect(warning).toHaveBeenCalledWith(
                "[recorder] meeting prompt registration:",
                error,
            );
        } finally {
            warning.mockRestore();
        }
    });
    it("stores only sanitized meeting identities while waiting and recording", async () => {
        h.tabs.get(7).url += "?password=aurora-private#secret";
        await arm();
        expect(h.session.armedTabs[7].meetingTarget).toEqual(
            meetingTarget(h.tabs.get(7).url),
        );
        expect(await message({ type: "meeting-banner-dialog" })).toEqual({
            ok: true,
        });
        expect(h.session.recordingState.meetingTarget).toEqual(
            meetingTarget(h.tabs.get(7).url),
        );
        delete h.session.recordingState;
        h.tabs.get(7).url =
            "https://meet.google.com/xyz-abcd-efg?password=aurora-private";
        await start();
        expect(h.session.recordingState.meetingTarget).toEqual(
            meetingTarget(h.tabs.get(7).url),
        );
        const writes = JSON.stringify(chrome.storage.session.set.mock.calls);
        expect(writes).not.toContain("password");
        expect(writes).not.toContain("aurora-private");
        expect(writes).not.toContain("meetingUrl");
    });
    it("accepts the same Teams meeting in the sender hash and rejects a different one", async () => {
        h.tabs.get(7).url =
            "https://teams.microsoft.com/v2/#/meetup-join/aurora-room?password=private";
        await start();
        const current = sender();
        expect(
            await message({ type: "get-folders", q: "Aurora" }, current),
        ).toMatchObject({ ok: true });
        expect(
            await message(
                { type: "get-folders", q: "Aurora" },
                {
                    ...current,
                    url: "https://teams.microsoft.com/v2/#/meetup-join/other-room",
                },
            ),
        ).toMatchObject({ ok: false });
        expect(h.session.recordingState.meetingTarget.meetingId).toBe(
            "aurora-room",
        );
    });
    it("tells auto-mode users that the icon opens Options until the policy is acknowledged", async () => {
        h.local.platformModes = { "google-meet": "auto" };
        await arm();
        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
            7,
            expect.objectContaining({ view: "prompt", policyRequired: true }),
            { frameId: 0 },
        );
        h.listeners.clicked(h.tabs.get(7));
        await vi.waitFor(() =>
            expect(chrome.runtime.openOptionsPage).toHaveBeenCalled(),
        );
        expect(h.createSession).not.toHaveBeenCalled();
    });
});

describe("Chrome-check worker fixes", () => {
    it.each([
        [true, "before"],
        [true, "after"],
        [false, "before"],
        [false, "after"],
    ])("nudges with access=%s when audible arrives %s the armed entry is written", async (granted, order) => {
        h.granted = granted;
        h.tabs.get(7).audible = false;
        const snapshot = { ...h.tabs.get(7) };
        let release;
        let reached;
        const writeReached = new Promise((resolve) => {
            reached = resolve;
        });
        const writeGate = new Promise((resolve) => {
            release = resolve;
        });
        chrome.storage.session.set.mockImplementationOnce(async (patch) => {
            reached();
            await writeGate;
            Object.assign(h.session, patch);
        });
        const arming = h.listeners.updated(7, { status: "complete" }, snapshot);
        await writeReached;
        try {
            if (order === "after") {
                release();
                await arming;
                expect(h.session.armedTabs[7].nudged).toBe(false);
            }
            h.tabs.get(7).audible = true;
            await h.listeners.updated(
                7,
                { audible: true },
                { ...h.tabs.get(7) },
            );
        } finally {
            release();
            await arming;
        }
        expect(h.session.armedTabs[7].nudged).toBe(true);
        if (granted) {
            expect(h.session.armedTabs[7].promptVisible).toBe(true);
            expect(chrome.notifications.create).not.toHaveBeenCalled();
        } else {
            expect(chrome.notifications.create).toHaveBeenCalledOnce();
        }
    });
    it.each([
        ["https://meet.google.com/abc-defg-hij", "google-meet", 16],
        ["https://zoom.us/wc/12345/join", "zoom", 16],
        ["https://teams.microsoft.com/l/meetup-join/aurora", "teams", 64],
        ["https://teams.live.com/meet/aurora", "teams", 64],
        ["https://teams.cloud.microsoft/meet/aurora", "teams", 64],
        ["https://aurora.webex.com/meet/aurora", "webex", 16],
        ["https://whereby.com/aurora", "whereby", 16],
    ])("positions prompt and recording pill at the registry offset for %s", async (url, id, topOffset) => {
        h.tabs.get(7).url = url;
        h.local.platformModes = { [id]: "prompt" };
        await arm();
        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
            7,
            expect.objectContaining({ view: "prompt", topOffset }),
            { frameId: 0 },
        );
        h.session.recordingState = {
            state: "recording",
            tabId: 7,
            sessionId: "aurora",
            meetingTarget: meetingTarget(url),
        };
        await message({ type: "meeting-banner-ready" });
        expect(chrome.tabs.sendMessage).toHaveBeenLastCalledWith(
            7,
            expect.objectContaining({ view: "recording", topOffset }),
            { frameId: 0 },
        );
    });
    it("uses the banner title and a plain fallback when access exists, then focuses the meeting", async () => {
        h.visible = false;
        await arm();
        expect(chrome.notifications.create).toHaveBeenCalledWith(
            "nudge:7",
            expect.objectContaining({
                title: "meetingPromptTitle",
                message: "meetingRecordBody",
            }),
        );
        await h.listeners.notificationClicked("nudge:7");
        expect(chrome.tabs.create).not.toHaveBeenCalled();
        expect(chrome.tabs.update).toHaveBeenCalledWith(7, { active: true });
    });
});
