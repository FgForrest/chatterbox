import { beforeEach, describe, expect, it, vi } from "vitest";

const { generateContent } = vi.hoisted(() => ({
    generateContent: vi.fn(),
}));

vi.mock("@google/generative-ai", () => ({
    GoogleGenerativeAI: class {
        getGenerativeModel() {
            return { generateContent };
        }
    },
}));

import { geminiTranscribe } from "@/lib/transcription/gemini-transcribe";

describe("Gemini transcription usage", () => {
    beforeEach(() => generateContent.mockReset());

    const args = {
        apiKey: "test-key",
        model: "gemini-2.5-flash",
        audioBuffer: Buffer.from("audio"),
        contentType: "audio/mpeg",
    };

    it("includes thinking tokens in billed output usage", async () => {
        generateContent.mockResolvedValue({
            response: {
                text: () => "Transcript",
                usageMetadata: {
                    promptTokenCount: 20,
                    candidatesTokenCount: 5,
                    thoughtsTokenCount: 11,
                },
            },
        });

        await expect(geminiTranscribe(args)).resolves.toMatchObject({
            inputTokens: 20,
            outputTokens: 16,
        });
    });

    it("leaves output usage unknown when metadata is missing", async () => {
        generateContent.mockResolvedValue({
            response: { text: () => "Transcript" },
        });

        expect((await geminiTranscribe(args)).outputTokens).toBeUndefined();
    });
});
