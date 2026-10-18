// @vitest-environment jsdom

import { act, cleanup, render, renderHook } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useItemProcessing } from "@/hooks/use-item-processing";
import {
    ITEM_PROCESSING_REVALIDATION_MS,
    invalidateItemProcessing,
} from "@/lib/pipeline/item-processing-events";
import type { ItemProcessingPresentation } from "@/lib/pipeline/presentation";

vi.mock("@/components/tasks/task-api", () => ({
    onTasksChanged: () => () => {},
}));

function processing(
    job: "queued" | "running" | null,
    itemId = "recording-1",
): ItemProcessingPresentation {
    return {
        itemId,
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

interface MailProcessingProbeProps {
    itemId: string;
    initialData: ItemProcessingPresentation | null;
    onProcessingChange: (data: ItemProcessingPresentation | null) => void;
}

function MailProcessingProbe({
    itemId,
    initialData,
    onProcessingChange,
}: MailProcessingProbeProps) {
    const { data } = useItemProcessing({
        itemId,
        kind: "mail",
        initialData,
    });

    useEffect(() => {
        onProcessingChange(data);
    }, [data, onProcessingChange]);

    return null;
}

function MailRoundTrip({
    initialData,
}: {
    initialData: ItemProcessingPresentation;
}) {
    const [processingData, setProcessingData] =
        useState<ItemProcessingPresentation | null>(initialData);

    useEffect(() => {
        setProcessingData(initialData);
    }, [initialData]);

    return (
        <MailProcessingProbe
            itemId={initialData.itemId}
            initialData={processingData}
            onProcessingChange={setProcessingData}
        />
    );
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
    it("polls every five seconds, refreshes on focus, and settles after work", async () => {
        const done = processing(null);
        const settled: ItemProcessingPresentation = {
            ...done,
            phases: {
                ...done.phases,
                learn: {
                    state: "skipped",
                    reason: "profile_off",
                    generation: 0,
                    at: "2026-10-16T08:00:01.000Z",
                },
            },
        };
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ processing: processing("running") }),
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ processing: done }),
            })
            .mockResolvedValue({
                ok: true,
                json: async () => ({ processing: settled }),
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
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(result.current.data?.jobs.transcription).toBeNull();

        await act(async () => {
            vi.advanceTimersByTime(15_000);
            await Promise.resolve();
        });
        expect(fetchMock).toHaveBeenCalledTimes(3);
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

    it("moves a finished Learn review to the server's running state without a reload", async () => {
        const review: ItemProcessingPresentation = {
            ...processing(null),
            phases: {
                ...processing(null).phases,
                learn: {
                    state: "waiting",
                    reason: "review_pending",
                    generation: 1,
                    at: "2026-10-16T08:01:00.000Z",
                },
            },
            learnFindingsWaiting: 2,
        };
        const running: ItemProcessingPresentation = {
            ...review,
            phases: {
                ...review.phases,
                learn: {
                    state: "running",
                    reason: "started",
                    generation: 2,
                    at: "2026-10-16T08:02:00.000Z",
                },
            },
            learnFindingsWaiting: 0,
        };
        const findingsCleared: ItemProcessingPresentation = {
            ...review,
            learnFindingsWaiting: 0,
        };
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ processing: findingsCleared }),
            })
            .mockResolvedValue({
                ok: true,
                json: async () => ({ processing: running }),
            });
        vi.stubGlobal("fetch", fetchMock);
        const { result } = renderHook(() =>
            useItemProcessing({
                itemId: review.itemId,
                kind: "audio",
                initialData: review,
            }),
        );

        await act(async () => {
            invalidateItemProcessing(review.itemId);
            await Promise.resolve();
        });
        expect(result.current.workflow?.status?.message).toBe("learnReview");
        expect(result.current.data?.learnFindingsWaiting).toBe(0);

        await act(async () => {
            vi.advanceTimersByTime(2_000);
            await Promise.resolve();
        });
        expect(result.current.workflow?.status?.message).toBe("learnRunning");
        expect(
            result.current.workflow?.steps.find((step) => step.id === "learn")
                ?.state,
        ).toBe("working");
    });

    it("keeps revalidating a newly selected upload until categorization arrives", async () => {
        const itemId = "uploaded-recording";
        const waiting: ItemProcessingPresentation = {
            ...processing(null, itemId),
            phases: {
                categorize: {
                    state: "waiting",
                    reason: "needs_folder",
                    generation: 0,
                    at: "2026-10-16T08:00:03.000Z",
                },
            },
            outputs: { transcript: false, learn: false, summary: false },
        };
        const empty: ItemProcessingPresentation = {
            ...processing(null, itemId),
            phases: {},
            outputs: { transcript: false, learn: false, summary: false },
        };
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ processing: empty }),
            })
            .mockResolvedValue({
                ok: true,
                json: async () => ({ processing: waiting }),
            });
        vi.stubGlobal("fetch", fetchMock);
        invalidateItemProcessing(itemId);
        const { result } = renderHook(() =>
            useItemProcessing({
                itemId,
                kind: "audio",
                initialData: null,
            }),
        );

        await act(async () => {
            await Promise.resolve();
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(result.current.workflow?.visible).toBe(false);

        await act(async () => {
            vi.advanceTimersByTime(2_000);
            await Promise.resolve();
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(result.current.workflow?.visible).toBe(true);
        expect(result.current.workflow?.status?.message).toBe("notFiled");
    });

    it("fetches the follow-on phase after active work ends", async () => {
        const itemId = "follow-on-recording";
        const running = processing("running", itemId);
        const done = processing(null, itemId);
        const summaryQueued: ItemProcessingPresentation = {
            ...done,
            phases: {
                ...done.phases,
                summary: {
                    state: "running",
                    reason: "started",
                    generation: 1,
                    at: "2026-10-16T08:01:00.000Z",
                },
            },
            jobs: { transcription: null, summary: "queued" },
        };
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ processing: done }),
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ processing: done }),
            })
            .mockResolvedValue({
                ok: true,
                json: async () => ({ processing: summaryQueued }),
            });
        vi.stubGlobal("fetch", fetchMock);
        const { result } = renderHook(() =>
            useItemProcessing({
                itemId,
                kind: "audio",
                initialData: running,
            }),
        );

        await act(async () => {
            vi.advanceTimersByTime(5_000);
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(result.current.data?.jobs.summary).toBeNull();

        await act(async () => {
            vi.advanceTimersByTime(2_000);
            await Promise.resolve();
        });
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(result.current.data?.jobs.summary).toBe("queued");
        expect(
            result.current.workflow?.steps.find((step) => step.id === "summary")
                ?.state,
        ).toBe("queued");
    });

    it("stops revalidating when the invalidation window expires", async () => {
        const itemId = "unchanged-recording";
        const unchanged = processing(null, itemId);
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ processing: unchanged }),
        });
        vi.stubGlobal("fetch", fetchMock);
        renderHook(() =>
            useItemProcessing({
                itemId,
                kind: "audio",
                initialData: unchanged,
            }),
        );

        await act(async () => {
            invalidateItemProcessing(itemId);
            await Promise.resolve();
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(
                ITEM_PROCESSING_REVALIDATION_MS - 1,
            );
        });
        expect(fetchMock).toHaveBeenCalledTimes(15);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(1);
        });
        expect(fetchMock).toHaveBeenCalledTimes(15);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(30_000);
        });
        expect(fetchMock).toHaveBeenCalledTimes(15);
    });

    it("cleans up revalidation polling and listeners on unmount", async () => {
        const itemId = "unmounted-recording";
        const unchanged = processing(null, itemId);
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ processing: unchanged }),
        });
        vi.stubGlobal("fetch", fetchMock);
        const { unmount } = renderHook(() =>
            useItemProcessing({
                itemId,
                kind: "audio",
                initialData: unchanged,
            }),
        );

        await act(async () => {
            invalidateItemProcessing(itemId);
            await Promise.resolve();
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(2_000);
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);

        unmount();
        await act(async () => {
            window.dispatchEvent(new Event("focus"));
            await vi.advanceTimersByTimeAsync(30_000);
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);

        await act(async () => {
            invalidateItemProcessing(itemId);
            await Promise.resolve();
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("consumes a recent mail invalidation once across processing round trips", async () => {
        const itemId = "mail-round-trip";
        const initial: ItemProcessingPresentation = {
            ...processing(null, itemId),
            kind: "mail",
            phases: {
                categorize: {
                    state: "done",
                    reason: "categorized",
                    generation: 0,
                    at: "2026-10-16T08:00:00.000Z",
                },
            },
            outputs: { transcript: false, learn: false, summary: false },
        };
        const fetchMock = vi.fn().mockImplementation(async () => ({
            ok: true,
            json: async () => ({ processing: { ...initial } }),
        }));
        vi.stubGlobal("fetch", fetchMock);

        const view = render(<MailRoundTrip initialData={{ ...initial }} />);
        await act(async () => {
            await Promise.resolve();
        });
        expect(fetchMock).not.toHaveBeenCalled();

        await act(async () => {
            invalidateItemProcessing(itemId);
            await Promise.resolve();
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        view.rerender(<MailRoundTrip initialData={{ ...initial }} />);
        view.rerender(<MailRoundTrip initialData={{ ...initial }} />);
        view.rerender(<MailRoundTrip initialData={{ ...initial }} />);
        await act(async () => {
            await Promise.resolve();
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(2_000);
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
