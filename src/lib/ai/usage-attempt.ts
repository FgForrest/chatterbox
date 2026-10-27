import { AsyncLocalStorage } from "node:async_hooks";
import type { ChatCompletion } from "openai/resources/chat/completions";
import { providerFetch } from "@/lib/ai/provider-fetch";
import {
    type AiUsageContext,
    recordAiUsage,
    recordChatCompletionUsage,
} from "@/lib/ai/usage-cost";
import { responseUsage } from "@/lib/ai/usage-values";

interface Attempt {
    context: AiUsageContext;
    failureRecorded: boolean;
}

const attempts = new AsyncLocalStorage<Attempt>();

async function failed(attempt: Attempt, error: unknown) {
    attempt.failureRecorded = true;
    try {
        await recordAiUsage(attempt.context, {
            ...responseUsage(error),
            outcome: "failed",
        });
    } catch {
        console.error("Failed to record AI usage");
    }
}

async function fetchAttempt(
    transport: typeof globalThis.fetch,
    input: RequestInfo | URL,
    init?: RequestInit,
): Promise<Response> {
    const attempt = attempts.getStore();
    if (!attempt) return transport(input, init);
    attempt.failureRecorded = false;
    let response: Response;
    try {
        response = await transport(input, init);
    } catch (error) {
        await failed(attempt, error);
        throw error;
    }
    if (!response.ok) {
        let body: unknown;
        try {
            body = await response.clone().json();
        } catch {
            body = null;
        }
        await failed(attempt, body);
    }
    return response;
}

/** SDK transport that records each failed HTTP attempt, including SDK retries. */
export const usageAttemptFetch: typeof globalThis.fetch = (input, init) =>
    fetchAttempt(providerFetch, input, init);

/** Track HTTP attempts through a caller's existing transport without changing its routing policy. */
export function createUsageFetch(
    context: AiUsageContext,
    transport: typeof globalThis.fetch,
): typeof globalThis.fetch {
    return (input, init) =>
        withUsageFailure(context, () => fetchAttempt(transport, input, init));
}

/** Preserve the provider's original rejection and record failures outside the SDK transport too. */
export async function withUsageFailure<T>(
    context: AiUsageContext,
    run: () => Promise<T>,
): Promise<T> {
    const attempt: Attempt = { context, failureRecorded: false };
    return attempts.run(attempt, async () => {
        try {
            return await run();
        } catch (error) {
            if (!attempt.failureRecorded) await failed(attempt, error);
            throw error;
        }
    });
}

/** Record one completed chat call and every failed attempt made before it. */
export async function chatCompletionWithUsage(
    context: AiUsageContext,
    run: () => Promise<ChatCompletion>,
): Promise<ChatCompletion> {
    const response = await withUsageFailure(context, run);
    await recordChatCompletionUsage(context, response);
    return response;
}
