import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@/lib/env", () => ({
    env: { IS_HOSTED: false },
}));

vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));

vi.mock("@/db", () => ({
    db: { select: vi.fn(), insert: vi.fn() },
}));

import { db } from "@/db";
import { parseProviderRates } from "@/lib/ai/provider-rate-input";
import { billingUnits, publishedRate } from "@/lib/ai/published-rates";
import { type AiUsageContext, recordAiUsage } from "@/lib/ai/usage-cost";

describe("published provider prices", () => {
    it("prices a vendor model on the vendor's own endpoint", () => {
        expect(
            publishedRate(
                "ElevenLabs",
                "scribe_v2",
                "https://api.elevenlabs.io",
            ),
        ).toEqual({
            inputUsdPerMillion: null,
            outputUsdPerMillion: null,
            audioUsdPerHour: 0.22,
        });
    });

    it("knows no price behind the agent bridge or a proxy", () => {
        expect(
            publishedRate(
                "Claude Code",
                "claude-sonnet-5-5",
                "http://agent-bridge:8787/v1",
            ),
        ).toBeNull();
        expect(
            publishedRate("OpenAI", "gpt-4o-mini", "https://proxy.example.com"),
        ).toBeNull();
    });

    it("asks only for the units a provider reports", () => {
        expect(billingUnits("Speechmatics")).toEqual({
            tokens: false,
            audio: true,
        });
        expect(billingUnits("Claude Code")).toEqual({
            tokens: true,
            audio: false,
        });
        expect(billingUnits("Google Gemini")).toEqual({
            tokens: true,
            audio: false,
        });
        expect(billingUnits("OpenAI")).toEqual({ tokens: true, audio: true });
    });
});

describe("provider price input", () => {
    it("clears the rate when the fields are absent", () => {
        expect(parseProviderRates({ provider: "Codex" })).toEqual({
            inputUsdPerMillion: null,
            outputUsdPerMillion: null,
            audioUsdPerHour: null,
        });
    });

    it("stores both token rates as numeric column values", () => {
        expect(
            parseProviderRates({
                inputUsdPerMillion: 3,
                outputUsdPerMillion: 15,
                audioUsdPerHour: null,
            }),
        ).toEqual({
            inputUsdPerMillion: "3.000000",
            outputUsdPerMillion: "15.000000",
            audioUsdPerHour: null,
        });
    });

    it("rejects a token rate without its pair, and a negative price", () => {
        expect(() => parseProviderRates({ inputUsdPerMillion: 3 })).toThrow();
        expect(() => parseProviderRates({ audioUsdPerHour: -1 })).toThrow();
    });
});

describe("recordAiUsage with a provider card's price", () => {
    let inserted: Record<string, unknown> | undefined;

    function cardRow(row: Record<string, unknown> | null) {
        (db.select as Mock).mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue(row ? [row] : []),
                }),
            }),
        });
    }

    function context(overrides: Partial<AiUsageContext>): AiUsageContext {
        return {
            recordingId: "rec-1",
            ownerUserId: "user-1",
            payerUserId: "user-1",
            operation: "transcription",
            provider: "Speechmatics",
            model: "enhanced+diarize",
            baseUrl: null,
            credentialId: "card-1",
            ...overrides,
        };
    }

    beforeEach(() => {
        vi.clearAllMocks();
        inserted = undefined;
        (db.insert as Mock).mockReturnValue({
            values: vi.fn((values: Record<string, unknown>) => {
                inserted = values;
                return Promise.resolve();
            }),
        });
    });

    it("prices the card's own model at the card's rate", async () => {
        cardRow({
            defaultModel: "enhanced+diarize",
            inputUsdPerMillion: null,
            outputUsdPerMillion: null,
            audioUsdPerHour: "0.400000",
        });
        await recordAiUsage(context({}), { audioSeconds: 1800 });
        expect(inserted).toMatchObject({
            costUsd: (0.2).toFixed(9),
            priceSource: "user",
        });
    });

    it("leaves a call on another model to the catalog", async () => {
        cardRow({
            defaultModel: "whisper-1",
            inputUsdPerMillion: "1.000000",
            outputUsdPerMillion: "1.000000",
            audioUsdPerHour: null,
        });
        await recordAiUsage(
            context({
                provider: "OpenAI",
                model: "gpt-4o-mini",
                operation: "title",
            }),
            { inputTokens: 1_000_000, outputTokens: 1_000_000 },
        );
        expect(inserted).toMatchObject({
            costUsd: (0.75).toFixed(9),
            priceSource: "catalog_2026_10_01",
        });
    });

    it("records an unknown cost when neither the card nor the catalog prices it", async () => {
        cardRow({
            defaultModel: "enhanced+diarize",
            inputUsdPerMillion: null,
            outputUsdPerMillion: null,
            audioUsdPerHour: null,
        });
        await recordAiUsage(context({}), { audioSeconds: 60 });
        expect(inserted).toMatchObject({ costUsd: null, priceSource: null });
    });
});
