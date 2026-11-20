// @vitest-environment jsdom

import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invalidateItemProcessing } from "@/lib/pipeline/item-processing-events";
import { renderItemDetail } from "@/tests/pipeline/item-detail-test-harness";
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
        nextCheckInMs: delay,
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
        renderItemDetail({
            itemId: initial.itemId,
            kind: "audio",
            initialData: initial,
        });
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
        renderItemDetail({
            itemId: initial.itemId,
            kind: "audio",
            initialData: initial,
        });
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
        const { result } = renderItemDetail({
            itemId: initial.itemId,
            kind: "audio",
            initialData: initial,
        });
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
        const { result } = renderItemDetail({
            itemId: initial.itemId,
            kind: "audio",
            initialData: initial,
        });
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
        const { result } = renderItemDetail({
            itemId: initial.itemId,
            kind: "audio",
            initialData: initial,
        });
        await act(async () => {
            await result.current.enqueueOperation({
                apply: (data) => ({ ...data, processAgain: true }),
                write: async () => ({}),
            });
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
        const { result, rerender } = renderItemDetail({
            itemId: first.itemId,
            kind: "audio",
            initialData: first,
        });
        act(() => {
            void result.current.refresh();
            window.dispatchEvent(new Event("focus"));
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        rerender({ itemId: second.itemId, kind: "audio", initialData: second });
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
        const { result } = renderItemDetail({
            itemId: initial.itemId,
            kind: "audio",
            initialData: initial,
        });
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
        const { result, unmount } = renderItemDetail({
            itemId: initial.itemId,
            kind: "audio",
            initialData: initial,
        });
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
        const { unmount } = renderItemDetail({
            itemId: initial.itemId,
            kind: "audio",
            initialData: initial,
        });
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
        renderItemDetail({
            itemId: "item-disabled",
            kind: "audio",
            enabled: false,
        });
        await act(async () => {
            window.dispatchEvent(new Event("focus"));
        });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
});

function versioned(initial: ReturnType<typeof processing>, item: string) {
    return {
        ...initial,
        phases: {
            categorize: {
                state: "done" as const,
                generation: 1,
                at: initial.nextCheckAt,
            },
        },
        versions: {
            item,
            tasks: "tasks",
            folders: "folders",
            title: "title",
            transcripts: {},
            summaries: {},
            learn: {},
            corrections: {},
            speakers: {},
        },
    };
}

it("backs off after invalidation until the item version moves", async () => {
    const initial = processing(60_000, "item-backoff");
    const fetchMock = vi
        .fn()
        .mockImplementationOnce(async () =>
            Response.json({ processing: versioned(initial, "old") }),
        )
        .mockImplementationOnce(async () =>
            Response.json({ processing: versioned(initial, "old") }),
        )
        .mockImplementation(async () =>
            Response.json({ processing: versioned(initial, "new") }),
        );
    vi.stubGlobal("fetch", fetchMock);
    const seed = versioned(initial, "old");
    renderItemDetail({
        itemId: initial.itemId,
        kind: "audio",
        initialData: seed,
    });
    await act(async () => invalidateItemProcessing(initial.itemId));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await act(async () => vi.advanceTimersByTimeAsync(59_999));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fetchMock).toHaveBeenCalledTimes(4);
});

it("tries the private projection after an Organization 404 for the owner", async () => {
    const initial = processing(60_000, "item-owner-fallback");
    const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response("", { status: 404 }))
        .mockImplementation(async () => Response.json({ processing: initial }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderItemDetail({
        itemId: initial.itemId,
        kind: "audio",
        view: "org",
        isOwn: true,
    });
    await act(async () => result.current.refresh());
    expect(fetchMock.mock.calls).toEqual([
        [
            `/api/recordings/${initial.itemId}?processing=1&view=org`,
            { signal: expect.any(AbortSignal) },
        ],
        [
            `/api/recordings/${initial.itemId}?processing=1`,
            { signal: expect.any(AbortSignal) },
        ],
    ]);
    expect(result.current.data).toEqual(initial);
    expect(result.current.status).toBe("ready");
});

it.each([
    401, 403, 404,
])("never tries the private projection after an Organization %i for a non-owner", async (status) => {
    const initial = processing(60_000, "item-member-unavailable");
    const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response("", { status }))
        .mockImplementation(async () => Response.json({ processing: initial }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderItemDetail({
        itemId: initial.itemId,
        kind: "audio",
        view: "org",
        isOwn: false,
    });
    await act(async () => result.current.refresh());
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        `/api/recordings/${initial.itemId}?processing=1&view=org`,
    ]);
    expect(result.current.status).toBe("unavailable");
    expect(result.current.data).toBeNull();
});

it("retries an unavailable item on invalidation", async () => {
    const initial = processing(60_000, "item-available-again");
    const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response("", { status: 404 }))
        .mockImplementation(async () => Response.json({ processing: initial }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderItemDetail({
        itemId: initial.itemId,
        kind: "audio",
    });
    await act(async () => result.current.refresh());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("unavailable");
    expect(vi.getTimerCount()).toBe(0);

    await act(async () => invalidateItemProcessing(initial.itemId));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe("ready");
    expect(result.current.data).toEqual(initial);
});

it("uses the initial response as the baseline and retries through the full window", async () => {
    const initial = versioned(
        processing(60_000, "item-initial-invalidation"),
        "unchanged",
    );
    const first = Promise.withResolvers<Response>();
    const times: number[] = [];
    const started = Date.now();
    const fetchMock = vi.fn(() => {
        times.push(Date.now() - started);
        return times.length === 1
            ? first.promise
            : Promise.resolve(Response.json({ processing: initial }));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderItemDetail({ itemId: initial.itemId, kind: "audio" });
    act(() => invalidateItemProcessing(initial.itemId));
    expect(times).toEqual([0]);
    await act(async () =>
        first.resolve(Response.json({ processing: initial })),
    );

    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(times).toEqual([0, 0, 1_000, 3_000, 7_000, 15_000, 30_000]);
    await act(async () => vi.advanceTimersByTimeAsync(59_999));
    expect(times).toHaveLength(7);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(times.at(-1)).toBe(90_000);
});

it.each([
    "item change",
    "row change",
    "hidden",
] as const)("skips a late owner fallback after %s", async (change) => {
    const org = processing(60_000, "item-fallback-org");
    const other = processing(60_000, "item-fallback-other");
    const pending = Promise.withResolvers<Response>();
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
        if (url.endsWith("view=org")) return pending.promise;
        return Response.json({
            processing: url.includes(other.itemId) ? other : org,
        });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result, rerender } = renderItemDetail({
        itemId: org.itemId,
        kind: "audio",
        view: "org",
        isOwn: true,
    });

    if (change === "hidden") {
        act(() => visibility("hidden"));
    } else {
        rerender({
            itemId: change === "row change" ? org.itemId : other.itemId,
            kind: "audio",
        });
        await act(async () => {});
        expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    }

    await act(async () => pending.resolve(new Response("", { status: 404 })));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        `/api/recordings/${org.itemId}?processing=1&view=org`,
        ...(change === "hidden"
            ? []
            : [
                  `/api/recordings/${change === "row change" ? org.itemId : other.itemId}?processing=1`,
              ]),
    ]);
    if (change === "hidden") {
        expect(vi.getTimerCount()).toBe(0);
        await act(async () => visibility("visible"));
        expect(fetchMock.mock.calls[1]?.[0]).toContain("view=org");
    } else {
        expect(result.current.status).toBe("ready");
    }
});

it("counts a hung read as a failure and starts the queued refresh after 20 seconds", async () => {
    const initial = processing(60_000, "item-read-timeout");
    const next = Promise.withResolvers<Response>();
    const fetchMock = vi
        .fn((_url: string, _init?: RequestInit) => next.promise)
        .mockImplementationOnce(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderItemDetail({
        itemId: initial.itemId,
        kind: "audio",
    });
    act(() => invalidateItemProcessing(initial.itemId));
    await act(async () => vi.advanceTimersByTimeAsync(19_999));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe("error");
    await act(async () => next.resolve(Response.json({ processing: initial })));
    expect(result.current.status).toBe("ready");
});
