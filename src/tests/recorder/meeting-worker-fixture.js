import { afterEach, beforeEach, vi } from "vitest";
import manifest from "../../../extensions/recorder/manifest.json";

const h = vi.hoisted(() => {
    const listeners = { connect: [] };
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
        abortSession: vi.fn(async () => {}),
        completeSession: vi.fn(),
        getSession: vi.fn(),
        listChunkIndices: vi.fn(async () => []),
        listLocalSessions: vi.fn(async () => []),
        readToken: vi.fn(async () => "private-recorder-token"),
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
            getManifest: () => manifest,
            sendMessage: vi.fn(async () => ({ ok: true })),
            getContexts: vi.fn(async () => []),
            openOptionsPage: vi.fn(async () => {}),
            onMessage: event("message"),
            onConnect: {
                addListener: (listener) => listeners.connect.push(listener),
            },
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
            setIcon: vi.fn(async () => {}),
            setBadgeText: vi.fn(async () => {}),
            setTitle: vi.fn(async () => {}),
            setBadgeBackgroundColor: vi.fn(async () => {}),
            getUserSettings: vi.fn(async () => ({ isOnToolbar: true })),
            onClicked: event("clicked"),
            onUserSettingsChanged: event("pinChanged"),
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
            get: vi.fn(async (id) => ({ id })),
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
    readToken: h.readToken,
}));
vi.mock("../../../extensions/recorder/lib/chunk-store.js", () => ({
    createLocalSession: vi.fn(async (id, meta) => h.metas.set(id, meta)),
    deleteLocalSession: vi.fn(async () => {}),
    listChunkIndices: h.listChunkIndices,
    listLocalSessions: h.listLocalSessions,
    readChunk: vi.fn(),
    readLocalMeta: vi.fn(async (id) => h.metas.get(id)),
    totalBufferedBytes: vi.fn(async () => 0),
}));
vi.mock("../../../extensions/recorder/lib/api.js", () => ({
    abortSession: h.abortSession,
    completeSession: h.completeSession,
    createSession: h.createSession,
    getSession: h.getSession,
    getRecorderFolder: h.lookup,
    recoverSession: vi.fn(),
    searchRecorderFolders: h.search,
    sha256Hex: vi.fn(),
    uploadChunk: vi.fn(),
}));
import "../../../extensions/recorder/service-worker.js";
export { h };
export const meeting = {
    id: 7,
    windowId: 3,
    url: "https://meet.google.com/abc-defg-hij",
    audible: true,
};
export const sender = () => ({
    id: "test",
    frameId: 0,
    url: h.tabs.get(7).url,
    tab: { id: 7 },
});
export const extension = {
    id: "test",
    url: "chrome-extension://test/popup/popup.html",
};
export const message = (input, from = sender()) =>
    new Promise((resolve) => h.listeners.message(input, from, resolve));
export const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

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
    chrome.tabs.sendMessage.mockImplementation(async (_tab, payload) => ({
        visible: h.visible,
        consentShown:
            h.visible &&
            payload.view === "prompt" &&
            !payload.disconnected &&
            !payload.agendaPanel &&
            !payload.policyRequired &&
            Boolean(payload.shortcut),
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
export async function arm() {
    await h.listeners.updated(7, { status: "complete" }, h.tabs.get(7));
}
export const startFromPopup = (payload = {}) =>
    message(
        {
            type: "start-recording",
            payload: {
                tabId: 7,
                noticeAcknowledgedAt: "2026-10-20T12:30:00Z",
                ...payload,
            },
        },
        extension,
    );

export const offscreen = {
    id: "test",
    url: "chrome-extension://test/offscreen/offscreen.html",
};

export function mockToolbarFrames() {
    vi.stubGlobal(
        "OffscreenCanvas",
        class {
            getContext() {
                return {
                    fillStyle: "#000",
                    drawImage() {},
                    clearRect() {},
                    beginPath() {},
                    roundRect() {},
                    fill() {},
                    getImageData(_x, _y, width) {
                        return { width, fillStyle: this.fillStyle };
                    },
                };
            }
        },
    );
    vi.stubGlobal(
        "createImageBitmap",
        vi.fn(async () => ({ close() {} })),
    );
    const fetchOriginal = globalThis.fetch;
    vi.stubGlobal("fetch", (url, ...args) =>
        String(url).startsWith("chrome-extension://test/icons/")
            ? Promise.resolve(new Response("toolbar icon"))
            : fetchOriginal(url, ...args),
    );
}
