import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/lib/integrations/google/connection", () => ({
    getGoogleConnectionStatus: vi.fn(),
    getGoogleAccessToken: vi.fn(),
    invalidateGoogleAccessToken: vi.fn(),
}));

import { listCalendarEventsForRecording } from "@/lib/integrations/google/calendar-events";
import {
    getGoogleAccessToken,
    getGoogleConnectionStatus,
} from "@/lib/integrations/google/connection";

const start = new Date("2026-10-08T10:00:00.000Z");
const end = new Date("2026-10-08T11:00:00.000Z");

describe("selected Calendar event Meet handoff", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getGoogleConnectionStatus).mockResolvedValue({
            subject: "google-user-1",
            email: "owner@example.test",
            hostedDomain: null,
            status: "active",
            scopes: [
                "https://www.googleapis.com/auth/calendar.events.readonly",
            ],
        });
        vi.mocked(getGoogleAccessToken).mockResolvedValue("token");
    });

    it.each([
        { hangoutLink: "https://meet.google.com/abc-defg-hij" },
        {
            conferenceData: {
                entryPoints: [
                    {
                        entryPointType: "video",
                        uri: "https://meet.google.com/abc-defg-hij",
                    },
                ],
            },
        },
    ])("gets the selected event's Meet code from one Calendar list call: %j", async (conference) => {
        const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
            Response.json({
                items: [
                    {
                        id: "selected-event",
                        summary: "Invented planning",
                        start: { dateTime: start.toISOString() },
                        end: { dateTime: end.toISOString() },
                        ...conference,
                    },
                ],
            }),
        );
        const events = await listCalendarEventsForRecording({
            userId: "owner",
            start,
            end,
            fetchImpl,
        });
        expect(events).toMatchObject([
            { id: "selected-event", meetingCode: "abc-defg-hij" },
        ]);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
        expect(url.pathname).toBe("/calendar/v3/calendars/primary/events");
        expect(url.searchParams.get("fields")).toContain(
            "hangoutLink,conferenceData",
        );
    });

    it("does not fetch event details without Calendar consent", async () => {
        vi.mocked(getGoogleConnectionStatus).mockResolvedValue({
            subject: "google-user-1",
            email: "owner@example.test",
            hostedDomain: null,
            status: "active",
            scopes: [],
        });
        const fetchImpl = vi.fn<typeof fetch>();
        expect(
            await listCalendarEventsForRecording({
                userId: "owner",
                start,
                end,
                fetchImpl,
            }),
        ).toEqual([]);
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(getGoogleAccessToken).not.toHaveBeenCalled();
    });
});
