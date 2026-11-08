import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    access: vi.fn(),
    selectDistinct: vi.fn(),
    rows: [] as { id: string; name: string | null }[],
}));
vi.mock("@/lib/meetings/access", () => ({
    requireMeetingAccess: mocks.access,
}));
vi.mock("@/db", () => ({ db: { selectDistinct: mocks.selectDistinct } }));

import { agendaRecordingBy } from "@/lib/meetings/recording-by";

beforeEach(() => {
    vi.clearAllMocks();
    mocks.rows = [];
    mocks.access.mockResolvedValue({ agenda: { id: "canonical-agenda" } });
    const query = {
        from: vi.fn(),
        innerJoin: vi.fn(),
        where: vi.fn(),
        orderBy: vi.fn(async () => mocks.rows),
    };
    query.from.mockReturnValue(query);
    query.innerJoin.mockReturnValue(query);
    query.where.mockReturnValue(query);
    mocks.selectDistinct.mockReturnValue(query);
});

describe("recording presence projection", () => {
    it("checks agenda visibility before querying recorder identities", async () => {
        mocks.access.mockRejectedValue(new Error("Not found"));
        await expect(agendaRecordingBy("viewer", "agenda")).rejects.toThrow(
            "Not found",
        );
        expect(mocks.selectDistinct).not.toHaveBeenCalled();
    });
    it("returns names and self flags without session or user identifiers", async () => {
        mocks.rows = [
            { id: "owner", name: "Jitka Dvořáková" },
            { id: "viewer", name: "Petr Král" },
        ];
        const result = await agendaRecordingBy("viewer", "meeting-alias");
        expect(mocks.access).toHaveBeenCalledWith("viewer", "meeting-alias");
        expect(result.recordingBy).toEqual([
            { name: "Jitka Dvořáková", self: false },
            { name: "Petr Král", self: true },
        ]);
        expect(result.cursor).toMatch(/^:p[0-9a-f]{16}$/);
    });
    it("changes its polling suffix when presence disappears", async () => {
        mocks.rows = [{ id: "viewer", name: null }];
        const active = await agendaRecordingBy("viewer", "agenda");
        mocks.rows = [];
        const inactive = await agendaRecordingBy("viewer", "agenda");
        expect(active.cursor).not.toBe(inactive.cursor);
        expect(inactive).toEqual({ recordingBy: [], cursor: "" });
    });
});
