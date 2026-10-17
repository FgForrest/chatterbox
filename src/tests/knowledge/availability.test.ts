import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockEnv, resolution } = vi.hoisted(() => ({
    mockEnv: {
        IS_HOSTED: false,
        EMBEDDING_BASE_URL: undefined as string | undefined,
    },
    resolution: { available: false },
}));

vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/profiles/providers", () => ({
    resolveStepProvider: async () => {
        if (!resolution.available) throw new Error("no provider");
        return { kind: "credential" };
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
        resolution.available = false;
    });

    it("exists only on self-hosted instances", async () => {
        resolution.available = true;
        expect(isLearnDeploymentAvailable()).toBe(true);
        expect(await isLearnAvailableFor("user-1")).toBe(true);

        mockEnv.IS_HOSTED = true;
        expect(isLearnDeploymentAvailable()).toBe(false);
        expect(await isLearnAvailableFor("user-1")).toBe(false);
    });

    it("requires the shared Learn provider resolution to succeed", async () => {
        expect(await isLearnAvailableFor("user-1")).toBe(false);
        resolution.available = true;
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
