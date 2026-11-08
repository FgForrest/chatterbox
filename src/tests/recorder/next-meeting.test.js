// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    cachedNextMeeting,
    clearNextMeeting,
    NEXT_BADGE,
    NEXT_MEETING_KEY,
    NEXT_START,
    notificationMeeting,
    notifyNextMeeting,
    refreshNextMeeting,
    roomIsOpen,
    updateNextMeetingBadge,
} from "../../../extensions/recorder/lib/next-meeting.js";
import { createNextMeetingCard } from "../../../extensions/recorder/lib/next-meeting-card.js";
import { getSettings } from "../../../extensions/recorder/lib/settings.js";

vi.mock("../../../extensions/recorder/lib/token-vault.js", () => ({
    readToken: async () => "test-token",
}));
let local;
let session;
let tabs;
let event;
const area = (data) => ({
    get: vi.fn(async () => structuredClone(data)),
    set: vi.fn(async (patch) => Object.assign(data, patch)),
    remove: vi.fn(async (keys) => {
        for (const key of [keys].flat()) delete data[key];
    }),
});
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T09:00:00Z"));
    local = {
        serverUrl: "https://recorder.example.com",
        encryptedApiKey: { nonce: [1] },
        dataUseAcknowledgedAt: "now",
        serverDefaults: { nextMeeting: true },
    };
    session = {};
    tabs = [{ id: 7, url: "https://example.com" }];
    event = {
        eventId: "event-one",
        title: "Acme planning",
        start: "2026-11-08T09:05:00Z",
        end: "2026-11-08T10:00:00Z",
        ongoing: false,
        joinUrl:
            "https://meet.google.com/abc-defg-hij?authuser=recorder%40example.com",
        accountEmail: "recorder@example.com",
        agendaId: "agenda-one",
    };
    vi.stubGlobal("chrome", {
        i18n: {
            getMessage: (key, values) => `${key}${values ? `:${values}` : ""}`,
        },
        storage: {
            local: area(local),
            session: area(session),
            onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
        },
        tabs: { query: vi.fn(async () => tabs), create: vi.fn() },
        action: {
            setBadgeText: vi.fn(async () => {}),
            setBadgeBackgroundColor: vi.fn(async () => {}),
        },
        alarms: {
            clear: vi.fn(async () => {}),
            create: vi.fn(async () => {}),
            getAll: vi.fn(async () => []),
        },
        notifications: {
            create: vi.fn(async () => {}),
            clear: vi.fn(async () => {}),
            getAll: vi.fn(async () => ({})),
        },
        runtime: { sendMessage: vi.fn(async () => ({ ok: true })) },
    });
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ data: event })),
    );
});
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
});

describe("Calendar capabilities and caching", () => {
    it("never calls the new endpoint on a released server", async () => {
        local.serverDefaults = { agendas: true };
        await refreshNextMeeting({ opened: true });
        expect(fetch).not.toHaveBeenCalled();
    });
    it("coalesces page opens, refreshes only after 60 seconds, and limits background refresh to five minutes", async () => {
        await Promise.all([
            refreshNextMeeting({ opened: true }),
            refreshNextMeeting({ opened: true }),
        ]);
        await refreshNextMeeting({ opened: true });
        expect(fetch).toHaveBeenCalledTimes(1);
        vi.setSystemTime(new Date(Date.now() + 61000));
        await refreshNextMeeting({ opened: true });
        expect(fetch).toHaveBeenCalledTimes(2);
        await refreshNextMeeting();
        expect(fetch).toHaveBeenCalledTimes(2);
        vi.setSystemTime(new Date(Date.now() + 300001));
        await refreshNextMeeting();
        expect(fetch).toHaveBeenCalledTimes(3);
    });
    it.each([
        "hosted",
        "not_configured",
        "not_connected",
        "no_calendar_scope",
        "calendar_unavailable",
    ])("caches reason %s without a retry loop", async (reason) => {
        fetch.mockResolvedValue(Response.json({ data: null, reason }));
        await refreshNextMeeting({ opened: true });
        await refreshNextMeeting({ opened: true });
        expect(await cachedNextMeeting()).toMatchObject({ data: null, reason });
        expect(fetch).toHaveBeenCalledTimes(1);
    });
    it("migrates the old reminder opt-out and defaults lead to zero", async () => {
        local.agendaReminders = false;
        expect(await getSettings()).toMatchObject({
            meetingNotifications: false,
            meetingLeadMinutes: 0,
        });
        local.meetingNotifications = true;
        local.meetingLeadMinutes = 3;
        expect(await getSettings()).toMatchObject({
            meetingNotifications: true,
            meetingLeadMinutes: 0,
        });
    });
    it("refuses cache and notification destinations after changing accounts", async () => {
        event.start = new Date().toISOString();
        await refreshNextMeeting();
        expect(await notificationMeeting("meeting:event-one")).toMatchObject({
            joinUrl: event.joinUrl,
        });
        local.encryptedApiKey.nonce = [2];
        expect(await cachedNextMeeting()).toBeNull();
        expect(await notificationMeeting("meeting:event-one")).toBeNull();
    });
});

describe("Calendar notifications and badges", () => {
    it.each([
        0, 1, 2, 5, 10,
    ])("schedules one notification with lead %s and suppresses duplicates", async (lead) => {
        event.start = "2026-11-08T09:15:00Z";
        local.meetingLeadMinutes = lead;
        await refreshNextMeeting();
        expect(chrome.alarms.create).toHaveBeenCalledWith(NEXT_START, {
            when: Date.parse(event.start) - lead * 60000,
        });
        expect(chrome.alarms.create).toHaveBeenCalledWith(NEXT_BADGE, {
            when: Date.parse(event.start),
        });
        vi.setSystemTime(new Date(Date.parse(event.start) - lead * 60000));
        await notifyNextMeeting();
        await notifyNextMeeting();
        expect(chrome.notifications.create).toHaveBeenCalledTimes(1);
        expect(chrome.notifications.create.mock.calls[0][1].buttons).toEqual([
            { title: "joinMeet" },
            { title: "agendaShow" },
        ]);
    });
    it("suppresses the notification when the room is open, even through a different authuser", async () => {
        tabs = [
            {
                id: 8,
                url: "https://meet.google.com/abc-defg-hij?authuser=other%40example.com",
            },
        ];
        expect(roomIsOpen(event, tabs)).toBe(true);
        await refreshNextMeeting();
        vi.setSystemTime(new Date(event.start));
        await notifyNextMeeting();
        tabs = [];
        await notifyNextMeeting();
        expect(chrome.notifications.create).not.toHaveBeenCalled();
    });
    it("offers no countdown, shows now only outside an ongoing room, and gives REC priority", async () => {
        await refreshNextMeeting();
        expect(chrome.action.setBadgeText).not.toHaveBeenCalledWith(
            expect.objectContaining({ text: "meetingNow" }),
        );
        vi.setSystemTime(new Date(event.start));
        await updateNextMeetingBadge();
        expect(chrome.action.setBadgeText).toHaveBeenCalledWith({
            text: "meetingNow",
        });
        tabs.push({ id: 8, url: event.joinUrl });
        await updateNextMeetingBadge();
        expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith(
            expect.objectContaining({ text: "" }),
        );
        session.recordingState = { state: "recording", tabId: 7 };
        await updateNextMeetingBadge();
        expect(chrome.action.setBadgeText).toHaveBeenCalledWith({
            tabId: 8,
            text: "REC",
        });
    });
    it("clears the now badge when the meeting ends or a pairing is removed", async () => {
        event.start = new Date().toISOString();
        await refreshNextMeeting();
        await clearNextMeeting();
        expect(session[NEXT_MEETING_KEY]).toBeUndefined();
        expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith(
            expect.objectContaining({ text: "" }),
        );
    });
    it("opens the exact authuser join URL without sending a start-recording message", async () => {
        await refreshNextMeeting();
        const container = document.createElement("section");
        document.body.append(container);
        const card = createNextMeetingCard(container, () => tabs[0]);
        await card.render();
        container.querySelector("button").click();
        expect(chrome.tabs.create).toHaveBeenCalledWith({ url: event.joinUrl });
        expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: "start-recording" }),
        );
        tabs[0].url = event.joinUrl;
        await card.render();
        expect(container.hidden).toBe(true);
        card.destroy();
    });
});

it.each([
    "cs",
    "en",
])("uses one localized date range in the popup and notification: %s", async (locale) => {
    chrome.i18n.getUILanguage = () => locale;
    event.start = "2026-11-08T18:34:00Z";
    event.end = "2026-11-08T19:17:00Z";
    await refreshNextMeeting();
    const container = document.createElement("section");
    const card = createNextMeetingCard(container, () => tabs[0]);
    await card.render();
    const expected =
        locale === "cs" ? "8. 11. 18:34–19:17" : "11/8 18:34–19:17";
    expect(container.textContent).toContain(expected);
    vi.setSystemTime(new Date(event.start));
    await notifyNextMeeting();
    expect(chrome.notifications.create.mock.calls[0][1].message).toContain(
        expected,
    );
    card.destroy();
});
