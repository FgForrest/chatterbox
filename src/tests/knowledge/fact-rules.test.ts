import { describe, expect, it } from "vitest";
import {
    nodeKey,
    QUOTE_SIMILARITY_THRESHOLD,
    quoteFromTurns,
    quoteSimilarity,
    relationFits,
} from "@/lib/knowledge/fact-rules";
import type { TranscriptTurn } from "@/lib/transcription/turns";

function turn(
    startMs: number,
    endMs: number,
    text: string,
    speaker = "speaker_0",
): TranscriptTurn {
    return { speaker, startMs, endMs, text };
}

describe("nodeKey", () => {
    it("tells people from entities, and keeps the id as it is", () => {
        expect(nodeKey({ personId: "AbC" })).toBe("p:AbC");
        expect(nodeKey({ entityId: "AbC" })).toBe("e:AbC");
    });
});

describe("relationFits", () => {
    const leads = {
        subjectTypes: ["person"],
        objectTypes: ["team", "project"],
        objectKind: "entity" as const,
    };
    const hasRole = {
        subjectTypes: ["person"],
        objectTypes: [],
        objectKind: "literal" as const,
    };

    it("takes a subject and an object of the types it names", () => {
        expect(relationFits(leads, "person", { type: "project" })).toBe(true);
        expect(relationFits(leads, "project", { type: "project" })).toBe(false);
        expect(relationFits(leads, "person", { type: "person" })).toBe(false);
    });

    it("takes text only where the relation's object is text", () => {
        expect(relationFits(hasRole, "person", { literal: true })).toBe(true);
        expect(relationFits(leads, "person", { literal: true })).toBe(false);
        expect(relationFits(hasRole, "person", { type: "project" })).toBe(
            false,
        );
    });
});

describe("quoteFromTurns", () => {
    const turns = [
        turn(0, 10_000, "one two three four five six seven eight nine ten"),
        turn(10_000, 12_000, "eleven twelve", "speaker_1"),
    ];

    it("cuts the words spoken over the range, whole words only", () => {
        expect(quoteFromTurns(turns, 0, 10_000)).toBe(
            "one two three four five six seven eight nine ten",
        );
        const middle = quoteFromTurns(turns, 3_000, 6_000) ?? "";
        expect(middle).toMatch(/^\S.*\S$/);
        expect(middle).toContain("five");
        expect(middle).not.toContain("one");
        expect(middle).not.toContain("ten");
    });

    it("joins the turns a range spans", () => {
        expect(quoteFromTurns(turns, 9_000, 12_000)).toMatch(
            /ten eleven twelve$/,
        );
    });

    it("finds nothing where nobody spoke, or without turns", () => {
        expect(quoteFromTurns(turns, 20_000, 30_000)).toBeNull();
        expect(quoteFromTurns(null, 0, 1_000)).toBeNull();
    });
});

describe("quoteSimilarity", () => {
    it("is 1 for the same words, whatever the case, accents or punctuation", () => {
        expect(
            quoteSimilarity(
                "Jan vede projekt Orion.",
                "jan  vede, projekt orion",
            ),
        ).toBe(1);
        expect(quoteSimilarity("Dvořák řekl", "Dvorak rekl")).toBe(1);
    });

    it("stays above the threshold for a lightly reworded quote", () => {
        expect(
            quoteSimilarity(
                "Jan vede projekt Orion pro Tavesi od března",
                "Jan vede ten projekt Orion pro Tavesi od března",
            ),
        ).toBeGreaterThanOrEqual(QUOTE_SIMILARITY_THRESHOLD);
    });

    it("falls below it when the words are different", () => {
        expect(
            quoteSimilarity(
                "Jan vede projekt Orion pro Tavesi",
                "Pavel odchází z firmy příští týden",
            ),
        ).toBeLessThan(QUOTE_SIMILARITY_THRESHOLD);
    });

    it("is 0 against nothing", () => {
        expect(quoteSimilarity("Jan", "")).toBe(0);
    });
});
