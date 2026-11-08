// @vitest-environment jsdom
import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    within,
} from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlaybackProvider } from "@/components/playback/playback-context";
import {
    RecordingCutBar,
    RecordingCutButton,
    RecordingCutProvider,
} from "@/components/recordings/recording-cut";
import type { Recording } from "@/types/recording";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
const fetchMock = vi.fn();
const changed = vi.fn();
const recording: Recording = {
    id: "recording",
    duration: 10000,
    filesize: 100,
    filename: "Meeting",
    startTime: "2026-11-01T10:00:00Z",
    deviceSn: "local",
};
const turns = [
    { speaker: "S1", startMs: 0, endMs: 2000, text: "Opening." },
    { speaker: "S1", startMs: 2000, endMs: 8000, text: "Keep this." },
    { speaker: "S1", startMs: 8000, endMs: 10000, text: "Ending." },
];
const playback = {
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    subscribe: (
        listener: (state: { ms: number; playing: boolean }) => void,
    ) => {
        listener({ ms: 4000, playing: false });
        return () => {};
    },
};
function View({ id = "recording" }: { id?: string }) {
    return (
        <PlaybackProvider playback={playback}>
            <RecordingCutProvider
                recording={{ ...recording, id }}
                transcripts={[{ turns }]}
                transcribing={false}
                shared
                onChanged={changed}
            >
                <RecordingCutButton />
                <RecordingCutBar />
            </RecordingCutProvider>
        </PlaybackProvider>
    );
}
function choose() {
    fireEvent.click(
        screen.getByRole("button", { name: "Cut the start and end" }),
    );
    const bar = within(screen.getByRole("region", { name: "Cut recording" }));
    fireEvent.click(bar.getByRole("button", { name: "Start here" }));
    fireEvent.click(bar.getByRole("button", { name: "End here" }));
    fireEvent.click(bar.getByRole("button", { name: "Cut…" }));
}
function submit() {
    fireEvent.click(screen.getByRole("button", { name: "Delete and cut" }));
}
function expectRange(message: string) {
    const bar = within(screen.getByRole("region", { name: "Cut recording" }));
    expect(bar.getByRole("alert").textContent).toBe(message);
    expect(bar.getByText("Start 00:02")).toBeTruthy();
    expect(bar.getByText("End 00:08")).toBeTruthy();
    expect(toast.error).not.toHaveBeenCalled();
}
beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});
describe("#327 refused and failed cuts remain visible", () => {
    it.each([
        [
            "Invalid cut range",
            "Choose a valid range that keeps part of the recording.",
        ],
        [
            "Choose a smaller range that keeps part of the recording",
            "Choose a smaller range that keeps part of the recording.",
        ],
        [
            "The range must keep at least one turn of every transcript",
            "Keep at least one turn of every transcript.",
        ],
        [
            "This transcript has no turn times",
            "This transcript has no turn times, so it cannot be cut.",
        ],
        [
            "Transcription or cutting is already running for this recording",
            "Wait for transcription or cutting to finish.",
        ],
        [
            "Cutting is already running for this recording",
            "Wait for transcription or cutting to finish.",
        ],
        [
            "The cut job is no longer running",
            "Cutting was interrupted. Try again.",
        ],
        ["Unauthorized", "Sign in again before cutting the recording."],
        [
            "Your access to this application has been withdrawn",
            "Your access to this application has been withdrawn.",
        ],
        [
            "Your access could not be verified right now. Try again shortly.",
            "Your access could not be verified right now. Try again shortly.",
        ],
        [
            "Account suspended",
            "Your account is suspended. Contact an administrator.",
        ],
        [
            "The recording or transcript changed. Reload it and choose the cut again.",
            "The recording or transcript changed. Reload it and choose the cut again.",
        ],
        [
            "Unexpected server message",
            "The recording could not be cut. Try again.",
        ],
    ])("keeps the range and explains %s inline", async (error, expected) => {
        fetchMock.mockImplementation(
            async (_url: string, init?: RequestInit) =>
                init?.method === "POST"
                    ? Response.json(
                          { error, code: "CONFLICT" },
                          { status: 409 },
                      )
                    : Response.json({ job: null }),
        );
        render(<View />);
        await act(async () => {});
        choose();
        await act(async () => submit());
        expectRange(expected);
        const post = fetchMock.mock.calls.find(
            ([, init]) => init?.method === "POST",
        );
        expect(JSON.parse(post?.[1].body)).toEqual({
            startMs: 2000,
            endMs: 8000,
        });
    });
    it("restores the queued range after a reload before reopening a failed cut", async () => {
        vi.useFakeTimers();
        let status = "pending";
        fetchMock.mockImplementation(async (url: string) =>
            url.startsWith("/api/jobs/")
                ? Response.json({
                      status,
                      error: "The cut job is no longer running",
                  })
                : Response.json({
                      job: {
                          id: "resumed-cut",
                          status,
                          range: { startMs: 2000, endMs: 8000 },
                          error: "The cut job is no longer running",
                      },
                  }),
        );
        render(<View />);
        await act(async () => {});
        expect(screen.getByRole("status").textContent).toBe("Cutting…");
        status = "failed";
        await act(async () => {
            await vi.advanceTimersByTimeAsync(2000);
        });
        expectRange("Cutting was interrupted. Try again.");
    });
    it("toasts a job failure after the recording view unmounts", async () => {
        vi.useFakeTimers();
        let status = "processing";
        fetchMock.mockImplementation(
            async (url: string, init?: RequestInit) => {
                if (init?.method === "POST")
                    return Response.json({ jobId: "cut-job" }, { status: 202 });
                if (url.startsWith("/api/jobs/"))
                    return Response.json({
                        status,
                        error: "The cut job is no longer running",
                    });
                return Response.json({ job: null });
            },
        );
        const { unmount } = render(<View />);
        await act(async () => {});
        choose();
        await act(async () => submit());
        unmount();
        status = "failed";
        await act(async () => {
            await vi.advanceTimersByTimeAsync(2000);
        });
        expect(toast.error).toHaveBeenCalledExactlyOnceWith(
            "Cutting was interrupted. Try again.",
        );
        expect(changed).not.toHaveBeenCalled();
    });
    it("keeps a refused range when a late status response reports another active cut", async () => {
        const pendingStatus = Promise.withResolvers<void>();
        fetchMock.mockImplementation(
            async (_url: string, init?: RequestInit) => {
                if (init?.method === "POST")
                    return Response.json(
                        {
                            code: "CONFLICT",
                            error: "Cutting is already running for this recording",
                        },
                        { status: 409 },
                    );
                await pendingStatus.promise;
                return Response.json({
                    job: {
                        id: "other-cut",
                        status: "processing",
                        range: { startMs: 0, endMs: 5000 },
                    },
                });
            },
        );
        render(<View />);
        choose();
        await act(async () => submit());
        expectRange("Wait for transcription or cutting to finish.");
        await act(async () => pendingStatus.resolve());
        expectRange("Wait for transcription or cutting to finish.");
    });
    it("uses the generic sentence for a transport failure", async () => {
        fetchMock.mockImplementation(
            async (_url: string, init?: RequestInit) => {
                if (init?.method === "POST")
                    throw new TypeError("Failed to fetch");
                return Response.json({ job: null });
            },
        );
        render(<View />);
        await act(async () => {});
        choose();
        await act(async () => submit());
        expectRange("The recording could not be cut. Try again.");
    });
    it("toasts a refused request after the recording identity changed", async () => {
        const pending = Promise.withResolvers<Response>();
        fetchMock.mockImplementation(
            async (_url: string, init?: RequestInit) =>
                init?.method === "POST"
                    ? pending.promise
                    : Response.json({ job: null }),
        );
        const { rerender } = render(<View />);
        await act(async () => {});
        choose();
        submit();
        rerender(<View id="other-recording" />);
        await act(async () =>
            pending.resolve(
                Response.json(
                    {
                        error: "Recording not found",
                        code: "RECORDING_NOT_FOUND",
                    },
                    { status: 404 },
                ),
            ),
        );
        expect(toast.error).toHaveBeenCalledExactlyOnceWith(
            "This recording no longer exists.",
        );
        expect(
            screen.queryByRole("region", { name: "Cut recording" }),
        ).toBeNull();
        expect(changed).not.toHaveBeenCalled();
    });
    it.each([
        false,
        true,
    ])("toasts a job failure after leaving the recording (POST pending=%s)", async (postPending) => {
        vi.useFakeTimers();
        const pending = Promise.withResolvers<Response>();
        let status = "processing";
        fetchMock.mockImplementation(
            async (url: string, init?: RequestInit) => {
                if (init?.method === "POST")
                    return postPending
                        ? pending.promise
                        : Response.json({ jobId: "cut-job" }, { status: 202 });
                if (url === "/api/jobs/cut-job")
                    return Response.json({
                        status,
                        error: "The cut job is no longer running",
                    });
                return Response.json({ job: null });
            },
        );
        const { rerender } = render(<View />);
        await act(async () => {});
        choose();
        await act(async () => submit());
        rerender(<View id="other-recording" />);
        if (postPending)
            await act(async () =>
                pending.resolve(
                    Response.json({ jobId: "cut-job" }, { status: 202 }),
                ),
            );
        status = "failed";
        await act(async () => {
            await vi.advanceTimersByTimeAsync(2000);
        });
        expect(toast.error).toHaveBeenCalledExactlyOnceWith(
            "Cutting was interrupted. Try again.",
        );
        expect(
            screen.queryByRole("region", { name: "Cut recording" }),
        ).toBeNull();
        expect(changed).not.toHaveBeenCalled();
    });
    it.each([
        "navigate",
        "unmount",
    ])("discards late discovery with POST unresolved on %s and follows the job once", async (leaving) => {
        vi.useFakeTimers();
        const discovery = Promise.withResolvers<Response>();
        const post = Promise.withResolvers<Response>();
        let status = "processing";
        fetchMock.mockImplementation(
            async (url: string, init?: RequestInit) => {
                if (init?.method === "POST") return post.promise;
                if (url === "/api/recordings/recording/cut")
                    return discovery.promise;
                if (url === "/api/jobs/cut-job")
                    return Response.json({
                        status,
                        error: "Processing was interrupted",
                    });
                return Response.json({ job: null });
            },
        );
        const { rerender, unmount } = render(<View />);
        choose();
        submit();
        if (leaving === "navigate") rerender(<View id="other-recording" />);
        else unmount();
        await act(async () =>
            post.resolve(Response.json({ jobId: "cut-job" }, { status: 202 })),
        );
        await act(async () =>
            discovery.resolve(
                Response.json({ job: { id: "cut-job", status: "processing" } }),
            ),
        );
        status = "failed";
        await act(async () => {
            await vi.advanceTimersByTimeAsync(2000);
        });
        expect(toast.error).toHaveBeenCalledExactlyOnceWith(
            "Cutting was interrupted. Try again.",
        );
        expect(
            fetchMock.mock.calls.filter(([url]) => url === "/api/jobs/cut-job"),
        ).toHaveLength(2);
        expect(vi.getTimerCount()).toBe(0);
    });
    it.each([
        401,
        404,
        "transport",
    ] as const)("bounds status retries and reopens the range for %s", async (status) => {
        vi.useFakeTimers();
        fetchMock.mockImplementation(
            async (url: string, init?: RequestInit) => {
                if (init?.method === "POST")
                    return Response.json({ jobId: "cut-job" }, { status: 202 });
                if (url.startsWith("/api/jobs/")) {
                    if (status === "transport")
                        throw new TypeError("Failed to fetch");
                    return Response.json(
                        {
                            error:
                                status === 401
                                    ? "Unauthorized"
                                    : "Job not found",
                            code:
                                status === 401
                                    ? "AUTH_SESSION_MISSING"
                                    : "NOT_FOUND",
                        },
                        { status },
                    );
                }
                return Response.json({ job: null });
            },
        );
        render(<View />);
        await act(async () => {});
        choose();
        await act(async () => submit());
        await act(async () => {
            await vi.advanceTimersByTimeAsync(6000);
        });
        expectRange(
            status === 401
                ? "Sign in again before cutting the recording."
                : "The recording could not be cut. Try again.",
        );
        expect(
            fetchMock.mock.calls.filter(([url]) => url === "/api/jobs/cut-job"),
        ).toHaveLength(3);
        expect(vi.getTimerCount()).toBe(0);
    });
    it.each([
        401,
        404,
        "transport",
    ] as const)("toasts bounded status failure %s after navigation", async (status) => {
        vi.useFakeTimers();
        let fail = false;
        fetchMock.mockImplementation(
            async (url: string, init?: RequestInit) => {
                if (init?.method === "POST")
                    return Response.json({ jobId: "cut-job" }, { status: 202 });
                if (url.startsWith("/api/jobs/")) {
                    if (!fail) return Response.json({ status: "processing" });
                    if (status === "transport")
                        throw new TypeError("Failed to fetch");
                    return Response.json(
                        {
                            error:
                                status === 401
                                    ? "Unauthorized"
                                    : "Job not found",
                            code:
                                status === 401
                                    ? "AUTH_SESSION_MISSING"
                                    : "NOT_FOUND",
                        },
                        { status },
                    );
                }
                return Response.json({ job: null });
            },
        );
        const { rerender } = render(<View />);
        await act(async () => {});
        choose();
        await act(async () => submit());
        rerender(<View id="other-recording" />);
        fail = true;
        await act(async () => {
            await vi.advanceTimersByTimeAsync(6000);
        });
        expect(toast.error).toHaveBeenCalledExactlyOnceWith(
            status === 401
                ? "Sign in again before cutting the recording."
                : "The recording could not be cut. Try again.",
        );
        expect(screen.queryByRole("status")).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
    });
    it.each([
        false,
        true,
    ])("expires a detached watcher and clears its timer (request stuck=%s)", async (stuck) => {
        vi.useFakeTimers();
        const pending = Promise.withResolvers<Response>();
        let requests = 0;
        fetchMock.mockImplementation(
            async (url: string, init?: RequestInit) => {
                if (init?.method === "POST")
                    return Response.json({ jobId: "cut-job" }, { status: 202 });
                if (url.startsWith("/api/jobs/")) {
                    requests++;
                    return stuck
                        ? pending.promise
                        : Response.json({ status: "processing" });
                }
                return Response.json({ job: null });
            },
        );
        const { unmount } = render(<View />);
        await act(async () => {});
        choose();
        await act(async () => submit());
        unmount();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(65 * 60 * 1000);
        });
        expect(toast.error).toHaveBeenCalledExactlyOnceWith(
            "The recording could not be cut. Try again.",
        );
        expect(vi.getTimerCount()).toBe(0);
        const count = requests;
        await act(async () =>
            pending.resolve(Response.json({ status: "failed" })),
        );
        await act(async () => {
            await vi.advanceTimersByTimeAsync(10000);
        });
        expect(requests).toBe(count);
        expect(toast.error).toHaveBeenCalledTimes(1);
    });
    it("does not leave progress stuck when returning discovery races with watcher completion", async () => {
        vi.useFakeTimers();
        const discovery = Promise.withResolvers<Response>();
        let returning = false;
        let status = "processing";
        fetchMock.mockImplementation(
            async (url: string, init?: RequestInit) => {
                if (init?.method === "POST")
                    return Response.json({ jobId: "cut-job" }, { status: 202 });
                if (url === "/api/jobs/cut-job")
                    return Response.json({ status });
                if (url === "/api/recordings/recording/cut" && returning)
                    return discovery.promise;
                return Response.json({ job: null });
            },
        );
        const { rerender } = render(<View />);
        await act(async () => {});
        choose();
        await act(async () => submit());
        rerender(<View id="other-recording" />);
        returning = true;
        rerender(<View />);
        status = "completed";
        await act(async () => {
            await vi.advanceTimersByTimeAsync(2000);
        });
        await act(async () =>
            discovery.resolve(
                Response.json({ job: { id: "cut-job", status: "processing" } }),
            ),
        );
        expect(screen.queryByRole("status")).toBeNull();
        expect(toast.error).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
});
