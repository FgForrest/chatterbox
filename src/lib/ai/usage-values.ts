import type { UsageValues } from "@/lib/ai/usage-cost";

function object(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
}

function number(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? value
        : undefined;
}

/** Extract only measured numeric usage, never error messages or response content. */
export function responseUsage(value: unknown): UsageValues {
    const body = object(value);
    const usage = object(body.usage ?? object(body.error).usage);
    const metadata = object(body.usageMetadata);
    return {
        inputTokens: number(
            usage.prompt_tokens ??
                usage.input_tokens ??
                usage.inputTokens ??
                metadata.promptTokenCount,
        ),
        outputTokens: number(
            usage.completion_tokens ??
                usage.output_tokens ??
                usage.outputTokens ??
                (body.usageMetadata
                    ? (number(metadata.candidatesTokenCount) ?? 0) +
                      (number(metadata.thoughtsTokenCount) ?? 0)
                    : undefined),
        ),
        audioSeconds: number(usage.seconds ?? usage.audioSeconds),
        reportedCostUsd: number(usage.cost ?? usage.reportedCostUsd),
    };
}

/** Attach numeric usage to the original error without retaining response content. */
export function withResponseUsage<T extends Error>(
    error: T,
    response: unknown,
): T & { usage: UsageValues } {
    return Object.assign(error, { usage: responseUsage(response) });
}
