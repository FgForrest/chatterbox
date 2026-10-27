import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    completeSession,
    getSession,
} from "../../../extensions/recorder/lib/api.js";
import {
    deleteLocalSession,
    listChunkIndices,
    listLocalSessions,
} from "../../../extensions/recorder/lib/chunk-store.js";

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
        request: vi.fn(async (_auth, path) => ({
            json: async () =>
                path.includes("/match?")
                    ? {
                          data: [
                              {
                                  id: "agenda-one",
                                  title: "Acme review",
                                  start: new Date(
                                      Date.now() - 60000,
                                  ).toISOString(),
                                  end: new Date(
                                      Date.now() + 3600000,
                                  ).toISOString(),
                                  folders: [
                                      { id: "agenda-folder", name: "Acme" },
                                  ],
                              },
                          ],
                      }
                    : {
                          id: "agenda-one",
                          title: "Acme review",
                          permissions: { edit: true },
                          folders: [{ id: "agenda-folder", name: "Acme" }],
                      },
        })),
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
            getAll: vi.fn(async () => ({})),
            create: vi.fn(async () => "notice"),
            clear: vi.fn(async () => {}),
            onClicked: event("notificationClicked"),
            onButtonClicked: event("notificationButton"),
        },
        alarms: {
            getAll: vi.fn(async () => []),
            get: vi.fn(async () => null),
            create: vi.fn(async () => {}),
            clear: vi.fn(async () => {}),
            onAlarm: event("alarm"),
        },
        sidePanel: { open: vi.fn(async () => {}) },
        windows: {
            WINDOW_ID_CURRENT: -2,
            onRemoved: event("windowRemoved"),
            getLastFocused: vi.fn(async () => null),
            create: vi.fn(async () => ({ id: 77 })),
            update: vi.fn(async () => ({})),
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
    request: h.request,
    completeSession: vi.fn(async () => ({ job_id: "job-one" })),
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
    completeSession.mockResolvedValue({ job_id: "job-one" });
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

async function finish() {
    h.session.recordingState.uploaded = [0];
    h.listeners.message(
        { type: "recording-stopped", sessionId: "session-1", chunkCount: 1 },
        extension,
        () => {},
    );
    await vi.waitFor(() => expect(completeSession).toHaveBeenCalled());
    await settle();
}

describe("reviewed agenda decisions", () => {
    it("omits an unseen single time match on shortcut start and leaves the default folder unchanged", async () => {
        h.local.serverDefaults.agendas = true;
        h.local.agendaBanner = false;
        h.local.autoModeAcknowledgedAt = "2026-10-20T12:00:00Z";
        h.local.folderId = "private-default";
        h.local.folderLabel = "Private";
        const match = await message(
            { type: "match-agendas", tabId: 7 },
            extension,
        );
        expect(match.agendas).toHaveLength(1);
        await arm();
        await h.listeners.command("toggle-recording");
        getSession.mockResolvedValue({ status: "completing" });
        await finish();
        expect(completeSession.mock.calls[0][2]).not.toHaveProperty("agendaId");
        expect(h.session.recordingState.agendaExplicit).toBe(false);
        expect(h.local.folderId).toBe("private-default");
    });
    it("sends the agenda shown by the popup card without another agenda request or sticky-folder write", async () => {
        h.local.serverDefaults.agendas = true;
        h.local.agendaBanner = false;
        h.local.folderId = "private-default";
        h.local.folderLabel = "Private";
        const match = await message(
            { type: "match-agendas", tabId: 7 },
            extension,
        );
        expect(match.agendas).toHaveLength(1);
        h.request.mockClear();
        expect(
            await message(
                {
                    type: "start-recording",
                    payload: {
                        tabId: 7,
                        agendaId: match.agendas[0].id,
                        noticeAcknowledgedAt: "now",
                    },
                },
                extension,
            ),
        ).toMatchObject({ ok: true });
        expect(h.request).not.toHaveBeenCalled();
        expect(h.createSession.mock.calls[0][1].folderId).toBe("agenda-folder");
        getSession.mockResolvedValue({ status: "completing" });
        await finish();
        expect(completeSession.mock.calls[0][2].agendaId).toBe("agenda-one");
        expect(h.local).toMatchObject({
            folderId: "private-default",
            folderLabel: "Private",
        });
    });
    it("does not treat a cached but unseen popup match as a choice", async () => {
        h.local.serverDefaults.agendas = true;
        h.local.agendaBanner = false;
        await message({ type: "match-agendas", tabId: 7 }, extension);
        await message(
            {
                type: "start-recording",
                payload: { tabId: 7, noticeAcknowledgedAt: "now" },
            },
            extension,
        );
        getSession.mockResolvedValue({ status: "completing" });
        await finish();
        expect(completeSession.mock.calls[0][2]).not.toHaveProperty("agendaId");
    });
    it("bounds a hanging banner match to one second before capture starts", async () => {
        h.local.serverDefaults.agendas = true;
        h.request.mockImplementationOnce(() => new Promise(() => {}));
        const began = Date.now();
        const result = await message(
            {
                type: "start-recording",
                payload: { tabId: 7, noticeAcknowledgedAt: "now" },
            },
            extension,
        );
        expect(result.ok).toBe(true);
        expect(Date.now() - began).toBeLessThan(1250);
        expect(h.request).toHaveBeenCalledTimes(1);
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({ target: "offscreen", type: "start" }),
        );
        expect(h.session.recordingState.agendaExplicit).toBe(false);
    });
    it("requires confirmation of a match offered in the pill after start", async () => {
        h.local.serverDefaults.agendas = true;
        h.local.nudgeEnabled = false;
        h.local.autoModeAcknowledgedAt = "now";
        await arm();
        await h.listeners.command("toggle-recording");
        expect(h.session.recordingState.agendaId).toBeNull();
        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
            7,
            expect.objectContaining({
                view: "recording",
                state: expect.objectContaining({
                    agendas: expect.arrayContaining([
                        expect.objectContaining({ id: "agenda-one" }),
                    ]),
                }),
            }),
            { frameId: 0 },
        );
        await message(
            {
                type: "select-agenda",
                sessionId: "session-1",
                agendaId: "agenda-one",
            },
            extension,
        );
        getSession.mockResolvedValue({ status: "completing" });
        await finish();
        expect(completeSession.mock.calls[0][2]).toMatchObject({
            agendaId: "agenda-one",
            folderId: "agenda-folder",
        });
        expect(h.local.folderId).toBeUndefined();
    });
    it.each([
        false,
        true,
    ])("sends null only after explicit No agenda (chosen=%s)", async (chosen) => {
        h.local.serverDefaults.agendas = true;
        h.local.agendaBanner = false;
        if (chosen)
            await message(
                { type: "select-agenda", tabId: 7, agendaId: null },
                extension,
            );
        await message(
            {
                type: "start-recording",
                payload: { tabId: 7, noticeAcknowledgedAt: "now" },
            },
            extension,
        );
        getSession.mockResolvedValue({ status: "completing" });
        await finish();
        const body = completeSession.mock.calls[0][2];
        if (chosen) expect(body).toHaveProperty("agendaId", null);
        else expect(body).not.toHaveProperty("agendaId");
    });
    it("persists No agenda during capture and restores only this recording's user folder", async () => {
        h.local.serverDefaults.agendas = true;
        h.local.folderId = "private-default";
        h.local.folderLabel = "Private";
        await start();
        expect(h.session.recordingState.folderId).toBe("agenda-folder");
        await message(
            { type: "select-agenda", agendaId: null, sessionId: "session-1" },
            extension,
        );
        expect(h.metas.get("session-1")).toMatchObject({
            agendaId: null,
            agendaExplicit: true,
            folderId: "private-default",
        });
        expect(h.local.folderId).toBe("private-default");
        getSession.mockResolvedValue({ status: "completing" });
        await finish();
        expect(completeSession.mock.calls[0][2]).toHaveProperty(
            "agendaId",
            null,
        );
    });
    it("refreshes an agenda folder label without making it the default, while a user folder pick stays sticky", async () => {
        h.local.serverDefaults.agendas = true;
        h.local.folderId = "private-default";
        h.local.folderLabel = "Private";
        await start();
        expect(
            await message(
                {
                    type: "set-recording-folder",
                    sessionId: "session-1",
                    folderId: "agenda-folder",
                    folderLabel: "Current / Acme",
                    remember: false,
                },
                extension,
            ),
        ).toMatchObject({ ok: true });
        expect(h.session.recordingState.folderLabel).toBe("Current / Acme");
        expect(h.local).toMatchObject({
            folderId: "private-default",
            folderLabel: "Private",
        });
        expect(
            await message(
                {
                    type: "set-recording-folder",
                    sessionId: "session-1",
                    folderId: "user-picked",
                    folderLabel: "Chosen",
                },
                extension,
            ),
        ).toMatchObject({ ok: true });
        expect(h.local).toMatchObject({
            folderId: "user-picked",
            folderLabel: "Chosen",
        });
    });
    it("does not replace the saved default when an agenda folder is refused at session creation", async () => {
        h.local.serverDefaults.agendas = true;
        h.local.folderId = "private-default";
        h.local.folderLabel = "Private";
        h.createSession.mockRejectedValueOnce(
            Object.assign(new Error("Invalid folder"), {
                status: 400,
                field: "folderId",
            }),
        );
        await start();
        expect(h.createSession).toHaveBeenCalledTimes(2);
        expect(h.createSession.mock.calls[1][1]).not.toHaveProperty("folderId");
        expect(h.session.recordingState.folderId).toBeNull();
        expect(h.local).toMatchObject({
            folderId: "private-default",
            folderLabel: "Private",
        });
    });
    it("keeps real 4xx refusals recoverable without deleting the encrypted buffer", async () => {
        h.local.serverDefaults.agendas = true;
        await start();
        completeSession.mockRejectedValueOnce(
            Object.assign(new Error("Invalid agenda"), {
                status: 400,
                field: "agendaId",
            }),
        );
        await finish();
        expect(h.session.recordingState).toMatchObject({
            state: "error",
            error: "Invalid agenda",
        });
        expect(deleteLocalSession).not.toHaveBeenCalled();
    });
    it("shows unavailable agenda completion as success and cleans up the encrypted buffer", async () => {
        h.local.serverDefaults.agendas = true;
        await start();
        completeSession.mockResolvedValueOnce({
            job_id: "job-one",
            agenda: { attached: false, reason: "unavailable" },
        });
        getSession.mockResolvedValue({
            status: "completed",
            recording_id: "recording-one",
        });
        await finish();
        expect(h.session.recordingState).toMatchObject({
            state: "completed",
            agendaUnavailable: true,
            error: null,
        });
        expect(h.metas.get("session-1").agendaUnavailable).toBe(true);
        expect(deleteLocalSession).toHaveBeenCalledExactlyOnceWith("session-1");
        expect(chrome.notifications.create).toHaveBeenCalledWith(
            expect.stringContaining("completed:"),
            expect.objectContaining({
                message: "recordingSentBody\nagendaUnavailable",
            }),
        );
        expect(completeSession).toHaveBeenCalledTimes(1);
        await vi.waitFor(
            () => expect(h.session.recordingState).toBeUndefined(),
            { timeout: 4500 },
        );
        await new Promise((resolve) => setTimeout(resolve, 450));
    });
});

describe("agenda worker integration", () => {
    it("keeps the 0.7.0 banner and recording payload on a released server", async () => {
        await start();
        expect(h.request).not.toHaveBeenCalled();
        expect(h.createSession.mock.calls[0][1]).not.toHaveProperty("agendaId");
        expect(h.session.recordingState.agendaId).toBeNull();
    });
    it("preselects the single matching agenda folder and persists its ID beside the encrypted buffer", async () => {
        h.local.serverDefaults.agendas = true;
        h.local.folderId = "my-default";
        h.local.folderLabel = "Private / Default";
        await start();
        expect(h.createSession.mock.calls[0][1].folderId).toBe("agenda-folder");
        expect(h.session.recordingState.agendaId).toBe("agenda-one");
        expect(h.metas.get("session-1").agendaId).toBe("agenda-one");
        expect(h.metas.get("session-1").agendaExplicit).toBe(true);
        expect(h.local).toMatchObject({
            folderId: "my-default",
            folderLabel: "Private / Default",
        });
        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
            7,
            expect.objectContaining({
                view: "recording",
                state: expect.objectContaining({
                    agendas: [{ id: "agenda-one", title: "Acme review" }],
                }),
            }),
            { frameId: 0 },
        );
    });
    it("sends the selected agenda on completion without adding it to create", async () => {
        h.local.serverDefaults.agendas = true;
        await start();
        h.session.recordingState.uploaded = [0];
        getSession.mockResolvedValue({ status: "completing" });
        h.listeners.message(
            {
                type: "recording-stopped",
                sessionId: "session-1",
                chunkCount: 1,
            },
            extension,
            () => {},
        );
        await vi.waitFor(() => expect(completeSession).toHaveBeenCalled());
        expect(completeSession.mock.calls[0][2]).toMatchObject({
            agendaId: "agenda-one",
            folderId: "agenda-folder",
            chunkCount: 1,
        });
        expect(h.createSession.mock.calls[0][1]).not.toHaveProperty("agendaId");
    });
    it("opens the panel synchronously on notification body and button clicks", async () => {
        const opened = h.listeners.notificationClicked("agenda:agenda-one");
        expect(chrome.sidePanel.open).toHaveBeenCalledWith({ windowId: -2 });
        await opened;
        chrome.sidePanel.open.mockClear();
        h.listeners.notificationButton("agenda:agenda-one", 0);
        expect(chrome.sidePanel.open).toHaveBeenCalledWith({ windowId: -2 });
        await settle();
        expect(h.session.recorderAgendaPanel.agendaIds).toEqual(["agenda-one"]);
    });
    it("does not open an agenda from the notification dismiss button", () => {
        h.listeners.notificationButton("agenda:agenda-one", 1);
        expect(chrome.sidePanel.open).not.toHaveBeenCalled();
    });
    it("accepts an armed top-frame gesture and refuses agenda operations from ordinary web pages", async () => {
        h.local.serverDefaults.agendas = true;
        await arm();
        expect(await message({ type: "open-agenda" })).toEqual({ ok: true });
        expect(chrome.sidePanel.open).toHaveBeenCalledWith({ tabId: 7 });
        expect(
            await message({ type: "select-agenda", agendaId: "agenda-one" }),
        ).toMatchObject({ ok: false });
        expect(
            await message({ type: "open-agenda" }, { ...sender(), frameId: 1 }),
        ).toMatchObject({ ok: false });
    });
    it("updates agenda selection in session and durable recovery metadata during capture", async () => {
        h.local.serverDefaults.agendas = true;
        await start();
        expect(
            await message(
                {
                    type: "select-agenda",
                    agendaId: null,
                    sessionId: "session-1",
                },
                extension,
            ),
        ).toMatchObject({ ok: true });
        expect(h.session.recordingState.agendaId).toBeNull();
        expect(h.metas.get("session-1").agendaId).toBeNull();
        expect(
            await message(
                {
                    type: "select-agenda",
                    agendaId: "agenda-one",
                    sessionId: "stale",
                },
                extension,
            ),
        ).toMatchObject({ ok: false });
    });
});

describe("agenda recovery", () => {
    it("restores the chosen agenda after a browser restart before retrying the buffer", async () => {
        h.local.serverDefaults.agendas = true;
        h.metas.set("buffer-one", {
            serverUrl: h.local.serverUrl,
            serverSessionId: "session-one",
            agendaId: "agenda-one",
            agendaTitle: "Acme review",
            agendaExplicit: true,
            nextRetryAt: new Date(Date.now() + 120000).toISOString(),
        });
        listLocalSessions.mockResolvedValueOnce(["buffer-one"]);
        listChunkIndices.mockResolvedValueOnce([0]);
        getSession.mockResolvedValueOnce({
            status: "open",
            received_chunks: [0],
        });
        h.listeners.startup();
        await vi.waitFor(() =>
            expect(h.session.recordingState?.agendaId).toBe("agenda-one"),
        );
        expect(h.session.recordingState).toMatchObject({
            agendaTitle: "Acme review",
            agendaExplicit: true,
            stopped: true,
            stopReason: "browser-closed",
        });
    });
});

describe("agenda selection and stop ordering", () => {
    it("waits for an in-flight agenda selection before stopping capture", async () => {
        h.local.serverDefaults.agendas = true;
        await start();
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        h.request.mockImplementationOnce(async () => {
            await gate;
            return {
                json: async () => ({
                    id: "agenda-two",
                    title: "Another review",
                    permissions: { edit: true },
                }),
            };
        });
        const selection = message(
            {
                type: "select-agenda",
                agendaId: "agenda-two",
                sessionId: "session-1",
            },
            extension,
        );
        const stop = message({ type: "stop-recording" }, extension);
        await settle();
        expect(
            chrome.runtime.sendMessage.mock.calls.some(
                ([input]) =>
                    input.target === "offscreen" && input.type === "stop",
            ),
        ).toBe(false);
        release();
        expect(await selection).toMatchObject({ ok: true });
        expect(await stop).toMatchObject({ ok: true });
        expect(h.metas.get("session-1").agendaId).toBe("agenda-two");
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
            target: "offscreen",
            type: "stop",
            payload: undefined,
        });
    });
});

describe("refused agenda completion recovery", () => {
    it("lets the user clear an unavailable agenda before retrying completion", async () => {
        h.local.serverDefaults.agendas = true;
        await start();
        Object.assign(h.session.recordingState, {
            state: "error",
            stopped: true,
            jobId: null,
        });
        expect(
            await message(
                {
                    type: "select-agenda",
                    agendaId: null,
                    sessionId: "session-1",
                },
                extension,
            ),
        ).toMatchObject({ ok: true });
        expect(h.metas.get("session-1").agendaId).toBeNull();
    });
});
