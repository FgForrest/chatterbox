import { describe, expect, it } from "vitest";
import { productName } from "@/lib/brand";
import {
    bucketize,
    calendarDay,
    chartScale,
    latencyPercentile,
    niceStep,
    packRanking,
    previousMinutes,
    type RankingRow,
    recordingSource,
    shiftDay,
    sliceRange,
    sum,
    tickIndices,
    unpackRanking,
    validateTimeZone,
} from "@/lib/statistics/data";
import { statisticsFixture } from "./fixtures";

describe("statistics ranges and daily aggregates", () => {
    it("keeps 62 days daily and switches 63 days to weeks", () => {
        expect(bucketize({ start: 0, end: 61 })).toHaveLength(62);
        expect(bucketize({ start: 0, end: 62 })).toHaveLength(9);
    });
    it("clips the first week to the exact selected range", () => {
        const buckets = bucketize({ start: 100, end: 189 });
        expect(buckets[0]).toEqual({ start: 100, end: 105 });
        expect(buckets.at(-1)).toEqual({ start: 183, end: 189 });
        expect(
            buckets.reduce((n, bucket) => n + bucket.end - bucket.start + 1, 0),
        ).toBe(90);
    });
    it("covers all 365 days without dropping the oldest partial week", () => {
        const buckets = bucketize({ start: 0, end: 364 });
        expect(buckets[0]).toEqual({ start: 0, end: 0 });
        expect(buckets.at(-1)).toEqual({ start: 358, end: 364 });
    });
    it("normalizes reversed, fractional and out-of-bounds brushes", () => {
        expect(sliceRange(400, -3)).toEqual({ start: 0, end: 364 });
        expect(sliceRange(10.9, 5.8)).toEqual({ start: 5, end: 10 });
    });
    it("sums only the selected days", () => {
        expect(sum([1, 10, 100], { start: 1, end: 2 })).toBe(110);
        expect(sum([1, 2], { start: -5, end: 9 })).toBe(3);
    });
    it("compares a year to a full previous year without truncating history", () => {
        const data = statisticsFixture();
        data.comparisonMinutes.fill(2);
        expect(previousMinutes(data, { start: 0, end: 364 })).toBe(730);
        expect(previousMinutes(data, { start: 100, end: 189 })).toBe(0);
    });
    it("computes weighted percentiles across days rather than averaging percentiles", () => {
        const rows: [number, number, number][] = [
            [0, 60, 9],
            [1, 6000, 1],
        ];
        expect(latencyPercentile(rows, { start: 0, end: 1 }, 0.5)).toBe(1);
        expect(latencyPercentile(rows, { start: 0, end: 1 }, 0.9)).toBeCloseTo(
            10.9,
        );
        expect(latencyPercentile(rows, { start: 1, end: 1 }, 0.5)).toBe(100);
        expect(latencyPercentile(rows, { start: 2, end: 3 }, 0.5)).toBeNull();
    });
});

describe("chart scales and ticks", () => {
    it.each([
        [0, 1],
        [0.012, 0.02],
        [1.1, 2],
        [2.1, 5],
        [5.1, 10],
        [100, 100],
    ])("niceStep(%s) is %s", (value, expected) =>
        expect(niceStep(value)).toBe(expected));
    it("covers the maximum with evenly spaced ticks", () => {
        expect(chartScale(73)).toEqual({
            step: 20,
            max: 80,
            ticks: [0, 20, 40, 60, 80],
        });
        expect(chartScale(0).max).toBeGreaterThan(0);
        expect(tickIndices(30, 280)).toEqual([0, 8, 16, 24]);
        expect(tickIndices(0, 0)).toEqual([]);
    });
});

describe("sources and calendar days", () => {
    it.each([
        ["local", "meeting-test", "meeting"],
        ["recorder", "uploaded-test", "upload"],
        ["recorder", "meeting-test", "meeting"],
        ["recorder", "remote-id", "plaud"],
    ])("derives %s / %s as %s", (device, id, source) =>
        expect(recordingSource(device, id)).toBe(source));
    it("validates IANA zones without accepting SQL or fixed-offset strings", () => {
        expect(validateTimeZone("Europe/Prague")).toBe("Europe/Prague");
        expect(validateTimeZone("Etc/GMT+1")).toBe("Etc/GMT+1");
        expect(validateTimeZone("UTC")).toBe("UTC");
        expect(validateTimeZone("UTC'; select 1")).toBe("UTC");
        expect(validateTimeZone("+02:00")).toBe("UTC");
        expect(validateTimeZone(null)).toBe("UTC");
    });
    it("uses the viewer's date and shifts dates through DST and leap days", () => {
        expect(
            calendarDay(new Date("2026-10-26T00:30:00Z"), "America/New_York"),
        ).toBe("2026-10-25");
        expect(calendarDay(new Date("2026-10-26T00:30:00Z"), "Etc/GMT+1")).toBe(
            "2026-10-25",
        );
        expect(shiftDay("2024-03-01", -1)).toBe("2024-02-29");
        expect(shiftDay("2026-10-25", 1)).toBe("2026-10-26");
    });
});

describe("statistics product name case", () => {
    it("declines the Czech name centrally without changing English or default callers", () => {
        expect(productName("cs-CZ", "accusative")).toBe("Klepnu");
        expect(productName("cs-CZ")).toBe("Klepna");
        expect(productName("en", "accusative")).toBe("Chatterbox");
    });
});

describe("compact daily rankings", () => {
    it("round-trips sparse days, zeroes, falling totals and large microdollar values", () => {
        const rows: RankingRow[] = [
            [364, 1, 1.5, 2, 0, 5000.123456],
            [0, 0, 90, 0, 4, 0.1],
            [12, 0, 15, 3, 0, 0],
            [13, 0, 15, 3, 0, 0],
        ];
        expect(unpackRanking(packRanking(rows, 3))).toEqual([
            rows[1],
            rows[2],
            rows[3],
            rows[0],
        ]);
        expect(packRanking([], 0)).toEqual([]);
    });
    it("keeps a dense and varied 50-member year below 200 KB", () => {
        const rows: RankingRow[] = [];
        for (let day = 0; day < 365; day++)
            for (let member = 0; member < 50; member++)
                rows.push([
                    day,
                    member,
                    15 + ((day * 7 + member * 13) % 120),
                    (day + member) % 8,
                    (day * 3 + member) % 5,
                    0.1 + ((day * 23 + member * 17) % 10000) / 1e6,
                ]);
        const data = statisticsFixture("everyone");
        data.members = Array.from({ length: 50 }, (_, i) => [
            `Member ${i}`,
            i === 0,
        ]);
        data.ranking = packRanking(rows, 50);
        const size = Buffer.byteLength(JSON.stringify(data));
        process.stdout.write(
            `Dense statistics payload: ${size} bytes, 50 members, 18,250 active member-days\n`,
        );
        expect(size).toBeLessThan(200_000);
        expect(unpackRanking(data.ranking)).toHaveLength(18_250);
    });
});
