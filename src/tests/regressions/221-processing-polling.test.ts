// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useItemProcessing } from "@/hooks/use-item-processing";
import { invalidateItemProcessing } from "@/lib/pipeline/item-processing-events";
import { processingFixture } from "@/tests/pipeline/processing-fixture";

vi.mock("@/components/tasks/task-api", () => ({
    onTasksChanged: () => () => {},
}));

const serverNow = Date.parse("2026-10-23T09:00:00Z");
function processing(delay: number) {
    return {
        ...processingFixture({
            itemId: "item-polling-veln",
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
        nextCheckAt: new Date(serverNow + delay).toISOString(),
        nextCheckInMs: delay,
    };
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

describe("#221 processing timers across client clock skew", () => {
    it.each([
        -120_000, -3_000, 3_000, 120_000,
    ])("re-arms a repeated hold response for 15 minutes with clock skew %s", async (skew) => {
        vi.setSystemTime(serverNow + skew);
        const initial = processing(1_000);
        const fetchMock = vi.fn(async () =>
            Response.json({ processing: initial }),
        );
        vi.stubGlobal("fetch", fetchMock);
        renderHook(() =>
            useItemProcessing({
                itemId: initial.itemId,
                kind: "audio",
                initialData: initial,
            }),
        );
        await act(async () => {
            await vi.advanceTimersByTimeAsync(2_999);
        });
        expect(fetchMock).not.toHaveBeenCalled();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1);
        });
        for (let i = 1; i < 300; i++) {
            await act(async () => {
                await vi.advanceTimersByTimeAsync(3_000);
            });
            expect(vi.getTimerCount()).toBe(1);
        }
        expect(fetchMock).toHaveBeenCalledTimes(300);
    });
    it.each([
        -120_000, 120_000,
    ])("polls an idle item once per minute with clock skew %s", async (skew) => {
        vi.setSystemTime(serverNow + skew);
        const initial = processing(60_000);
        const fetchMock = vi.fn(async () =>
            Response.json({ processing: initial }),
        );
        vi.stubGlobal("fetch", fetchMock);
        renderHook(() =>
            useItemProcessing({
                itemId: initial.itemId,
                kind: "audio",
                initialData: initial,
            }),
        );
        for (let i = 0; i < 3; i++) {
            await act(async () => {
                await vi.advanceTimersByTimeAsync(59_999);
            });
            expect(fetchMock).toHaveBeenCalledTimes(i);
            await act(async () => {
                await vi.advanceTimersByTimeAsync(1);
            });
            expect(fetchMock).toHaveBeenCalledTimes(i + 1);
            expect(vi.getTimerCount()).toBe(1);
        }
    });
    it.each([
        401, 403, 404,
    ])("stops all refresh triggers after HTTP %s, then allows a different item", async (status) => {
        const initial = processing(60_000);
        const fetchMock = vi.fn(async () => new Response("", { status }));
        vi.stubGlobal("fetch", fetchMock);
        const { result, rerender } = renderHook(
            ({ itemId }) => useItemProcessing({ itemId, kind: "audio" }),
            { initialProps: { itemId: initial.itemId } },
        );
        await act(async () => {
            await result.current.refresh();
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(900_000);
            window.dispatchEvent(new Event("focus"));
            document.dispatchEvent(new Event("visibilitychange"));
            invalidateItemProcessing(initial.itemId);
            await result.current.refresh();
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        rerender({ itemId: "item-polling-zurna" });
        await act(async () => {
            await result.current.refresh();
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    it("requests only the mail processing projection in the selected view", async () => {
        const initial = processing(60_000);
        const fetchMock = vi.fn(async () =>
            Response.json({ processing: initial }),
        );
        vi.stubGlobal("fetch", fetchMock);
        const { result } = renderHook(() =>
            useItemProcessing({
                itemId: initial.itemId,
                kind: "mail",
                view: "org",
                initialData: initial,
            }),
        );
        await act(async () => {
            await result.current.refresh();
        });
        expect(fetchMock).toHaveBeenCalledWith(
            `/api/mail/${initial.itemId}?processing=1&view=org`,
        );
    });
});
