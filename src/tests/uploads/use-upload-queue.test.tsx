// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    followJob: vi.fn(),
    response: {
        status: 201,
        body: {
            filename: "meeting",
            recordingId: "recording-1",
        } as Record<string, unknown>,
    },
}));

vi.mock("sonner", () => ({
    toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/jobs/client", () => ({
    followJob: mocks.followJob,
}));

import { useUploadQueue } from "@/hooks/use-upload-queue";

class UploadRequest {
    upload = new EventTarget();
    status = 0;
    responseText = "";
    private events = new EventTarget();

    open() {}

    setRequestHeader() {}

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
    mocks.followJob.mockReset();
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
        const onUploadComplete = vi.fn();
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
        });
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
            }),
        );
    });
});
