import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    AssignedProfileUnavailableError: class extends Error {},
    resolveItemProfile: vi.fn(),
    select: vi.fn(),
}));

vi.mock("@/db", () => ({ db: { select: mocks.select } }));
vi.mock("@/lib/profiles/resolve", () => ({
    AssignedProfileUnavailableError: mocks.AssignedProfileUnavailableError,
    resolveItemProfile: mocks.resolveItemProfile,
}));

import {
    type PipelineQueueStep,
    pipelineMayQueue,
} from "@/lib/pipeline/pending";

function profile(step: PipelineQueueStep, automatic: boolean) {
    return {
        settings: {
            steps: {
                summary: {
                    automatic: step === "summary" ? automatic : true,
                },
                topics: {
                    automatic: step === "topics" ? automatic : true,
                },
            },
        },
    };
}

describe("pipeline pending profile automation", () => {
    let manualOnly = false;

    beforeEach(() => {
        vi.clearAllMocks();
        manualOnly = false;
        mocks.select.mockImplementation((fields: Record<string, unknown>) => {
            const chain = {
                from: () => chain,
                leftJoin: () => chain,
                where: () => chain,
                limit: () =>
                    Promise.resolve(
                        "summaryDueAt" in fields
                            ? [{ summaryDueAt: null, manualOnly }]
                            : [{ turns: [{ startMs: 0 }] }],
                    ),
            };
            return chain;
        });
    });

    it.each([
        { step: "summary" as const, automatic: true, due: true },
        {
            step: "summary" as const,
            automatic: false,
            due: false,
        },
        { step: "topics" as const, automatic: true, due: true },
        {
            step: "topics" as const,
            automatic: false,
            due: false,
        },
    ])("$step is $due when automatic is $automatic", async ({
        step,
        automatic,
        due,
    }) => {
        mocks.resolveItemProfile.mockResolvedValue(profile(step, automatic));

        await expect(pipelineMayQueue("user-1", "item-1", step)).resolves.toBe(
            due,
        );
    });

    it("queues no automatic step for a manual-only item", async () => {
        manualOnly = true;

        await expect(
            pipelineMayQueue("user-1", "item-1", "summary"),
        ).resolves.toBe(false);
        expect(mocks.resolveItemProfile).not.toHaveBeenCalled();
    });

    it("treats an unavailable assigned profile as unable to queue", async () => {
        mocks.resolveItemProfile.mockRejectedValue(
            new mocks.AssignedProfileUnavailableError(),
        );

        await expect(
            pipelineMayQueue("user-1", "item-1", "summary"),
        ).resolves.toBe(false);
    });
});
