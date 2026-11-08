import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
    settings: null,
    request: vi.fn(),
    token: vi.fn(),
    local: {},
    session: {},
    alarms: new Map(),
}));
vi.mock("../../../extensions/recorder/lib/settings.js", () => ({
    getSettings: async () => ({ ...h.settings }),
}));
vi.mock("../../../extensions/recorder/lib/token-vault.js", () => ({
    readToken: h.token,
}));
vi.mock("../../../extensions/recorder/lib/api.js", () => ({
    request: h.request,
}));

import { subscribeAgenda } from "../../../extensions/recorder/lib/agenda-live.js";
import {
    refreshAgendas,
    remindAgenda,
} from "../../../extensions/recorder/lib/agendas.js";
import { refreshNextMeeting } from "../../../extensions/recorder/lib/next-meeting.js";

let stop;
beforeEach(() => {
    h.session = {};
    h.local = {};
    h.alarms.clear();
    h.request.mockReset();
    h.token.mockReset();
    h.settings = {
        serverUrl: "https://old.example.com",
        connectionId: "old",
        dataUseAcknowledgedAt: "yes",
        hasApiKey: true,
        agendaReminders: true,
        meetingNotifications: true,
        meetingLeadMinutes: 0,
        serverDefaults: { agendas: true, agendaLive: true, nextMeeting: true },
    };
    const area = (key) => ({
        get: async () => ({ ...h[key] }),
        set: async (p) => Object.assign(h[key], p),
        remove: async (keys) => {
            for (const key2 of [keys].flat()) delete h[key][key2];
        },
    });
    globalThis.chrome = {
        i18n: { getMessage: (k) => k },
        storage: { local: area("local"), session: area("session") },
        alarms: {
            getAll: async () => [...h.alarms.keys()].map((name) => ({ name })),
            get: async (name) => h.alarms.get(name),
            clear: async (name) => h.alarms.delete(name),
            create: async (name, data) => h.alarms.set(name, data),
        },
        notifications: {
            getAll: async () => ({}),
            clear: async () => {},
            create: vi.fn(),
        },
        action: {
            setBadgeText: async () => {},
            setBadgeBackgroundColor: async () => {},
        },
        tabs: { query: async () => [] },
    };
});
afterEach(() => {
    stop?.();
    stop = null;
    vi.useRealTimers();
});
const rePair = async () => {
    h.settings = {
        ...h.settings,
        serverUrl: "https://new.example.com",
        connectionId: "new",
    };
    return "NEW-SERVER-SECRET";
};
describe("pairing isolation and reminder fallback", () => {
    it("refuses an SSE request when pairing changes during the token read", async () => {
        h.token.mockImplementation(rePair);
        h.request.mockRejectedValue(new Error("fixture"));
        stop = subscribeAgenda("agenda", { invalidate: async () => {} });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(h.request).not.toHaveBeenCalled();
    });
    it("refuses a Calendar request when pairing changes during the token read", async () => {
        h.token.mockImplementation(rePair);
        h.request.mockResolvedValue({ json: async () => ({ data: null }) });
        await refreshNextMeeting();
        expect(h.request).not.toHaveBeenCalled();
    });
    it.each([
        "not_connected",
        "not_configured",
        "hosted",
        "no_calendar_scope",
        "calendar_unavailable",
    ])("keeps reminders without a Calendar replacement: %s", async (reason) => {
        vi.useFakeTimers();
        h.token.mockResolvedValue("key");
        h.alarms.set("agenda:one", { when: Date.now() + 60000 });
        h.request.mockImplementation(async (_auth, path) => ({
            json: async () =>
                path.includes("meetings/next")
                    ? { data: null, reason }
                    : {
                          data: [
                              {
                                  id: "one",
                                  timeSet: true,
                                  start: new Date(
                                      Date.now() + 60000,
                                  ).toISOString(),
                                  title: "Planning",
                              },
                          ],
                      },
        }));
        await refreshNextMeeting();
        await refreshAgendas({ force: true });
        expect(h.alarms.has("agenda:one")).toBe(true);
        vi.setSystemTime(new Date(Date.now() + 60000));
        await remindAgenda("one");
        expect(chrome.notifications.create).toHaveBeenCalledOnce();
    });
});

it("suppresses only the covered agenda occurrence and shares lead/opt-out with fallback reminders", async () => {
    vi.useFakeTimers();
    const start = new Date(Date.now() + 10 * 60000).toISOString();
    const end = new Date(Date.now() + 60 * 60000).toISOString();
    h.settings.meetingLeadMinutes = 5;
    const meeting = {
        eventId: "event",
        agendaId: "covered",
        start,
        end,
        title: "Planning",
        joinUrl:
            "https://meet.google.com/abc-defg-hij?authuser=test%40example.com",
        accountEmail: "test@example.com",
    };
    const agendas = ["covered", "manual", "non-meet"].map((id) => ({
        id,
        timeSet: true,
        start,
        end,
        title: id,
    }));
    h.token.mockResolvedValue("key");
    h.request.mockImplementation(async (_auth, path) => ({
        json: async () =>
            path.includes("meetings/next")
                ? { data: meeting }
                : { data: agendas },
    }));
    await refreshAgendas({ force: true });
    await refreshNextMeeting();
    expect(h.alarms.has("agenda:covered")).toBe(false);
    for (const id of ["manual", "non-meet"])
        expect(h.alarms.get(`agenda:${id}`)).toEqual({
            when: Date.parse(start) - 5 * 60000,
        });
    vi.setSystemTime(new Date(Date.parse(start) - 5 * 60000));
    await remindAgenda("covered");
    expect(chrome.notifications.create).not.toHaveBeenCalled();
    await remindAgenda("manual");
    await remindAgenda("manual");
    expect(chrome.notifications.create).toHaveBeenCalledOnce();
    h.settings.meetingNotifications = false;
    await remindAgenda("non-meet");
    expect(chrome.notifications.create).toHaveBeenCalledOnce();
});
it("does not suppress another occurrence of the same agenda", async () => {
    vi.useFakeTimers();
    h.token.mockResolvedValue("key");
    const start = new Date(Date.now() + 60000).toISOString();
    h.session.recorderNextMeeting = {
        serverUrl: h.settings.serverUrl,
        connectionId: h.settings.connectionId,
        fetchedAt: Date.now(),
        data: {
            agendaId: "one",
            start: new Date(Date.now() + 86400000).toISOString(),
        },
    };
    h.request.mockResolvedValue({
        json: async () => ({
            data: [{ id: "one", timeSet: true, start, title: "Planning" }],
        }),
    });
    await refreshAgendas({ force: true });
    expect(h.alarms.has("agenda:one")).toBe(true);
});

it("rechecks pairing during a stream reconnect", async () => {
    vi.useFakeTimers();
    h.token.mockResolvedValueOnce("old-key").mockImplementation(rePair);
    h.request.mockResolvedValue(
        new Response(
            new ReadableStream({
                start(controller) {
                    controller.enqueue(
                        new TextEncoder().encode(": connected\n\n"),
                    );
                    controller.close();
                },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
        ),
    );
    stop = subscribeAgenda("agenda", { invalidate: async () => {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.token).toHaveBeenCalledTimes(2);
    expect(h.request).toHaveBeenCalledOnce();
});

it("does not notify again when Calendar becomes available after the fallback reminder", async () => {
    vi.useFakeTimers();
    const start = new Date().toISOString();
    const end = new Date(Date.now() + 3600000).toISOString();
    h.token.mockResolvedValue("key");
    h.request.mockImplementation(async (_auth, path) => ({
        json: async () =>
            path.includes("meetings/next")
                ? {
                      data: {
                          eventId: "event",
                          agendaId: "one",
                          title: "Planning",
                          start,
                          end,
                          joinUrl:
                              "https://meet.google.com/abc-defg-hij?authuser=test%40example.com",
                          accountEmail: "test@example.com",
                      },
                  }
                : {
                      data: [
                          {
                              id: "one",
                              title: "Planning",
                              timeSet: true,
                              start,
                              end,
                          },
                      ],
                  },
    }));
    await refreshAgendas({ force: true });
    expect(chrome.notifications.create).not.toHaveBeenCalled();
    expect(h.alarms.has("agenda:one")).toBe(true);
    await remindAgenda("one");
    expect(chrome.notifications.create).toHaveBeenCalledOnce();
    await refreshNextMeeting();
    expect(chrome.notifications.create).toHaveBeenCalledOnce();
});
