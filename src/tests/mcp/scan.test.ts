import { afterEach, describe, expect, it, vi } from "vitest";
import { boundedScan } from "@/lib/mcp/scan";

/** Items 99 (newest) down to 0, stamped by their number. */
const ALL = Array.from({ length: 100 }, (_, i) => 99 - i);

function batches(size = 10) {
    const calls: (string | null)[] = [];
    const next = async (before: string | null) => {
        calls.push(before);
        const from = before === null ? 0 : ALL.indexOf(Number(before)) + 1;
        return ALL.slice(from, from + size);
    };
    return { calls, next };
}

describe("boundedScan", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("stops at the limit and says where to continue", async () => {
        const source = batches();
        const outcome = await boundedScan({
            batches: source.next,
            stampOf: String,
            visit: (item) => (item % 10 === 0 ? item : null),
            limit: 25,
            deadlineMs: 10_000,
            maxResults: 50,
            before: null,
        });
        expect(outcome).toEqual({
            results: [90, 80],
            scanned: 25,
            complete: false,
            continueBefore: "75",
        });

        const rest = await boundedScan({
            batches: source.next,
            stampOf: String,
            visit: (item) => (item % 10 === 0 ? item : null),
            limit: 1_000,
            deadlineMs: 10_000,
            maxResults: 50,
            before: outcome.continueBefore,
        });
        expect(rest.results).toEqual([70, 60, 50, 40, 30, 20, 10, 0]);
        expect(rest.scanned).toBe(75);
        expect(rest.complete).toBe(true);
        expect(rest.continueBefore).toBeNull();
    });

    it("is complete when the data runs out", async () => {
        const outcome = await boundedScan({
            batches: batches(30).next,
            stampOf: String,
            visit: () => null,
            limit: 100,
            deadlineMs: 10_000,
            maxResults: 50,
            before: "9",
        });
        expect(outcome).toEqual({
            results: [],
            scanned: 9,
            complete: true,
            continueBefore: null,
        });
    });

    it("is complete when the limit meets the end exactly", async () => {
        const outcome = await boundedScan({
            batches: batches().next,
            stampOf: String,
            visit: () => null,
            limit: 10,
            deadlineMs: 10_000,
            maxResults: 50,
            before: "10",
        });
        expect(outcome.scanned).toBe(10);
        expect(outcome.complete).toBe(true);
    });

    it("stops at the deadline", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-10-07T10:00:00Z"));
        const outcome = await boundedScan({
            batches: batches().next,
            stampOf: String,
            visit: (item) => {
                vi.setSystemTime(Date.now() + 1_000);
                return item;
            },
            limit: 100,
            deadlineMs: 3_500,
            maxResults: 50,
            before: null,
        });
        expect(outcome).toEqual({
            results: [99, 98, 97, 96],
            scanned: 4,
            complete: false,
            continueBefore: "96",
        });
    });

    it("does not fetch past the deadline", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-10-07T10:00:00Z"));
        const source = batches(2);
        const outcome = await boundedScan({
            batches: source.next,
            stampOf: String,
            visit: () => {
                vi.setSystemTime(Date.now() + 1_000);
                return null;
            },
            limit: 100,
            deadlineMs: 2_000,
            maxResults: 50,
            before: null,
        });
        expect(outcome.scanned).toBe(2);
        expect(outcome.complete).toBe(false);
        expect(source.calls).toEqual([null]);
    });

    it("stops once it has enough results", async () => {
        const outcome = await boundedScan({
            batches: batches().next,
            stampOf: String,
            visit: async (item) => (item % 2 === 0 ? item : null),
            limit: 100,
            deadlineMs: 10_000,
            maxResults: 3,
            before: null,
        });
        expect(outcome).toEqual({
            results: [98, 96, 94],
            scanned: 6,
            complete: false,
            continueBefore: "94",
        });
    });
});
