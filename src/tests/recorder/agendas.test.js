import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    AGENDA_CACHE_KEY,
    AGENDA_PANEL_KEY,
    agendaCompletion,
    agendaFolder,
    agendaPanelKey,
    agendaRequest,
    clearAgendas,
    currentAgendas,
    matchAgendas,
    openAgendaPanel,
    refreshAgendas,
    remindAgenda,
    supportsAgendas,
} from "../../../extensions/recorder/lib/agendas.js";
import { refreshServerConfig } from "../../../extensions/recorder/lib/pairing.js";

vi.mock("../../../extensions/recorder/lib/token-vault.js", () => ({
    readToken: vi.fn(async () => "test-token"),
}));

let local;
let session;
const now = Date.parse("2026-10-27T09:00:00Z");
const meeting = {
    id: "agenda-one",
    title: "Acme review",
    start: "2026-10-27T09:10:00Z",
    end: "2026-10-27T10:00:00Z",
    timeSet: true,
    counts: { points: 3, tasks: 2 },
    folders: [{ id: "folder-one", name: "Acme" }],
    folderPath: "Clients / Acme",
};
const area = (data) => ({
    get: vi.fn(async () => structuredClone(data)),
    set: vi.fn(async (patch) => Object.assign(data, patch)),
    remove: vi.fn(async (keys) => {
        for (const key of [keys].flat()) delete data[key];
    }),
});
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    local = {
        serverUrl: "https://recorder.example.com",
        encryptedApiKey: { ciphertext: "test" },
        dataUseAcknowledgedAt: "2026-10-26T12:00:00Z",
        serverDefaults: { agendas: true },
    };
    session = {};
    vi.stubGlobal("chrome", {
        i18n: {
            getMessage: (key, values) =>
                `${key}${values ? `:${[values].flat().join("|")}` : ""}`,
        },
        storage: { local: area(local), session: area(session) },
        alarms: {
            getAll: vi.fn(async () => [
                { name: "agenda:old" },
                { name: "upload-retry" },
            ]),
            clear: vi.fn(async () => true),
            create: vi.fn(async () => {}),
        },
        notifications: {
            create: vi.fn(async () => "notice"),
            clear: vi.fn(async () => true),
            getAll: vi.fn(async () => ({
                "agenda:old": {},
                "completed:one": {},
            })),
        },
        runtime: { getURL: (path) => `chrome-extension://test/${path}` },
        sidePanel: {
            setOptions: vi.fn(async () => {}),
            open: vi.fn(async () => {}),
        },
        windows: {
            WINDOW_ID_CURRENT: -2,
            getLastFocused: vi.fn(async () => ({
                left: 0,
                top: 0,
                width: 1200,
                height: 900,
            })),
            create: vi.fn(async () => ({ id: 4 })),
        },
    });
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ data: [meeting] })),
    );
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("released-server compatibility", () => {
    it.each([
        undefined,
        {},
        { agendas: false },
    ])("requires an explicit capability: %j", async (defaults) => {
        local.serverDefaults = defaults;
        expect(supportsAgendas({ ...local, hasApiKey: true })).toBe(false);
        expect(
            await matchAgendas("https://meet.google.com/abc-defg-hij"),
        ).toEqual([]);
        await expect(agendaRequest("/one")).rejects.toThrow(
            "agendaUnsupported",
        );
        await refreshAgendas();
        expect(fetch).not.toHaveBeenCalled();
        expect(chrome.alarms.create).not.toHaveBeenCalled();
        expect(
            agendaCompletion(
                { ...local, hasApiKey: true },
                { agendaId: "one" },
            ),
        ).toEqual({});
    });
    it.each([
        "dataUseAcknowledgedAt",
        "encryptedApiKey",
        "serverUrl",
    ])("does not use agendas without %s", async (key) => {
        delete local[key];
        await refreshAgendas();
        expect(fetch).not.toHaveBeenCalled();
    });
    it("omits absent agenda selections and includes only a supported selection", () => {
        const settings = { ...local, hasApiKey: true };
        expect(agendaCompletion(settings, {})).toEqual({});
        expect(agendaCompletion(settings, { agendaId: null })).toEqual({});
        expect(agendaCompletion(settings, { agendaId: "one" })).toEqual({});
        expect(
            agendaCompletion(settings, {
                agendaId: null,
                agendaExplicit: true,
            }),
        ).toEqual({ agendaId: null });
        expect(
            agendaCompletion(settings, {
                agendaId: "one",
                agendaExplicit: true,
            }),
        ).toEqual({
            agendaId: "one",
        });
        expect(
            agendaCompletion(
                { ...settings, serverDefaults: {} },
                { agendaId: null, agendaExplicit: true },
            ),
        ).toEqual({});
    });
});

describe("matching and folders", () => {
    it("sends only the Meet code and time to the paired server", async () => {
        expect(
            await matchAgendas(
                "https://meet.google.com/abc-defg-hij?password=private#secret",
            ),
        ).toEqual([meeting]);
        const [url, options] = fetch.mock.calls[0];
        const parsed = new URL(url);
        expect(parsed.origin).toBe(local.serverUrl);
        expect(parsed.searchParams.get("meetCode")).toBe("abc-defg-hij");
        expect(parsed.searchParams.get("at")).toBe(new Date(now).toISOString());
        expect(url).not.toMatch(/password|private|secret|meet.google.com/);
        expect(options.headers.get("Authorization")).toBe("Bearer test-token");
    });
    it("keeps multiple time matches for Teams instead of choosing silently", async () => {
        fetch.mockResolvedValueOnce(
            Response.json({ data: [meeting, { ...meeting, id: "second" }] }),
        );
        expect(
            await matchAgendas(
                "https://teams.microsoft.com/l/meetup-join/room",
            ),
        ).toHaveLength(2);
        expect(
            new URL(fetch.mock.calls[0][0]).searchParams.has("meetCode"),
        ).toBe(false);
    });
    it("never falls back from an invalid Meet room to time matching", async () => {
        expect(await matchAgendas("https://meet.google.com/landing")).toEqual(
            [],
        );
        expect(fetch).not.toHaveBeenCalled();
    });
    it("limits popup agendas to running meetings or the next fifteen minutes", () => {
        expect(
            currentAgendas(
                [
                    meeting,
                    { ...meeting, id: "later", start: "2026-10-27T09:16:00Z" },
                    {
                        ...meeting,
                        id: "ended",
                        end: new Date(now).toISOString(),
                    },
                    { ...meeting, id: "untimed", start: null },
                    { ...meeting, id: "held", state: "held" },
                ],
                now,
            ),
        ).toEqual([meeting]);
    });
    it("preselects the agenda folder and preserves an unfiled agenda", () => {
        expect(agendaFolder(meeting)).toEqual({
            folderId: "folder-one",
            folderLabel: "Clients / Acme",
        });
        expect(agendaFolder({ folders: [] })).toEqual({});
    });
});

describe("reminder lifecycle", () => {
    it("fetches the next 24 hours and schedules one minute before a timed start", async () => {
        fetch.mockResolvedValueOnce(
            Response.json({
                data: [
                    meeting,
                    { ...meeting, id: "untimed", timeSet: false },
                    {
                        ...meeting,
                        id: "past",
                        start: new Date(now - 60000).toISOString(),
                    },
                ],
            }),
        );
        await refreshAgendas();
        const query = new URL(fetch.mock.calls[0][0]).searchParams;
        expect(
            Date.parse(query.get("to")) - Date.parse(query.get("from")),
        ).toBe(86400000);
        expect(chrome.alarms.create).toHaveBeenCalledExactlyOnceWith(
            "agenda:agenda-one",
            { when: Date.parse(meeting.start) - 60000 },
        );
        expect(chrome.alarms.clear).toHaveBeenCalledWith("agenda:old");
        expect(chrome.alarms.clear).not.toHaveBeenCalledWith("upload-retry");
        expect(
            session[AGENDA_CACHE_KEY].agendas.some(
                (row) => row.id === "untimed",
            ),
        ).toBe(false);
    });
    it("turning reminders off clears alarms and keeps agendas available", async () => {
        local.agendaReminders = false;
        await refreshAgendas();
        expect(chrome.alarms.create).not.toHaveBeenCalled();
        expect(session[AGENDA_CACHE_KEY].agendas).toEqual([meeting]);
        await remindAgenda(meeting.id);
        expect(chrome.notifications.create).not.toHaveBeenCalled();
    });
    it("shows localized title, time, counts and a Show agenda action", async () => {
        await refreshAgendas();
        await remindAgenda(meeting.id);
        expect(chrome.notifications.create).toHaveBeenCalledWith(
            "agenda:agenda-one",
            expect.objectContaining({
                title: expect.stringContaining(meeting.title),
                message: "agendaCounts:3|2",
                buttons: [
                    { title: "agendaShow" },
                    { title: "meetingPromptDismiss" },
                ],
            }),
        );
    });
    it("does not notify a stale agenda after a server change or suspension beyond its start", async () => {
        await refreshAgendas();
        local.serverUrl = "https://other.example.com";
        await remindAgenda(meeting.id);
        local.serverUrl = "https://recorder.example.com";
        vi.setSystemTime(Date.parse(meeting.start) + 120000);
        await remindAgenda(meeting.id);
        expect(chrome.notifications.create).not.toHaveBeenCalled();
    });
    it("clears private cached content, choices and notifications on disconnect", async () => {
        session[AGENDA_CACHE_KEY] = { agendas: [meeting] };
        session[AGENDA_PANEL_KEY] = { agendaIds: [meeting.id] };
        session[agendaPanelKey(7)] = { agendaIds: [meeting.id] };
        session[agendaPanelKey(8)] = { agendaIds: ["other"] };
        session[agendaPanelKey()] = { agendaIds: ["fallback"] };
        await clearAgendas();
        expect(session).toEqual({});
        expect(chrome.notifications.clear).toHaveBeenCalledExactlyOnceWith(
            "agenda:old",
        );
    });
    it("ignores a refresh that finishes after pairing changes", async () => {
        fetch.mockImplementationOnce(async () => {
            local.encryptedApiKey = { ciphertext: "different-user" };
            return Response.json({ data: [meeting] });
        });
        await refreshAgendas();
        expect(session[AGENDA_CACHE_KEY]).toBeUndefined();
        expect(chrome.alarms.create).not.toHaveBeenCalled();
    });
});

describe("panel gesture and fallback", () => {
    it("enables only the clicked tab and opens synchronously before storage or setOptions settles", async () => {
        const order = [];
        let enable;
        chrome.sidePanel.setOptions.mockImplementation(() => {
            order.push("enable");
            return new Promise((resolve) => {
                enable = resolve;
            });
        });
        chrome.sidePanel.open.mockImplementation(() => {
            order.push("open");
            return Promise.resolve();
        });
        chrome.storage.session.set.mockImplementation(async () => {
            order.push("store");
        });
        const result = openAgendaPanel({ tabId: 7 }, [meeting.id]);
        expect(order).toEqual(["enable", "open"]);
        expect(chrome.sidePanel.setOptions).toHaveBeenCalledExactlyOnceWith({
            tabId: 7,
            path: "agenda/agenda.html?tab=7",
            enabled: true,
        });
        expect(chrome.sidePanel.open).toHaveBeenCalledWith({ tabId: 7 });
        enable();
        await result;
        expect(order).toEqual(["enable", "open", "store"]);
        expect(chrome.windows.create).not.toHaveBeenCalled();
    });
    it("keeps two tab panels and the fallback window in separate contexts", async () => {
        await openAgendaPanel({ tabId: 7 }, [meeting.id]);
        await openAgendaPanel({ tabId: 8 }, ["agenda-two"]);
        chrome.sidePanel.open.mockRejectedValueOnce(new Error("No gesture"));
        await openAgendaPanel({ tabId: 8, matchTabId: 7 }, ["fallback"]);
        expect(session[agendaPanelKey(7)].agendaIds).toEqual([meeting.id]);
        expect(session[agendaPanelKey(8)].agendaIds).toEqual(["agenda-two"]);
        expect(session[agendaPanelKey()]).toMatchObject({
            agendaIds: ["fallback"],
            tabId: 7,
        });
        expect(chrome.sidePanel.setOptions).toHaveBeenCalledWith({
            tabId: 8,
            path: "agenda/agenda.html?tab=8",
            enabled: true,
        });
        expect(chrome.windows.create).toHaveBeenCalledWith(
            expect.objectContaining({
                url: "chrome-extension://test/agenda/agenda.html",
            }),
        );
    });
    it("falls back if enabling the tab fails", async () => {
        chrome.sidePanel.setOptions.mockRejectedValueOnce(
            new Error("Tab closed"),
        );
        await openAgendaPanel({ tabId: 7 }, [meeting.id]);
        expect(chrome.windows.create).toHaveBeenCalled();
    });
    it.each([
        "throw",
        "reject",
    ])("opens the same packaged page in a centered window on %s", async (failure) => {
        chrome.sidePanel.open.mockImplementation(() => {
            if (failure === "throw") throw new Error("No gesture");
            return Promise.reject(new Error("No gesture"));
        });
        await openAgendaPanel({}, [meeting.id]);
        expect(chrome.sidePanel.open).toHaveBeenCalledWith({ windowId: -2 });
        expect(chrome.sidePanel.setOptions).not.toHaveBeenCalled();
        expect(chrome.windows.create).toHaveBeenCalledWith(
            expect.objectContaining({
                url: "chrome-extension://test/agenda/agenda.html",
                type: "popup",
                width: 430,
                height: 640,
                left: 385,
                top: 130,
            }),
        );
        expect(session[agendaPanelKey()].agendaIds).toEqual([meeting.id]);
    });
});

describe("configuration capability negotiation", () => {
    it("persists support and fetches agendas as part of configuration refresh", async () => {
        fetch.mockResolvedValueOnce(
            Response.json({
                encrypted_recording_protocol: 1,
                features: { agendas: true },
            }),
        );
        await refreshServerConfig();
        expect(local.serverDefaults.agendas).toBe(true);
        expect(fetch.mock.calls[0][0]).toBe(
            "https://recorder.example.com/api/v1/recorder/config",
        );
        await vi.waitFor(() =>
            expect(fetch.mock.calls[1]?.[0]).toContain(
                "/api/v1/recorder/agendas?",
            ),
        );
        await refreshAgendas();
    });
    it("a released config removes stale support without attempting any new endpoint", async () => {
        session[AGENDA_CACHE_KEY] = {
            serverUrl: local.serverUrl,
            agendas: [meeting],
        };
        fetch.mockResolvedValueOnce(
            Response.json({ encrypted_recording_protocol: 1, defaults: {} }),
        );
        await refreshServerConfig();
        expect(local.serverDefaults.agendas).toBe(false);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(session[AGENDA_CACHE_KEY]).toBeUndefined();
    });
});

describe("pairing identity", () => {
    it("rejects a response received after switching accounts on the same server", async () => {
        local.encryptedApiKey.nonce = [1, 2, 3];
        fetch.mockImplementationOnce(async () => {
            local.encryptedApiKey = {
                nonce: [4, 5, 6],
                ciphertext: "other-account",
            };
            return Response.json({ data: [meeting] });
        });
        await expect(agendaRequest("/match")).rejects.toThrow(
            "agendaUnsupported",
        );
    });
    it("does not show a reminder cached under another token nonce", async () => {
        local.encryptedApiKey.nonce = [1, 2, 3];
        await refreshAgendas();
        expect(session[AGENDA_CACHE_KEY].connectionId).toBe("1.2.3");
        local.encryptedApiKey.nonce = [4, 5, 6];
        await remindAgenda(meeting.id);
        expect(chrome.notifications.create).not.toHaveBeenCalled();
    });
});

describe("reminder refresh regressions", () => {
    it("limits routine refreshes to once per 30 minutes and allows a popup refresh", async () => {
        await refreshAgendas();
        await refreshAgendas();
        expect(fetch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(30 * 60000);
        await refreshAgendas();
        expect(fetch).toHaveBeenCalledTimes(2);
        await refreshAgendas({ force: true });
        expect(fetch).toHaveBeenCalledTimes(3);
    });
    it("preserves alarms and shown reminders when refreshed agendas are unchanged", async () => {
        await refreshAgendas();
        chrome.alarms.get = vi.fn(async () => ({
            name: "agenda:agenda-one",
            scheduledTime: Date.parse(meeting.start) - 60000,
        }));
        chrome.alarms.getAll.mockResolvedValue([
            {
                name: "agenda:agenda-one",
                scheduledTime: Date.parse(meeting.start) - 60000,
            },
        ]);
        chrome.notifications.getAll.mockResolvedValue({
            "agenda:agenda-one": {},
        });
        chrome.alarms.clear.mockClear();
        chrome.alarms.create.mockClear();
        chrome.notifications.clear.mockClear();
        await refreshAgendas({ force: true });
        expect(chrome.alarms.clear).not.toHaveBeenCalled();
        expect(chrome.alarms.create).not.toHaveBeenCalled();
        expect(chrome.notifications.clear).not.toHaveBeenCalled();
    });
    it("times out a hanging refresh without blocking config or pairing", async () => {
        fetch
            .mockResolvedValueOnce(
                Response.json({ features: { agendas: true } }),
            )
            .mockImplementationOnce(() => new Promise(() => {}));
        await refreshServerConfig();
        await vi.advanceTimersByTimeAsync(0);
        const refresh = refreshAgendas();
        const assertion = expect(refresh).rejects.toThrow("timed out");
        await vi.advanceTimersByTimeAsync(5000);
        await assertion;
    });
});
