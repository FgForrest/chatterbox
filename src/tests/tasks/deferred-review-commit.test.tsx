// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDeferredReviewCommit } from "@/hooks/use-deferred-review-commit";

const { toastOptions, dismiss } = vi.hoisted(() => ({
    toastOptions: {
        current: null as null | {
            duration: number;
            action: { onClick: () => void };
            onAutoClose: () => void;
            onDismiss: () => void;
        },
    },
    dismiss: vi.fn(),
}));
vi.mock("sonner", () => ({
    toast: {
        dismiss,
        success: vi.fn((_message, options) => {
            toastOptions.current = options;
            setTimeout(options.onAutoClose, options.duration);
            return "undo-toast";
        }),
    },
}));
afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
});

describe("deferred review commits", () => {
    it("Undo cancels the request and restores the review", async () => {
        vi.useFakeTimers();
        const commit = vi.fn(async () => {});
        const { result } = renderHook(useDeferredReviewCommit);
        act(() => result.current.defer("Skipped", "Undo", commit));
        expect(result.current.hidden).toBe(true);
        expect(commit).not.toHaveBeenCalled();
        act(() => toastOptions.current?.action.onClick());
        expect(result.current.hidden).toBe(false);
        await act(() => vi.advanceTimersByTimeAsync(8000));
        expect(commit).not.toHaveBeenCalled();
    });
    it("waits eight seconds for the toast to close before committing once", async () => {
        vi.useFakeTimers();
        const commit = vi.fn(async () => {});
        const { result } = renderHook(useDeferredReviewCommit);
        act(() => result.current.defer("Skipped", "Undo", commit));
        await act(() => vi.advanceTimersByTimeAsync(7999));
        expect(commit).not.toHaveBeenCalled();
        await act(() => vi.advanceTimersByTimeAsync(1));
        expect(commit).toHaveBeenCalledExactlyOnceWith(false);
        act(() => toastOptions.current?.onDismiss());
        expect(commit).toHaveBeenCalledTimes(1);
    });
    it("commits with keepalive when unmounted", () => {
        vi.useFakeTimers();
        const commit = vi.fn(async () => {});
        const { result, unmount } = renderHook(useDeferredReviewCommit);
        act(() => result.current.defer("Skipped", "Undo", commit));
        unmount();
        expect(commit).toHaveBeenCalledExactlyOnceWith(true);
    });
    it("commits with keepalive when the page becomes hidden", () => {
        vi.useFakeTimers();
        const commit = vi.fn(async () => {});
        const { result } = renderHook(useDeferredReviewCommit);
        act(() => result.current.defer("Skipped", "Undo", commit));
        Object.defineProperty(document, "visibilityState", {
            configurable: true,
            value: "hidden",
        });
        act(() => document.dispatchEvent(new Event("visibilitychange")));
        expect(commit).toHaveBeenCalledExactlyOnceWith(true);
        Object.defineProperty(document, "visibilityState", {
            configurable: true,
            value: "visible",
        });
    });
    it("restores the review after a rejected commit", async () => {
        vi.useFakeTimers();
        const commit = vi.fn(async () => {
            throw new Error("offline");
        });
        const { result } = renderHook(useDeferredReviewCommit);
        act(() => result.current.defer("Skipped", "Undo", commit));
        await act(() => vi.advanceTimersByTimeAsync(8000));
        expect(result.current.hidden).toBe(false);
    });
});
