import { describe, expect, it } from "vitest";
import { normalizeName } from "@/lib/knowledge/name-match";
import { romanianVariants } from "@/lib/knowledge/stemming/romanian";

const meets = (heard: string, written: string) => {
    const theirs = new Set(romanianVariants(normalizeName(written)));
    return romanianVariants(normalizeName(heard)).some((variant) =>
        theirs.has(variant),
    );
};

const missedForms = (table: Record<string, string[]>) =>
    Object.entries(table).flatMap(([name, forms]) =>
        forms
            .filter((form) => !meets(form, name))
            .map((form) => `${form} → ${name}`),
    );

/** Names and the forms Romanian gives them: the article and the genitive. */
const INFLECTIONS: Record<string, string[]> = {
    // masculine names take "-ul", "-ului"; Snowball has no vocative "-ule"
    Ion: ["Ionul", "Ionului"],
    Dan: ["Danul", "Danului"],
    Moldovan: ["Moldovanul", "Moldovanului"],
    Lazăr: ["Lazărul", "Lazărului"],
    // feminine names in "-ia" take "-iei"; Snowball's step 0 strips "-iei"
    // but not a bare "-ei", so "Elenei" and "Ioanei" stay apart from
    // "Elena" and "Ioana", and its vowel step leaves the vocative "-o"
    Maria: ["Mariei"],
    Sofia: ["Sofiei"],
    Natalia: ["Nataliei"],
    // "Popescului" strips to "popesc" while the vowel step keeps the final
    // "u" of "Popescu", and "Popeștii" alternates "sc"/"șt": none meet
    // places
    București: ["Bucureștiul", "Bucureștiului"],
    Cluj: ["Clujul", "Clujului"],
    Brașov: ["Brașovul", "Brașovului"],
    Arad: ["Aradul", "Aradului"],
    Galați: ["Galațiul", "Galațiului"],
    // "Timișoarei" and "Constanței" end in the bare "-ei" Snowball keeps
    România: ["României"],
    Dunăre: ["Dunărea", "Dunării"],
    // borrowed names, declined as Romanian does
    Kubernetes: ["Kubernetesul", "Kubernetesului"],
    Linux: ["Linuxul", "Linuxului"],
    Docker: ["Dockerul", "Dockerului"],
};

/** Lemmas and forms from evitaDB's Romanian fixture, its encoding probes too. */
const FIXTURE: Record<string, string[]> = {
    // "negru"/"neagră" and "telefon"/"telefoane" alternate inside the stem:
    // the fixture carries them to measure that no suffix stripper converges
    galben: ["galbenă", "galbeni", "galbene"],
    ieftin: ["ieftină", "ieftine"],
    bărbătesc: ["bărbătească", "bărbătești"],
    lucrat: ["lucrată", "lucrate", "lucrați"],
    vopsit: ["vopsită", "vopsite"],
    // the comma-below and the cedilla spellings of one word
    mașină: ["mașina", "mașini", "mașinile", "maşină", "maşini"],
    pantof: ["pantofi", "pantofii"],
    rochie: ["rochia", "rochii"],
    scaun: ["scaune", "scaunele"],
    inel: ["inele", "inelul"],
    telefon: ["telefonul"],
    calculator: ["calculatorul", "calculatoare"],
    calitate: ["calitatea", "calități", "calității"],
    garanție: ["garanția", "garanții", "garanţie"],
    promoție: ["promoția", "promoții"],
    chestiune: ["chestiuni"],
    cumpăra: ["cumpără", "cumpărăm"],
};

describe("Romanian stem variants", () => {
    it("meet every form of a name with the name", () => {
        expect(missedForms(INFLECTIONS)).toEqual([]);
    });

    it("meet the forms of evitaDB's Romanian fixture", () => {
        expect(missedForms(FIXTURE)).toEqual([]);
    });

    it("meet whether either side kept its accents", () => {
        expect(meets("Bucurestiului", "București")).toBe(true);
        expect(meets("Bucureștiului", "Bucuresti")).toBe(true);
        expect(meets("Brasovului", "Brașov")).toBe(true);
        expect(meets("Galatiului", "Galați")).toBe(true);
        // the legacy cedilla spelling meets the comma-below one
        expect(meets("Galaţiului", "Galați")).toBe(true);
        expect(meets("Dunarii", "Dunărea")).toBe(true);
    });

    it("keep apart names that merely start alike", () => {
        expect(meets("Ion", "Ionescu")).toBe(false);
        expect(meets("Ionului", "Ionescu")).toBe(false);
        expect(meets("Maria", "Marian")).toBe(false);
        expect(meets("Dan", "Daniel")).toBe(false);
        expect(meets("Popa", "Popescu")).toBe(false);
        expect(meets("Ana", "Anastasia")).toBe(false);
        // evitaDB's confusable lemmas
        expect(meets("format", "formă")).toBe(false);
        expect(meets("veste", "poveste")).toBe(false);
        expect(meets("copilul", "copia")).toBe(false);
    });

    it("include the word itself, and stay within their bound", () => {
        // evitaDB's boundary words: the "tiune" fork, the "ș"/"ă"-spelled
        // verb endings, the combo loop, step 0, the markers and the regions
        for (const word of [
            "chestiune",
            "gravitatiune",
            "xxasesi",
            "cumpara",
            "lucreaza",
            "descalicator",
            "specificitate",
            "organism",
            "copiii",
            "cartile",
            "abile",
            "omului",
            "ziua",
            "oua",
            "ai",
            "a",
            "",
        ]) {
            const variants = romanianVariants(word);
            expect(variants).toContain(word);
            expect(variants.length).toBeLessThanOrEqual(64);
        }
    });
});
