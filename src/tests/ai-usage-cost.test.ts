import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));

import { type AiUsageContext, estimateAiUsage } from "@/lib/ai/usage-cost";

function context(provider: string, model: string): AiUsageContext {
    return {
        recordingId: "recording",
        ownerUserId: "owner",
        payerUserId: "owner",
        operation: "transcription",
        provider,
        model,
    };
}

describe("AI usage estimates", () => {
    it("uses audio transcription rates before similarly named text models", () => {
        const result = estimateAiUsage(
            context("OpenAI", "gpt-4o-mini-transcribe"),
            {
                inputTokens: 1_000_000,
                outputTokens: 1_000_000,
            },
        );
        expect(result.cost).toBe(6.25);
    });

    it("applies Groq's minimum billable audio length", () => {
        const result = estimateAiUsage(
            context("Groq", "whisper-large-v3-turbo"),
            {
                audioSeconds: 2,
            },
        );
        expect(result.cost).toBeCloseTo(0.04 * (10 / 3600));
    });

    it("prefers a provider-reported price and leaves unknown rates unpriced", () => {
        expect(
            estimateAiUsage(context("OpenRouter", "some-model"), {
                inputTokens: 100,
                outputTokens: 50,
                reportedCostUsd: 0.002,
            }).cost,
        ).toBe(0.002);
        expect(
            estimateAiUsage(context("Custom", "some-model"), {
                inputTokens: 100,
                outputTokens: 50,
            }).cost,
        ).toBeNull();
    });

    it("uses a user rate for an otherwise unpriced model", () => {
        const result = estimateAiUsage(
            context("Custom", "meeting-model"),
            { inputTokens: 2000, outputTokens: 1000 },
            {
                inputUsdPerMillion: 1,
                outputUsdPerMillion: 3,
                audioUsdPerHour: null,
            },
        );
        expect(result.cost).toBe(0.005);
        expect(result.source).toBe("user");
    });

    it("does not apply vendor rates to a custom endpoint", () => {
        expect(
            estimateAiUsage(
                {
                    ...context("OpenAI", "gpt-4o-mini"),
                    baseUrl: "http://localhost:11434/v1",
                },
                { inputTokens: 1000, outputTokens: 1000 },
            ).cost,
        ).toBeNull();
    });
});
