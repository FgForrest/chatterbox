// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRecorderSetupMarker } from "@/hooks/use-recorder-setup-marker";

const appState = { mobileView: "detail", draft: "draft-fenra" };
const nextState = {
    __NA: true,
    _N: true,
    __N: true,
    __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: [] },
};

beforeEach(() => {
    window.history.replaceState(
        { ...appState, ...nextState },
        "",
        "/dashboard?recording=recording-velno&section=storage#notes",
    );
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe("recorder setup URL marker", () => {
    it("keeps app state and restores the prior section without adding history", () => {
        const replace = vi.spyOn(window.history, "replaceState");
        const length = window.history.length;
        const { unmount } = renderHook(() => useRecorderSetupMarker(true));
        expect(replace).toHaveBeenLastCalledWith(appState, "", expect.any(URL));
        expect(window.location.search).toBe(
            "?recording=recording-velno&section=recorder",
        );
        window.history.replaceState(
            { ...appState, mobileView: "list", ...nextState },
            "",
            window.location.href,
        );
        unmount();
        expect(replace).toHaveBeenLastCalledWith(
            { ...appState, mobileView: "list" },
            "",
            expect.any(URL),
        );
        expect(window.location.search).toBe(
            "?recording=recording-velno&section=storage",
        );
        expect(window.location.hash).toBe("#notes");
        expect(window.history.length).toBe(length);
    });

    it.each([
        null,
        "recorder",
    ])("removes the marker after a prior %s section", (section) => {
        const url = new URL(window.location.href);
        if (section) url.searchParams.set("section", section);
        else url.searchParams.delete("section");
        window.history.replaceState({ ...appState, ...nextState }, "", url);
        const { rerender } = renderHook(
            ({ visible }) => useRecorderSetupMarker(visible),
            { initialProps: { visible: true } },
        );
        rerender({ visible: false });
        expect(window.location.search).toBe("?recording=recording-velno");
        expect(window.history.state).toEqual(appState);
    });

    it("leaves a section selected during setup unchanged on cleanup", () => {
        const { unmount } = renderHook(() => useRecorderSetupMarker(true));
        const url = new URL(window.location.href);
        url.searchParams.set("section", "providers");
        window.history.replaceState(appState, "", url);
        const replace = vi.spyOn(window.history, "replaceState");
        unmount();
        expect(replace).not.toHaveBeenCalled();
        expect(window.location.search).toContain("section=providers");
    });

    it("does not write while hidden", () => {
        const replace = vi.spyOn(window.history, "replaceState");
        renderHook(() => useRecorderSetupMarker(false));
        expect(replace).not.toHaveBeenCalled();
    });
});
