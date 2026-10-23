/**
 * The actor's chat provider as Learn and the correction pass talk to it:
 * the credential marked for Learn, else the enhancement default. Two
 * clients over it: the agent bridge's (one attempt, with the answer's JSON
 * Schema and the run's token for Riffado's tools) and a plain chat one
 * (retried). Every response records its usage for the recording.
 */

import { OpenAI } from "openai";
import { buildChatCompletionParams } from "@/lib/ai/chat-completion-params";
import { enhancementChatModel } from "@/lib/ai/enhancement-provider";
import { providerFetch } from "@/lib/ai/provider-fetch";
import {
    type AiOperation,
    recordChatCompletionUsage,
} from "@/lib/ai/usage-cost";
import { AppError, ErrorCode } from "@/lib/errors";
import { retryWithBackoff } from "@/lib/jobs/backoff";
import { isRetryableError } from "@/lib/jobs/retryable";
import type { LearnBridgeChat } from "@/lib/learn/run-bridge";
import type { LearnChat } from "@/lib/learn/run-fallback";
import { resolveStepProvider } from "@/lib/profiles/providers";
import type { ProviderPin } from "@/lib/profiles/settings";

const CALL_RETRY_ATTEMPTS = 3;
/** A call through the bridge, tools and all; the jobs allow 20 min. */
const BRIDGE_CALL_TIMEOUT_MS = 18 * 60 * 1000;

export interface LearnChatClients {
    chat: LearnChat;
    bridge: LearnBridgeChat;
    provider: string;
    baseUrl: string | null;
    model: string;
    payerUserId: string;
}

/**
 * The clients `actorUserId`'s provider is called through, for work on
 * `ownerUserId`'s recording, its usage recorded as `operation`. 400 when
 * the actor has no chat provider.
 */
export async function learnChatClients(input: {
    actorUserId: string;
    recordingId: string;
    ownerUserId: string;
    operation: AiOperation;
    /** The name the bridge's JSON Schema answer goes by. */
    schemaName: string;
    signal: AbortSignal;
    pin?: ProviderPin | null;
}): Promise<LearnChatClients> {
    const { actorUserId, signal } = input;
    const resolved = await resolveStepProvider({
        step: "learn",
        pin: input.pin ?? null,
        actorUserId,
    });
    if (resolved.kind !== "credential") {
        throw new AppError(
            ErrorCode.AI_PROVIDER_NOT_CONFIGURED,
            "No AI provider configured",
            400,
        );
    }
    const credentials = resolved.credential;
    const openai = new OpenAI({
        fetch: providerFetch,
        apiKey: credentials.apiKey,
        baseURL: credentials.baseUrl || undefined,
        maxRetries: resolved.organizationCredential ? 0 : undefined,
    });
    const model = enhancementChatModel(credentials);
    const bridgeClient = new OpenAI({
        fetch: providerFetch,
        apiKey: credentials.apiKey,
        baseURL: credentials.baseUrl || undefined,
        maxRetries: 0,
        timeout: BRIDGE_CALL_TIMEOUT_MS,
    });
    const usage = {
        recordingId: input.recordingId,
        ownerUserId: input.ownerUserId,
        actorUserId,
        payerUserId: resolved.payerUserId,
        operation: input.operation,
        provider: credentials.provider,
        model,
        baseUrl: credentials.baseUrl,
        credentialId: credentials.id,
    };
    return {
        provider: credentials.provider,
        baseUrl: credentials.baseUrl,
        model,
        payerUserId: resolved.payerUserId,
        // Path 1: the agent bridge's extension (`agent-bridge/README.md`):
        // the answer's JSON Schema, and the run's token for Riffado's
        // tools. Unknown fields travel in the body as they are.
        // One attempt: a CLI session with tools spends the run's lookups,
        // and a second one would answer knowing nothing. The job's own
        // retry starts over with a fresh budget instead. Long enough for a
        // CLI that looks things up (the bridge's BRIDGE_TIMEOUT_MS bounds
        // it on the other side).
        bridge: {
            complete: async ({ system, user, schema, mcp, maxTokens }) => {
                signal.throwIfAborted();
                await resolved.reserveCall();
                const response = await bridgeClient.chat.completions.create(
                    {
                        ...buildChatCompletionParams({
                            model,
                            messages: [
                                { role: "system", content: system },
                                { role: "user", content: user },
                            ],
                            temperature: 0.1,
                            maxTokens,
                            maxOutputTokens: credentials.maxOutputTokens,
                        }),
                        response_format: {
                            type: "json_schema",
                            json_schema: { name: input.schemaName, schema },
                        },
                        ...(mcp ? { riffado_mcp: mcp } : {}),
                    } as Parameters<
                        typeof openai.chat.completions.create
                    >[0] & { stream?: false },
                    { signal },
                );
                await recordChatCompletionUsage(usage, response);
                return response.choices[0]?.message?.content?.trim() || "";
            },
        },
        chat: {
            complete: (messages, maxTokens, options) =>
                retryWithBackoff({
                    attempts:
                        options?.retry === false ? 1 : CALL_RETRY_ATTEMPTS,
                    baseMs: 1_500,
                    maxMs: 15_000,
                    jitter: 0.5,
                    isRetryable: isRetryableError,
                    run: async () => {
                        signal.throwIfAborted();
                        await resolved.reserveCall();
                        const response = await openai.chat.completions.create(
                            buildChatCompletionParams({
                                model,
                                messages,
                                temperature: 0.1,
                                maxTokens,
                                maxOutputTokens: credentials.maxOutputTokens,
                            }),
                            {
                                signal,
                                ...(options?.retry === false
                                    ? { maxRetries: 0 }
                                    : {}),
                            },
                        );
                        await recordChatCompletionUsage(usage, response);
                        return (
                            response.choices[0]?.message?.content?.trim() || ""
                        );
                    },
                }),
        },
    };
}
