import { OpenAI } from "openai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { providerFetch } from "@/lib/ai/provider-fetch";
import {
    chatCompletionWithUsage,
    usageAttemptFetch,
    withUsageFailure,
} from "@/lib/ai/usage-attempt";
import {
    type AiUsageContext,
    recordAiUsage,
    recordChatCompletionUsage,
} from "@/lib/ai/usage-cost";
import { responseUsage } from "@/lib/ai/usage-values";
import { learnChatClients } from "@/lib/learn/chat-clients";
import { chatTranscribe } from "@/lib/transcription/chat-transcribe";
import { transcodeToMp3 } from "@/lib/transcription/ffmpeg";
import { geminiTranscribe } from "@/lib/transcription/gemini-transcribe";

vi.mock("@/lib/ai/provider-fetch", () => ({
    providerFetch: vi.fn(),
    fetchWithoutIdleTimeout: (...args: Parameters<typeof globalThis.fetch>) =>
        globalThis.fetch(...args),
}));
vi.mock("@/lib/transcription/ffmpeg", () => ({ transcodeToMp3: vi.fn() }));
vi.mock("@/lib/profiles/providers", () => ({
    resolveStepProvider: vi.fn(async () => ({
        kind: "credential",
        payerUserId: "payer",
        organizationCredential: false,
        reserveCall: async () => undefined,
        credential: {
            id: "credential",
            provider: "Example",
            apiKey: "test",
            baseUrl: "https://example.com/v1",
            defaultModel: "model",
        },
    })),
}));
vi.mock("@/lib/env", () => ({ env: { WHISPER_REQUEST_TIMEOUT_MS: 60_000 } }));
vi.mock("@/lib/ai/usage-cost", () => ({
    recordAiUsage: vi.fn().mockResolvedValue(undefined),
    recordChatCompletionUsage: vi.fn().mockResolvedValue(undefined),
}));

const context: AiUsageContext = {
    recordingId: "item",
    ownerUserId: "owner",
    actorUserId: "actor",
    payerUserId: "payer",
    operation: "summary",
    provider: "Example",
    model: "model",
};

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(recordAiUsage).mockResolvedValue(undefined);
});

describe("durable usage attempts", () => {
    it.each([
        "transcription",
        "summary",
        "topics",
        "learn",
        "correction",
        "title",
    ] as const)("records a failed %s call without changing its error", async (operation) => {
        const error = Object.assign(new Error("provider failed"), {
            usage: { prompt_tokens: 12, completion_tokens: 4, cost: 0.5 },
        });
        await expect(
            withUsageFailure({ ...context, operation }, async () => {
                throw error;
            }),
        ).rejects.toBe(error);
        expect(recordAiUsage).toHaveBeenCalledExactlyOnceWith(
            { ...context, operation },
            {
                inputTokens: 12,
                outputTokens: 4,
                audioSeconds: undefined,
                reportedCostUsd: 0.5,
                outcome: "failed",
            },
        );
    });

    it("records measured Gemini tokens when a successful HTTP call withholds the transcript", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                Response.json({
                    candidates: [{ finishReason: "SAFETY" }],
                    usageMetadata: {
                        promptTokenCount: 20,
                        candidatesTokenCount: 2,
                        thoughtsTokenCount: 3,
                    },
                }),
            ),
        );
        try {
            await expect(
                geminiTranscribe({
                    apiKey: "test",
                    model: "gemini-test",
                    audioBuffer: Buffer.from("audio"),
                    contentType: "audio/mpeg",
                    attempt: (run) =>
                        withUsageFailure(
                            { ...context, operation: "transcription" },
                            run,
                        ),
                }),
            ).rejects.toThrow("withheld");
            expect(recordAiUsage).toHaveBeenCalledExactlyOnceWith(
                expect.anything(),
                expect.objectContaining({
                    inputTokens: 20,
                    outputTokens: 5,
                    outcome: "failed",
                }),
            );
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("records measured chat transcription tokens when the model cuts off its answer", async () => {
        vi.mocked(providerFetch).mockResolvedValue(
            Response.json({
                choices: [
                    {
                        finish_reason: "length",
                        message: { content: "partial" },
                    },
                ],
                usage: { prompt_tokens: 20, completion_tokens: 10, cost: 0.2 },
            }),
        );
        const client = new OpenAI({ apiKey: "test", fetch: usageAttemptFetch });
        await expect(
            chatTranscribe({
                client,
                model: "audio-model",
                audioBuffer: Buffer.from("audio"),
                contentType: "audio/mpeg",
                attempt: (run) =>
                    withUsageFailure(
                        { ...context, operation: "transcription" },
                        run,
                    ),
            }),
        ).rejects.toThrow("cut off");
        expect(recordAiUsage).toHaveBeenCalledExactlyOnceWith(
            expect.anything(),
            expect.objectContaining({
                inputTokens: 20,
                outputTokens: 10,
                reportedCostUsd: 0.2,
                outcome: "failed",
            }),
        );
    });

    it.each([
        {
            contentType: "application/octet-stream",
            model: "gemini-test",
            size: 5,
        },
        { contentType: "audio/mpeg", model: "../bad", size: 5 },
        {
            contentType: "audio/mpeg",
            model: "gemini-test",
            size: 21 * 1024 * 1024,
        },
    ])("does not record Gemini pre-flight failures: %j", async ({
        contentType,
        model,
        size,
    }) => {
        const fetch = vi.fn();
        vi.stubGlobal("fetch", fetch);
        try {
            await expect(
                geminiTranscribe({
                    apiKey: "test",
                    model,
                    contentType,
                    audioBuffer: Buffer.alloc(size),
                    attempt: (run) => withUsageFailure(context, run),
                }),
            ).rejects.toThrow();
            expect(fetch).not.toHaveBeenCalled();
            expect(recordAiUsage).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("does not record a failed local chat transcode", async () => {
        vi.mocked(transcodeToMp3).mockRejectedValueOnce(
            new Error("ffmpeg unavailable"),
        );
        const client = new OpenAI({ apiKey: "test", fetch: usageAttemptFetch });
        await expect(
            chatTranscribe({
                client,
                model: "audio-model",
                audioBuffer: Buffer.from("audio"),
                contentType: "audio/opus",
                attempt: (run) => withUsageFailure(context, run),
            }),
        ).rejects.toThrow("Conversion to mp3 failed");
        expect(providerFetch).not.toHaveBeenCalled();
        expect(recordAiUsage).not.toHaveBeenCalled();
    });

    it.each([
        "chat",
        "bridge",
    ] as const)("does not record caller cancellation of a Learn %s call", async (kind) => {
        const controller = new AbortController();
        vi.mocked(providerFetch).mockImplementationOnce(
            async (_input, init) => {
                controller.abort();
                throw init?.signal?.reason;
            },
        );
        const clients = await learnChatClients({
            actorUserId: "actor",
            ownerUserId: "owner",
            recordingId: "item",
            operation: "learn",
            schemaName: "learn_output",
            signal: controller.signal,
        });
        const call =
            kind === "chat"
                ? clients.chat.complete(
                      [{ role: "user", content: "test" }],
                      10,
                      { retry: false },
                  )
                : clients.bridge.complete({
                      system: "test",
                      user: "test",
                      schema: {},
                      mcp: null,
                      maxTokens: 10,
                  });
        await expect(call).rejects.toBeInstanceOf(OpenAI.APIUserAbortError);
        expect(providerFetch).toHaveBeenCalledTimes(1);
        expect(recordAiUsage).not.toHaveBeenCalled();
        expect(recordChatCompletionUsage).not.toHaveBeenCalled();
    });

    it("preserves a caller's custom cancellation reason", async () => {
        const controller = new AbortController();
        const reason = new Error("superseded");
        await expect(
            withUsageFailure(
                context,
                async () => {
                    controller.abort(reason);
                    throw reason;
                },
                controller.signal,
            ),
        ).rejects.toBe(reason);
        expect(recordAiUsage).not.toHaveBeenCalled();
    });

    it("still records provider timeouts", async () => {
        const signal = AbortSignal.abort(
            new DOMException("deadline", "TimeoutError"),
        );
        await expect(
            withUsageFailure(
                context,
                async () => {
                    throw signal.reason;
                },
                signal,
            ),
        ).rejects.toBe(signal.reason);
        expect(recordAiUsage).toHaveBeenCalledExactlyOnceWith(
            context,
            expect.objectContaining({ outcome: "failed" }),
        );
    });

    it("counts SDK retries separately and records the final success once", async () => {
        vi.mocked(providerFetch)
            .mockResolvedValueOnce(
                Response.json(
                    { error: { message: "busy" }, usage: { prompt_tokens: 3 } },
                    { status: 429, headers: { "retry-after-ms": "1" } },
                ),
            )
            .mockResolvedValueOnce(
                Response.json(
                    { error: { message: "busy" } },
                    { status: 503, headers: { "retry-after-ms": "1" } },
                ),
            )
            .mockResolvedValueOnce(
                Response.json({
                    id: "response",
                    object: "chat.completion",
                    created: 1,
                    model: "model",
                    choices: [],
                    usage: {
                        prompt_tokens: 10,
                        completion_tokens: 5,
                        total_tokens: 15,
                    },
                }),
            );
        const client = new OpenAI({
            apiKey: "test",
            baseURL: "https://example.com/v1",
            fetch: usageAttemptFetch,
        });
        const response = await chatCompletionWithUsage(context, () =>
            client.chat.completions.create({ model: "model", messages: [] }),
        );
        expect(providerFetch).toHaveBeenCalledTimes(3);
        expect(recordAiUsage).toHaveBeenCalledTimes(2);
        expect(recordChatCompletionUsage).toHaveBeenCalledExactlyOnceWith(
            context,
            response,
        );
    });

    it("does not duplicate the last failed SDK attempt", async () => {
        vi.mocked(providerFetch).mockResolvedValue(
            Response.json({ error: { message: "refused" } }, { status: 400 }),
        );
        const client = new OpenAI({ apiKey: "test", fetch: usageAttemptFetch });
        await expect(
            chatCompletionWithUsage(context, () =>
                client.chat.completions.create({
                    model: "model",
                    messages: [],
                }),
            ),
        ).rejects.toMatchObject({ status: 400 });
        expect(recordAiUsage).toHaveBeenCalledTimes(1);
        expect(recordChatCompletionUsage).not.toHaveBeenCalled();
    });

    it("preserves network rejections and unknown usage", async () => {
        const error = new Error("connection closed");
        vi.mocked(providerFetch).mockRejectedValue(error);
        await expect(
            withUsageFailure(context, () =>
                usageAttemptFetch("https://example.com"),
            ),
        ).rejects.toBe(error);
        expect(recordAiUsage).toHaveBeenCalledTimes(1);
        expect(recordAiUsage).toHaveBeenCalledWith(
            context,
            expect.objectContaining({
                outcome: "failed",
                inputTokens: undefined,
                reportedCostUsd: undefined,
            }),
        );
    });

    it("isolates simultaneous payers", async () => {
        vi.mocked(providerFetch).mockImplementation(async () => {
            await Promise.resolve();
            throw new Error("offline");
        });
        const other = { ...context, payerUserId: "other" };
        await Promise.allSettled(
            [context, other].map((input) =>
                withUsageFailure(input, () =>
                    usageAttemptFetch("https://example.com"),
                ),
            ),
        );
        expect(recordAiUsage).toHaveBeenCalledWith(
            context,
            expect.objectContaining({ outcome: "failed" }),
        );
        expect(recordAiUsage).toHaveBeenCalledWith(
            other,
            expect.objectContaining({ outcome: "failed" }),
        );
        expect(recordAiUsage).toHaveBeenCalledTimes(2);
    });

    it("does not replace a provider error when the ledger itself rejects", async () => {
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        vi.mocked(recordAiUsage).mockRejectedValue(
            new Error("ledger unavailable"),
        );
        const error = new Error("provider original");
        await expect(
            withUsageFailure(context, async () => {
                throw error;
            }),
        ).rejects.toBe(error);
        vi.restoreAllMocks();
    });

    it("retains only valid measured numbers from provider errors", () => {
        expect(
            responseUsage({
                error: {
                    usage: {
                        input_tokens: -1,
                        output_tokens: "4",
                        seconds: Number.NaN,
                        cost: Number.POSITIVE_INFINITY,
                    },
                    message: "private",
                },
            }),
        ).toEqual({
            inputTokens: undefined,
            outputTokens: undefined,
            audioSeconds: undefined,
            reportedCostUsd: undefined,
        });
    });
});
