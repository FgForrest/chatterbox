import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
    env: {
        WHISPER_REQUEST_TIMEOUT_MS: 60 * 60 * 1000,
    },
}));

import {
    GeminiTranscribeError,
    GeminiTranscribeFormatError,
    geminiTranscribe,
} from "@/lib/transcription/gemini-transcribe";

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

function answer(text: string, extra: Record<string, unknown> = {}): Response {
    return jsonResponse({
        candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
        ...extra,
    });
}

function lastRequest(): { url: string; init: RequestInit; body: unknown } {
    const call = vi.mocked(globalThis.fetch).mock.calls.at(-1);
    if (!call) {
        throw new Error("fetch was not called");
    }
    const [url, init] = call as [string, RequestInit];
    return { url, init, body: JSON.parse(init.body as string) };
}

describe("gemini-transcribe", () => {
    beforeEach(() => {
        vi.stubGlobal("fetch", vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const args = {
        apiKey: "test-key",
        model: "gemini-3.8-flash",
        audioBuffer: Buffer.from("audio"),
        contentType: "audio/mpeg",
    };

    it("posts the audio inline to generateContent, the key in a header only", async () => {
        vi.mocked(globalThis.fetch).mockResolvedValue(answer(" Hello. "));

        await expect(
            geminiTranscribe({ ...args, language: "cs" }),
        ).resolves.toMatchObject({ text: "Hello.", detectedLanguage: "cs" });

        const { url, init, body } = lastRequest();
        expect(url).toBe(
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
        );
        expect(url).not.toContain("test-key");
        expect(init.method).toBe("POST");
        expect(init.headers).toMatchObject({
            "x-goog-api-key": "test-key",
            "Content-Type": "application/json",
        });
        expect(init.signal).toBeInstanceOf(AbortSignal);
        expect(body).toEqual({
            contents: [
                {
                    role: "user",
                    parts: [
                        {
                            text: expect.stringContaining(
                                "The audio language is cs.",
                            ),
                        },
                        {
                            inlineData: {
                                mimeType: "audio/mpeg",
                                data: Buffer.from("audio").toString("base64"),
                            },
                        },
                    ],
                },
            ],
        });
    });

    it("takes a model given as its resource name", async () => {
        vi.mocked(globalThis.fetch).mockResolvedValue(answer("Hello."));

        await geminiTranscribe({ ...args, model: "models/gemini-3.6-flash" });

        expect(lastRequest().url).toBe(
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent",
        );
    });

    it("refuses a model id that would leave the model's path, sending nothing", async () => {
        for (const model of ["../files", "gemini?key=x", "a/b/c", ""]) {
            await expect(
                geminiTranscribe({ ...args, model }),
            ).rejects.toBeInstanceOf(GeminiTranscribeError);
        }
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("refuses an audio format Gemini does not take", async () => {
        await expect(
            geminiTranscribe({ ...args, contentType: "video/x-msvideo" }),
        ).rejects.toBeInstanceOf(GeminiTranscribeFormatError);
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("joins the answer's text parts, leaving out thoughts", async () => {
        vi.mocked(globalThis.fetch).mockResolvedValue(
            jsonResponse({
                candidates: [
                    {
                        content: {
                            parts: [
                                { text: "Planning the answer", thought: true },
                                { text: "Hello, " },
                                { text: "world." },
                            ],
                        },
                    },
                ],
            }),
        );

        expect((await geminiTranscribe(args)).text).toBe("Hello, world.");
    });

    it("includes thinking tokens in billed output usage", async () => {
        vi.mocked(globalThis.fetch).mockResolvedValue(
            answer("Transcript", {
                usageMetadata: {
                    promptTokenCount: 20,
                    candidatesTokenCount: 5,
                    thoughtsTokenCount: 11,
                },
            }),
        );

        await expect(geminiTranscribe(args)).resolves.toMatchObject({
            inputTokens: 20,
            outputTokens: 16,
        });
    });

    it("leaves output usage unknown when metadata is missing", async () => {
        vi.mocked(globalThis.fetch).mockResolvedValue(answer("Transcript"));

        expect((await geminiTranscribe(args)).outputTokens).toBeUndefined();
    });

    it("says why when the prompt was blocked", async () => {
        vi.mocked(globalThis.fetch).mockResolvedValue(
            jsonResponse({ promptFeedback: { blockReason: "SAFETY" } }),
        );

        await expect(geminiTranscribe(args)).rejects.toThrow(
            "Google Gemini withheld the transcription: SAFETY.",
        );
    });

    it("says why when the answer was withheld", async () => {
        vi.mocked(globalThis.fetch).mockResolvedValue(
            jsonResponse({
                candidates: [
                    {
                        content: { parts: [{ text: "partial" }] },
                        finishReason: "RECITATION",
                    },
                ],
            }),
        );

        await expect(geminiTranscribe(args)).rejects.toThrow(
            "Google Gemini withheld the transcription: RECITATION.",
        );
    });

    it("fails on an empty transcription", async () => {
        vi.mocked(globalThis.fetch).mockResolvedValue(answer("  "));

        await expect(geminiTranscribe(args)).rejects.toThrow(
            "Google Gemini returned an empty transcription.",
        );
    });

    it("names a retired model when Google does not find it", async () => {
        vi.mocked(globalThis.fetch).mockResolvedValue(
            jsonResponse(
                {
                    error: {
                        code: 404,
                        message:
                            "models/gemini-2.0-flash is not found for API version v1beta.",
                        status: "NOT_FOUND",
                    },
                },
                404,
            ),
        );

        const failure = geminiTranscribe({
            ...args,
            model: "gemini-2.0-flash",
        });
        await expect(failure).rejects.toMatchObject({
            name: "GeminiTranscribeError",
            status: 404,
        });
        await expect(failure).rejects.toThrow(
            'Google Gemini does not serve the model "gemini-2.0-flash"',
        );
    });

    it("reads an invalid key from the error's details, whatever the status", async () => {
        vi.mocked(globalThis.fetch).mockResolvedValue(
            jsonResponse(
                {
                    error: {
                        code: 400,
                        message:
                            "API key not valid. Please pass a valid API key.",
                        status: "INVALID_ARGUMENT",
                        details: [
                            {
                                "@type":
                                    "type.googleapis.com/google.rpc.ErrorInfo",
                                reason: "API_KEY_INVALID",
                            },
                        ],
                    },
                },
                400,
            ),
        );

        await expect(geminiTranscribe(args)).rejects.toThrow(
            "Google Gemini rejected the API key. API key not valid.",
        );
    });

    it("keeps a non-JSON error body short", async () => {
        vi.mocked(globalThis.fetch).mockResolvedValue(
            new Response("x".repeat(1000), { status: 502 }),
        );

        const error = await geminiTranscribe(args).catch((e: Error) => e);
        expect(error).toBeInstanceOf(GeminiTranscribeError);
        expect((error as Error).message).toBe(
            `Google Gemini returned 502. ${"x".repeat(200)}`,
        );
    });
});
