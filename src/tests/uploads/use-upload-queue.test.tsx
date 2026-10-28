// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    headers: vi.fn(),
    followJob: vi.fn(),
    toastError: vi.fn(),
    toastSuccess: vi.fn(),
    response: {
        status: 201,
        body: {
            filename: "meeting",
            recordingId: "recording-1",
        } as Record<string, unknown>,
    },
}));

vi.mock("sonner", () => ({
    toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

vi.mock("@/lib/jobs/client", () => ({
    followJob: mocks.followJob,
}));

import { useUploadQueue } from "@/hooks/use-upload-queue";
import { onItemProcessingInvalidated } from "@/lib/pipeline/item-processing-events";

class UploadRequest {
    upload = new EventTarget();
    status = 0;
    responseText = "";
    private events = new EventTarget();

    open() {}

    setRequestHeader(name: string, value: string) {
        mocks.headers(name, value);
    }

    addEventListener(type: string, listener: EventListener) {
        this.events.addEventListener(type, listener);
    }

    send() {
        this.status = mocks.response.status;
        this.responseText = JSON.stringify(mocks.response.body);
        queueMicrotask(() => this.events.dispatchEvent(new Event("load")));
    }
}

beforeEach(() => {
    mocks.headers.mockReset();
    mocks.followJob.mockReset();
    mocks.toastError.mockReset();
    mocks.toastSuccess.mockReset();
    mocks.response = {
        status: 201,
        body: { filename: "meeting", recordingId: "recording-1" },
    };
    vi.stubGlobal("XMLHttpRequest", UploadRequest);
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ uploads: [], limits: {} })),
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("useUploadQueue completion", () => {
    it("reports the recording id for a direct audio upload", async () => {
        const onUploadStarted = vi.fn();
        const action = { label: "Open", onClick: vi.fn() };
        const onUploadComplete = vi.fn(() => action);
        const invalidated = vi.fn();
        const stop = onItemProcessingInvalidated("recording-1", invalidated);
        const { result } = renderHook(() =>
            useUploadQueue({ onUploadStarted, onUploadComplete }),
        );
        const file = new File(["audio"], "meeting.m4a", {
            type: "audio/mp4",
        });

        act(() => {
            result.current.handleUpload({
                target: { files: [file], value: "meeting.m4a" },
            } as unknown as React.ChangeEvent<HTMLInputElement>);
        });
        await act(async () => {
            await result.current.confirmUpload(null);
        });

        const upload = onUploadStarted.mock.calls[0]?.[0];
        expect(upload.uploadId).toMatch(/^pending:/);
        expect(onUploadComplete).toHaveBeenCalledWith({
            recordingId: "recording-1",
            uploadId: upload.uploadId,
            filename: "meeting",
            resumed: false,
        });
        expect(mocks.toastSuccess).toHaveBeenCalledWith('"meeting" uploaded', {
            action,
        });
        expect(invalidated).toHaveBeenCalledOnce();
        stop();
    });

    it("reports the recording id from a completed video conversion", async () => {
        mocks.response = {
            status: 202,
            body: {
                filename: "meeting",
                conversion: true,
                jobId: "job-1",
            },
        };
        mocks.followJob.mockResolvedValue({
            status: "completed",
            result: { recordingId: "recording-2" },
        });
        const onUploadStarted = vi.fn();
        const onUploadComplete = vi.fn();
        const invalidated = vi.fn();
        const stop = onItemProcessingInvalidated("recording-2", invalidated);
        const { result } = renderHook(() =>
            useUploadQueue({ onUploadStarted, onUploadComplete }),
        );
        const file = new File(["video"], "meeting.mp4", {
            type: "video/mp4",
        });

        act(() => {
            result.current.handleUpload({
                target: { files: [file], value: "meeting.mp4" },
            } as unknown as React.ChangeEvent<HTMLInputElement>);
        });
        await act(async () => {
            await result.current.confirmUpload(null);
        });

        await waitFor(() =>
            expect(onUploadComplete).toHaveBeenCalledWith({
                recordingId: "recording-2",
                uploadId: expect.stringMatching(/^pending:/),
                filename: "meeting",
                resumed: false,
            }),
        );
        expect(invalidated).toHaveBeenCalledOnce();
        stop();
    });
});

describe("useUploadQueue failure reporting", () => {
    it("reports a direct upload failure", async () => {
        mocks.response = {
            status: 500,
            body: { error: "Upload refused" },
        };
        const onUploadStarted = vi.fn();
        const onUploadFailed = vi.fn();
        const { result } = renderHook(() =>
            useUploadQueue({
                onUploadStarted,
                onUploadFailed,
                onUploadComplete: vi.fn(),
            }),
        );
        const file = new File(["audio"], "meeting.m4a", {
            type: "audio/mp4",
        });

        act(() => {
            result.current.handleUpload({
                target: { files: [file], value: "meeting.m4a" },
            } as unknown as React.ChangeEvent<HTMLInputElement>);
        });
        await act(async () => {
            await result.current.confirmUpload(null);
        });

        const uploadId = onUploadStarted.mock.calls[0]?.[0].uploadId;
        expect(onUploadFailed).toHaveBeenCalledWith(uploadId);
    });

    describe.each([
        {
            failure: "a non-completed conversion job",
            arrange: () =>
                mocks.followJob.mockResolvedValue({
                    status: "failed",
                    error: "Conversion refused",
                }),
        },
        {
            failure: "a rejected conversion watcher",
            arrange: () =>
                mocks.followJob.mockRejectedValue(new Error("Watcher failed")),
        },
    ])("for $failure", ({ arrange }) => {
        it("reports the failed upload id", async () => {
            mocks.response = {
                status: 202,
                body: {
                    filename: "meeting",
                    conversion: true,
                    jobId: "job-1",
                },
            };
            arrange();
            const onUploadStarted = vi.fn();
            const onUploadFailed = vi.fn();
            const { result } = renderHook(() =>
                useUploadQueue({
                    onUploadStarted,
                    onUploadFailed,
                    onUploadComplete: vi.fn(),
                }),
            );
            const file = new File(["video"], "meeting.mp4", {
                type: "video/mp4",
            });

            act(() => {
                result.current.handleUpload({
                    target: { files: [file], value: "meeting.mp4" },
                } as unknown as React.ChangeEvent<HTMLInputElement>);
            });
            await act(async () => {
                await result.current.confirmUpload(null);
            });

            const uploadId = onUploadStarted.mock.calls[0]?.[0].uploadId;
            await waitFor(() =>
                expect(onUploadFailed).toHaveBeenCalledWith(uploadId),
            );
        });
    });
});

it.each([
    "audio/mpeg",
    "video/mp4",
])("sends the agenda with the initial %s upload, and leaves ordinary uploads independent", async (type) => {
    const { result } = renderHook(() =>
        useUploadQueue({ onUploadComplete: vi.fn() }),
    );
    const choose = () =>
        act(() =>
            result.current.handleUpload({
                target: {
                    files: [
                        new File(
                            ["test"],
                            type.startsWith("video")
                                ? "meeting.mp4"
                                : "meeting.mp3",
                            { type },
                        ),
                    ],
                    value: "",
                },
            } as unknown as React.ChangeEvent<HTMLInputElement>),
        );
    choose();
    await act(async () => result.current.confirmUpload("folder", "agenda"));
    expect(mocks.headers).toHaveBeenCalledWith("x-upload-agenda-id", "agenda");
    mocks.headers.mockClear();
    choose();
    await act(async () => result.current.confirmUpload(null));
    expect(
        mocks.headers.mock.calls.some(
            ([name]) => name === "x-upload-agenda-id",
        ),
    ).toBe(false);
});
