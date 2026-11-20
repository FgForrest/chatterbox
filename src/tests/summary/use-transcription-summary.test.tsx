// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTranscriptionSummary } from "@/hooks/use-transcription-summary";
import { followJob } from "@/lib/jobs/client";

vi.mock("sonner", () => ({
    toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/jobs/client", () => ({ followJob: vi.fn() }));

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe("useTranscriptionSummary requests", () => {
    it.each([
        { channel: "mail", profileId: "" },
        { channel: "mail", profileId: "mail-profile" },
        { channel: "audio", profileId: "" },
        { channel: "audio", profileId: "audio-profile" },
    ] as const)("fetches and generates $channel summaries with profile '$profileId'", async ({
        channel,
        profileId,
    }) => {
        const itemId = `${channel}-1`;
        const fetch = vi.fn(async (url: string, init?: RequestInit) => {
            if (url.startsWith("/api/settings/profiles?")) {
                return Response.json({ profiles: [] });
            }
            return Response.json({
                summary: init?.method === "POST" ? "Generated summary" : null,
                source: "riffado",
                keyPoints: [],
                actionItems: [],
            });
        });
        vi.stubGlobal("fetch", fetch);
        const { result } = renderHook(() =>
            useTranscriptionSummary({
                recordingId: itemId,
                transcriptionText: channel === "audio" ? "Transcript" : null,
                profileChannel: channel,
            }),
        );
        await waitFor(() => {
            expect(result.current.summaryLoaded).toBe(true);
            expect(result.current.summaryProfilesLoading).toBe(false);
        });
        expect(fetch).toHaveBeenCalledWith(
            `/api/settings/profiles?channel=${channel}&pageSize=100`,
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
        expect(fetch).toHaveBeenCalledWith(
            `/api/recordings/${itemId}/summary?source=riffado`,
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
        if (profileId) {
            act(() => result.current.setSummaryProfileId(profileId));
        }

        await act(async () => {
            await result.current.handleSummarize();
        });

        expect(fetch).toHaveBeenCalledWith(
            `/api/recordings/${itemId}/summary`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Accept: "text/event-stream, application/json",
                },
                body: JSON.stringify(profileId ? { profileId } : {}),
            },
        );
        expect(result.current.summaryData?.summary).toBe("Generated summary");
        expect(result.current.isSummarizing).toBe(false);
    });
});

it.each([
    404, 500,
])("keeps a summary through HTTP %s and refetches by version", async (status) => {
    const read = vi
        .fn()
        .mockResolvedValueOnce(
            Response.json({ error: "Unavailable" }, { status }),
        )
        .mockResolvedValueOnce(
            Response.json({ summary: "Existing summary", source: "riffado" }),
        )
        .mockResolvedValueOnce(
            Response.json({ error: "Unavailable" }, { status }),
        )
        .mockResolvedValueOnce(
            Response.json({ summary: null, source: "riffado" }),
        );
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
            url.startsWith("/api/settings/")
                ? Response.json({ profiles: [] })
                : read(),
        ),
    );
    const { result, rerender } = renderHook(
        ({ version }) =>
            useTranscriptionSummary({
                recordingId: "summary-version-test",
                transcriptionText: "Transcript",
                version,
            }),
        { initialProps: { version: "1" } },
    );

    await waitFor(() => {
        expect(result.current.summaryStatus).toBe("error");
        expect(result.current.summaryLoaded).toBe(false);
        expect(result.current.summaryData).toBeNull();
    });
    rerender({ version: "2" });
    await waitFor(() =>
        expect(result.current.summaryData?.summary).toBe("Existing summary"),
    );
    rerender({ version: "3" });
    await waitFor(() => {
        expect(result.current.summaryStatus).toBe("error");
        expect(result.current.summaryLoaded).toBe(false);
        expect(result.current.summaryData?.summary).toBe("Existing summary");
    });
    rerender({ version: "4" });
    await waitFor(() => {
        expect(result.current.summaryLoaded).toBe(true);
        expect(result.current.summaryData).toBeNull();
    });
    expect(read).toHaveBeenCalledTimes(4);
});

it.each([
    "completion GET",
    "POST",
    "POST after replacement",
] as const)("keeps the newer revision when a %s returns late", async (path) => {
    const late = Promise.withResolvers<Response>();
    const job = Promise.withResolvers<Awaited<ReturnType<typeof followJob>>>();
    const stored = (
        summary: string,
        revision: number,
        summaryId = "summary-row",
    ) => ({
        summaryId,
        source: "riffado",
        summary,
        revision,
    });
    vi.mocked(followJob).mockReturnValue(job.promise);
    const reads = vi.fn().mockResolvedValueOnce(
        Response.json({
            ...stored("First summary", 1),
            ...(path === "completion GET"
                ? {
                      activeJob: {
                          jobId: "job-1",
                          status: "pending",
                          progress: null,
                      },
                  }
                : {}),
        }),
    );
    if (path === "completion GET") reads.mockReturnValueOnce(late.promise);
    const replaced = path === "POST after replacement";
    const edited = stored(
        "Edited summary",
        replaced ? 0 : 3,
        replaced ? "replacement-row" : "summary-row",
    );
    reads.mockImplementation(async () => Response.json(edited));
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith("/api/settings/"))
            return Response.json({ profiles: [] });
        if (init?.method === "POST") return late.promise;
        return reads();
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(
        ({ version }) =>
            useTranscriptionSummary({
                recordingId: "summary-ordering",
                transcriptionText: "Transcript",
                version,
            }),
        { initialProps: { version: "1" } },
    );
    await waitFor(() =>
        expect(result.current.summaryData?.summary).toBe("First summary"),
    );
    if (path === "completion GET") {
        await act(async () =>
            job.resolve({ status: "completed" } as Awaited<
                ReturnType<typeof followJob>
            >),
        );
        expect(reads).toHaveBeenCalledTimes(2);
    } else {
        act(() => {
            void result.current.handleSummarize();
        });
    }

    rerender({ version: "2" });
    await waitFor(() =>
        expect(result.current.summaryData?.summary).toBe("Edited summary"),
    );
    await act(async () =>
        late.resolve(Response.json(stored("Older generated summary", 2))),
    );
    expect(result.current.summaryData).toMatchObject(edited);
    expect(toast.success).toHaveBeenCalledWith("Summary generated");
});

it.each([
    "view swap",
    "equal revision",
] as const)("keeps the current read when a POST returns after a %s", async (race) => {
    const latePost = Promise.withResolvers<Response>();
    const pendingPrivateRead = Promise.withResolvers<Response>();
    const stored = (summary: string, revision: number) => ({
        source: "riffado",
        summaryId: "summary-row",
        summary,
        revision,
    });
    const latest = {
        ...stored("Summary from the newer read", race === "view swap" ? 3 : 2),
        stale: true,
    };
    let privateReads = 0;
    const requests = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith("/api/settings/"))
            return Response.json({ profiles: [] });
        if (init?.method === "POST") return latePost.promise;
        if (url.includes("view=org")) return Response.json(latest);
        if (++privateReads === 1)
            return Response.json(stored("First summary", 1));
        return race === "view swap"
            ? pendingPrivateRead.promise
            : Response.json(latest);
    });
    vi.stubGlobal("fetch", requests);
    const { result, rerender } = renderHook(
        ({ view, version }: { view: "private" | "org"; version: string }) =>
            useTranscriptionSummary({
                recordingId: "item-summary-post-race",
                transcriptionText: "Transcript",
                view,
                version,
            }),
        { initialProps: { view: "private", version: "1" } },
    );
    await waitFor(() =>
        expect(result.current.summaryData?.summary).toBe("First summary"),
    );
    let post: Promise<void> | undefined;
    act(() => {
        post = result.current.handleSummarize();
    });

    rerender({ view: race === "view swap" ? "org" : "private", version: "2" });
    await waitFor(() =>
        expect(result.current.summaryData).toMatchObject(latest),
    );
    if (race === "view swap") {
        rerender({ view: "private", version: "3" });
        await waitFor(() => expect(privateReads).toBe(2));
        expect(result.current.summaryData).toMatchObject(latest);
    }

    await act(async () => {
        latePost.resolve(Response.json(stored("Summary from POST", 2)));
        await post;
    });
    expect(result.current.summaryData).toMatchObject(latest);
    expect(toast.success).toHaveBeenCalledExactlyOnceWith("Summary generated");
});
