import { APIError, type OpenAI } from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { apiCredentials } from "@/db/schema";

vi.mock("@/lib/ai/usage-cost", () => ({
    recordChatCompletionUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/profiles/providers", () => ({
    resolveStepProvider: vi.fn(),
}));

import { runSummary, type SummaryModel } from "@/lib/summary/summary-model";

function reply() {
    return {
        choices: [
            {
                message: {
                    content:
                        '{"summary":"summary","keyPoints":[],"actionItems":[],"taskUpdates":[]}',
                },
            },
        ],
    };
}

describe("summary provider call reservations", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("reserves every pass, retry, and merge", async () => {
        vi.useFakeTimers();
        let calls = 0;
        const create = vi.fn(async () => {
            calls += 1;
            if (calls === 2) {
                throw new APIError(
                    429,
                    { message: "rate limited" },
                    undefined,
                    undefined,
                );
            }
            return reply();
        });
        const reserveCall = vi.fn().mockResolvedValue(undefined);
        const credential = {
            id: "org-card",
            userId: "org-user",
            provider: "OpenAI",
            apiKey: "plaintext-at-use",
            baseUrl: null,
            defaultModel: "gpt-4o-mini",
            isDefaultTranscription: false,
            isDefaultEnhancement: false,
            isDefaultLearn: false,
            inputUsdPerMillion: null,
            outputUsdPerMillion: null,
            audioUsdPerHour: null,
            disabledAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        } satisfies typeof apiCredentials.$inferSelect;
        const model = {
            openai: {
                chat: { completions: { create } },
            } as unknown as OpenAI,
            model: "gpt-4o-mini",
            credentials: credential,
            payerUserId: "org-user",
            reserveCall,
        } as SummaryModel;

        const pending = runSummary({
            model,
            usage: {
                itemId: "recording",
                ownerUserId: "actor",
                payerUserId: "actor",
            },
            systemContent: "system",
            prompt: "prompt",
            mergeSystem: (prompt) => prompt,
            multiPass: { rounds: 3, mergePrompt: null },
        });
        for (let index = 0; index < 4; index += 1) {
            await vi.advanceTimersByTimeAsync(60_000);
        }
        await pending;

        expect(create).toHaveBeenCalledTimes(5);
        expect(reserveCall).toHaveBeenCalledTimes(5);
    });
});
