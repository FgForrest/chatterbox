// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useItemProcessing } from "@/hooks/use-item-processing";
import { invalidateItemProcessing } from "@/lib/pipeline/item-processing-events";
import { processingFixture } from "@/tests/pipeline/processing-fixture";

vi.mock("@/components/tasks/task-api", () => ({
    onTasksChanged: () => () => {},
}));

function processing(delay = 60_000, itemId = "item-veln") {
    return {
        ...processingFixture({
            itemId,
            kind: "audio",
            legacy: false,
            manualOnly: false,
            phases: {},
            profile: null,
            placements: [],
            intents: [],
            outputs: { transcript: false, summary: false, learn: false },
            processAgain: false,
            processAgainReason: null,
            learnFindingsWaiting: 0,
            taskReviewWaiting: 0,
            jobs: { transcription: null, summary: null },
            failures: [],
        }),
        nextCheckAt: new Date(Date.now() + delay).toISOString(),
    };
}
function visibility(state: "hidden" | "visible") {
    Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: state,
    });
    document.dispatchEvent(new Event("visibilitychange"));
}
beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
    });
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("server-driven processing refresh", () => {
    it("keeps one timer, follows successive deadlines, and continues while idle", async () => {
        const fetchMock = vi
            .fn()
            .mockImplementation(async () =>
                Response.json({ processing: processing(60_000) }),
            );
        vi.stubGlobal("fetch", fetchMock);
        const initial = processing(3_000);
        renderHook(() =>
            useItemProcessing({
                itemId: initial.itemId,
                kind: "audio",
                initialData: initial,
            }),
        );
        expect(vi.getTimerCount()).toBe(1);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(2_999);
        });
        expect(fetchMock).not.toHaveBeenCalled();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1);
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(1);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(59_999);
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1);
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    it("refetches on focus, pauses hidden polling, and immediately refreshes when visible", async () => {
        const fetchMock = vi
            .fn()
            .mockImplementation(async () =>
                Response.json({ processing: processing(5_000) }),
            );
        vi.stubGlobal("fetch", fetchMock);
        const initial = processing(5_000);
        renderHook(() =>
            useItemProcessing({
                itemId: initial.itemId,
                kind: "audio",
                initialData: initial,
            }),
        );
        await act(async () => {
            window.dispatchEvent(new Event("focus"));
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await act(async () => {
            visibility("hidden");
        });
        expect(vi.getTimerCount()).toBe(0);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(600_000);
            window.dispatchEvent(new Event("focus"));
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await act(async () => {
            visibility("visible");
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(1);
    });
    it("shows staleness after two consecutive failures and clears it on retry success", async () => {
        const fetchMock = vi
            .fn()
            .mockRejectedValueOnce(new Error("offline"))
            .mockResolvedValueOnce(new Response("", { status: 503 }))
            .mockImplementation(async () =>
                Response.json({ processing: processing() }),
            );
        vi.stubGlobal("fetch", fetchMock);
        const initial = processing(5_000);
        const { result } = renderHook(() =>
            useItemProcessing({
                itemId: initial.itemId,
                kind: "audio",
                initialData: initial,
            }),
        );
        await act(async () => {
            await result.current.refresh();
        });
        expect(result.current.stale).toBe(false);
        await act(async () => {
            await result.current.refresh();
        });
        expect(result.current.stale).toBe(true);
        await act(async () => {
            await result.current.refresh();
        });
        expect(result.current.stale).toBe(false);
        expect(vi.getTimerCount()).toBe(1);
    });
    it("resets the consecutive failure count on a successful read", async () => {
        const fetchMock = vi
            .fn()
            .mockRejectedValueOnce(new Error("offline"))
            .mockImplementationOnce(async () =>
                Response.json({ processing: processing() }),
            )
            .mockRejectedValueOnce(new Error("offline"));
        vi.stubGlobal("fetch", fetchMock);
        const initial = processing();
        const { result } = renderHook(() =>
            useItemProcessing({
                itemId: initial.itemId,
                kind: "audio",
                initialData: initial,
            }),
        );
        for (let i = 0; i < 3; i++)
            await act(async () => {
                await result.current.refresh();
            });
        expect(result.current.stale).toBe(false);
    });
    it("immediately refetches after a local action and keeps optimistic state while it waits", async () => {
        let resolve: (value: Response) => void = () => {};
        const fetchMock = vi.fn(
            () =>
                new Promise<Response>((r) => {
                    resolve = r;
                }),
        );
        vi.stubGlobal("fetch", fetchMock);
        const initial = processing();
        const { result } = renderHook(() =>
            useItemProcessing({
                itemId: initial.itemId,
                kind: "audio",
                initialData: initial,
            }),
        );
        act(() => {
            result.current.setData({ ...initial, processAgain: true });
            invalidateItemProcessing(initial.itemId);
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(result.current.data?.processAgain).toBe(true);
        await act(async () => {
            resolve(Response.json({ processing: processing() }));
        });
        expect(result.current.data?.processAgain).toBe(false);
    });
    it("deduplicates concurrent refresh triggers and ignores another item's late response", async () => {
        let resolve: (value: Response) => void = () => {};
        const fetchMock = vi.fn(
            () =>
                new Promise<Response>((r) => {
                    resolve = r;
                }),
        );
        vi.stubGlobal("fetch", fetchMock);
        const first = processing(5_000, "item-zurna");
        const second = processing(60_000, "item-tavro");
        const { result, rerender } = renderHook(
            ({ initial }) =>
                useItemProcessing({
                    itemId: initial.itemId,
                    kind: "audio",
                    initialData: initial,
                }),
            { initialProps: { initial: first } },
        );
        act(() => {
            void result.current.refresh();
            window.dispatchEvent(new Event("focus"));
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        rerender({ initial: second });
        await act(async () => {
            resolve(Response.json({ processing: first }));
        });
        expect(result.current.data?.itemId).toBe(second.itemId);
    });
    it("refetches a local write after an older in-flight read finishes", async () => {
        let resolve: (value: Response) => void = () => {};
        const initial = processing(600_000, "item-race-veln");
        const fetchMock = vi
            .fn()
            .mockImplementationOnce(
                () =>
                    new Promise<Response>((r) => {
                        resolve = r;
                    }),
            )
            .mockImplementation(async () =>
                Response.json({
                    processing: {
                        ...processing(60_000, initial.itemId),
                        processAgain: true,
                    },
                }),
            );
        vi.stubGlobal("fetch", fetchMock);
        const { result } = renderHook(() =>
            useItemProcessing({
                itemId: initial.itemId,
                kind: "audio",
                initialData: initial,
            }),
        );
        act(() => {
            void result.current.refresh();
            invalidateItemProcessing(initial.itemId);
            invalidateItemProcessing(initial.itemId);
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await act(async () => {
            resolve(Response.json({ processing: initial }));
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(result.current.data?.processAgain).toBe(true);
        expect(vi.getTimerCount()).toBe(1);
    });
    it("cancels a write's pending follow-up refresh when the item unmounts", async () => {
        let resolve: (response: Response) => void = () => {};
        const initial = processing(600_000, "item-unmounted-request-felno");
        const fetchMock = vi.fn(
            () =>
                new Promise<Response>((r) => {
                    resolve = r;
                }),
        );
        vi.stubGlobal("fetch", fetchMock);
        const { result, unmount } = renderHook(() =>
            useItemProcessing({
                itemId: initial.itemId,
                kind: "audio",
                initialData: initial,
            }),
        );
        act(() => {
            void result.current.refresh();
            invalidateItemProcessing(initial.itemId);
        });
        unmount();
        await act(async () => {
            resolve(Response.json({ processing: initial }));
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });
    it("cleans up its timer and listeners on unmount", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        const initial = processing(60_000, "item-unmount-felno");
        const { unmount } = renderHook(() =>
            useItemProcessing({
                itemId: initial.itemId,
                kind: "audio",
                initialData: initial,
            }),
        );
        unmount();
        expect(vi.getTimerCount()).toBe(0);
        await act(async () => {
            window.dispatchEvent(new Event("focus"));
            invalidateItemProcessing(initial.itemId);
            await vi.advanceTimersByTimeAsync(120_000);
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it("does not fetch or schedule while disabled", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        renderHook(() =>
            useItemProcessing({
                itemId: "item-disabled",
                kind: "audio",
                enabled: false,
            }),
        );
        await act(async () => {
            window.dispatchEvent(new Event("focus"));
        });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
});
