import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
    env: {
        IS_HOSTED: true,
        EMBEDDING_BASE_URL: "http://embeddings:8080/v1",
        EMBEDDING_MODEL: "bge-m3",
        EMBEDDING_API_KEY: undefined,
        EMBEDDING_TIMEOUT_MS: 60_000,
    },
}));

import { embeddingClient } from "@/lib/knowledge/embeddings";

describe("hosted embedding client", () => {
    it("stays disabled even with an endpoint configured", () => {
        expect(embeddingClient()).toBeNull();
    });
});
