// @vitest-environment jsdom
// biome-ignore-all lint/suspicious/noDocumentCookie: Exercise browser cookie synchronization.
import { cleanup, fireEvent, render } from "@testing-library/react";
import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ViewerTimeZone } from "@/components/viewer-time-zone";
import { TIME_ZONE_COOKIE, timeZoneFromCookie } from "@/lib/i18n/time-zone";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

beforeEach(() => {
    document.cookie = `${TIME_ZONE_COOKIE}=; Max-Age=0; Path=/`;
    refresh.mockReset();
});
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe("time zone cookies", () => {
    it.each([
        undefined,
        null,
        "",
        "%",
        "Invalid/Zone",
        "Europe/Prague; Path=/",
        "Europe%2FPrague%00",
        "+01:00",
        "a".repeat(101),
    ])("uses UTC for %s", (value) => {
        expect(timeZoneFromCookie(value)).toBe("UTC");
    });
    it.each([
        "Europe/Prague",
        "Europe%2FPrague",
        "America/New_York",
        "Etc/GMT+1",
        "UTC",
    ])("accepts %s", (value) => {
        expect(timeZoneFromCookie(value)).toBe(decodeURIComponent(value));
    });
    it("formats Prague winter and summer clock times from the validated cookie", () => {
        const format = new Intl.DateTimeFormat("cs-CZ", {
            timeZone: timeZoneFromCookie("Europe%2FPrague"),
            hour: "2-digit",
            minute: "2-digit",
        });
        expect(format.format(new Date("2026-11-06T09:00:00Z"))).toBe("10:00");
        expect(format.format(new Date("2026-07-06T09:00:00Z"))).toBe("11:00");
    });
    it("renders no server markup and refreshes once even with StrictMode effects", () => {
        expect(renderToString(<ViewerTimeZone />)).toBe("");
        render(
            <StrictMode>
                <ViewerTimeZone />
            </StrictMode>,
        );
        expect(document.cookie).toContain(
            `${TIME_ZONE_COOKIE}=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`,
        );
        expect(refresh).toHaveBeenCalledOnce();
        fireEvent.focus(window);
        expect(refresh).toHaveBeenCalledOnce();
    });
    it("updates a changed zone once and ignores repeated focus events", () => {
        document.cookie = `${TIME_ZONE_COOKIE}=Pacific%2FHonolulu; Path=/`;
        render(<ViewerTimeZone />);
        expect(refresh).toHaveBeenCalledOnce();
        document.cookie = `${TIME_ZONE_COOKIE}=Europe%2FPrague; Path=/`;
        fireEvent.focus(window);
        expect(refresh).toHaveBeenCalledTimes(2);
        fireEvent.focus(window);
        expect(refresh).toHaveBeenCalledTimes(2);
    });
});
