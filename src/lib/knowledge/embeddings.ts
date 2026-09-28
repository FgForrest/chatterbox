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
    /** The API base, e.g. `http://embeddings:8080/v1`. */
    baseUrl: string;
    model: string;
    apiKey?: string;
    batchSize?: number;
    timeoutMs?: number;
    /** Consecutive failures that open the breaker. */
    failureThreshold?: number;
    /** How long an open breaker refuses before trying again. */
    openMs?: number;
    fetch?: typeof globalThis.fetch;
    now?: () => number;
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
        { signal }: { signal?: AbortSignal } = {},
    ): Promise<Float32Array[]> {
        if (texts.length === 0) return [];
        if (!this.available) {
            throw new EmbeddingUnavailable("The embedding service is paused");
        }
        const size = this.options.batchSize ?? 32;
        const vectors: Float32Array[] = [];
        for (let start = 0; start < texts.length; start += size) {
            signal?.throwIfAborted();
            vectors.push(
                ...(await this.batch(texts.slice(start, start + size), signal)),
            );
        }
        return vectors;
    }

    private now(): number {
        return (this.options.now ?? Date.now)();
    }

    private async batch(
        input: string[],
        cancel?: AbortSignal,
    ): Promise<Float32Array[]> {
        const fetch = this.options.fetch ?? globalThis.fetch;
        const url = `${this.options.baseUrl.replace(/\/+$/, "")}/embeddings`;
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
                    AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
                    ...(cancel ? [cancel] : []),
                ]),
                redirect: "error",
            });
            if (!response.ok) {
                throw new HttpStatusError(response.status);
            }
            const body = (await response.json()) as {
                data?: { index: number; embedding: number[] }[];
            };
            const data = [...(body.data ?? [])].sort(
                (a, b) => a.index - b.index,
            );
            if (data.length !== input.length) {
                throw new Error("The response does not match the request");
            }
            this.failures = 0;
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
              })
            : null;
    return client;
}
