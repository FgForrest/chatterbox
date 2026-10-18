import { describe, expect, it, vi } from "vitest";
import type { apiCredentials } from "@/db/schema";
import {
    enhancementChatModel,
    enhancementModelRequiredMessage,
} from "@/lib/ai/enhancement-provider";
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

import { learnChatClients } from "@/lib/learn/chat-clients";
import { summaryModelFor } from "@/lib/summary/summary-model";

const provider = "Example Provider";
const message = enhancementModelRequiredMessage(provider);

function credential(defaultModel: string | null) {
    return {
        id: "provider-1",
        userId: "user-1",
        provider,
        apiKey: "test-key",
        baseUrl: "https://example.com/v1",
        defaultModel,
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
}

function resolved(defaultModel: string | null) {
    return {
        kind: "credential" as const,
        credential: credential(defaultModel),
        payerUserId: "user-1",
        reserveCall: vi.fn().mockResolvedValue(undefined),
        organizationCredential: false,
    };
}

describe("enhancementChatModel", () => {
    it.each([
        null,
        "",
        " \t\n ",
    ])("rejects a blank Default Model (%j)", (defaultModel) => {
        expect(() =>
            enhancementChatModel({
                id: "provider-1",
                provider,
                defaultModel,
                baseUrl: "https://example.com/v1",
            }),
        ).toThrowError(
            expect.objectContaining({
                code: ErrorCode.AI_PROVIDER_NOT_CONFIGURED,
                message,
                statusCode: 400,
            }),
        );
    });

    it("returns a configured chat model", () => {
        expect(
            enhancementChatModel({
                provider,
                defaultModel: "example-chat-model",
                baseUrl: "https://example.com/v1",
            }),
        ).toBe("example-chat-model");
    });

    it.each([
        ["https://example.com/groq/v1", "llama-3.1-8b-instant"],
        [
            "https://example.com/together/v1",
            "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
        ],
        ["https://example.com/openrouter/v1", "openai/gpt-4o-mini"],
        ["https://example.com/v1", "gpt-4o-mini"],
    ])("keeps the Whisper mapping for %s", (baseUrl, expected) => {
        expect(
            enhancementChatModel({
                provider,
                defaultModel: "whisper-1",
                baseUrl,
            }),
        ).toBe(expected);
    });
});

describe("enhancement model callers", () => {
    it("surfaces the actionable error from summaries", async () => {
        vi.mocked(resolveStepProvider).mockResolvedValueOnce(resolved(null));

        await expect(summaryModelFor("user-1")).rejects.toEqual(
            expect.objectContaining({
                code: ErrorCode.AI_PROVIDER_NOT_CONFIGURED,
                message,
            }),
        );
    });

    it("surfaces the actionable error from Learn", async () => {
        vi.mocked(resolveStepProvider).mockResolvedValueOnce(resolved("  "));

        await expect(
            learnChatClients({
                actorUserId: "user-1",
                recordingId: "recording-1",
                ownerUserId: "user-1",
                operation: "learn",
                schemaName: "learn_answer",
                signal: new AbortController().signal,
            }),
        ).rejects.toEqual(
            expect.objectContaining({
                code: ErrorCode.AI_PROVIDER_NOT_CONFIGURED,
                message,
            }),
        );
    });

    it("throws an AppError with the provider id", () => {
        expect.assertions(3);
        try {
            enhancementChatModel(credential(null));
        } catch (error) {
            expect(error).toBeInstanceOf(AppError);
            expect((error as AppError).message).toBe(message);
            expect((error as AppError).details).toEqual({
                field: "defaultModel",
                providerId: "provider-1",
            });
        }
    });
});
