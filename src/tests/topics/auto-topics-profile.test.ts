import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    countRateLimitedJobs: vi.fn(),
    enqueueJob: vi.fn(),
    getActiveJob: vi.fn(),
    nudge: vi.fn(),
    resolveItemProfile: vi.fn(),
    consumeRateLimitBucket: vi.fn(),
}));

vi.mock("@/db/queries/async-jobs", () => ({
    countRateLimitedJobs: mocks.countRateLimitedJobs,
    delayBehindBacklog: vi.fn(),
    enqueueJob: mocks.enqueueJob,
    getActiveJob: mocks.getActiveJob,
}));
vi.mock("@/lib/env", () => ({
    env: { AUTO_SUMMARY_RATE_LIMIT_PER_HOUR: 20 },
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: mocks.nudge }));
vi.mock("@/lib/profiles/resolve", () => ({
    resolveItemProfile: mocks.resolveItemProfile,
}));
vi.mock("@/lib/rate-limit", () => ({
    consumeRateLimitBucket: mocks.consumeRateLimitBucket,
}));

import { queueAutoTopics } from "@/lib/topics/topics-job";

describe("automatic topics profile switch", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getActiveJob.mockResolvedValue(null);
        mocks.countRateLimitedJobs.mockResolvedValue(0);
        mocks.consumeRateLimitBucket.mockResolvedValue({
            allowed: true,
            resetAt: new Date(0),
        });
        mocks.enqueueJob.mockResolvedValue({
            created: true,
            job: { id: "job-1" },
        });
    });

    it.each([
        { enabled: true, automatic: true, queued: true },
        { enabled: true, automatic: false, queued: false },
        { enabled: false, automatic: true, queued: false },
    ])("queues=$queued when topics automation is $enabled/$automatic", async ({
        enabled,
        automatic,
        queued,
    }) => {
        mocks.resolveItemProfile.mockResolvedValue({
            settings: { steps: { topics: { enabled, automatic } } },
        });

        await queueAutoTopics("user-1", "recording-1", "riffado");

        expect(mocks.enqueueJob).toHaveBeenCalledTimes(queued ? 1 : 0);
    });
});
