// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    push: vi.fn(),
    uploadOptions: null as null | {
        onUploadComplete: (upload: {
            recordingId: string | null;
            uploadId: string;
            filename: string;
        }) => void;
    },
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: mocks.push }),
}));

vi.mock("next-intl", () => ({
    useExtracted: () => (text: string) => text,
}));

vi.mock("@/hooks/use-upload-queue", () => ({
    useUploadQueue: (options: typeof mocks.uploadOptions) => {
        mocks.uploadOptions = options;
        return {
            isUploading: false,
            pendingUploads: [],
            uploadInputRef: { current: null },
            handleUpload: vi.fn(),
            selectedFile: null,
            confirmUpload: vi.fn(),
            cancelUpload: vi.fn(),
            triggerUpload: vi.fn(),
        };
    },
}));

import { AppUploadButton } from "@/components/app-upload-button";

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

beforeEach(() => {
    mocks.push.mockClear();
    mocks.uploadOptions = null;
    vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
            Response.json({
                recordings: [{ id: "recording / 1", filename: "Meeting" }],
            }),
        ),
    );
});

describe("AppUploadButton", () => {
    it("navigates a completed cross-page upload to its dashboard URL", async () => {
        render(<AppUploadButton />);

        await act(async () => {
            await mocks.uploadOptions?.onUploadComplete({
                recordingId: null,
                uploadId: "upload-1",
                filename: "Meeting",
            });
        });

        await waitFor(() =>
            expect(mocks.push).toHaveBeenCalledWith(
                "/dashboard?recording=recording%20%2F%201",
            ),
        );
    });
});
