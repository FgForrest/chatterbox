import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    consumeRateLimitBucket: vi.fn(),
    llmRendering: vi.fn(),
    resolveItemProfile: vi.fn(),
    select: vi.fn(),
}));

vi.mock("@/db", () => ({ db: { select: mocks.select } }));
vi.mock("@/lib/env", () => ({
    env: { AUTO_SUMMARY_RATE_LIMIT_PER_HOUR: 20 },
}));
vi.mock("@/lib/learn/llm-input", () => ({
    llmRendering: mocks.llmRendering,
}));
vi.mock("@/lib/profiles/resolve", () => ({
    resolveItemProfile: mocks.resolveItemProfile,
}));
vi.mock("@/lib/rate-limit", () => ({
    consumeRateLimitBucket: mocks.consumeRateLimitBucket,
}));
vi.mock("@/lib/summary/summary-job", () => ({
    enqueueSummaryJob: vi.fn(),
}));

import { summaryRefreshDue } from "@/lib/learn/summary-refresh";

describe("summary refresh profile switch", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.select.mockReturnValue({
            from: () => ({
                where: () => ({
                    limit: () =>
                        Promise.resolve([
                            {
                                transcriptionId: "transcription-1",
                                inputFingerprint: "old",
                            },
                        ]),
                }),
            }),
        });
        mocks.llmRendering.mockResolvedValue({ fingerprint: "new" });
        mocks.consumeRateLimitBucket.mockResolvedValue({
            allowed: true,
            resetAt: new Date(0),
        });
    });

    it.each([
        { enabled: true, automatic: true, due: true },
        { enabled: true, automatic: false, due: false },
        { enabled: false, automatic: true, due: false },
    ])("due=$due when summary automation is $enabled/$automatic", async ({
        enabled,
        automatic,
        due,
    }) => {
        mocks.resolveItemProfile.mockResolvedValue({
            settings: { steps: { summary: { enabled, automatic } } },
        });

        const result = await summaryRefreshDue({
            ownerUserId: "user-1",
            recordingId: "recording-1",
            view: "private",
        });

        expect(result !== null).toBe(due);
        if (due) expect(result).toEqual({});
    });
});
