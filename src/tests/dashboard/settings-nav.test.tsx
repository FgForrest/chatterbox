// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useSettingsNav } from "@/hooks/use-settings-nav";

afterEach(cleanup);
beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, "", "/almanac");
});

describe("settings URL history", () => {
    it("does not write a hash or add history while closed", () => {
        const historyLength = window.history.length;
        const { result } = renderHook(() =>
            useSettingsNav(false, () => {}, false),
        );
        act(() => result.current.setActiveSection("storage"));
        expect(window.location.href).toMatch(/\/almanac$/);
        expect(window.history.length).toBe(historyLength);
        expect(localStorage.length).toBe(0);
    });
    it("writes the selected hash only while open", () => {
        const { result, rerender } = renderHook(
            ({ open }) => useSettingsNav(open, () => {}, false),
            { initialProps: { open: false } },
        );
        rerender({ open: true });
        expect(window.location.hash).toBe("#providers");
        act(() => result.current.setActiveSection("storage"));
        expect(window.location.hash).toBe("#storage");
        rerender({ open: false });
        act(() => result.current.setActiveSection("providers"));
        expect(window.location.hash).toBe("#storage");
    });
});
