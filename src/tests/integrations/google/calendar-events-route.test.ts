import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));
vi.mock("@/db", () => ({ db: { select: vi.fn() } }));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn().mockResolvedValue({ user: { id: "owner" } }),
}));
vi.mock("@/lib/integrations/google/calendar-events", () => ({
    listCalendarEventsForRecording: vi.fn(),
}));

import { GET } from "@/app/api/recordings/[id]/calendar-events/route";
import { db } from "@/db";
import { listCalendarEventsForRecording } from "@/lib/integrations/google/calendar-events";

const request = new Request(
    "http://localhost/api/recordings/recording/calendar-events",
);
const context = { params: Promise.resolve({ id: "recording" }) };

function selectRecording(row: unknown) {
    (db.select as Mock).mockReturnValue({
        from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue(row ? [row] : []),
            }),
        }),
    });
}

describe("owner Calendar event candidates", () => {
    beforeEach(() => vi.clearAllMocks());

    it("does not fetch Calendar for a recording outside the signed-in owner scope", async () => {
        selectRecording(null);
        const response = await GET(request, context);
        expect(response.status).toBe(404);
        expect(listCalendarEventsForRecording).not.toHaveBeenCalled();
    });

    it("returns only event choice fields, with no attendee data", async () => {
        const start = new Date("2026-10-07T10:00:00Z");
        const end = new Date("2026-10-07T11:00:00Z");
        selectRecording({ start, end });
        (listCalendarEventsForRecording as Mock).mockResolvedValue([
            {
                id: "event",
                title: "Meeting",
                start: start.toISOString(),
                end: end.toISOString(),
                attendees: [{ name: "Alex" }],
            },
        ]);
        const response = await GET(request, context);
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            events: [
                { id: "event", title: "Meeting", start: start.toISOString() },
            ],
        });
        expect(listCalendarEventsForRecording).toHaveBeenCalledWith({
            userId: "owner",
            start,
            end,
        });
    });
});
