import { describe, expect, it } from "vitest";
import {
    boundedLevenshtein,
    matchNames,
    normalizeName,
    trigramSimilarity,
} from "@/lib/knowledge/name-match";

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
