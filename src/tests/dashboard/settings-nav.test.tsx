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
    it("keeps legacy hash actions working after a previous dialog visit", () => {
        const { result, rerender } = renderHook(
            ({ open }) => useSettingsNav(open, () => {}, false),
            { initialProps: { open: true } },
        );
        act(() => result.current.setActiveSection("storage"));
        rerender({ open: false });
        window.history.replaceState({}, "", "/almanac?section=storage#export");
        rerender({ open: true });
        expect(result.current.activeSection).toBe("export");
        expect(window.location.hash).toBe("#export");
    });
    it("resolves a query link when the already-mounted dialog opens", () => {
        const { result, rerender } = renderHook(
            ({ open }) => useSettingsNav(open, () => {}, false),
            { initialProps: { open: false } },
        );
        window.history.replaceState({}, "", "/settings?section=recorder");
        rerender({ open: true });
        expect(result.current.activeSection).toBe("recorder");
        expect(window.location.search).toBe("?section=recorder");
    });
    it("opens the recorder query section ahead of hash and saved state", () => {
        localStorage.setItem("settings-last-section", "storage");
        window.history.replaceState(
            {},
            "",
            "/settings?section=recorder#providers",
        );
        const historyLength = window.history.length;
        const { result } = renderHook(() =>
            useSettingsNav(true, () => {}, false),
        );
        expect(result.current.activeSection).toBe("recorder");
        expect(window.location.search).toBe("?section=recorder");
        expect(window.history.length).toBe(historyLength);
        act(() => result.current.setActiveSection("storage"));
        expect(window.location.search).toBe("?section=storage");
        expect(window.history.length).toBe(historyLength);
    });

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
