import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    resolveItemProfile: vi.fn(),
    select: vi.fn(),
}));

vi.mock("@/db", () => ({ db: { select: mocks.select } }));
vi.mock("@/lib/profiles/resolve", () => ({
    resolveItemProfile: mocks.resolveItemProfile,
}));

import {
    type PipelineQueueStep,
    pipelineMayQueue,
} from "@/lib/pipeline/pending";

function profile(
    step: PipelineQueueStep,
    enabled: boolean,
    automatic: boolean,
) {
    return {
        settings: {
            steps: {
                summary: {
                    enabled: step === "summary" ? enabled : true,
                    automatic: step === "summary" ? automatic : true,
                },
                topics: {
                    enabled: step === "topics" ? enabled : true,
                    automatic: step === "topics" ? automatic : true,
                },
            },
        },
    };
}

describe("pipeline pending profile automation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.select.mockImplementation((fields: Record<string, unknown>) => ({
            from: () => ({
                where: () => ({
                    limit: () =>
                        Promise.resolve(
                            "summaryDueAt" in fields
                                ? [{ summaryDueAt: null }]
                                : [{ turns: [{ startMs: 0 }] }],
                        ),
                }),
            }),
        }));
    });

    it.each([
        { step: "summary" as const, enabled: true, automatic: true, due: true },
        {
            step: "summary" as const,
            enabled: true,
            automatic: false,
            due: false,
        },
        {
            step: "summary" as const,
            enabled: false,
            automatic: true,
            due: false,
        },
        { step: "topics" as const, enabled: true, automatic: true, due: true },
        {
            step: "topics" as const,
            enabled: true,
            automatic: false,
            due: false,
        },
        {
            step: "topics" as const,
            enabled: false,
            automatic: true,
            due: false,
        },
    ])("$step is $due when profile automation is $enabled/$automatic", async ({
        step,
        enabled,
        automatic,
        due,
    }) => {
        mocks.resolveItemProfile.mockResolvedValue(
            profile(step, enabled, automatic),
        );

        await expect(pipelineMayQueue("user-1", "item-1", step)).resolves.toBe(
            due,
        );
    });
});
