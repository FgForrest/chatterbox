import { describe, expect, it } from "vitest";
import { stemmingLanguage, stemVariants } from "@/lib/knowledge/stemming";

describe("stemming by language", () => {
    it.each([
        ["cs", "cs"],
        ["ces", "cs"],
        ["cs-CZ", "cs"],
        ["Czech", "cs"],
        ["slk", "sk"],
        ["pl_PL", "pl"],
        ["rum", "ro"],
        ["de", "de"],
        ["ger", "de"],
        ["nb", "no"],
        // English names take no case endings: Hughes is not Hugh.
        ["en", null],
        ["xx", null],
        ["", null],
        [null, null],
    ])("reads %s as %s", (code, language) => {
        expect(stemmingLanguage(code)).toBe(language);
    });

    it("stems a word in its language, without its accents", () => {
        expect(stemVariants("Šimákem", "cs")).toContain("simak");
        expect(stemVariants("Bratislavou", "sk")).toContain("bratislav");
        expect(stemVariants("Krakowem", "pl")).toContain("krakow");
        expect(stemVariants("Bucureștiului", "ro")).toContain("bucurest");
        expect(stemVariants("Helsingissä", "fi")).toContain("helsing");
        expect(stemVariants("Häusern", "de")).toContain("haus");
        expect(stemVariants("Москвой", "ru")).toContain("moskv");
    });

    it.each([
        ["ar", "المكتبات", "مكتب"],
        ["ca", "ciutats", "ciut"],
        ["da", "byerne", "byern"],
        ["de", "Häusern", "haus"],
        ["es", "ciudades", "ciudad"],
        ["eu", "etxeetan", "etxe"],
        ["fi", "Helsingissä", "helsing"],
        ["fr", "maisons", "maison"],
        ["ga", "bhfear", "fear"],
        ["hu", "házakban", "haz"],
        ["hy", "քաղաքներում", "քաղ"],
        ["it", "città", "citt"],
        ["nl", "huizen", "huis"],
        ["no", "byene", "byen"],
        ["pt", "cidades", "cidad"],
        ["ru", "Москвой", "moskv"],
        ["sv", "städerna", "stad"],
        ["ta", "நகரங்களில்", "நகரம"],
        ["tr", "evlerde", "ev"],
    ])("stems %s with Snowball: %s is %s", (language, word, stem) => {
        expect(stemVariants(word, language)).toContain(stem);
    });

    it("keeps the word as it is, and alone where no stemmer knows the language", () => {
        expect(stemVariants("Šimákem", "cs")).toContain("simakem");
        expect(stemVariants("Šimákem", "xx")).toEqual(["simakem"]);
        expect(stemVariants("Hughes", "en")).toEqual(["hughes"]);
        expect(stemVariants("Šimákem", null)).toEqual(["simakem"]);
        expect(stemVariants("...", "cs")).toEqual([]);
    });
});
