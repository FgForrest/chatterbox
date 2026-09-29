import { describe, expect, it } from "vitest";
import { groupPhrases } from "@/lib/knowledge/phrase-groups";

describe("groupPhrases", () => {
    it("groups phrases that say much the same, inflected, and leaves the rest alone", () => {
        expect(
            groupPhrases([
                { id: "a", phrase: "pracuje na" },
                { id: "b", phrase: "je klientem" },
                { id: "c", phrase: "pracují na" },
                { id: "d", phrase: "pracoval na" },
                { id: "e", phrase: "je klient" },
                { id: "f", phrase: "vede" },
            ]),
        ).toEqual([["a", "c", "d"], ["b", "e"], ["f"]]);
    });

    it("keeps one-word phrases that only share a letter or two apart", () => {
        expect(
            groupPhrases([
                { id: "a", phrase: "vede" },
                { id: "b", phrase: "vendor" },
            ]),
        ).toEqual([["a"], ["b"]]);
    });
});
