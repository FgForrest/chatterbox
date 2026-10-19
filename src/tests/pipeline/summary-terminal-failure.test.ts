import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    markSummaryStepFailed: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/lib/pipeline/state", () => ({
    markSummaryStepFailed: mocks.markSummaryStepFailed,
}));

import { summaryJobHandler } from "@/lib/summary/summary-job-handler";
import { topicsJobHandler } from "@/lib/topics/topics-job-handler";

describe("Summary-phase terminal failures", () => {
    beforeEach(() => {
        mocks.markSummaryStepFailed.mockClear();
    });

    it.each([
        {
            invoke: () =>
                summaryJobHandler.onTerminalFailure?.({
                    jobId: "job-1",
                    userId: "user-1",
                    payload: {
                        recordingId: "recording-1",
                        trigger: "auto",
                        view: "org",
                    },
                    errorCode: "PROVIDER_FAILED",
                }),
            step: "summary",
            view: "org",
        },
        {
            invoke: () =>
                topicsJobHandler.onTerminalFailure?.({
                    jobId: "job-1",
                    userId: "user-1",
                    payload: {
                        recordingId: "recording-1",
                        source: "riffado",
                        trigger: "auto",
                    },
                    errorCode: "PROVIDER_FAILED",
                }),
            step: "topics",
            view: "private",
        },
    ])("marks $step failed and advances the pipeline", async ({
        invoke,
        step,
        view,
    }) => {
        await invoke();

        expect(mocks.markSummaryStepFailed).toHaveBeenCalledWith({
            itemId: "recording-1",
            userId: "user-1",
            view,
            step,
            errorCode: "PROVIDER_FAILED",
        });
    });

    it.each([
        {
            invoke: () =>
                summaryJobHandler.onTerminalFailure?.({
                    jobId: "job-1",
                    userId: "user-1",
                    payload: {
                        recordingId: "recording-1",
                        trigger: "manual",
                    },
                    errorCode: "PROVIDER_FAILED",
                }),
        },
        {
            invoke: () =>
                topicsJobHandler.onTerminalFailure?.({
                    jobId: "job-1",
                    userId: "user-1",
                    payload: {
                        recordingId: "recording-1",
                        source: "riffado",
                        trigger: "manual",
                    },
                    errorCode: "PROVIDER_FAILED",
                }),
        },
    ])("does not settle manual jobs", async ({ invoke }) => {
        await invoke();

        expect(mocks.markSummaryStepFailed).not.toHaveBeenCalled();
    });
});
