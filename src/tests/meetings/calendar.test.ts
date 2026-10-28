import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
    env: {
        IS_HOSTED: false,
        GOOGLE_CLIENT_ID: "test",
        GOOGLE_CLIENT_SECRET: "test",
        APP_URL: "https://example.com",
    },
}));
const connection = vi.hoisted(() => ({
    status: vi.fn(),
    token: vi.fn(),
    invalidate: vi.fn(),
}));
vi.mock("@/lib/integrations/google/connection", () => ({
    getGoogleConnectionStatus: connection.status,
    getGoogleAccessToken: connection.token,
    invalidateGoogleAccessToken: connection.invalidate,
}));

import {
    getCalendarEvent,
    listUpcomingCalendarEvents,
    writeCalendarAgenda,
} from "@/lib/integrations/google/calendar-events";
import {
    GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE,
    GOOGLE_CALENDAR_EVENTS_WRITE_SCOPE,
} from "@/lib/integrations/google/config";

const from = new Date("2026-11-03T10:00:00Z");
const to = new Date("2026-11-17T10:00:00Z");
const event = {
    id: "occurrence",
    summary: "Acme",
    recurringEventId: "series",
    start: { dateTime: "2026-11-03T10:00:00Z" },
    end: { dateTime: "2026-11-03T11:00:00Z" },
    organizer: { self: true },
    attendees: [{ displayName: "Jitka Dvořáková", email: "jitka@example.com" }],
};

beforeEach(() => {
    vi.clearAllMocks();
    connection.status.mockResolvedValue({
        status: "active",
        subject: "account",
        scopes: [
            GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE,
            GOOGLE_CALENDAR_EVENTS_WRITE_SCOPE,
        ],
    });
    connection.token.mockResolvedValue("token");
});

describe("upcoming Calendar events", () => {
    it("follows pages, preserves series ids, filters all-day and declined events", async () => {
        const requests: URL[] = [];
        const fetchImpl = vi.fn(async (input: string | URL | Request) => {
            const url = new URL(String(input));
            requests.push(url);
            return Response.json(
                url.searchParams.has("pageToken")
                    ? {
                          items: [
                              { ...event, id: "second" },
                              {
                                  id: "all-day",
                                  start: { date: "2026-11-03" },
                                  end: { date: "2026-11-04" },
                              },
                              {
                                  ...event,
                                  id: "declined",
                                  attendees: [
                                      {
                                          self: true,
                                          responseStatus: "declined",
                                      },
                                  ],
                              },
                          ],
                      }
                    : { items: [event], nextPageToken: "page-two" },
            );
        });
        const result = await listUpcomingCalendarEvents("owner", from, to, {
            fetchImpl,
        });
        expect(result.map((entry) => entry.id)).toEqual([
            "occurrence",
            "second",
        ]);
        expect(result[0].recurringEventId).toBe("series");
        expect(requests[1].searchParams.get("pageToken")).toBe("page-two");
        expect(requests[0].searchParams.get("fields")).toContain(
            "recurringEventId",
        );
    });
    it("bounds pagination and refuses incomplete results", async () => {
        const fetchImpl = vi.fn(async () =>
            Response.json({ items: [event], nextPageToken: "another" }),
        );
        await expect(
            listUpcomingCalendarEvents("owner", from, to, { fetchImpl }),
        ).rejects.toMatchObject({ statusCode: 502 });
        expect(fetchImpl).toHaveBeenCalledTimes(10);
    });
    it("queries the recurring series instances for next-meeting lookup", async () => {
        const fetchImpl = vi.fn(async (_input: string | URL | Request) =>
            Response.json({ items: [event] }),
        );
        await listUpcomingCalendarEvents("owner", from, to, {
            fetchImpl,
            seriesId: "series",
        });
        expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(
            "/series/instances",
        );
    });
});

describe("manual Calendar export", () => {
    it("freshly refuses a non-organizer without sending a patch", async () => {
        const fetchImpl = vi.fn(async () =>
            Response.json({ ...event, organizer: { self: false } }),
        );
        await expect(
            writeCalendarAgenda("owner", event.id, "Agenda", "en", fetchImpl),
        ).rejects.toMatchObject({ statusCode: 403 });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
    it("patches only the instance without email updates and preserves the description", async () => {
        const requests: { url: URL; init: RequestInit }[] = [];
        const fetchImpl: typeof fetch = vi.fn(async (input, init = {}) => {
            requests.push({ url: new URL(String(input)), init });
            return Response.json({
                ...event,
                description: "Organizer text",
                etag: '"v1"',
                htmlLink: "https://example.com/event",
            });
        });
        await writeCalendarAgenda(
            "owner",
            event.id,
            "- Agenda point",
            "en",
            fetchImpl,
        );
        expect(requests[1].url.pathname).toContain("/events/occurrence");
        expect(requests[1].url.searchParams.get("sendUpdates")).toBe("none");
        expect(requests[1].init.method).toBe("PATCH");
        expect(requests[1].init.headers).toMatchObject({ "If-Match": '"v1"' });
        expect(JSON.parse(String(requests[1].init.body)).description).toContain(
            "Organizer text\n\n--- Agenda from Chatterbox ---",
        );
    });
    it("refuses a recurring master on linking and export", async () => {
        const fetchImpl = vi.fn(async () =>
            Response.json({ ...event, recurrence: ["RRULE:FREQ=WEEKLY"] }),
        );
        await expect(
            getCalendarEvent("owner", "series", fetchImpl),
        ).rejects.toMatchObject({ statusCode: 400 });
        await expect(
            writeCalendarAgenda("owner", "series", "Agenda", "en", fetchImpl),
        ).rejects.toMatchObject({ statusCode: 400 });
    });
});
