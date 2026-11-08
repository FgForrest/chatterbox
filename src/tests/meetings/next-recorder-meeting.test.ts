import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarEventCandidate } from "@/lib/integrations/google/calendar-events";

const mocks = vi.hoisted(() => ({
    reason: vi.fn(),
    connection: vi.fn(),
    events: vi.fn(),
    agendas: vi.fn(),
}));
vi.mock("@/lib/meetings/calendar", () => ({
    calendarUnavailableReason: mocks.reason,
}));
vi.mock("@/lib/meetings/service", () => ({ listMeetings: mocks.agendas }));
vi.mock("@/lib/integrations/google/connection", () => ({
    getGoogleConnectionStatus: mocks.connection,
}));
vi.mock("@/lib/integrations/google/calendar-events", () => ({
    listUpcomingCalendarEvents: mocks.events,
}));

import {
    nextRecorderMeeting,
    recorderJoinUrl,
    selectNextRecorderMeeting,
} from "@/lib/meetings/next-meeting";

const at = new Date("2026-11-08T10:00:00Z");
function event(
    id: string,
    start: string,
    end: string,
    meetingCode: string | null = "abc-defg-hij",
): CalendarEventCandidate {
    return { id, title: "Planning", start, end, attendees: [], meetingCode };
}
let clock = Date.now();
beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    clock += 120000;
    vi.setSystemTime(new Date(clock));
    mocks.reason.mockResolvedValue(null);
    mocks.connection.mockResolvedValue({ email: "jitka+calendar@example.com" });
    mocks.events.mockResolvedValue([]);
    mocks.agendas.mockResolvedValue([{ id: "own-agenda", own: true }]);
});

describe("next recorder meeting", () => {
    it("prefers ongoing over future, and earliest future within twelve hours", () => {
        const future = event(
            "future",
            "2026-11-08T11:00:00Z",
            "2026-11-08T12:00:00Z",
        );
        const ongoing = event(
            "ongoing",
            "2026-11-08T09:00:00Z",
            "2026-11-08T10:30:00Z",
        );
        expect(selectNextRecorderMeeting([future, ongoing], at)?.id).toBe(
            "ongoing",
        );
        expect(
            selectNextRecorderMeeting(
                [
                    event(
                        "ended",
                        "2026-11-08T08:00:00Z",
                        "2026-11-08T10:00:00Z",
                    ),
                    event(
                        "late",
                        "2026-11-08T22:01:00Z",
                        "2026-11-08T23:00:00Z",
                    ),
                    event(
                        "no-room",
                        "2026-11-08T10:30:00Z",
                        "2026-11-08T12:00:00Z",
                        null,
                    ),
                    future,
                ],
                at,
            )?.id,
        ).toBe("future");
    });
    it("builds URLs only from validated room codes and encodes the account email", () => {
        expect(
            recorderJoinUrl("abc-defg-hij", "jitka+calendar@example.com"),
        ).toBe(
            "https://meet.google.com/abc-defg-hij?authuser=jitka%2Bcalendar%40example.com",
        );
        for (const code of [
            null,
            "https://example.com",
            "abc-defg-hij/evil",
            "abc-defg-hij?authuser=wrong",
        ])
            expect(recorderJoinUrl(code, "jitka@example.com")).toBeNull();
    });
    it.each([
        "not_connected",
        "no_calendar_scope",
        "hosted",
    ])("returns a reason when Calendar is unavailable: %s", async (reason) => {
        mocks.reason.mockResolvedValue(reason);
        expect(await nextRecorderMeeting("viewer", at)).toEqual({
            data: null,
            reason,
        });
        expect(mocks.events).not.toHaveBeenCalled();
    });
    it("reads only the principal's primary events and returns an own-first visible agenda", async () => {
        mocks.events.mockResolvedValue([
            event("event", "2026-11-08T09:00:00Z", "2026-11-08T11:00:00Z"),
        ]);
        const response = await nextRecorderMeeting("viewer", at);
        expect(mocks.events).toHaveBeenCalledWith(
            "viewer",
            at,
            new Date("2026-11-08T22:00:00Z"),
            { participantEmail: "jitka+calendar@example.com" },
        );
        expect(response.data).toMatchObject({
            eventId: "event",
            agendaId: "own-agenda",
            ongoing: true,
            accountEmail: "jitka+calendar@example.com",
        });
        expect(mocks.agendas).toHaveBeenCalledWith("viewer", {
            calendarEventId: "event",
            includePast: true,
            includeAbsorbed: true,
        });
    });
    it("returns a neutral failure reason without leaking provider details", async () => {
        mocks.events.mockRejectedValue(new Error("private provider response"));
        expect(await nextRecorderMeeting("viewer", at)).toEqual({
            data: null,
            reason: "calendar_unavailable",
        });
    });
});

afterEach(() => vi.useRealTimers());
it("caches hits and null results per user for 60 seconds", async () => {
    await nextRecorderMeeting("cache-hit", at);
    await nextRecorderMeeting("cache-hit", at);
    expect(mocks.events).toHaveBeenCalledTimes(1);
    await nextRecorderMeeting("different-user", at);
    expect(mocks.events).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60001);
    await nextRecorderMeeting("cache-hit", at);
    expect(mocks.events).toHaveBeenCalledTimes(3);
});
it("drops cached join URLs on disconnect and scope change", async () => {
    mocks.events.mockResolvedValue([
        event("event", "2026-11-08T09:00:00Z", "2026-11-08T11:00:00Z"),
    ]);
    expect((await nextRecorderMeeting("disconnect", at)).data).not.toBeNull();
    mocks.reason.mockResolvedValue("not_connected");
    expect(await nextRecorderMeeting("disconnect", at)).toEqual({
        data: null,
        reason: "not_connected",
    });
    mocks.reason.mockResolvedValue("no_calendar_scope");
    expect(await nextRecorderMeeting("disconnect", at)).toEqual({
        data: null,
        reason: "no_calendar_scope",
    });
    mocks.reason.mockResolvedValue(null);
    await nextRecorderMeeting("disconnect", at);
    expect(mocks.events).toHaveBeenCalledTimes(2);
});

it("caches a meeting hit and refreshes when the connected identity changes", async () => {
    mocks.events.mockResolvedValue([
        event("event", "2026-11-08T09:00:00Z", "2026-11-08T11:00:00Z"),
    ]);
    const first = await nextRecorderMeeting("meeting-cache", at);
    expect(first.data).not.toBeNull();
    expect(await nextRecorderMeeting("meeting-cache", at)).toEqual(first);
    expect(mocks.events).toHaveBeenCalledOnce();
    mocks.connection.mockResolvedValue({ email: "different@example.com" });
    expect(
        (await nextRecorderMeeting("meeting-cache", at)).data?.accountEmail,
    ).toBe("different@example.com");
    expect(mocks.events).toHaveBeenCalledTimes(2);
});
