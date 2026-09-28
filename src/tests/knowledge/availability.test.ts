import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockEnv, credentials } = vi.hoisted(() => ({
    mockEnv: {
        IS_HOSTED: false,
        EMBEDDING_BASE_URL: undefined as string | undefined,
    },
    credentials: {
        rows: [] as { provider: string; isDefaultEnhancement: boolean }[],
    },
}));

vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/db", () => ({
    db: {
        select: () => ({
            from: () => ({ where: async () => credentials.rows }),
        }),
    },
}));

import {
    isEmbeddingAvailable,
    isLearnAvailableFor,
    isLearnDeploymentAvailable,
} from "@/lib/knowledge/availability";

describe("Learn availability", () => {
    beforeEach(() => {
        mockEnv.IS_HOSTED = false;
        mockEnv.EMBEDDING_BASE_URL = undefined;
        credentials.rows = [];
    });

    it("exists only on self-hosted instances", async () => {
        credentials.rows = [{ provider: "openai", isDefaultEnhancement: true }];
        expect(isLearnDeploymentAvailable()).toBe(true);
        expect(await isLearnAvailableFor("user-1")).toBe(true);

        mockEnv.IS_HOSTED = true;
        expect(isLearnDeploymentAvailable()).toBe(false);
        expect(await isLearnAvailableFor("user-1")).toBe(false);
    });

    it("needs a chat provider, not only a transcription one", async () => {
        expect(await isLearnAvailableFor("user-1")).toBe(false);
        credentials.rows = [
            { provider: "Speechmatics", isDefaultEnhancement: true },
        ];
        expect(await isLearnAvailableFor("user-1")).toBe(false);
        credentials.rows = [
            { provider: "openai", isDefaultEnhancement: false },
        ];
        expect(await isLearnAvailableFor("user-1")).toBe(true);
    });

    it("matches by meaning only with an embedding service, and never hosted", () => {
        expect(isEmbeddingAvailable()).toBe(false);
        mockEnv.EMBEDDING_BASE_URL = "http://embeddings:8080/v1";
        expect(isEmbeddingAvailable()).toBe(true);
        mockEnv.IS_HOSTED = true;
        expect(isEmbeddingAvailable()).toBe(false);
    });
});
