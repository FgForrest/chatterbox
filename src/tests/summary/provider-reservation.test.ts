import { APIError, type OpenAI } from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { apiCredentials } from "@/db/schema";
import { AppError, ErrorCode } from "@/lib/errors";
import { resolveStepProvider } from "@/lib/profiles/providers";

vi.mock("@/lib/ai/usage-cost", () => ({
    recordChatCompletionUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/profiles/providers", () => ({
    resolveStepProvider: vi.fn(),
}));

import {
    runSummary,
    type SummaryModel,
    summaryModelFor,
} from "@/lib/summary/summary-model";

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
    beforeEach(() => {
        vi.mocked(resolveStepProvider).mockReset();
    });

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
            organizationCredential: true,
        } as SummaryModel;

        const pending = runSummary({
            model,
            usage: {
                itemId: "recording",
                ownerUserId: "actor",
                actorUserId: "actor",
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

    it("uses a pinned Organization provider and reserves every multi-pass call", async () => {
        const create = vi.fn().mockResolvedValue(reply());
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
        vi.mocked(resolveStepProvider).mockResolvedValueOnce({
            kind: "credential",
            credential,
            payerUserId: "org-user",
            reserveCall,
            organizationCredential: true,
        });
        const pin = {
            credentialId: "org-card",
            scope: "organization" as const,
        };
        const model = await summaryModelFor("actor", pin);
        model.openai.chat.completions.create = create;

        await runSummary({
            model,
            usage: {
                itemId: "recording",
                ownerUserId: "owner",
                actorUserId: "actor",
                payerUserId: model.payerUserId,
            },
            systemContent: "system",
            prompt: "prompt",
            mergeSystem: (prompt) => prompt,
            multiPass: { rounds: 2, mergePrompt: null },
        });

        expect(resolveStepProvider).toHaveBeenCalledWith({
            step: "summary",
            pin,
            actorUserId: "actor",
        });
        expect(model.payerUserId).toBe("org-user");
        expect(create).toHaveBeenCalledTimes(3);
        expect(reserveCall).toHaveBeenCalledTimes(3);
        expect(model.openai.maxRetries).toBe(0);
    });

    it("makes no paid pass when a pinned multi-pass cap is hit during pre-reservation", async () => {
        const create = vi.fn().mockResolvedValue(reply());
        const cap = new AppError(ErrorCode.AI_RATE_LIMITED, "cap reached", 429);
        const reserveCall = vi
            .fn()
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(cap);
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
            openai: { chat: { completions: { create } } } as unknown as OpenAI,
            model: "gpt-4o-mini",
            credentials: credential,
            payerUserId: "org-user",
            reserveCall,
            organizationCredential: true,
        } satisfies SummaryModel;

        await expect(
            runSummary({
                model,
                usage: {
                    itemId: "recording",
                    ownerUserId: "owner",
                    actorUserId: "actor",
                    payerUserId: "org-user",
                },
                systemContent: "system",
                prompt: "prompt",
                mergeSystem: (prompt) => prompt,
                multiPass: { rounds: 3, mergePrompt: null },
            }),
        ).rejects.toBe(cap);
        expect(reserveCall).toHaveBeenCalledTimes(2);
        expect(create).not.toHaveBeenCalled();
    });

    it("does not fall back when a pinned provider is missing", async () => {
        const missing = new AppError(
            ErrorCode.NOT_FOUND,
            "The pinned Organization provider no longer exists",
            404,
        );
        vi.mocked(resolveStepProvider).mockRejectedValueOnce(missing);

        await expect(
            summaryModelFor("actor", {
                credentialId: "missing",
                scope: "organization",
            }),
        ).rejects.toBe(missing);
        expect(resolveStepProvider).toHaveBeenCalledTimes(1);
    });
});
