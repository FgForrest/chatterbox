import { OpenAI } from "openai";
import { describe, expect, it, vi } from "vitest";
import { buildChatCompletionParams } from "@/lib/ai/chat-completion-params";
import { learnChatClients } from "@/lib/learn/chat-clients";
import { chatTranscribe } from "@/lib/transcription/chat-transcribe";

const { create, resolved } = vi.hoisted(() => ({
    create: vi.fn(),
    resolved: {
        kind: "credential",
        credential: {
            id: "card-1",
            provider: "Codex",
            apiKey: "test-key",
            baseUrl: "http://bridge.example.test/v1",
            defaultModel: "gpt-6.1-sol",
            maxOutputTokens: 3500,
        },
        payerUserId: "user-1",
        reserveCall: vi.fn(),
        organizationCredential: false,
    },
}));
vi.mock("@/lib/profiles/providers", () => ({
    resolveStepProvider: async () => resolved,
}));
vi.mock("@/lib/ai/usage-cost", () => ({ recordChatCompletionUsage: vi.fn() }));
vi.mock("@/lib/env", () => ({ env: { WHISPER_REQUEST_TIMEOUT_MS: 10000 } }));
vi.mock("openai", () => ({
    OpenAI: class {
        chat = { completions: { create } };
    },
}));

describe("shared chat output cap", () => {
    it.each([
        "gpt-4o-mini",
        "gpt-6.1-sol",
    ])("caps the correct token parameter on %s", (model) => {
        const params = buildChatCompletionParams({
            model,
            messages: [],
            temperature: 0,
            maxTokens: 16000,
            maxOutputTokens: 3500,
        });
        expect(params).toMatchObject(
            model === "gpt-4o-mini"
                ? { max_tokens: 3500 }
                : { max_completion_tokens: 3500 },
        );
    });

    it("keeps smaller allowances and allows an empty provider cap", () => {
        expect(
            buildChatCompletionParams({
                model: "model",
                messages: [],
                maxTokens: 50,
                maxOutputTokens: 3500,
            }).max_tokens,
        ).toBe(50);
        expect(
            buildChatCompletionParams({
                model: "model",
                messages: [],
                maxTokens: 16000,
                maxOutputTokens: null,
            }).max_tokens,
        ).toBe(16000);
        expect(
            buildChatCompletionParams({ model: "model", messages: [] }),
        ).not.toHaveProperty("max_tokens");
    });

    it("applies the cap to Learn fallback and bridge requests used by correction", async () => {
        create.mockReset().mockResolvedValue({
            choices: [{ message: { content: "answer" } }],
        });
        const clients = await learnChatClients({
            actorUserId: "user-1",
            recordingId: "rec-1",
            ownerUserId: "user-1",
            operation: "learn",
            schemaName: "answer",
            signal: new AbortController().signal,
        });
        await clients.chat.complete(
            [{ role: "user", content: "Explain the topic" }],
            8000,
        );
        await clients.bridge.complete({
            system: "Return JSON",
            user: "Explain the topic",
            schema: { type: "object" },
            mcp: null,
            maxTokens: 8000,
        });
        expect(create).toHaveBeenCalledTimes(2);
        for (const [params] of create.mock.calls)
            expect(params.max_completion_tokens).toBe(3500);
    });

    it.each([
        "gpt-4o-mini",
        "gpt-6.1-sol",
    ])("never caps audio transcription on %s", async (model) => {
        create.mockReset().mockResolvedValue({
            choices: [
                {
                    message: { content: "Transcript" },
                    finish_reason: "stop",
                },
            ],
        });
        await chatTranscribe({
            client: new OpenAI({ apiKey: "test-key" }),
            model,
            audioBuffer: Buffer.from("audio"),
            contentType: "audio/mpeg",
        });
        expect(create.mock.calls[0]?.[0]).not.toHaveProperty("max_tokens");
        expect(create.mock.calls[0]?.[0]).not.toHaveProperty(
            "max_completion_tokens",
        );
    });

    it.each([
        "Partial transcript",
        "",
    ])("rejects a length-truncated transcript (%j)", async (content) => {
        create.mockReset().mockResolvedValue({
            choices: [{ message: { content }, finish_reason: "length" }],
        });
        await expect(
            chatTranscribe({
                client: new OpenAI({ apiKey: "test-key" }),
                model: "audio-model",
                audioBuffer: Buffer.from("audio"),
                contentType: "audio/mpeg",
            }),
        ).rejects.toMatchObject({
            code: "TRANSCRIPTION_FAILED",
            message: expect.stringContaining("No partial transcript was saved"),
        });
    });
});
