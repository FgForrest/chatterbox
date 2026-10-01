import { describe, expect, it } from "vitest";
import {
    boundedLevenshtein,
    matchNames,
    normalizeName,
    trigramSimilarity,
    type WordStemmer,
} from "@/lib/knowledge/name-match";
import { stemVariants } from "@/lib/knowledge/stemming";

describe("normalizeName", () => {
    it.each([
        ["Dvořák", "dvorak"],
        ["  Jan   Novotný ", "jan novotny"],
        ["Łukasz Żółć", "lukasz zolc"],
        ["Müller-Straße", "muller strasse"],
        ["Ærø Øster", "aero oster"],
        ["Иванов", "ivanov"],
        ["Щукин", "shchukin"],
        ["Νίκος Παπαδόπουλος", "nikos papadopoulos"],
        ["O'Neil", "o neil"],
    ])("reads %s as %s", (name, normalized) => {
        expect(normalizeName(name)).toBe(normalized);
    });
});

describe("trigramSimilarity", () => {
    it("is 1 for the same name and 0 for nothing in common", () => {
        expect(trigramSimilarity("novak", "novak")).toBe(1);
        expect(trigramSimilarity("novak", "xyz")).toBe(0);
    });

    it("keeps word forms of one name close", () => {
        expect(trigramSimilarity("honza", "honzou")).toBeGreaterThan(0.4);
        expect(trigramSimilarity("novak", "novakem")).toBeGreaterThan(0.5);
    });
});

describe("boundedLevenshtein", () => {
    it("counts edits up to the bound, and says more past it", () => {
        expect(boundedLevenshtein("muller", "mueller", 2)).toBe(1);
        expect(boundedLevenshtein("kowalski", "kovalski", 2)).toBe(1);
        expect(boundedLevenshtein("jan", "pavel", 2)).toBe(3);
        expect(boundedLevenshtein("same", "same", 0)).toBe(0);
    });
});

describe("matchNames", () => {
    const candidates = [
        { id: "jan", names: ["Jan Novotný", "Honza"] },
        { id: "anna", names: ["Anna Dvořáková"] },
        { id: "ivanov", names: ["Иван Иванов"] },
        { id: "muller", names: ["Jürgen Müller"] },
        { id: "orion", names: ["Orion"] },
    ];

    it("finds a name as spoken, in any script or spelling, with its reason", () => {
        expect(matchNames("jan novotny", candidates)[0]).toMatchObject({
            id: "jan",
            reason: "exact",
        });
        expect(matchNames("Novotný", candidates)[0]).toMatchObject({
            id: "jan",
            reason: "token",
        });
        expect(matchNames("Ivan Ivanov", candidates)[0]).toMatchObject({
            id: "ivanov",
            reason: "exact",
        });
        expect(matchNames("Jurgen Mueller", candidates)[0]).toMatchObject({
            id: "muller",
            reason: "edit",
        });
        expect(matchNames("Honzou", candidates)[0]).toMatchObject({
            id: "jan",
            reason: "trigram",
        });
    });

    it("ranks by score, one entry per candidate, and leaves out the unrelated", () => {
        const found = matchNames("Orion", candidates);
        expect(found.map((match) => match.id)).toEqual(["orion"]);
        expect(matchNames("Kubernetes", candidates)).toEqual([]);
        const scores = matchNames("Anna", candidates).map((m) => m.score);
        expect(scores).toEqual([...scores].sort((a, b) => b - a));
    });
});

describe("matchNames in a language", () => {
    const czech: WordStemmer = {
        key: "cs",
        stem: (word) => stemVariants(word, "cs"),
    };
    const candidates = [
        { id: "simak", names: ["Jan Šimák"] },
        { id: "milan", names: ["Milan Petrák"] },
        { id: "forrest", names: ["FG Forrest"] },
        { id: "shoptet", names: ["Shoptet"] },
        { id: "mcp", names: ["MCP"] },
        { id: "jan", names: ["Jan Novotný", "Honza"] },
    ];
    const first = (query: string) => matchNames(query, candidates, czech)[0];

    it("meets a name heard inflected, by its stems", () => {
        expect(first("Šimákem")).toMatchObject({
            id: "simak",
            reason: "stem",
        });
        expect(first("Milane")).toMatchObject({ id: "milan", reason: "stem" });
        expect(first("Honzou")).toMatchObject({ id: "jan", reason: "stem" });
        // Inflected and a letter off: "Forestu" for Forrest.
        expect(first("Forestu")).toMatchObject({
            id: "forrest",
            reason: "stem",
        });
        // The light stemmer's slip on "-etem" is one letter.
        expect(first("Shoptetem")).toMatchObject({
            id: "shoptet",
            reason: "stem",
        });
    });

    it("finds a known name inside a longer one", () => {
        expect(first("MCP server")).toMatchObject({
            id: "mcp",
            reason: "part",
        });
    });

    it("finds no more without a language than before", () => {
        expect(matchNames("Milane", candidates)).toEqual([]);
    });
});
