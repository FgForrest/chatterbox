import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    failLearnRunAfterTerminalJob: vi.fn().mockResolvedValue("recording-1"),
    releaseAutoLearnHold: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/lib/learn/auto-learn", () => ({
    releaseAutoLearnHold: mocks.releaseAutoLearnHold,
}));
vi.mock("@/lib/learn/learn-job", () => ({
    failLearnRunAfterTerminalJob: mocks.failLearnRunAfterTerminalJob,
    LEARN_JOB_KIND: "learn.run",
    LEARN_MAX_ATTEMPTS: 3,
    parseLearnJobPayload: vi.fn(),
}));

import { learnJobHandler } from "@/lib/learn/learn-job-handler";

describe("Learn terminal job failure", () => {
    beforeEach(() => {
        mocks.failLearnRunAfterTerminalJob.mockClear();
        mocks.releaseAutoLearnHold.mockClear();
    });

    it("fails the Learn run immediately and releases its pipeline hold", async () => {
        await learnJobHandler.onTerminalFailure?.({
            jobId: "job-1",
            userId: "user-1",
            payload: { runId: "run-1" },
            errorCode: "PROVIDER_FAILED",
        });

        expect(mocks.failLearnRunAfterTerminalJob).toHaveBeenCalledWith(
            "run-1",
            "user-1",
            "PROVIDER_FAILED",
        );
        expect(mocks.releaseAutoLearnHold).toHaveBeenCalledWith("recording-1");
    });

    it("does not release the pipeline hold when the run was already settled", async () => {
        mocks.failLearnRunAfterTerminalJob.mockResolvedValueOnce(null);

        await learnJobHandler.onTerminalFailure?.({
            jobId: "job-1",
            userId: "user-1",
            payload: { runId: "run-1" },
            errorCode: "PROVIDER_FAILED",
        });

        expect(mocks.failLearnRunAfterTerminalJob).toHaveBeenCalledWith(
            "run-1",
            "user-1",
            "PROVIDER_FAILED",
        );
        expect(mocks.releaseAutoLearnHold).not.toHaveBeenCalled();
    });
});
