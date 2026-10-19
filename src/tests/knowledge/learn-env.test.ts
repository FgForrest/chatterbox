import { afterAll, beforeAll, describe, expect, it } from "vitest";

type EnvSchema = typeof import("@/lib/env")["envSchema"];
type ReadEnvInput = typeof import("@/lib/env")["readEnvInput"];
let envSchema: EnvSchema;
let readEnvInput: ReadEnvInput;
let originalNextPhase: string | undefined;

beforeAll(async () => {
    originalNextPhase = process.env.NEXT_PHASE;
    process.env.NEXT_PHASE = "phase-production-build";
    ({ envSchema, readEnvInput } = await import("@/lib/env"));
});

afterAll(() => {
    if (originalNextPhase === undefined) {
        delete process.env.NEXT_PHASE;
    } else {
        process.env.NEXT_PHASE = originalNextPhase;
    }
});

describe("Learn environment configuration", () => {
    it("is off without values, including the empty ones compose passes", () => {
        for (const input of [
            {},
            {
                EMBEDDING_BASE_URL: "",
                EMBEDDING_MODEL: "",
                EMBEDDING_API_KEY: "",
                EMBEDDING_TIMEOUT_MS: "",
                LEARN_MCP_URL: "",
            },
        ]) {
            const parsed = envSchema.parse(input);
            expect(parsed.EMBEDDING_BASE_URL).toBeUndefined();
            expect(parsed.EMBEDDING_MODEL).toBe("bge-m3");
            expect(parsed.EMBEDDING_API_KEY).toBeUndefined();
            expect(parsed.EMBEDDING_TIMEOUT_MS).toBe(60_000);
            expect(parsed.LEARN_MCP_URL).toBeUndefined();
            expect(parsed.KNOWLEDGE_MEMORY_MB).toBe(256);
        }
    });

    it("takes an operator's values", () => {
        const parsed = envSchema.parse({
            EMBEDDING_BASE_URL: " http://embeddings:8080/v1 ",
            EMBEDDING_MODEL: "multilingual-e5-large",
            EMBEDDING_API_KEY: "secret",
            EMBEDDING_TIMEOUT_MS: "90000",
            LEARN_MCP_URL: "http://riffado:3000/api/mcp/learn",
            KNOWLEDGE_MEMORY_MB: "1024",
        });
        expect(parsed.KNOWLEDGE_MEMORY_MB).toBe(1024);
        expect(parsed.EMBEDDING_BASE_URL).toBe("http://embeddings:8080/v1");
        expect(parsed.EMBEDDING_MODEL).toBe("multilingual-e5-large");
        expect(parsed.EMBEDDING_API_KEY).toBe("secret");
        expect(parsed.EMBEDDING_TIMEOUT_MS).toBe(90_000);
        expect(parsed.LEARN_MCP_URL).toBe("http://riffado:3000/api/mcp/learn");
    });

    it.each([
        ["EMBEDDING_BASE_URL", "not a url"],
        ["EMBEDDING_TIMEOUT_MS", "0"],
        ["EMBEDDING_TIMEOUT_MS", "later"],
        ["LEARN_MCP_URL", "embeddings:8080"],
        ["KNOWLEDGE_MEMORY_MB", "8"],
        ["KNOWLEDGE_MEMORY_MB", "a lot"],
    ])("rejects an invalid %s", (field, value) => {
        expect(() => envSchema.parse({ [field]: value })).toThrow();
    });

    it("reads the embedding timeout from the explicit runtime mapping", () => {
        expect(readEnvInput()).toHaveProperty("EMBEDDING_TIMEOUT_MS");
    });
});
