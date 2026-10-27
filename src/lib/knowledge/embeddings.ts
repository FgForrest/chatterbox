/**
 * Embeddings from an OpenAI-compatible `/embeddings` endpoint: the compose
 * `embeddings` service, or any other the operator points
 * `EMBEDDING_BASE_URL` at.
 *
 * Texts go in batches, each with a timeout; vectors come back
 * L2-normalized, so a cosine is a dot product (`vector-search.ts`). After
 * repeated failures a circuit breaker stops asking for a while: callers
 * fall back to matching names by their words, and say so. A request the
 * service refuses (a 4xx other than a timeout or a rate limit) says
 * nothing about whether it is up, and a run its caller cancels failed
 * nothing: neither counts.
 */

import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { apiCredentials } from "@/db/schema";
import {
    type AiUsageContext,
    recordAiUsage,
    type UsageValues,
} from "@/lib/ai/usage-cost";
import { responseUsage } from "@/lib/ai/usage-values";
import { decrypt } from "@/lib/encryption";
import { env } from "@/lib/env";

export class EmbeddingUnavailable extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "EmbeddingUnavailable";
    }
}

class HttpStatusError extends Error {
    constructor(readonly status: number) {
        super(`HTTP ${status}`);
    }

    /** Refused for what was asked, not because the service is struggling. */
    get refused(): boolean {
        return (
            this.status >= 400 &&
            this.status < 500 &&
            this.status !== 408 &&
            this.status !== 429
        );
    }
}

export interface EmbeddingClientOptions {
    /** The API base, e.g. `http://embeddings:11434/v1` (the compose service). */
    baseUrl: string;
    model: string;
    apiKey?: string;
    batchSize?: number;
    /** Estimated character budget for one request. */
    maxBatchCharacters?: number;
    timeoutMs?: number;
    /** Consecutive failures that open the breaker. */
    failureThreshold?: number;
    /** How long an open breaker refuses before trying again. */
    openMs?: number;
    fetch?: typeof globalThis.fetch;
    now?: () => number;
}

export interface EmbeddingUsage {
    userId: string;
    payerUserId?: string;
    recordingId?: string | null;
    actorUserId?: string;
    query?: boolean;
}

export interface EmbeddingBatch {
    /** Index of the first text in the original input. */
    start: number;
    texts: readonly string[];
    vectors: readonly Float32Array[];
}

type EmbeddingContext = AiUsageContext & { priced: boolean };

interface PendingBatch {
    start: number;
    texts: string[];
}

function requestBatches(
    texts: readonly string[],
    countLimit: number,
    characterLimit: number,
): PendingBatch[] {
    const batches: PendingBatch[] = [];
    let current: PendingBatch | null = null;
    let characters = 0;
    for (const [index, text] of texts.entries()) {
        if (
            current &&
            (current.texts.length >= countLimit ||
                characters + text.length > characterLimit)
        ) {
            batches.push(current);
            current = null;
            characters = 0;
        }
        current ??= { start: index, texts: [] };
        current.texts.push(text);
        characters += text.length;
    }
    if (current) batches.push(current);
    return batches;
}

function normalize(values: readonly number[]): Float32Array {
    const length = Math.hypot(...values) || 1;
    return Float32Array.from(values, (value) => value / length);
}

export class EmbeddingClient {
    private failures = 0;
    private openUntil = 0;

    constructor(private readonly options: EmbeddingClientOptions) {}

    get model(): string {
        return this.options.model;
    }

    /** Whether the breaker lets a request through now. */
    get available(): boolean {
        return this.now() >= this.openUntil;
    }

    /**
     * One normalized vector per text, in order. `signal` cancels between
     * and during batches, throwing its reason.
     */
    async embed(
        texts: readonly string[],
        {
            signal,
            onBatch,
            usage,
        }: {
            signal?: AbortSignal;
            usage?: EmbeddingUsage;
            /** Called and awaited once per completed sub-batch before resolution. */
            onBatch?: (batch: EmbeddingBatch) => void | Promise<void>;
        } = {},
    ): Promise<Float32Array[]> {
        if (texts.length === 0) return [];
        if (!this.available) {
            throw new EmbeddingUnavailable("The embedding service is paused");
        }
        const countLimit = Math.max(1, this.options.batchSize ?? 32);
        const characterLimit = Math.max(
            1,
            this.options.maxBatchCharacters ?? 6_000,
        );
        const context = usage ? await this.usageContext(usage) : null;
        const vectors: Float32Array[] = [];
        for (const request of requestBatches(
            texts,
            countLimit,
            characterLimit,
        )) {
            signal?.throwIfAborted();
            const batchVectors = await this.batch(
                request.texts,
                signal,
                context,
                usage?.query,
            );
            await onBatch?.({
                start: request.start,
                texts: request.texts,
                vectors: batchVectors,
            });
            vectors.push(...batchVectors);
        }
        return vectors;
    }

    private async usageContext(
        usage: EmbeddingUsage,
    ): Promise<EmbeddingContext> {
        const context: EmbeddingContext = {
            priced: false,
            recordingId: usage.recordingId ?? null,
            ownerUserId: usage.userId,
            actorUserId: usage.actorUserId ?? usage.userId,
            payerUserId: usage.payerUserId ?? usage.userId,
            operation: "embedding",
            provider: "Embeddings",
            model: this.model,
            baseUrl: this.options.baseUrl,
        };
        try {
            const cards = await db
                .select()
                .from(apiCredentials)
                .where(
                    and(
                        eq(apiCredentials.userId, context.payerUserId),
                        eq(apiCredentials.defaultModel, this.model),
                        isNull(apiCredentials.disabledAt),
                    ),
                );
            const matches = cards.filter(
                (card) =>
                    (card.baseUrl || "https://api.openai.com/v1").replace(
                        /\/+$/,
                        "",
                    ) === this.options.baseUrl.replace(/\/+$/, "") &&
                    decrypt(card.apiKey) === (this.options.apiKey ?? ""),
            );
            if (matches.length === 1) {
                context.credentialId = matches[0].id;
                context.provider = matches[0].provider;
                context.priced = Number(matches[0].inputUsdPerMillion) > 0;
            }
        } catch {
            console.error("Failed to resolve embedding usage rate");
        }
        return context;
    }

    private now(): number {
        return (this.options.now ?? Date.now)();
    }

    private async batch(
        input: string[],
        cancel?: AbortSignal,
        context?: EmbeddingContext | null,
        query = false,
    ): Promise<Float32Array[]> {
        const fetch = this.options.fetch ?? globalThis.fetch;
        const url = `${this.options.baseUrl.replace(/\/+$/, "")}/embeddings`;
        let measured: UsageValues = {};
        let completed = false;
        try {
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    ...(this.options.apiKey
                        ? { authorization: `Bearer ${this.options.apiKey}` }
                        : {}),
                },
                body: JSON.stringify({ model: this.options.model, input }),
                signal: AbortSignal.any([
                    AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
                    ...(cancel ? [cancel] : []),
                ]),
                redirect: "error",
            });
            if (!response.ok) {
                try {
                    measured = responseUsage(await response.json());
                } catch {
                    measured = {};
                }
                throw new HttpStatusError(response.status);
            }
            const body = (await response.json()) as {
                data?: { index: number; embedding: number[] }[];
                usage?: {
                    prompt_tokens?: number;
                    total_tokens?: number;
                    cost?: number;
                };
            };
            measured = responseUsage(body);
            const data = [...(body.data ?? [])].sort(
                (a, b) => a.index - b.index,
            );
            if (data.length !== input.length) {
                throw new Error("The response does not match the request");
            }
            this.failures = 0;
            completed = true;
            return data.map((item) => normalize(item.embedding));
        } catch (error) {
            if (cancel?.aborted) throw cancel.reason;
            if (error instanceof HttpStatusError && error.refused) {
                throw new EmbeddingUnavailable(
                    "The embedding service refused",
                    {
                        cause: error,
                    },
                );
            }
            this.failures++;
            if (this.failures >= (this.options.failureThreshold ?? 3)) {
                this.openUntil = this.now() + (this.options.openMs ?? 60_000);
                this.failures = 0;
            }
            throw new EmbeddingUnavailable("The embedding service failed", {
                cause: error,
            });
        } finally {
            if (
                context &&
                (!query ||
                    context.priced ||
                    (measured.reportedCostUsd ?? 0) > 0)
            ) {
                await recordAiUsage(context, {
                    ...measured,
                    outcome: completed ? "succeeded" : "failed",
                });
            }
        }
    }
}

let client: EmbeddingClient | null | undefined;

/** The configured client, or null when embeddings are not set up here. */
export function embeddingClient(): EmbeddingClient | null {
    if (client !== undefined) return client;
    client =
        !env.IS_HOSTED && env.EMBEDDING_BASE_URL
            ? new EmbeddingClient({
                  baseUrl: env.EMBEDDING_BASE_URL,
                  model: env.EMBEDDING_MODEL,
                  apiKey: env.EMBEDDING_API_KEY,
                  timeoutMs: env.EMBEDDING_TIMEOUT_MS,
              })
            : null;
    return client;
}
