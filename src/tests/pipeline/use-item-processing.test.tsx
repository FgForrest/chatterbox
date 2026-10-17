// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useItemProcessing } from "@/hooks/use-item-processing";
import type { ItemProcessingPresentation } from "@/lib/pipeline/presentation";

vi.mock("@/components/tasks/task-api", () => ({
    onTasksChanged: () => () => {},
}));

function processing(
    job: "queued" | "running" | null,
): ItemProcessingPresentation {
    return {
        itemId: "recording-1",
        kind: "audio",
        legacy: false,
        manualOnly: false,
        phases: {
            categorize: {
                state: "done",
                reason: "categorized",
                generation: 0,
                at: "2026-10-16T08:00:00.000Z",
            },
            transcribe: {
                state: job ? "running" : "done",
                generation: 0,
                at: "2026-10-16T08:00:00.000Z",
            },
        },
        profile: null,
        placements: [],
        intents: [],
        outputs: {
            transcript: job === null,
            learn: false,
            summary: false,
        },
        processAgain: false,
        processAgainReason: null,
        learnFindingsWaiting: 0,
        taskReviewWaiting: 0,
        jobs: { transcription: job, summary: null },
        failures: [],
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

describe("useItemProcessing", () => {
    it("polls every five seconds, refreshes on focus, and stops after work", async () => {
        const done = processing(null);
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ processing: processing("running") }),
            })
            .mockResolvedValue({
                ok: true,
                json: async () => ({ processing: done }),
            });
        vi.stubGlobal("fetch", fetchMock);
        const initial = processing("queued");
        const { result } = renderHook(() =>
            useItemProcessing({
                itemId: "recording-1",
                kind: "audio",
                initialData: initial,
            }),
        );

        await act(async () => {
            vi.advanceTimersByTime(5_000);
            await Promise.resolve();
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(result.current.data?.jobs.transcription).toBe("running");

        await act(async () => {
            window.dispatchEvent(new Event("focus"));
            await Promise.resolve();
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(result.current.data?.jobs.transcription).toBeNull();

        await act(async () => {
            vi.advanceTimersByTime(15_000);
            await Promise.resolve();
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does not poll or focus-refresh a hidden tab", async () => {
        Object.defineProperty(document, "visibilityState", {
            configurable: true,
            value: "hidden",
        });
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        const initial = processing("queued");
        renderHook(() =>
            useItemProcessing({
                itemId: "recording-1",
                kind: "audio",
                initialData: initial,
            }),
        );

        await act(async () => {
            vi.advanceTimersByTime(10_000);
            window.dispatchEvent(new Event("focus"));
            await Promise.resolve();
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
