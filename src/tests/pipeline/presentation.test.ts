import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    isRecordingShared: vi.fn(),
    waitingTaskDecisions: vi.fn(),
}));

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/env", () => ({
    env: { AUTO_SUMMARY_RATE_LIMIT_PER_HOUR: 100 },
}));
vi.mock("@/lib/encryption/fields", () => ({
    decryptText: (value: string) => value,
}));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: vi.fn(),
}));
vi.mock("@/lib/sharing/shared", () => ({
    isRecordingShared: mocks.isRecordingShared,
}));
vi.mock("@/lib/tasks/waiting-review", () => ({
    waitingTaskDecisions: mocks.waitingTaskDecisions,
}));

import {
    markPhasesOutdatedForInputs,
    markPhasesOutdatedForProfileChange,
} from "@/lib/pipeline/outdated";
import {
    countItemTaskReviewWaiting,
    processingFailures,
    processingJobState,
    processingOutdatedReason,
    settleTaskReviewPhase,
} from "@/lib/pipeline/presentation";

describe("pipeline presentation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.isRecordingShared.mockResolvedValue(false);
        mocks.waitingTaskDecisions.mockResolvedValue({
            proposals: 0,
            followUps: 0,
            total: 0,
        });
    });

    it("counts waiting task decisions in the Organization view once shared", async () => {
        mocks.isRecordingShared.mockResolvedValue(true);
        mocks.waitingTaskDecisions.mockResolvedValue({
            proposals: 8,
            followUps: 0,
            total: 8,
        });

        await expect(
            countItemTaskReviewWaiting("item-1", "owner-1", "org-1"),
        ).resolves.toBe(8);

        expect(mocks.isRecordingShared).toHaveBeenCalledWith("item-1", "org-1");
        expect(mocks.waitingTaskDecisions).toHaveBeenCalledWith(
            expect.anything(),
            "item-1",
            "owner-1",
            "org",
        );
    });

    it("presents a waiting task review as done when no decisions remain", () => {
        const phases = {
            taskReview: {
                state: "waiting" as const,
                reason: "needs_review",
                generation: 1,
                at: "2026-10-15T00:00:00.000Z",
            },
        };

        expect(settleTaskReviewPhase(phases, 0, true)).toMatchObject({
            taskReview: {
                state: "done",
                reason: "reviewed",
            },
        });
    });

    it("distinguishes queued jobs from jobs a worker is running", () => {
        expect(processingJobState([{ status: "pending" }])).toBe("queued");
        expect(
            processingJobState([
                { status: "pending" },
                { status: "processing" },
            ]),
        ).toBe("running");
        expect(processingJobState([])).toBeNull();
        expect(processingJobState([{ status: "completed" }])).toBeNull();
    });

    it("presents failure reason codes and retry availability", () => {
        expect(
            processingFailures({
                categorize: {
                    state: "failed",
                    reason: "profile_unavailable",
                    generation: 1,
                    at: "2026-10-15T00:00:00.000Z",
                },
                summary: {
                    state: "pending",
                    reason: "transcript",
                    generation: 1,
                    at: "2026-10-15T00:00:00.000Z",
                    steps: {
                        summary: {
                            contentId: "content-1",
                            contentRevision: 1,
                            generation: 1,
                            state: "failed",
                            reason: "PROVIDER_TIMEOUT",
                        },
                    },
                },
            }),
        ).toEqual([
            {
                phase: "categorize",
                reasonCode: "profile_unavailable",
                retryAvailable: false,
            },
            {
                phase: "summary",
                step: "summary",
                reasonCode: "PROVIDER_TIMEOUT",
                retryAvailable: true,
            },
        ]);
    });

    it("keeps profile change as the Process again reason after content changes", () => {
        const currentInput = {
            contentId: "transcript-current",
            contentSourceId: "riffado",
            contentRevision: 2,
        };
        const profileChanged = markPhasesOutdatedForProfileChange(
            {
                categorize: {
                    state: "done",
                    reason: "categorized",
                    generation: 2,
                    at: "2026-10-15T00:00:00.000Z",
                },
                learn: {
                    state: "done",
                    generation: 2,
                    at: "2026-10-15T00:00:00.000Z",
                    inputs: {
                        ...currentInput,
                        contentRevision: 1,
                    },
                },
                summary: {
                    state: "done",
                    generation: 2,
                    at: "2026-10-15T00:00:00.000Z",
                    inputs: currentInput,
                },
            },
            3,
            "2026-10-15T01:00:00.000Z",
        );
        const contentChanged = markPhasesOutdatedForInputs(
            profileChanged,
            currentInput,
            4,
            "2026-10-15T02:00:00.000Z",
            false,
        ).phases;

        expect(contentChanged.learn?.reason).toBe("content_changed");
        expect(contentChanged.summary?.reason).toBe("profile_changed");
        expect(processingOutdatedReason(contentChanged)).toBe(
            "profile_changed",
        );
    });

    it("keeps profile change as the Process again reason after Learn changes", () => {
        const input = {
            contentId: "transcript-current",
            contentSourceId: "riffado",
            contentRevision: 2,
        };
        const profileChanged = markPhasesOutdatedForProfileChange(
            {
                categorize: {
                    state: "done",
                    generation: 2,
                    at: "2026-10-15T00:00:00.000Z",
                },
                learn: {
                    state: "done",
                    generation: 2,
                    at: "2026-10-15T00:00:00.000Z",
                    inputs: input,
                },
                summary: {
                    state: "done",
                    generation: 2,
                    at: "2026-10-15T00:00:00.000Z",
                    inputs: input,
                },
            },
            3,
            "2026-10-15T01:00:00.000Z",
        );
        const learnChanged = markPhasesOutdatedForInputs(
            profileChanged,
            input,
            4,
            "2026-10-15T02:00:00.000Z",
            true,
        ).phases;

        expect(learnChanged.learn?.reason).toBe("profile_changed");
        expect(learnChanged.summary?.reason).toBe("learn_changed");
        expect(processingOutdatedReason(learnChanged)).toBe("profile_changed");
    });
});
