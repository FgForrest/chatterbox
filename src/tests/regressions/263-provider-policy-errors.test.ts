import { APIConnectionError } from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { lookup, resolveStepProvider, reserveCall, transport } = vi.hoisted(
    () => ({
        lookup: vi.fn(),
        resolveStepProvider: vi.fn(),
        reserveCall: vi.fn(),
        transport: vi.fn(),
    }),
);

vi.mock("node:dns/promises", () => ({ lookup }));
vi.mock("node:http", () => ({ request: transport }));
vi.mock("node:https", () => ({ request: transport }));
vi.mock("@/lib/env", () => ({ env: { IS_HOSTED: true } }));
vi.mock("@/lib/profiles/providers", () => ({ resolveStepProvider }));
vi.mock("@/lib/ai/usage-cost", () => ({ recordChatCompletionUsage: vi.fn() }));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));

import { HOSTED_LOCAL_BASE_URL_MESSAGE } from "@/lib/ai/validate-base-url";
import { AppError, ErrorCode, mapErrorToAppError } from "@/lib/errors";
import { isRetryableError } from "@/lib/jobs/retryable";
import { learnChatClients } from "@/lib/learn/chat-clients";
import { runSummary, summaryModelFor } from "@/lib/summary/summary-model";

beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    lookup.mockResolvedValue([{ address: "10.0.0.1", family: 4 }]);
    reserveCall.mockResolvedValue(undefined);
    resolveStepProvider.mockResolvedValue({
        kind: "credential",
        credential: {
            id: "test-credential",
            provider: "Custom",
            apiKey: "test-key",
            baseUrl: "https://api.example.com/v1",
            defaultModel: "example-model",
        },
        payerUserId: "test-owner",
        reserveCall,
        organizationCredential: false,
    });
});

afterEach(() => {
    vi.useRealTimers();
});

describe("hosted provider refusals through the real OpenAI SDK", () => {
    it("preserves an AppError through multiple cause wrappers", () => {
        const error = new AppError(
            ErrorCode.INVALID_INPUT,
            "Policy refusal",
            400,
        );
        const wrapped = new APIConnectionError({
            cause: new Error("wrapped", { cause: error }),
        });
        expect(mapErrorToAppError(wrapped)).toBe(error);
    });

    it("terminates a cyclic cause chain without losing the outer mapping", () => {
        const error = new APIConnectionError({});
        error.cause = error;
        expect(mapErrorToAppError(error).code).toBe(
            ErrorCode.UPSTREAM_BAD_RESPONSE,
        );
    });

    it("keeps summary policy refusals permanent without retrying the pass", async () => {
        const model = await summaryModelFor("test-owner");
        const pending = runSummary({
            model,
            usage: {
                itemId: "test-recording",
                ownerUserId: "test-owner",
                actorUserId: "test-owner",
                payerUserId: "test-owner",
            },
            systemContent: "Summarize the supplied text.",
            prompt: "Example transcript.",
            mergeSystem: (prompt) => prompt,
            multiPass: null,
        }).catch((error: unknown) => error);
        await vi.runAllTimersAsync();
        const error = await pending;
        expect(error).toBeInstanceOf(APIConnectionError);
        expect(mapErrorToAppError(error)).toMatchObject({
            code: ErrorCode.INVALID_INPUT,
            statusCode: 400,
            message: HOSTED_LOCAL_BASE_URL_MESSAGE,
        });
        expect(isRetryableError(error)).toBe(false);
        expect(reserveCall).toHaveBeenCalledTimes(1);
        expect(lookup).toHaveBeenCalledTimes(3);
        expect(transport).not.toHaveBeenCalled();
    });

    it.each([
        "chat",
        "bridge",
    ] as const)("keeps Learn %s refusals permanent without retrying the call", async (path) => {
        const clients = await learnChatClients({
            actorUserId: "test-owner",
            recordingId: "test-recording",
            ownerUserId: "test-owner",
            operation: "learn",
            schemaName: "example",
            signal: new AbortController().signal,
        });
        const pending = (
            path === "chat"
                ? clients.chat.complete(
                      [{ role: "user", content: "Example" }],
                      100,
                  )
                : clients.bridge.complete({
                      system: "Read the supplied text.",
                      user: "Example",
                      schema: { type: "object" },
                      mcp: null,
                      maxTokens: 100,
                  })
        ).catch((error: unknown) => error);
        await vi.runAllTimersAsync();
        const error = await pending;
        expect(error).toBeInstanceOf(APIConnectionError);
        expect(mapErrorToAppError(error)).toMatchObject({
            code: ErrorCode.INVALID_INPUT,
            statusCode: 400,
            message: HOSTED_LOCAL_BASE_URL_MESSAGE,
        });
        expect(isRetryableError(error)).toBe(false);
        expect(reserveCall).toHaveBeenCalledTimes(1);
        expect(lookup).toHaveBeenCalledTimes(path === "chat" ? 3 : 1);
        expect(transport).not.toHaveBeenCalled();
    });
});
