import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMeetingRoster } from "@/lib/integrations/google/meeting-roster";

vi.mock("@/lib/env", () => ({ env: {} }));

const { list, get, meet, stored, update } = vi.hoisted(() => ({
    list: vi.fn(),
    get: vi.fn(),
    meet: vi.fn(),
    update: vi.fn(),
    stored: {
        calendarEventId: "agenda-event" as string | null,
        calendarSeriesId: null as string | null,
    },
}));
vi.mock("@/db", () => ({
    db: {
        select: () => ({
            from: () => ({
                innerJoin: () => ({
                    where: () => ({
                        limit: async () => [
                            {
                                start: new Date("2026-10-27T10:00:00Z"),
                                end: new Date("2026-10-27T11:00:00Z"),
                                calendarEventId: stored.calendarEventId,
                                calendarSeriesId: stored.calendarSeriesId,
                            },
                        ],
                    }),
                }),
            }),
        }),
        update: () => ({ set: update }),
    },
}));
vi.mock("@/lib/integrations/google/calendar-events", () => ({
    listCalendarEventsForRecording: list,
    getCalendarEvent: get,
}));
vi.mock("@/lib/integrations/google/meet-speaker-candidates", () => ({
    getMeetSpeakerCandidates: meet,
}));
vi.mock("@/lib/integrations/google/match-roster-people", () => ({
    matchRosterPeople: vi.fn(),
}));
vi.mock("@/lib/knowledge/knowledge-loader", () => ({ knowledgeView: vi.fn() }));
vi.mock("@/lib/sharing/writer", () => ({ sharingOrgUserId: async () => null }));

describe("explicit agenda Calendar event", () => {
    beforeEach(() => {
        vi.resetAllMocks();
        stored.calendarEventId = "agenda-event";
        stored.calendarSeriesId = null;
        list.mockResolvedValue([]);
        get.mockResolvedValue({
            id: "agenda-event",
            title: "Acme",
            start: "2026-10-27T08:00:00Z",
            end: "2026-10-27T09:00:00Z",
            recurringEventId: "series",
            attendees: [{ name: "Jitka Dvořáková" }],
        });
        meet.mockResolvedValue([]);
        update.mockReturnValue({ where: async () => undefined });
    });
    it("loads the explicit event even outside the recording overlap window", async () => {
        expect(
            await resolveMeetingRoster({
                ownerUserId: "owner",
                itemId: "recording",
            }),
        ).toMatchObject({
            eventId: "agenda-event",
            attendees: [{ name: "Jitka Dvořáková", source: "calendar" }],
        });
        expect(get).toHaveBeenCalledWith("owner", "agenda-event", undefined);
        expect(update).toHaveBeenCalledWith({
            calendarEventId: "agenda-event",
            calendarSeriesId: "series",
        });
    });
    it("respects an explicit opt-out and performs no calendar reads", async () => {
        expect(
            await resolveMeetingRoster({
                ownerUserId: "owner",
                itemId: "recording",
                calendarEventId: "",
            }),
        ).toBeNull();
        expect(list).not.toHaveBeenCalled();
        expect(get).not.toHaveBeenCalled();
    });
    it("does not choose another event when the explicit event cannot be read", async () => {
        get.mockRejectedValue(new Error("Event unavailable"));
        expect(
            await resolveMeetingRoster({
                ownerUserId: "owner",
                itemId: "recording",
            }),
        ).toBeNull();
        expect(meet).not.toHaveBeenCalled();
    });
});

it("does not write Calendar identifiers again when repeated views resolve the same event", async () => {
    stored.calendarEventId = "agenda-event";
    stored.calendarSeriesId = "series";
    update.mockClear();
    get.mockResolvedValue({
        id: "agenda-event",
        start: "2026-10-27T08:00:00Z",
        end: "2026-10-27T09:00:00Z",
        recurringEventId: "series",
        attendees: [{ name: "Jitka Dvořáková" }],
    });
    for (let i = 0; i < 3; i++)
        await expect(
            resolveMeetingRoster({ ownerUserId: "owner", itemId: "recording" }),
        ).resolves.toMatchObject({ eventId: "agenda-event" });
    expect(update).not.toHaveBeenCalled();
});
