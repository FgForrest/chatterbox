import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    list: vi.fn(),
    rows: vi.fn(),
    snapshot: vi.fn(),
}));
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/db/queries/meetings", () => ({ listMeetingRows: mocks.rows }));
vi.mock("@/lib/meetings/service", () => ({ listMeetings: mocks.list }));
vi.mock("@/lib/meetings/access", () => ({
    meetingViewer: async () => ({ orgUserId: null }),
}));
vi.mock("@/lib/meetings/calendar-snapshot", () => ({
    readMeetingCalendarSnapshot: mocks.snapshot,
    cachedMeetingCalendarSnapshot: () => null,
}));
vi.mock("@/lib/folders/folders", () => ({}));
vi.mock("@/lib/sharing/access", () => ({}));
vi.mock("@/lib/integrations/google/connection", () => ({}));
vi.mock("@/lib/env", () => ({ env: { IS_HOSTED: false } }));

import { matchRecorderAgendas } from "@/lib/meetings/calendar";

const at = new Date("2026-11-08T10:15:00Z");
const row = {
    id: "agenda",
    own: true,
    state: "held",
    start: new Date("2026-11-08T10:00:00Z"),
    end: new Date("2026-11-08T11:00:00Z"),
    calendarEventId: "event",
};
beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue([row]);
    mocks.rows.mockResolvedValue([
        {
            agenda: {
                id: "agenda",
                calendarEventId: "event",
                calendarSnapshot: null,
            },
        },
    ]);
    mocks.snapshot.mockResolvedValue({ meetingCode: "abc-defg-hij" });
});

describe("recorder agenda matching while capture is running", () => {
    it("matches a missing or stale snapshot in the same response, without waiting for another poll", async () => {
        const after = vi.fn();
        expect(
            await matchRecorderAgendas("viewer", at, "abc-defg-hij", after),
        ).toEqual([row]);
        expect(mocks.snapshot).toHaveBeenCalledOnce();
        expect(after).toHaveBeenCalledOnce();
    });
    it("keeps held standalone agendas reachable and prefers the caller's plan", async () => {
        const other = { ...row, id: "other", own: false };
        mocks.list.mockResolvedValue([other, row]);
        expect(
            (await matchRecorderAgendas("viewer", at)).map((entry) => entry.id),
        ).toEqual(["agenda", "other"]);
    });
    it("does not match another room or an absorbed agenda", async () => {
        expect(
            await matchRecorderAgendas("viewer", at, "xyz-abcd-efg"),
        ).toEqual([]);
        expect(mocks.list).toHaveBeenCalledWith(
            "viewer",
            expect.objectContaining({ excludeAbsorbed: true }),
        );
    });
    it("rejects malformed room codes and the exact end boundary", async () => {
        expect(
            await matchRecorderAgendas(
                "viewer",
                at,
                "abc-defg-hij?authuser=other",
            ),
        ).toEqual([]);
        expect(await matchRecorderAgendas("viewer", row.end)).toEqual([]);
    });
});

it("bounds a missing-code refresh to 700 ms", async () => {
    vi.useFakeTimers();
    mocks.snapshot.mockImplementation(() => new Promise(() => {}));
    const result = matchRecorderAgendas("viewer", at, "abc-defg-hij");
    await vi.advanceTimersByTimeAsync(700);
    expect(await result).toEqual([]);
    vi.useRealTimers();
});
