import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { agendaPanelKey } from "../../../extensions/recorder/lib/agendas.js";
import {
    clearJoinedMeeting,
    joinedMeeting,
    joinMeeting,
    MEETING_END_PREFIX,
    publishJoinedMeeting,
    reconcileJoinedMeetings,
} from "../../../extensions/recorder/lib/join-meeting.js";
import { joinMeetingFromPage } from "../../../extensions/recorder/lib/join-meeting-page.js";

let stored;
let local;
let meeting;
let tabs;
let nextTabId;
const settings = () => ({
    serverUrl: local.serverUrl,
    connectionId: "1",
    dataUseAcknowledgedAt: "now",
    hasApiKey: true,
});
beforeEach(() => {
    stored = {};
    tabs = new Map([[7, { id: 7, windowId: 3 }]]);
    nextTabId = 8;
    local = {
        serverUrl: "https://example.com",
        encryptedApiKey: { nonce: [1] },
        dataUseAcknowledgedAt: "now",
    };
    meeting = {
        serverUrl: local.serverUrl,
        connectionId: "1",
        eventId: "event",
        agendaId: "agenda",
        joinUrl:
            "https://meet.google.com/abc-defg-hij?authuser=test%40example.com",
        end: new Date(Date.now() + 3600000).toISOString(),
    };
    vi.stubGlobal("chrome", {
        storage: {
            local: { get: async () => local },
            session: {
                get: async () => structuredClone(stored),
                set: async (patch) => Object.assign(stored, patch),
                remove: async (keys) => {
                    for (const key of [keys].flat()) delete stored[key];
                },
            },
        },
        tabs: {
            create: vi.fn(async (options) => {
                const tab = {
                    id: nextTabId++,
                    windowId: options.windowId ?? 3,
                    url: options.url,
                };
                tabs.set(tab.id, tab);
                return tab;
            }),
            get: vi.fn(async (id) => {
                if (!tabs.has(id)) throw new Error("Tab closed");
                return tabs.get(id);
            }),
            query: vi.fn(async () => [...tabs.values()]),
            update: vi.fn(async (id, patch) =>
                Object.assign(tabs.get(id), patch),
            ),
        },
        sidePanel: {
            setOptions: vi.fn(async () => {}),
            close: vi.fn(async () => {}),
            open: vi.fn(async () => {}),
        },
        alarms: { create: vi.fn(async () => {}), clear: vi.fn(async () => {}) },
        windows: {
            WINDOW_ID_CURRENT: -2,
            get: vi.fn(async (id) => ({ id })),
            getAll: vi.fn(async () => [{ id: 3 }, { id: 4 }]),
            getLastFocused: vi.fn(async () => ({ id: 3 })),
            create: vi.fn(async () => ({ id: 20 })),
        },
        runtime: {
            getURL: (path) => `chrome-extension://test/${path}`,
            getContexts: vi.fn(async () => []),
            sendMessage: vi.fn(async ({ tabId, fallback }) => {
                await publishJoinedMeeting(meeting, tabId);
                if (fallback) {
                    await chrome.tabs.update(tabId, { active: true });
                    await chrome.windows.create({ type: "popup" });
                }
                return { ok: true };
            }),
        },
    });
});
afterEach(() => vi.unstubAllGlobals());

it("opens the panel from the side panel page before worker publication and preserves the old panel", async () => {
    stored[agendaPanelKey(7)] = { agendaIds: ["old"], tabId: 7 };
    await joinMeetingFromPage(meeting, { windowId: 3 });
    expect(chrome.tabs.create).toHaveBeenCalledExactlyOnceWith({
        url: meeting.joinUrl,
        active: true,
        windowId: 3,
    });
    expect(chrome.sidePanel.setOptions).toHaveBeenCalledExactlyOnceWith({
        tabId: 8,
        path: "agenda/agenda.html?tab=8",
        enabled: true,
    });
    expect(chrome.sidePanel.open).toHaveBeenCalledExactlyOnceWith({ tabId: 8 });
    expect(chrome.sidePanel.open.mock.invocationCallOrder[0]).toBeLessThan(
        chrome.runtime.sendMessage.mock.invocationCallOrder[0],
    );
    expect(stored[agendaPanelKey(7)]).toEqual({ agendaIds: ["old"], tabId: 7 });
    expect(stored[agendaPanelKey(8)]).toMatchObject({
        agendaIds: ["agenda"],
        roomCode: "abc-defg-hij",
        tabId: 8,
    });
    expect(stored["agenda-route:8"]).toEqual(stored[agendaPanelKey(8)]);
});

it("keeps the popup alive by publishing and opening on an inactive tab before activation", async () => {
    await joinMeetingFromPage(meeting, { popup: true, windowId: 3 });
    expect(chrome.tabs.create).toHaveBeenCalledExactlyOnceWith({
        url: meeting.joinUrl,
        active: false,
        windowId: 3,
    });
    const publishOrder = chrome.runtime.sendMessage.mock.invocationCallOrder[0];
    const registerOrder =
        chrome.sidePanel.setOptions.mock.invocationCallOrder[0];
    const openOrder = chrome.sidePanel.open.mock.invocationCallOrder[0];
    expect(publishOrder).toBeLessThan(registerOrder);
    expect(registerOrder).toBeLessThan(openOrder);
    expect(openOrder).toBeLessThan(
        chrome.tabs.update.mock.invocationCallOrder[0],
    );
    expect(chrome.tabs.update).toHaveBeenCalledExactlyOnceWith(8, {
        active: true,
    });
});

it("waits for popup publication and panel registration to finish", async () => {
    let finishPublish;
    let finishRegistration;
    chrome.runtime.sendMessage.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                finishPublish = resolve;
            }),
    );
    chrome.sidePanel.setOptions.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                finishRegistration = resolve;
            }),
    );
    const work = joinMeetingFromPage(meeting, { popup: true });
    await vi.waitFor(() => expect(finishPublish).toBeTypeOf("function"));
    expect(chrome.sidePanel.setOptions).not.toHaveBeenCalled();
    finishPublish({ ok: true });
    await vi.waitFor(() => expect(finishRegistration).toBeTypeOf("function"));
    expect(chrome.sidePanel.open).not.toHaveBeenCalled();
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    finishRegistration();
    await work;
});

it("joins from a Calendar notification without calling any panel API or fallback", async () => {
    await joinMeeting(async () => meeting);
    expect(chrome.tabs.create).toHaveBeenCalledExactlyOnceWith({
        url: meeting.joinUrl,
    });
    expect(chrome.sidePanel.open).not.toHaveBeenCalled();
    expect(chrome.sidePanel.setOptions).not.toHaveBeenCalled();
    expect(chrome.windows.create).not.toHaveBeenCalled();
    expect(stored["meeting-tab:8"]).toEqual({
        agendaId: "agenda",
        roomCode: "abc-defg-hij",
        end: meeting.end,
        serverUrl: local.serverUrl,
        connectionId: "1",
    });
    expect(chrome.alarms.create).toHaveBeenCalledWith(
        `${MEETING_END_PREFIX}8`,
        { when: Date.parse(meeting.end) },
    );
});

it.each([
    false,
    true,
])("falls back through the worker without losing the binding (popup=%s)", async (popup) => {
    chrome.sidePanel.open.mockRejectedValueOnce(new Error("No gesture"));
    await joinMeetingFromPage(meeting, { popup });
    expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith({
        type: "join-meeting",
        eventId: "event",
        tabId: 8,
        fallback: true,
    });
    expect(chrome.windows.create).toHaveBeenCalled();
    expect(stored["meeting-tab:8"].agendaId).toBe("agenda");
    expect(stored["agenda-route:8"].agendaIds).toEqual(["agenda"]);
});

it.each([
    "missing",
    "registration",
])("falls back when the panel API is %s", async (kind) => {
    if (kind === "missing") delete chrome.sidePanel;
    else
        chrome.sidePanel.setOptions.mockRejectedValueOnce(
            new Error("Unavailable"),
        );
    await joinMeetingFromPage(meeting);
    expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ fallback: true }),
    );
    expect(stored["meeting-tab:8"].agendaId).toBe("agenda");
});

it.each([
    false,
    true,
])("joins an agenda-less meeting without a panel (popup=%s)", async (popup) => {
    meeting.agendaId = null;
    await joinMeetingFromPage(meeting, { popup });
    expect(chrome.sidePanel.open).not.toHaveBeenCalled();
    expect(stored["meeting-tab:8"].agendaId).toBeNull();
    expect(stored["agenda-route:8"]).toBeUndefined();
    if (popup)
        expect(chrome.tabs.update).toHaveBeenCalledWith(8, { active: true });
});

it.each([
    "",
    "meet/",
])("retains identity through /%s<code> redirects and a different authuser", async (prefix) => {
    await joinMeeting(async () => meeting);
    expect(
        await joinedMeeting(
            {
                id: 8,
                url: `https://meet.google.com/${prefix}abc-defg-hij/?authuser=1#joined`,
            },
            settings(),
        ),
    ).toMatchObject({ agendaId: "agenda" });
});

it.each([
    "https://meet.google.com/xyz-abcd-efg",
    "https://meet.google.com/",
    "https://example.com",
])("clears identity when leaving the room for %s", async (url) => {
    await joinMeeting(async () => meeting);
    expect(await joinedMeeting({ id: 8, url }, settings())).toBeNull();
    expect(stored["meeting-tab:8"]).toBeUndefined();
    expect(stored[agendaPanelKey(8)]).toBeUndefined();
    expect(stored["agenda-route:8"]).toBeUndefined();
});

it.each([
    "end",
    "pairing",
    "consent",
])("expires the binding after %s changes", async (change) => {
    await joinMeeting(async () => meeting);
    const current = settings();
    if (change === "end")
        stored["meeting-tab:8"].end = new Date(Date.now() - 1).toISOString();
    if (change === "pairing") current.connectionId = "2";
    if (change === "consent") current.dataUseAcknowledgedAt = null;
    expect(
        await joinedMeeting({ id: 8, url: meeting.joinUrl }, current),
    ).toBeNull();
    expect(stored["meeting-tab:8"]).toBeUndefined();
});

it("clears the closed tab or end alarm's binding without affecting another meeting", async () => {
    await joinMeeting(async () => meeting);
    await joinMeeting(async () => ({ ...meeting, agendaId: "other" }));
    await clearJoinedMeeting(8);
    expect(stored["meeting-tab:8"]).toBeUndefined();
    expect(stored["meeting-tab:9"].agendaId).toBe("other");
    expect(stored[agendaPanelKey(9)].agendaIds).toEqual(["other"]);
    expect(chrome.alarms.clear).toHaveBeenCalledWith(`${MEETING_END_PREFIX}8`);
    expect(chrome.sidePanel.setOptions).not.toHaveBeenCalled();
});

it.each([
    ["recording", false],
    ["recording", true],
    ["finalizing", true],
])("keeps the recording panel when the meeting ends (%s, stopped=%s)", async (state, stopped) => {
    await joinMeeting(async () => meeting);
    stored.recordingState = { state, stopped, tabId: 8, agendaId: "agenda" };
    const context = structuredClone(stored[agendaPanelKey(8)]);
    await clearJoinedMeeting(8);
    expect(stored["meeting-tab:8"]).toBeUndefined();
    expect(stored[agendaPanelKey(8)]).toEqual(context);
    expect(stored["agenda-route:8"]).toEqual(context);
    expect(chrome.alarms.clear).toHaveBeenCalledWith(`${MEETING_END_PREFIX}8`);
});

it("keeps the recording panel when worker wake discovers an expired meeting", async () => {
    await joinMeeting(async () => meeting);
    stored.recordingState = {
        state: "recording",
        tabId: 8,
        agendaId: "agenda",
    };
    stored["meeting-tab:8"].end = new Date(Date.now() - 1).toISOString();
    const context = structuredClone(stored[agendaPanelKey(8)]);
    await reconcileJoinedMeetings();
    expect(stored["meeting-tab:8"]).toBeUndefined();
    expect(stored[agendaPanelKey(8)]).toEqual(context);
    expect(stored["agenda-route:8"]).toEqual(context);
});

it.each([
    { state: "recording", tabId: 9, agendaId: "agenda" },
    { state: "idle", tabId: 8, agendaId: "agenda" },
    { state: "completed", tabId: 8, agendaId: "agenda" },
    { state: "recording", tabId: 8, agendaId: null },
])("clears expired panel context without an active agenda recording: %j", async (state) => {
    await joinMeeting(async () => meeting);
    stored.recordingState = state;
    await clearJoinedMeeting(8);
    expect(stored[agendaPanelKey(8)]).toBeUndefined();
    expect(stored["agenda-route:8"]).toBeUndefined();
});

it.each([
    "pairing",
    "expired",
    "invalid room",
])("refuses %s before creating a notification Join tab", async (kind) => {
    if (kind === "pairing") meeting.connectionId = "old";
    if (kind === "expired")
        meeting.end = new Date(Date.now() - 1).toISOString();
    if (kind === "invalid room") meeting.joinUrl = "https://example.com";
    await expect(joinMeeting(async () => meeting)).rejects.toThrow(
        "Meeting unavailable",
    );
    expect(chrome.tabs.create).not.toHaveBeenCalled();
});

it("keeps the binding while Chrome reports a pending room URL", async () => {
    await joinMeeting(async () => meeting);
    expect(
        await joinedMeeting(
            { id: 8, url: "", pendingUrl: meeting.joinUrl },
            settings(),
        ),
    ).toMatchObject({ agendaId: "agenda" });
});

it.each([
    "closed",
    "other room",
    "other site",
    "pending navigation",
    "pairing",
])("refuses publication after %s before the write", async (reason) => {
    const tab = await chrome.tabs.create({ url: meeting.joinUrl });
    if (reason === "closed") {
        tabs.delete(tab.id);
        await clearJoinedMeeting(tab.id);
    }
    if (reason === "other room")
        tab.url = "https://meet.google.com/xyz-abcd-efg";
    if (reason === "other site") tab.url = "https://example.com";
    if (reason === "pending navigation") tab.pendingUrl = "https://example.com";
    if (reason === "pairing") local.encryptedApiKey.nonce = [2];
    await expect(publishJoinedMeeting(meeting, tab.id)).rejects.toThrow(
        "Meeting unavailable",
    );
    expect(stored["meeting-tab:8"]).toBeUndefined();
    expect(stored[agendaPanelKey(8)]).toBeUndefined();
    expect(stored["agenda-route:8"]).toBeUndefined();
    expect(chrome.alarms.create).not.toHaveBeenCalled();
});

it("serializes removal during publication and removes every published field", async () => {
    let finishWrite;
    const set = chrome.storage.session.set;
    chrome.storage.session.set = async (patch) => {
        if (patch["meeting-tab:8"])
            await new Promise((resolve) => {
                finishWrite = resolve;
            });
        return set(patch);
    };
    const work = joinMeeting(async () => meeting);
    await vi.waitFor(() => expect(finishWrite).toBeTypeOf("function"));
    tabs.delete(8);
    const removal = clearJoinedMeeting(8);
    finishWrite();
    await Promise.all([work, removal]);
    expect(stored["meeting-tab:8"]).toBeUndefined();
    expect(stored[agendaPanelKey(8)]).toBeUndefined();
    expect(stored["agenda-route:8"]).toBeUndefined();
    expect(chrome.alarms.clear).toHaveBeenCalledWith(`${MEETING_END_PREFIX}8`);
});

it.each([
    "closed",
    "expired",
    "pairing",
    "left room",
    "live",
])("reconciles only the tab binding on worker wake: %s", async (reason) => {
    await joinMeeting(async () => meeting);
    if (reason === "closed") tabs.delete(8);
    if (reason === "expired")
        stored["meeting-tab:8"].end = new Date(Date.now() - 1).toISOString();
    if (reason === "pairing") local.encryptedApiKey.nonce = [2];
    if (reason === "left room") tabs.get(8).url = "https://example.com";
    await reconcileJoinedMeetings();
    if (reason === "live")
        expect(stored["meeting-tab:8"].agendaId).toBe("agenda");
    else expect(stored["meeting-tab:8"]).toBeUndefined();
    expect(chrome.sidePanel.open).not.toHaveBeenCalled();
    expect(chrome.sidePanel.setOptions).not.toHaveBeenCalled();
});
