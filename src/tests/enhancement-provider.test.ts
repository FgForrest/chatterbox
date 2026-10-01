import { describe, expect, it } from "vitest";
import {
    pickEnhancementCredential,
    pickLearnCredential,
    pickTopicsCredential,
} from "@/lib/ai/enhancement-provider";
import { topicsProviderId } from "@/lib/ai/topics-provider";

describe("pickEnhancementCredential", () => {
    it("prefers the enhancement default among providers that can summarize", () => {
        const picked = pickEnhancementCredential([
            { id: "a", provider: "Groq", isDefaultEnhancement: false },
            { id: "b", provider: "OpenAI", isDefaultEnhancement: true },
        ]);

        expect(picked?.id).toBe("b");
    });

    it("never picks a transcription-only provider, even when flagged as the default", () => {
        const picked = pickEnhancementCredential([
            { id: "a", provider: "ElevenLabs", isDefaultEnhancement: true },
            { id: "b", provider: "Groq", isDefaultEnhancement: false },
        ]);

        expect(picked?.id).toBe("b");
    });

    it("skips transcription-only providers when falling back", () => {
        const picked = pickEnhancementCredential([
            { id: "a", provider: "Google Gemini", isDefaultEnhancement: false },
            { id: "b", provider: "OpenAI", isDefaultEnhancement: false },
        ]);

        expect(picked?.id).toBe("b");
    });

    it("returns undefined when every provider is transcription-only", () => {
        const picked = pickEnhancementCredential([
            { id: "a", provider: "ElevenLabs", isDefaultEnhancement: false },
            { id: "b", provider: "Google Gemini", isDefaultEnhancement: true },
        ]);

        expect(picked).toBeUndefined();
    });

    it("treats unknown providers as capable", () => {
        const picked = pickEnhancementCredential([
            { id: "a", provider: "Custom", isDefaultEnhancement: false },
        ]);

        expect(picked?.id).toBe("a");
    });

    it("returns undefined for an empty list", () => {
        expect(pickEnhancementCredential([])).toBeUndefined();
    });
});

describe("pickTopicsCredential", () => {
    const providers = [
        { id: "summary", provider: "OpenAI", isDefaultEnhancement: true },
        { id: "topics", provider: "Groq", isDefaultEnhancement: false },
        { id: "audio", provider: "ElevenLabs", isDefaultEnhancement: false },
    ];

    it("uses the independent Topics selection", () => {
        expect(pickTopicsCredential(providers, "topics")?.id).toBe("topics");
        expect(pickEnhancementCredential(providers)?.id).toBe("summary");
    });

    it("falls back to summaries for missing or incompatible selections", () => {
        expect(pickTopicsCredential(providers, null)?.id).toBe("summary");
        expect(pickTopicsCredential(providers, "missing")?.id).toBe("summary");
        expect(pickTopicsCredential(providers, "audio")?.id).toBe("summary");
    });

    it("reads only a valid Topics preference", () => {
        expect(topicsProviderId({ topics: "topics" })).toBe("topics");
        expect(topicsProviderId({ topics: 123 })).toBeNull();
        expect(topicsProviderId(null)).toBeNull();
    });
});

describe("pickLearnCredential", () => {
    it("prefers the provider marked for Learn over the enhancement default", () => {
        const picked = pickLearnCredential([
            {
                id: "sonnet",
                provider: "Claude Code",
                isDefaultEnhancement: true,
                isDefaultLearn: false,
            },
            {
                id: "opus",
                provider: "Claude Code",
                isDefaultEnhancement: false,
                isDefaultLearn: true,
            },
        ]);

        expect(picked?.id).toBe("opus");
    });

    it("falls back to the enhancement choice when none is marked, or the marked one cannot chat", () => {
        expect(
            pickLearnCredential([
                { id: "a", provider: "Groq", isDefaultEnhancement: false },
                { id: "b", provider: "OpenAI", isDefaultEnhancement: true },
            ])?.id,
        ).toBe("b");
        expect(
            pickLearnCredential([
                {
                    id: "a",
                    provider: "ElevenLabs",
                    isDefaultEnhancement: false,
                    isDefaultLearn: true,
                },
                { id: "b", provider: "OpenAI", isDefaultEnhancement: true },
            ])?.id,
        ).toBe("b");
    });
});
