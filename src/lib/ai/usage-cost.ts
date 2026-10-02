import { and, eq } from "drizzle-orm";
import type { ChatCompletion } from "openai/resources/chat/completions";
import { db } from "@/db";
import { aiCostRates, aiUsageEvents } from "@/db/schema";

export type AiOperation =
    | "transcription"
    | "summary"
    | "topics"
    | "learn"
    | "correction"
    | "title";

export interface AiUsageContext {
    recordingId: string;
    ownerUserId: string;
    payerUserId: string;
    operation: AiOperation;
    provider: string;
    model: string;
    baseUrl?: string | null;
}

interface UsageValues {
    inputTokens?: number | null;
    outputTokens?: number | null;
    audioSeconds?: number | null;
    reportedCostUsd?: number | null;
    /** Keyterms sent with an ElevenLabs transcription, priced as an add-on. */
    keytermCount?: number;
}

export interface AiCustomRate {
    inputUsdPerMillion: number | null;
    outputUsdPerMillion: number | null;
    audioUsdPerHour: number | null;
}

const PRICE_SOURCE = "catalog_2026_10_01";

// ElevenLabs keyterm prompting: an hourly add-on, and past this many terms
// a request bills at least `KEYTERM_MIN_BILLABLE_SECONDS`.
const ELEVENLABS_KEYTERMS_USD_PER_HOUR = 0.05;
const KEYTERM_MIN_BILLING_THRESHOLD = 100;
const KEYTERM_MIN_BILLABLE_SECONDS = 20;

function usesPublishedEndpoint(context: AiUsageContext): boolean {
    if (!context.baseUrl) return context.provider !== "Groq";
    try {
        const url = new URL(context.baseUrl);
        if (url.protocol !== "https:") return false;
        if (context.provider === "OpenAI")
            return url.hostname === "api.openai.com";
        if (context.provider === "Groq") return url.hostname === "api.groq.com";
        if (context.provider === "ElevenLabs")
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

function positiveFinite(value: number | null | undefined): number | null {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? value
        : null;
}

/** Price one request in USD, preserving an unknown price as null. */
export function estimateAiUsage(
    context: AiUsageContext,
    usage: UsageValues,
    customRate?: AiCustomRate | null,
): {
    inputTokens: number | null;
    outputTokens: number | null;
    audioSeconds: number | null;
    cost: number | null;
    source: string | null;
} {
    const inputTokens = positiveFinite(usage.inputTokens);
    const outputTokens = positiveFinite(usage.outputTokens);
    const audioSeconds = positiveFinite(usage.audioSeconds);
    const reportedCost = positiveFinite(usage.reportedCostUsd);
    let cost: number | null = reportedCost;
    let source: string | null = reportedCost === null ? null : "provider";

    if (cost === null && inputTokens !== null && outputTokens !== null) {
        const manualRates: [number, number] | null =
            customRate?.inputUsdPerMillion != null &&
            customRate.outputUsdPerMillion != null
                ? [
                      customRate.inputUsdPerMillion,
                      customRate.outputUsdPerMillion,
                  ]
                : null;
        const rates =
            manualRates ??
            (usesPublishedEndpoint(context)
                ? tokenRates(context.provider, context.model)
                : null);
        if (rates) {
            cost =
                (inputTokens * rates[0] + outputTokens * rates[1]) / 1_000_000;
            source = manualRates ? "user" : PRICE_SOURCE;
        }
    }
    if (cost === null && audioSeconds !== null) {
        const keyterms =
            context.provider === "ElevenLabs"
                ? Math.max(0, usage.keytermCount ?? 0)
                : 0;
        const published =
            customRate?.audioUsdPerHour == null &&
            usesPublishedEndpoint(context)
                ? audioHourlyRate(context.provider, context.model)
                : null;
        let rate = customRate?.audioUsdPerHour ?? published;
        let minimumSeconds = 0;
        if (context.provider === "Groq") {
            minimumSeconds = 10;
        } else if (published !== null && keyterms > 0) {
            rate = published + ELEVENLABS_KEYTERMS_USD_PER_HOUR;
            if (keyterms > KEYTERM_MIN_BILLING_THRESHOLD) {
                minimumSeconds = KEYTERM_MIN_BILLABLE_SECONDS;
            }
        }
        if (rate !== null) {
            const billableSeconds = Math.max(minimumSeconds, audioSeconds);
            cost = (billableSeconds * rate) / 3600;
            source =
                customRate?.audioUsdPerHour != null ? "user" : PRICE_SOURCE;
        }
    }

    return { inputTokens, outputTokens, audioSeconds, cost, source };
}

/** Store measured provider usage and a rate snapshot for one completed call. */
export async function recordAiUsage(
    context: AiUsageContext,
    usage: UsageValues,
): Promise<void> {
    try {
        const [configured] = await db
            .select({
                inputUsdPerMillion: aiCostRates.inputUsdPerMillion,
                outputUsdPerMillion: aiCostRates.outputUsdPerMillion,
                audioUsdPerHour: aiCostRates.audioUsdPerHour,
            })
            .from(aiCostRates)
            .where(
                and(
                    eq(aiCostRates.userId, context.payerUserId),
                    eq(aiCostRates.provider, context.provider),
                    eq(aiCostRates.model, context.model),
                ),
            )
            .limit(1);
        const customRate: AiCustomRate | null = configured
            ? {
                  inputUsdPerMillion:
                      configured.inputUsdPerMillion === null
                          ? null
                          : Number(configured.inputUsdPerMillion),
                  outputUsdPerMillion:
                      configured.outputUsdPerMillion === null
                          ? null
                          : Number(configured.outputUsdPerMillion),
                  audioUsdPerHour:
                      configured.audioUsdPerHour === null
                          ? null
                          : Number(configured.audioUsdPerHour),
              }
            : null;
        const { inputTokens, outputTokens, audioSeconds, cost, source } =
            estimateAiUsage(context, usage, customRate);
        await db.insert(aiUsageEvents).values({
            recordingId: context.recordingId,
            userId: context.ownerUserId,
            payerUserId: context.payerUserId,
            operation: context.operation,
            provider: context.provider,
            model: context.model,
            inputTokens,
            outputTokens,
            audioSeconds:
                audioSeconds === null ? null : audioSeconds.toFixed(3),
            costUsd: cost === null ? null : cost.toFixed(9),
            priceSource: source,
        });
    } catch (error) {
        console.error("Failed to record AI usage:", error);
    }
}

/** Read usage from an OpenAI-compatible chat response. */
export async function recordChatCompletionUsage(
    context: AiUsageContext,
    response: ChatCompletion,
): Promise<void> {
    const usage = response.usage;
    const extended = usage as (typeof usage & { cost?: number }) | undefined;
    await recordAiUsage(context, {
        inputTokens: usage?.prompt_tokens,
        outputTokens: usage?.completion_tokens,
        reportedCostUsd: extended?.cost,
    });
}

/** Count only spend paid by this account, including previous artefact runs. */
export async function recordingAiCost(
    recordingId: string,
    payerUserId: string,
) {
    const rows = await db
        .select({
            operation: aiUsageEvents.operation,
            provider: aiUsageEvents.provider,
            model: aiUsageEvents.model,
            costUsd: aiUsageEvents.costUsd,
        })
        .from(aiUsageEvents)
        .where(
            and(
                eq(aiUsageEvents.recordingId, recordingId),
                eq(aiUsageEvents.payerUserId, payerUserId),
            ),
        );
    const byOperation: Record<string, number> = {};
    const byService: Record<string, number> = {};
    const unknownByService: Record<string, number> = {};
    let totalUsd = 0;
    let unknownCount = 0;
    for (const row of rows) {
        const service = `${row.provider} · ${row.model}`;
        if (row.costUsd === null) {
            unknownCount += 1;
            unknownByService[service] = (unknownByService[service] ?? 0) + 1;
            continue;
        }
        const amount = Number(row.costUsd);
        totalUsd += amount;
        byOperation[row.operation] = (byOperation[row.operation] ?? 0) + amount;
        byService[service] = (byService[service] ?? 0) + amount;
    }
    return {
        totalUsd,
        byOperation,
        byService,
        unknownByService,
        unknownCount,
        requestCount: rows.length,
    };
}
