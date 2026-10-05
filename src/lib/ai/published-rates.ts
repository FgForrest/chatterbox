import { findPreset } from "@/lib/ai/provider-presets";

/** USD rates for one model; a null field is a unit it is not priced by. */
export interface AiRate {
    inputUsdPerMillion: number | null;
    outputUsdPerMillion: number | null;
    audioUsdPerHour: number | null;
}

/** Version tag stored on usage events priced from this catalog. */
export const PRICE_SOURCE = "catalog_2026_10_01";

/**
 * Whether requests to `baseUrl` reach the vendor's own API, the only
 * place its published price list applies. A proxy, a local server, or a
 * plain-HTTP endpoint may bill differently or not at all.
 */
function usesPublishedEndpoint(
    provider: string,
    baseUrl: string | null | undefined,
): boolean {
    if (!baseUrl) return provider !== "Groq";
    try {
        const url = new URL(baseUrl);
        if (url.protocol !== "https:") return false;
        if (provider === "OpenAI") return url.hostname === "api.openai.com";
        if (provider === "Groq") return url.hostname === "api.groq.com";
        if (provider === "ElevenLabs")
            return url.hostname === "api.elevenlabs.io";
    } catch {
        return false;
    }
    return false;
}

function tokenRates(provider: string, model: string): [number, number] | null {
    if (provider === "OpenAI") {
        if (model.startsWith("gpt-4o-mini-transcribe")) return [1.25, 5];
        if (model.startsWith("gpt-4o-transcribe")) return [2.5, 10];
        if (model === "gpt-4o-mini" || model.startsWith("gpt-4o-mini-")) {
            return [0.15, 0.6];
        }
        if (model === "gpt-4o" || model.startsWith("gpt-4o-20")) {
            return [2.5, 10];
        }
    }
    return null;
}

function audioHourlyRate(provider: string, model: string): number | null {
    if (provider === "OpenAI" && model === "whisper-1") return 0.36;
    if (provider === "Groq" && model === "whisper-large-v3-turbo") return 0.04;
    if (provider === "Groq" && model === "whisper-large-v3") return 0.111;
    if (provider === "ElevenLabs" && model.startsWith("scribe_")) return 0.22;
    return null;
}

/**
 * The vendor's list price for `model` behind `baseUrl`, or null when
 * Riffado has none. Token and audio rates are reported independently: a
 * Whisper-style endpoint may answer with either unit.
 */
export function publishedRate(
    provider: string,
    model: string,
    baseUrl: string | null | undefined,
): AiRate | null {
    if (!usesPublishedEndpoint(provider, baseUrl)) return null;
    const tokens = tokenRates(provider, model);
    const audio = audioHourlyRate(provider, model);
    if (!tokens && audio === null) return null;
    return {
        inputUsdPerMillion: tokens?.[0] ?? null,
        outputUsdPerMillion: tokens?.[1] ?? null,
        audioUsdPerHour: audio,
    };
}

/**
 * The units a provider can report usage in, so a price form asks only
 * for the rates that will ever apply.
 */
export function billingUnits(provider: string): {
    tokens: boolean;
    audio: boolean;
} {
    const preset = findPreset(provider);
    if (preset?.enhancementOnly) return { tokens: true, audio: false };
    switch (preset?.transcriptionStyle) {
        case "elevenlabs":
        case "speechmatics":
            return { tokens: false, audio: true };
        case "gemini":
        case "chat":
            return { tokens: true, audio: false };
        default:
            return { tokens: true, audio: true };
    }
}

/** A rate as stored in `numeric` columns, which Postgres returns as text. */
export function storedRate(columns: {
    inputUsdPerMillion: string | null;
    outputUsdPerMillion: string | null;
    audioUsdPerHour: string | null;
}): AiRate {
    const toNumber = (value: string | null) =>
        value === null ? null : Number(value);
    return {
        inputUsdPerMillion: toNumber(columns.inputUsdPerMillion),
        outputUsdPerMillion: toNumber(columns.outputUsdPerMillion),
        audioUsdPerHour: toNumber(columns.audioUsdPerHour),
    };
}

/** Whether a rate prices anything at all. */
export function hasRate(rate: AiRate | null | undefined): rate is AiRate {
    return (
        rate != null &&
        ((rate.inputUsdPerMillion !== null &&
            rate.outputUsdPerMillion !== null) ||
            rate.audioUsdPerHour !== null)
    );
}
