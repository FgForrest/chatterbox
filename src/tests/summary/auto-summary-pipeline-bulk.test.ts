import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    backlog: 0,
    consumeRateLimitBucket: vi.fn(),
    enqueueSummaryJob: vi.fn(),
    emitEvent: vi.fn(),
}));

vi.mock("@/db/queries/async-jobs", () => ({
    countRateLimitedJobs: vi.fn(() => mocks.backlog),
    delayBehindBacklog: vi.fn(({ backlog }: { backlog: number }) =>
        Math.max(1_000, (backlog + 1) * 1_000),
    ),
}));
vi.mock("@/lib/summary/corrections", () => ({
    summaryEditState: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/env", () => ({
    env: { AUTO_SUMMARY_RATE_LIMIT_PER_HOUR: 2 },
}));
vi.mock("@/lib/rate-limit", () => ({
    consumeRateLimitBucket: mocks.consumeRateLimitBucket,
}));
vi.mock("@/lib/summary/summary-job", () => ({
    SUMMARY_JOB_KIND: "summary",
    enqueueSummaryJob: mocks.enqueueSummaryJob,
}));
vi.mock("@/lib/webhooks/emit", () => ({ emitEvent: mocks.emitEvent }));

import { queueAutoSummary } from "@/lib/summary/auto-summary";

describe("pipeline auto-summary bulk queueing", () => {
    beforeEach(() => {
        mocks.backlog = 0;
        mocks.consumeRateLimitBucket.mockReset();
        mocks.enqueueSummaryJob.mockReset();
        mocks.emitEvent.mockReset();
        mocks.consumeRateLimitBucket
            .mockResolvedValueOnce({
                allowed: true,
                remaining: 1,
                resetAt: new Date(Date.now() + 60 * 60_000),
            })
            .mockResolvedValueOnce({
                allowed: true,
                remaining: 0,
                resetAt: new Date(Date.now() + 60 * 60_000),
            })
            .mockResolvedValueOnce({
                allowed: false,
                remaining: 0,
                resetAt: new Date(Date.now() + 60 * 60_000),
            });
        mocks.enqueueSummaryJob.mockImplementation(
            async (input: { rateLimited?: boolean }) => {
                if (input.rateLimited) mocks.backlog++;
                return { created: true, job: { id: `job-${mocks.backlog}` } };
            },
        );
    });

    it("queues every pipeline summary and defers the work above a small cap", async () => {
        for (let index = 0; index < 5; index++) {
            await queueAutoSummary("user-1", `recording-${index}`, null, {
                strict: true,
            });
        }

        expect(mocks.enqueueSummaryJob).toHaveBeenCalledTimes(5);
        expect(
            mocks.enqueueSummaryJob.mock.calls.filter(
                ([input]) => input.rateLimited === true,
            ),
        ).toHaveLength(3);
        expect(mocks.emitEvent).not.toHaveBeenCalled();
    });
});
