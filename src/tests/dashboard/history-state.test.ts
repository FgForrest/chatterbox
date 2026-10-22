// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { getAppHistoryState } from "@/lib/history-state";

afterEach(() => vi.restoreAllMocks());

describe("application history state", () => {
    it("removes Next's markers and router tree while preserving application keys", () => {
        const state = Object.freeze({
            __NA: true,
            _N: true,
            __N: true,
            __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: [] },
            mobileView: "detail",
            draft: { id: "draft-velno" },
            expanded: false,
        });
        vi.spyOn(window.history, "state", "get").mockReturnValue(state);
        expect(getAppHistoryState()).toEqual({
            mobileView: "detail",
            draft: state.draft,
            expanded: false,
        });
        expect(state.__NA).toBe(true);
        expect(getAppHistoryState()).not.toBe(state);
    });

    it.each([
        null,
        undefined,
        "",
        0,
    ])("handles an empty state (%s)", (state) => {
        vi.spyOn(window.history, "state", "get").mockReturnValue(state);
        expect(getAppHistoryState()).toEqual({});
    });
});
