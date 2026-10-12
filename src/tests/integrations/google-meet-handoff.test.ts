import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/lib/integrations/google/connection", () => ({
    getGoogleConnectionStatus: vi.fn(),
    getGoogleAccessToken: vi.fn(),
    invalidateGoogleAccessToken: vi.fn(),
}));

import {
    type CalendarEventCandidate,
    getSelectedCalendarMeetCode,
} from "@/lib/integrations/google/calendar-events";
import {
    getGoogleAccessToken,
    getGoogleConnectionStatus,
} from "@/lib/integrations/google/connection";

const event: CalendarEventCandidate = {
    id: "selected-event",
    title: "Planning",
    start: "2026-10-08T10:00:00.000Z",
    end: "2026-10-08T11:00:00.000Z",
    attendees: [],
};

describe("selected Calendar event Meet handoff", () => {
    beforeEach(() => {
        vi.mocked(getGoogleConnectionStatus).mockResolvedValue({
            subject: "google-user-1",
            email: "a@example.com",
            hostedDomain: null,
            status: "active",
            scopes: [
                "https://www.googleapis.com/auth/calendar.events.readonly",
            ],
        });
        vi.mocked(getGoogleAccessToken).mockResolvedValue("token");
    });

    it("gets Meet code from the revalidated selected event", async () => {
        const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
            Response.json({
                id: event.id,
                start: { dateTime: event.start },
                end: { dateTime: event.end },
                conferenceData: {
                    entryPoints: [
                        {
                            entryPointType: "video",
                            uri: "https://meet.google.com/abc-defg-hij",
                        },
                    ],
                },
            }),
        );
        await expect(
            getSelectedCalendarMeetCode({
                userId: "riffado-user-1",
                event,
                fetchImpl,
            }),
        ).resolves.toBe("abc-defg-hij");
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(
            "/calendars/primary/events/selected-event",
        );
        expect(getGoogleAccessToken).toHaveBeenCalledWith(
            "riffado-user-1",
            expect.objectContaining({
                expectedSubject: "google-user-1",
                requiredScope:
                    "https://www.googleapis.com/auth/calendar.events.readonly",
            }),
        );
    });

    it("rejects an event whose time changed after selection", async () => {
        const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
            Response.json({
                id: event.id,
                start: { dateTime: "2026-10-08T12:00:00.000Z" },
                end: { dateTime: event.end },
                hangoutLink: "https://meet.google.com/abc-defg-hij",
            }),
        );
        await expect(
            getSelectedCalendarMeetCode({
                userId: "riffado-user-1",
                event,
                fetchImpl,
            }),
        ).resolves.toBeNull();
    });

    it("does not fetch Meet details without Calendar consent", async () => {
        vi.mocked(getGoogleConnectionStatus).mockResolvedValue({
            subject: "google-user-1",
            email: "a@example.com",
            hostedDomain: null,
            status: "active",
            scopes: [],
        });
        const fetchImpl = vi.fn<typeof fetch>();
        await expect(
            getSelectedCalendarMeetCode({
                userId: "riffado-user-1",
                event,
                fetchImpl,
            }),
        ).resolves.toBeNull();
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
