import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: { IS_HOSTED: false } }));

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

import { listCalendarEventsForRecording } from "@/lib/integrations/google/calendar-events";

const SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
const start = new Date("2026-10-07T10:00:00Z");
const end = new Date("2026-10-07T11:00:00Z");

beforeEach(() => {
    vi.clearAllMocks();
    connection.status.mockResolvedValue({
        subject: "google-user",
        status: "active",
        scopes: [SCOPE],
    });
    connection.token.mockResolvedValue("access-token");
});

describe("Calendar event candidates", () => {
    it("does not contact Google without the separate Calendar grant", async () => {
        connection.status.mockResolvedValue({
            subject: "google-user",
            status: "active",
            scopes: ["https://www.googleapis.com/auth/drive.file"],
        });
        const fetchImpl = vi.fn();
        expect(
            await listCalendarEventsForRecording({
                userId: "owner",
                start,
                end,
                fetchImpl,
            }),
        ).toEqual([]);
        expect(connection.token).not.toHaveBeenCalled();
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("reads only the bounded primary-calendar window and removes declined guests", async () => {
        const fetchImpl = vi.fn(
            async () =>
                new Response(
                    JSON.stringify({
                        items: [
                            {
                                id: "meeting",
                                summary: "Team meeting",
                                start: { dateTime: "2026-10-07T09:45:00Z" },
                                end: { dateTime: "2026-10-07T11:15:00Z" },
                                attendees: [
                                    {
                                        displayName: "Alex",
                                        email: "alex@example.com",
                                        responseStatus: "accepted",
                                    },
                                    {
                                        displayName: "Pat",
                                        responseStatus: "declined",
                                    },
                                    { displayName: "Room", resource: true },
                                ],
                            },
                            {
                                id: "all-day",
                                start: { date: "2026-10-07" },
                                end: { date: "2026-10-08" },
                            },
                        ],
                    }),
                    { status: 200 },
                ),
        );
        const events = await listCalendarEventsForRecording({
            userId: "owner",
            start,
            end,
            fetchImpl: fetchImpl as typeof fetch,
        });
        expect(events).toEqual([
            {
                id: "meeting",
                title: "Team meeting",
                start: "2026-10-07T09:45:00.000Z",
                end: "2026-10-07T11:15:00.000Z",
                attendees: [{ name: "Alex" }],
            },
        ]);
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [
            URL,
            RequestInit,
        ];
        expect(url.pathname).toBe("/calendar/v3/calendars/primary/events");
        expect(url.searchParams.get("timeMin")).toBe(
            "2026-10-07T09:30:00.000Z",
        );
        expect(url.searchParams.get("timeMax")).toBe(
            "2026-10-07T11:30:00.000Z",
        );
        expect(init.headers).toEqual({ Authorization: "Bearer access-token" });
        expect(connection.token).toHaveBeenCalledWith("owner", {
            expectedSubject: "google-user",
            requiredScope: SCOPE,
            fetchImpl,
        });
    });

    it("uses no candidates if Google has more pages than the bounded response", async () => {
        const fetchImpl = vi.fn(
            async () =>
                new Response(
                    JSON.stringify({
                        items: [{ id: "partial" }],
                        nextPageToken: "next",
                    }),
                    { status: 200 },
                ),
        );
        expect(
            await listCalendarEventsForRecording({
                userId: "owner",
                start,
                end,
                fetchImpl: fetchImpl as typeof fetch,
            }),
        ).toEqual([]);
    });
});
