import { describe, expect, it } from "vitest";
import {
    dateTimeInput,
    dateTimeInputIso,
    resolveTimeZone,
    validTimeZone,
} from "@/lib/i18n/time-zone";

describe("time zone preferences", () => {
    it.each([
        [
            {
                user: "Asia/Tokyo",
                cookie: "Europe%2FPrague",
                organization: "America/New_York",
            },
            "Asia/Tokyo",
        ],
        [
            { cookie: "Europe%2FPrague", organization: "America/New_York" },
            "Europe/Prague",
        ],
        [
            { cookie: "Invalid/Zone", organization: "America/New_York" },
            "America/New_York",
        ],
        [
            { user: "Asia/Tokyo", organization: "America/New_York" },
            "Asia/Tokyo",
        ],
        [{ organization: "America/New_York" }, "America/New_York"],
        [
            { user: "Invalid/Zone", cookie: "%", organization: "Invalid/Zone" },
            "UTC",
        ],
        [{}, "UTC"],
        [{ user: "UTC", cookie: "Europe%2FPrague" }, "UTC"],
    ])("resolves %o as %s", (preferences, expected) => {
        expect(resolveTimeZone(preferences)).toBe(expected);
    });
    it.each([
        null,
        undefined,
        42,
        "",
        "Not/AZone",
        "+01:00",
        "Europe/Prague; Path=/",
        "a".repeat(101),
    ])("rejects invalid API value %s", (value) =>
        expect(validTimeZone(value)).toBeNull());
    it.each([
        "UTC",
        "Europe/Prague",
        "America/New_York",
        "Etc/GMT+1",
    ])("accepts IANA zone %s", (zone) =>
        expect(validTimeZone(zone)).toBe(zone));
    it.each([
        ["2026-11-06T09:00:00.000Z", "2026-11-06T10:00"],
        ["2026-07-06T09:00:00.000Z", "2026-07-06T11:00"],
    ])("round-trips %s through a datetime-local field", (iso, wall) => {
        expect(dateTimeInput(iso, "Europe/Prague")).toBe(wall);
        expect(dateTimeInputIso(wall, "Europe/Prague")).toBe(iso);
    });
    it("rejects the spring daylight-saving gap and malformed dates", () => {
        expect(
            dateTimeInputIso("2026-03-29T02:30", "Europe/Prague"),
        ).toBeNull();
        expect(dateTimeInputIso("2026-02-31T12:00", "UTC")).toBeNull();
        expect(dateTimeInputIso("invalid", "UTC")).toBeNull();
    });
});
