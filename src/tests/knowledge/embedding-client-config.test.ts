import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
    env: {
        IS_HOSTED: false,
        EMBEDDING_BASE_URL: "http://embeddings:8080/v1",
        EMBEDDING_MODEL: "configured-model",
        EMBEDDING_API_KEY: undefined,
        EMBEDDING_TIMEOUT_MS: 12_345,
    },
}));

import { embeddingClient } from "@/lib/knowledge/embeddings";

afterEach(() => {
    vi.restoreAllMocks();
});

describe("configured embedding client", () => {
    it("uses the timeout from the environment", async () => {
        const timeout = vi.spyOn(AbortSignal, "timeout");
        vi.spyOn(globalThis, "fetch").mockResolvedValue(
            Response.json({ data: [{ index: 0, embedding: [1, 0] }] }),
        );

        await embeddingClient()?.embed(["text"]);

        expect(timeout).toHaveBeenCalledWith(12_345);
    });
});
