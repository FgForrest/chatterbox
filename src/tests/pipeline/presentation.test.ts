import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    isRecordingShared: vi.fn(),
    waitingTaskDecisions: vi.fn(),
}));

vi.mock("@/db", () => ({ db: {} }));
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
    countItemTaskReviewWaiting,
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
});
