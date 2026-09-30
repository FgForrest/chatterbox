import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: { IS_HOSTED: false } }));

import {
    EmbeddingClient,
    EmbeddingUnavailable,
} from "@/lib/knowledge/embeddings";

/** A fake OpenAI-compatible endpoint: each text becomes [length, 1, 0]. */
function fakeFetch(
    options: {
        fail?: () => boolean;
        status?: () => number;
        delayMs?: number;
    } = {},
) {
    const calls: {
        url: string;
        body: { model: string; input: string[] };
        auth: string | null;
    }[] = [];
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        calls.push({
            url,
            body,
            auth: new Headers(init.headers).get("authorization"),
        });
        if (options.delayMs) {
            await new Promise((resolve, reject) => {
                const timer = setTimeout(resolve, options.delayMs);
                init.signal?.addEventListener("abort", () => {
                    clearTimeout(timer);
                    reject(init.signal?.reason);
                });
            });
        }
        if (options.fail?.()) {
            return new Response("down", { status: 503 });
        }
        const status = options.status?.() ?? 200;
        if (status !== 200) return new Response("no", { status });
        return Response.json({
            data: (body.input as string[])
                .map((text, index) => ({
                    index,
                    embedding: [text.length, 1, 0],
                }))
                .reverse(),
        });
    });
    return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

describe("EmbeddingClient", () => {
    it("embeds in batches, in order, normalized, with the model and key", async () => {
        const { fetch, calls } = fakeFetch();
        const client = new EmbeddingClient({
            baseUrl: "http://embeddings:8080/v1/",
            model: "bge-m3",
            apiKey: "secret",
            batchSize: 2,
            fetch,
        });
        const vectors = await client.embed(["a", "bbb", "cc"]);
        expect(calls).toHaveLength(2);
        expect(calls[0]).toMatchObject({
            url: "http://embeddings:8080/v1/embeddings",
            body: { model: "bge-m3", input: ["a", "bbb"] },
            auth: "Bearer secret",
        });
        const expected = [1, 3, 2].map(
            (length) => length / Math.hypot(length, 1),
        );
        vectors.forEach((vector, index) => {
            expect(vector[0]).toBeCloseTo(expected[index] ?? 0, 6);
        });
        for (const vector of vectors) {
            expect(Math.hypot(...vector)).toBeCloseTo(1, 5);
        }
    });

    it("gives up on a slow endpoint", async () => {
        const { fetch } = fakeFetch({ delayMs: 200 });
        const client = new EmbeddingClient({
            baseUrl: "http://embeddings/v1",
            model: "m",
            timeoutMs: 20,
            fetch,
        });
        await expect(client.embed(["a"])).rejects.toBeInstanceOf(
            EmbeddingUnavailable,
        );
    });

    it("stops asking after repeated failures, and tries again later", async () => {
        let down = true;
        const { fetch, calls } = fakeFetch({ fail: () => down });
        let now = 0;
        const client = new EmbeddingClient({
            baseUrl: "http://embeddings/v1",
            model: "m",
            failureThreshold: 2,
            openMs: 60_000,
            now: () => now,
            fetch,
        });
        for (let i = 0; i < 2; i++) {
            await expect(client.embed(["a"])).rejects.toBeInstanceOf(
                EmbeddingUnavailable,
            );
        }
        expect(client.available).toBe(false);
        await expect(client.embed(["a"])).rejects.toBeInstanceOf(
            EmbeddingUnavailable,
        );
        expect(calls).toHaveLength(2);

        now = 61_000;
        down = false;
        expect(client.available).toBe(true);
        await expect(client.embed(["a"])).resolves.toHaveLength(1);
        expect(calls).toHaveLength(3);
    });

    it("does not pause for a refused request, but does for a rate limit", async () => {
        let status = 400;
        const { fetch } = fakeFetch({ status: () => status });
        const client = new EmbeddingClient({
            baseUrl: "http://embeddings/v1",
            model: "m",
            failureThreshold: 2,
            fetch,
        });
        for (let i = 0; i < 3; i++) {
            await expect(client.embed(["a"])).rejects.toBeInstanceOf(
                EmbeddingUnavailable,
            );
        }
        expect(client.available).toBe(true);
        status = 429;
        for (let i = 0; i < 2; i++) {
            await expect(client.embed(["a"])).rejects.toBeInstanceOf(
                EmbeddingUnavailable,
            );
        }
        expect(client.available).toBe(false);
    });

    it("stops when its caller cancels, without counting it as a failure", async () => {
        const { fetch, calls } = fakeFetch({ delayMs: 200 });
        const client = new EmbeddingClient({
            baseUrl: "http://embeddings/v1",
            model: "m",
            batchSize: 1,
            failureThreshold: 1,
            fetch,
        });
        const controller = new AbortController();
        const run = client.embed(["a", "b"], { signal: controller.signal });
        controller.abort(new Error("cancelled"));
        await expect(run).rejects.toThrow("cancelled");
        expect(calls).toHaveLength(1);
        expect(client.available).toBe(true);
    });

    it("embeds nothing without asking", async () => {
        const { fetch, calls } = fakeFetch();
        const client = new EmbeddingClient({
            baseUrl: "http://embeddings/v1",
            model: "m",
            fetch,
        });
        expect(await client.embed([])).toEqual([]);
        expect(calls).toHaveLength(0);
    });
});
