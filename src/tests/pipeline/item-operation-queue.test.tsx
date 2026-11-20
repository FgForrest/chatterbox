// @vitest-environment jsdom

import { act, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ItemOperationRegistry } from "@/components/items/item-operation-queue";
import type { ItemProcessingPresentation } from "@/lib/pipeline/presentation";
import { renderItemDetail } from "@/tests/pipeline/item-detail-test-harness";
import { processingFixture } from "@/tests/pipeline/processing-fixture";

const base = processingFixture({
    itemId: "queue-test",
    kind: "audio",
    legacy: true,
    manualOnly: false,
    phases: {},
    profile: null,
    placements: [],
    intents: [],
    outputs: { transcript: true, summary: false, learn: false },
    processAgain: true,
    processAgainReason: null,
    learnFindingsWaiting: 0,
    taskReviewWaiting: 0,
    jobs: { transcription: null, summary: null },
    failures: [],
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((ok, fail) => {
        resolve = ok;
        reject = fail;
    });
    return { promise, resolve, reject };
}

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

it("sends in order and removes only the failed operation", async () => {
    const { result } = renderItemDetail({
        itemId: base.itemId,
        kind: "audio",
        initialData: base,
    });
    const first = deferred<{ processing: ItemProcessingPresentation }>();
    const second = deferred<{ processing: ItemProcessingPresentation }>();
    const write = vi.fn(() => second.promise);
    let failed: Promise<unknown>;
    let saved: Promise<unknown>;
    act(() => {
        failed = result.current
            .enqueueOperation({
                apply: (data) => ({ ...data, manualOnly: true }),
                write: () => first.promise,
            })
            .catch((error: unknown) => error);
        saved = result.current.enqueueOperation({
            apply: (data) => ({ ...data, processAgain: false }),
            write,
        });
    });
    expect(result.current.data).toMatchObject({
        manualOnly: true,
        processAgain: false,
    });
    expect(write).not.toHaveBeenCalled();
    await act(async () => {
        first.reject(new Error("refused"));
        await failed;
    });
    expect(result.current.data).toMatchObject({
        manualOnly: false,
        processAgain: false,
    });
    expect(write).toHaveBeenCalledTimes(1);
    await act(async () => {
        second.resolve({
            processing: {
                ...base,
                processAgain: false,
                learnFindingsWaiting: 3,
            },
        });
        await saved;
    });
    expect(result.current.data).toMatchObject({
        processAgain: false,
        learnFindingsWaiting: 3,
    });
});

it("keeps a stale write overlay until a read started after its answer is accepted", async () => {
    const early = deferred<Response>();
    const late = deferred<Response>();
    const fetch = vi
        .fn()
        .mockReturnValueOnce(early.promise)
        .mockReturnValueOnce(late.promise);
    vi.stubGlobal("fetch", fetch);
    const { result } = renderItemDetail({
        itemId: base.itemId,
        kind: "audio",
        initialData: base,
    });
    const write = deferred<{ processingStale: true }>();
    let saved: Promise<unknown>;
    act(() => {
        void result.current.refresh();
        saved = result.current.enqueueOperation({
            apply: (data) => ({ ...data, processAgain: false }),
            write: () => write.promise,
        });
    });
    await act(async () => {
        write.resolve({ processingStale: true });
        await saved;
    });
    expect(result.current.data?.processAgain).toBe(false);
    await act(async () =>
        early.resolve(
            Response.json({ processing: { ...base, learnFindingsWaiting: 2 } }),
        ),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.current.data).toMatchObject({
        processAgain: false,
        learnFindingsWaiting: 2,
    });
    await act(async () =>
        late.resolve(
            Response.json({ processing: { ...base, learnFindingsWaiting: 5 } }),
        ),
    );
    expect(result.current.data).toMatchObject({
        processAgain: true,
        learnFindingsWaiting: 5,
    });
});

const detachedScope = { kind: "audio", view: "private", isOwn: true } as const;
const filing = {
    folders: {
        pendingIds: ["folder"],
        addedIds: ["folder"],
        apply: (ids: string[]) => [...ids, "folder"],
    },
    write: async () => ({ processingStale: true as const }),
};

it("evicts a detached queue as soon as its server read settles", async () => {
    const finish = vi.fn();
    const refreshDashboard = vi.fn();
    const registry = new ItemOperationRegistry(() => finish, refreshDashboard);
    const read = deferred<Response>();
    const fetch = vi.fn(() => read.promise);
    vi.stubGlobal("fetch", fetch);
    const queue = registry.get(base.itemId, detachedScope);
    await queue.enqueueOperation(filing);
    expect(registry.find(base.itemId)).toBe(queue);
    expect(fetch).toHaveBeenCalledTimes(1);
    read.resolve(Response.json({ processing: base }));
    await vi.waitFor(() => expect(registry.find(base.itemId)).toBeUndefined());
    expect(finish).toHaveBeenCalledWith({
        processingStale: true,
        processing: base,
    });
    expect(refreshDashboard).not.toHaveBeenCalled();
});

it("drops the guessed edit, refreshes, and evicts after five minutes of failed detached reads", async () => {
    vi.useFakeTimers();
    const finish = vi.fn();
    const refreshDashboard = vi.fn();
    const registry = new ItemOperationRegistry(() => finish, refreshDashboard);
    const fetch = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const queue = registry.get(base.itemId, detachedScope);
    await queue.enqueueOperation(filing);
    const write = vi.fn(async () => ({ processing: base }));
    const waiting = queue
        .enqueueOperation({ write })
        .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(299_000);
    expect(registry.find(base.itemId)).toBe(queue);
    expect(finish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(registry.find(base.itemId)).toBeUndefined();
    expect(finish).toHaveBeenCalledWith();
    expect(refreshDashboard).toHaveBeenCalledOnce();
    expect(await waiting).toBeInstanceOf(Error);
    expect(write).not.toHaveBeenCalled();
    const attempts = fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledTimes(attempts);
});

it("clears an active detached read and its timers when the registry is cleared", async () => {
    vi.useFakeTimers();
    const refreshDashboard = vi.fn();
    const registry = new ItemOperationRegistry(() => vi.fn(), refreshDashboard);
    const read = deferred<Response>();
    const fetch = vi.fn((_path: string, _options: RequestInit) => read.promise);
    vi.stubGlobal("fetch", fetch);
    const queue = registry.get(base.itemId, detachedScope);
    await queue.enqueueOperation(filing);
    registry.clear();
    expect(registry.find(base.itemId)).toBeUndefined();
    expect(fetch.mock.calls[0][1].signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    read.resolve(Response.json({ processing: base }));
    await vi.advanceTimersByTimeAsync(300_000);
    expect(refreshDashboard).not.toHaveBeenCalled();
});
