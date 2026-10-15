import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/env", () => ({
    env: {
        API_TOKEN_HASH_SECRET: "test-lookup-secret",
        BETTER_AUTH_SECRET: "fallback-secret",
    },
}));

const { domainLookupHash, lookupHash, normalizeForLookup } = await import(
    "../../lib/knowledge/lookup-hash"
);

describe("normalizeForLookup", () => {
    it("folds case and surrounding whitespace", () => {
        expect(normalizeForLookup("  Jan.Novotny@Example.test ")).toBe(
            "jan.novotny@example.test",
        );
    });
});

describe("lookupHash", () => {
    it("is stable for the same value", () => {
        expect(lookupHash("jan@example.test")).toBe(
            lookupHash("jan@example.test"),
        );
    });

    it("ignores case and whitespace so one person is not created twice", () => {
        expect(lookupHash("  JAN@EXAMPLE.TEST ")).toBe(
            lookupHash("jan@example.test"),
        );
    });

    it("differs for different values", () => {
        expect(lookupHash("jan@example.test")).not.toBe(
            lookupHash("petr@example.test"),
        );
    });

    it("does not return the plaintext", () => {
        const hash = lookupHash("jan@example.test");
        expect(hash).not.toContain("jan");
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
});

describe("domainLookupHash", () => {
    it("separates equal values of different kinds", () => {
        expect(domainLookupHash("relation-label", "leads")).not.toBe(
            domainLookupHash("entity-name", "leads"),
        );
    });

    it("folds case, composition and inner whitespace", () => {
        expect(domainLookupHash("entity-name", "  Café   Orion ")).toBe(
            domainLookupHash("entity-name", "cafe\u0301 orion"),
        );
    });

    it("is not the plain lookup hash of the value", () => {
        expect(domainLookupHash("entity-name", "orion")).not.toBe(
            lookupHash("orion"),
        );
    });
});
