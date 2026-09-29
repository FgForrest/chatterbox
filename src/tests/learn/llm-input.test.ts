import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
    env: { BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00" },
}));
vi.mock("@/db", () => ({ db: {} }));

import { llmInputFingerprint } from "@/lib/learn/llm-input";

const turn = (text: string) => [
    { speaker: "speaker_0", startMs: 0, endMs: 1_000, text },
];

describe("the fingerprint of what a model reads", () => {
    it("is equal exactly when the text is, case and spacing included", () => {
        expect(llmInputFingerprint(turn("We met Orion."))).toBe(
            llmInputFingerprint(turn("We met Orion.")),
        );
        expect(llmInputFingerprint(turn("We met Orion."))).not.toBe(
            llmInputFingerprint(turn("We met orion.")),
        );
        expect(llmInputFingerprint(turn("We met  Orion."))).not.toBe(
            llmInputFingerprint(turn("We met Orion.")),
        );
        expect(llmInputFingerprint(turn("We met Orion."))).toMatch(
            /^[0-9a-f]{64}$/,
        );
    });
});
