import { describe, expect, it } from "vitest";
import { normalizeName } from "@/lib/knowledge/name-match";
import { czechVariants } from "@/lib/knowledge/stemming/czech";

const meets = (heard: string, written: string) => {
    const theirs = new Set(czechVariants(normalizeName(written)));
    return czechVariants(normalizeName(heard)).some((variant) =>
        theirs.has(variant),
    );
};

/** Names and the forms Czech gives them, one per declension pattern. */
const DECLENSIONS: Record<string, string[]> = {
    // pán
    Novák: ["Nováka", "Novákovi", "Nováku", "Novákem", "Nováci", "Nováků"],
    Šimák: ["Šimáka", "Šimákovi", "Šimáku", "Šimákem"],
    Milan: ["Milana", "Milanovi", "Milane", "Milanem"],
    Jan: ["Jana", "Janovi", "Jane", "Janem"],
    // the e Czech drops, and k~c, h~z
    Hájek: ["Hájka", "Hájkovi", "Hájku", "Hájkem"],
    Němec: ["Němce", "Němcovi", "Němče", "Němcem"],
    // muž
    Lukáš: ["Lukáše", "Lukášovi", "Lukáši", "Lukášem"],
    // předseda
    Honza: ["Honzy", "Honzovi", "Honzo", "Honzou", "Honzu"],
    Kafka: ["Kafky", "Kafkovi", "Kafko", "Kafkou"],
    // žena, with ř~r
    Petra: ["Petry", "Petře", "Petru", "Petro", "Petrou"],
    Praha: ["Prahy", "Praze", "Prahu", "Prahou"],
    // adjectives
    Veselý: ["Veselého", "Veselému", "Veselém", "Veselým"],
    Brabcová: ["Brabcové", "Brabcovou"],
    Jiří: ["Jiřího", "Jiřímu", "Jiřím"],
    // město
    Brno: ["Brna", "Brnu", "Brnem"],
    // borrowed names, declined as Czech does
    Forest: ["Forestu", "Forestem"],
    // "Shoptetem" strips "-etem" as "kuřetem" does: the stems are one
    // letter apart, which the name index tolerates (name-match tests).
    Shoptet: ["Shoptetu"],
    Kubernetes: ["Kubernetesu", "Kubernetesem"],
};

describe("Czech stem variants", () => {
    it("meet every form of a name with the name", () => {
        const missed = Object.entries(DECLENSIONS).flatMap(([name, forms]) =>
            forms
                .filter((form) => !meets(form, name))
                .map((form) => `${form} → ${name}`),
        );
        expect(missed).toEqual([]);
    });

    it("meet whether either side kept its accents", () => {
        expect(meets("Simakem", "Šimák")).toBe(true);
        expect(meets("Šimákem", "Simak")).toBe(true);
        expect(meets("Petre", "Petra")).toBe(true);
    });

    it("keep apart names that merely start alike", () => {
        expect(meets("nová", "Novák")).toBe(false);
        expect(meets("Jana", "Janoušek")).toBe(false);
        expect(meets("Petr", "Petrák")).toBe(false);
        expect(meets("Hora", "Horák")).toBe(false);
        expect(meets("Lada", "Ladislav")).toBe(false);
    });

    it("include the word itself, and stay within their bound", () => {
        for (const word of ["a", "ab", "abc", "simakem", "atech", "atum"]) {
            const variants = czechVariants(word);
            expect(variants).toContain(word);
            expect(variants.length).toBeLessThanOrEqual(19);
        }
    });
});
