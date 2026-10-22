// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTranscribeQueue } from "@/hooks/use-transcribe-queue";
import { followJob } from "@/lib/jobs/client";
import { invalidateItemProcessing } from "@/lib/pipeline/item-processing-events";

vi.mock("@/lib/pipeline/item-processing-events", () => ({
    invalidateItemProcessing: vi.fn(),
}));

vi.mock("sonner", () => ({
    toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/jobs/client", () => ({
    followJob: vi.fn(),
}));

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

describe("useTranscribeQueue", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("ignores repeated manual clicks and follows the one durable job", async () => {
        const completion = deferred<Awaited<ReturnType<typeof followJob>>>();
        vi.mocked(followJob).mockReturnValue(completion.promise);
        const fetchMock = vi.fn().mockResolvedValue(
            jsonResponse(
                {
                    jobId: "job-1",
                    status: "pending",
                    created: true,
                },
                202,
            ),
        );
        vi.stubGlobal("fetch", fetchMock);
        const onTranscribeComplete = vi.fn();
        const hook = renderHook(() =>
            useTranscribeQueue({ onTranscribeComplete }),
        );

        let first!: Promise<void>;
        let second!: Promise<void>;
        act(() => {
            first = hook.result.current.transcribeById("recording-1");
            second = hook.result.current.transcribeById("recording-1");
        });
        await act(async () => {
            await Promise.resolve();
        });

        expect(invalidateItemProcessing).toHaveBeenCalledExactlyOnceWith(
            "recording-1",
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/recordings/recording-1/transcribe",
            expect.objectContaining({
                body: JSON.stringify({}),
            }),
        );
        expect(hook.result.current.inFlightActions.get("recording-1")).toBe(
            "transcribing",
        );

        completion.resolve({
            id: "job-1",
            kind: "transcription",
            status: "completed",
            attempts: 1,
            maxAttempts: 3,
            progress: null,
            result: null,
            error: null,
            errorCode: null,
        });
        await act(async () => {
            await first;
            await second;
        });

        expect(hook.result.current.inFlightActions.has("recording-1")).toBe(
            false,
        );
        expect(invalidateItemProcessing).toHaveBeenCalledTimes(2);
        expect(onTranscribeComplete).toHaveBeenCalledTimes(1);
        expect(toast.success).toHaveBeenCalledWith("Transcription complete");
    });

    it("sends the explicit flag only for re-transcription", async () => {
        vi.mocked(followJob).mockResolvedValue(null);
        const fetchMock = vi.fn().mockResolvedValue(
            jsonResponse(
                {
                    jobId: "job-2",
                    status: "pending",
                    created: true,
                },
                202,
            ),
        );
        vi.stubGlobal("fetch", fetchMock);
        const hook = renderHook(() =>
            useTranscribeQueue({ onTranscribeComplete: vi.fn() }),
        );

        await act(async () => {
            await hook.result.current.transcribeById(
                "recording-1",
                "riffado",
                "private",
                true,
            );
        });

        expect(fetchMock).toHaveBeenCalledWith(
            "/api/recordings/recording-1/transcribe",
            expect.objectContaining({
                body: JSON.stringify({
                    attributionSource: "riffado",
                    retranscribe: true,
                }),
            }),
        );
    });

    it("carries a one-run language pin through the existing job path", async () => {
        vi.mocked(followJob).mockResolvedValue(null);
        const fetchMock = vi
            .fn()
            .mockResolvedValue(jsonResponse({ jobId: "invented-job" }, 202));
        vi.stubGlobal("fetch", fetchMock);
        const hook = renderHook(() =>
            useTranscribeQueue({ onTranscribeComplete: vi.fn() }),
        );
        await act(async () => {
            await hook.result.current.transcribeById(
                "invented-rec",
                "riffado",
                "org",
                true,
                "cs",
            );
        });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/recordings/invented-rec/transcribe?view=org",
            expect.objectContaining({
                body: JSON.stringify({
                    attributionSource: "riffado",
                    language: "cs",
                    retranscribe: true,
                }),
            }),
        );
    });

    it("reloads transcripts instead of showing an error for an existing transcript", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                jsonResponse(
                    {
                        error: "A transcript already exists.",
                        code: "TRANSCRIPT_ALREADY_EXISTS",
                    },
                    409,
                ),
            ),
        );
        const onTranscribeComplete = vi.fn();
        const hook = renderHook(() =>
            useTranscribeQueue({ onTranscribeComplete }),
        );

        await act(async () => {
            await hook.result.current.transcribeById("recording-1");
        });

        expect(onTranscribeComplete).toHaveBeenCalledOnce();
        expect(toast.error).not.toHaveBeenCalled();
    });

    it("reattaches to a job started by sync and exposes its busy state", async () => {
        const completion = deferred<Awaited<ReturnType<typeof followJob>>>();
        vi.mocked(followJob).mockReturnValue(completion.promise);
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                jsonResponse({
                    activeJob: {
                        jobId: "job-sync",
                        status: "processing",
                    },
                }),
            ),
        );
        const hook = renderHook(() =>
            useTranscribeQueue({ onTranscribeComplete: vi.fn() }),
        );

        let observing!: Promise<void>;
        act(() => {
            observing =
                hook.result.current.observeTranscriptionById("recording-1");
        });
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(hook.result.current.inFlightActions.get("recording-1")).toBe(
            "transcribing",
        );
        expect(invalidateItemProcessing).toHaveBeenCalledExactlyOnceWith(
            "recording-1",
        );
        expect(followJob).toHaveBeenCalledWith("job-sync", {
            signal: expect.any(AbortSignal),
        });

        completion.resolve(null);
        await act(async () => {
            await observing;
        });
        expect(invalidateItemProcessing).toHaveBeenCalledTimes(2);
        expect(hook.result.current.inFlightActions.has("recording-1")).toBe(
            false,
        );
    });

    it.each([
        { code: "NO_TRANSCRIPTION_PROVIDER", status: 400 },
        { code: "INTERNAL_ERROR", status: 500 },
    ])("invalidates processing after a rejected request with $code", async ({
        code,
        status,
    }) => {
        vi.stubGlobal(
            "fetch",
            vi
                .fn()
                .mockResolvedValue(
                    jsonResponse(
                        { code, error: "Transcription unavailable" },
                        status,
                    ),
                ),
        );
        const onTranscribeComplete = vi.fn();
        const hook = renderHook(() =>
            useTranscribeQueue({ onTranscribeComplete }),
        );

        await act(async () => {
            await hook.result.current.transcribeById("recording-1");
        });

        expect(invalidateItemProcessing).toHaveBeenCalledExactlyOnceWith(
            "recording-1",
        );
        expect(toast.error).toHaveBeenCalledWith("Transcription unavailable");
        expect(onTranscribeComplete).not.toHaveBeenCalled();
        expect(followJob).not.toHaveBeenCalled();
        expect(hook.result.current.inFlightActions.has("recording-1")).toBe(
            false,
        );
    });

    it.each([
        "network",
        "response",
    ])("invalidates processing after a %s failure", async (failure) => {
        const fetchMock = vi.fn();
        if (failure === "network")
            fetchMock.mockRejectedValue(new TypeError("Connection lost"));
        else fetchMock.mockResolvedValue(new Response("{", { status: 202 }));
        vi.stubGlobal("fetch", fetchMock);
        const onTranscribeComplete = vi.fn();
        const hook = renderHook(() =>
            useTranscribeQueue({ onTranscribeComplete }),
        );

        await act(async () => {
            await hook.result.current.transcribeById(
                "org-recording",
                undefined,
                "org",
            );
        });

        expect(invalidateItemProcessing).toHaveBeenCalledExactlyOnceWith(
            "org-recording",
        );
        expect(toast.error).toHaveBeenCalledWith(
            "Failed to transcribe recording",
        );
        expect(onTranscribeComplete).not.toHaveBeenCalled();
        expect(followJob).not.toHaveBeenCalled();
        expect(
            hook.result.current.inFlightActions.has("org:org-recording"),
        ).toBe(false);
    });
});

it("invalidates the item after a failed job on the Organization view", async () => {
    vi.mocked(followJob).mockResolvedValue({
        id: "failed-job",
        kind: "transcription",
        status: "failed",
        attempts: 1,
        maxAttempts: 3,
        progress: null,
        result: null,
        error: "Unavailable",
        errorCode: "NO_PROVIDER",
    });
    vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(jsonResponse({ jobId: "failed-job" }, 202)),
    );
    const onTranscribeComplete = vi.fn();
    const hook = renderHook(() => useTranscribeQueue({ onTranscribeComplete }));
    vi.mocked(invalidateItemProcessing).mockClear();
    await act(async () => {
        await hook.result.current.transcribeById(
            "org-recording",
            undefined,
            "org",
        );
    });
    expect(vi.mocked(invalidateItemProcessing).mock.calls).toEqual([
        ["org-recording"],
        ["org-recording"],
    ]);
    expect(onTranscribeComplete).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
});
