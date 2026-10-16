import { describe, expect, it } from "vitest";
import { formatCompactRelativeTime } from "@/lib/format-date";

const now = Date.parse("2026-10-16T12:00:00Z");
const at = (offsetMs: number) => new Date(now + offsetMs);
const english = (offsetMs: number) =>
    formatCompactRelativeTime(at(offsetMs), "en", now);

describe("formatCompactRelativeTime", () => {
    it("rounds into the next unit at the minute, hour and day boundaries", () => {
        expect(english(59_600)).toBe("in 1 min.");
        expect(english(3_599_600)).toBe("in 1 hr.");
        expect(english(23.6 * 3_600_000)).toBe("tomorrow");
    });

    it("rounds within the chosen unit", () => {
        expect(english(89.7 * 60_000)).toBe("in 1 hr.");
        expect(english(-35_000)).toBe("35 sec. ago");
        expect(english(-4 * 60_000)).toBe("4 min. ago");
    });

    it("says now for the current moment", () => {
        expect(english(0)).toBe("now");
        expect(english(-200)).toBe("now");
    });

    it("formats in Czech", () => {
        expect(formatCompactRelativeTime(at(-3 * 60_000), "cs-CZ", now)).toBe(
            "před 3 min",
        );
    });
});
