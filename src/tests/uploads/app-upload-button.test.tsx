// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    push: vi.fn(),
    uploadOptions: null as null | {
        onUploadComplete: (upload: {
            recordingId: string;
            uploadId: string;
            filename: string;
            resumed: boolean;
        }) => { label: string; onClick: () => void } | undefined;
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
});

beforeEach(() => {
    mocks.push.mockClear();
    mocks.uploadOptions = null;
});

describe("AppUploadButton", () => {
    it("navigates a completed cross-page upload while mounted", () => {
        render(<AppUploadButton />);

        act(() => {
            mocks.uploadOptions?.onUploadComplete({
                recordingId: "recording / 1",
                uploadId: "upload-1",
                filename: "Meeting",
                resumed: false,
            });
        });

        expect(mocks.push).toHaveBeenCalledWith(
            "/dashboard?recording=recording%20%2F%201",
        );
    });

    it("returns an Open action instead of navigating after unmount", () => {
        const { unmount } = render(<AppUploadButton />);
        const complete = mocks.uploadOptions?.onUploadComplete;
        unmount();

        const action = complete?.({
            recordingId: "recording-2",
            uploadId: "upload-2",
            filename: "Interview",
            resumed: false,
        });

        expect(mocks.push).not.toHaveBeenCalled();
        expect(action?.label).toBe("Open");
        action?.onClick();
        expect(mocks.push).toHaveBeenCalledWith(
            "/dashboard?recording=recording-2",
        );
    });

    it("returns an Open action for a resumed conversion", () => {
        render(<AppUploadButton />);

        const action = mocks.uploadOptions?.onUploadComplete({
            recordingId: "recording-3",
            uploadId: "conversion:job-3",
            filename: "Conference",
            resumed: true,
        });

        expect(mocks.push).not.toHaveBeenCalled();
        expect(action?.label).toBe("Open");
    });
});
