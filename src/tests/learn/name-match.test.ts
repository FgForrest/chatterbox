import { describe, expect, it } from "vitest";
import {
    heardIsFirstNameOnly,
    heardIsTheName,
    isNameWord,
    moreThanFirstName,
    nameTokens,
} from "@/lib/learn/name-match";

describe("name matching, as Czech says names", () => {
    it("knows a surname inflected, including one that drops its e", () => {
        expect(isNameWord("bednarovi", "bednar")).toBe(true);
        expect(isNameWord("hrubcovou", "hrubcova")).toBe(true);
        expect(isNameWord("zeleneho", "zeleny")).toBe(true);
        expect(isNameWord("hajka", "hajek")).toBe(true);
        expect(isNameWord("nemcovi", "nemec")).toBe(true);
        expect(isNameWord("vondo", "vonda")).toBe(true);
    });

    it("knows the consonant a Czech ending changes, and only real endings", () => {
        expect(isNameWord("prochazce", "prochazka")).toBe(true);
        expect(isNameWord("zelenyho", "zeleny")).toBe(true);
        expect(isNameWord("krejciho", "krejci")).toBe(true);
        expect(isNameWord("krejcimu", "krejci")).toBe(true);
        expect(isNameWord("novakuv", "novak")).toBe(true);
        expect(isNameWord("novakovych", "novak")).toBe(true);
        // Another name that starts like a first name is not it.
        expect(isNameWord("janusek", "jan")).toBe(false);
        expect(isNameWord("janda", "jan")).toBe(false);
        expect(isNameWord("petrusek", "petr")).toBe(false);
    });

    it("does not take a common word that starts like a surname for it", () => {
        expect(isNameWord("nova", "novak")).toBe(false);
        expect(isNameWord("dost", "dostal")).toBe(false);
        expect(isNameWord("marketing", "marks")).toBe(false);
    });

    it("does not take an adjective starting a sentence for a surname", () => {
        const words = (text: string) => nameTokens(text);
        // Capitalized only because the sentence starts there.
        expect(
            moreThanFirstName(words("Dubových stolů je dost."), {
                name: "Jan Dub",
            }),
        ).toBe(false);
        expect(
            moreThanFirstName(words("Hotovo. Zeleného ráno nebaví."), {
                name: "Martin Zelený",
            }),
        ).toBe(false);
        // Inside a sentence the capital is the name's.
        expect(
            moreThanFirstName(words("To Zeleného nebaví."), {
                name: "Martin Zelený",
            }),
        ).toBe(true);
        // A title's period ends no sentence.
        expect(
            moreThanFirstName(words("Mluvil jsem s Ing. Zeleným."), {
                name: "Martin Zelený",
            }),
        ).toBe(true);
        // A noun's ending starting a sentence still names them.
        expect(
            moreThanFirstName(words("Dubovi to pošlu."), { name: "Jan Dub" }),
        ).toBe(true);
    });

    it("hears more than a first name only in a surname or a real nickname", () => {
        const words = (text: string) => nameTokens(text);
        expect(
            moreThanFirstName(words("Bednářovi to pošlu"), {
                name: "Michal Bednář",
            }),
        ).toBe(true);
        expect(
            moreThanFirstName(words("Díky, Michale."), {
                name: "Michal Bednář",
            }),
        ).toBe(false);
        // Titles and initials are not surnames.
        expect(
            moreThanFirstName(words("Ing. Jan tady"), {
                name: "Ing. Jan Novák",
            }),
        ).toBe(false);
        expect(
            moreThanFirstName(words("John F. here"), { name: "John F. Smith" }),
        ).toBe(false);
        // A one-word name is a first name alone, unless a nickname is heard.
        expect(moreThanFirstName(words("Jan tady"), { name: "Jan" })).toBe(
            false,
        );
        expect(
            moreThanFirstName(words("Jo, Vonďo, pošli"), {
                name: "Michal Vondra",
                aliases: ["Vonďa"],
            }),
        ).toBe(true);
        // An adjective is not the surname it looks like: Czech writes
        // names with a capital.
        expect(
            moreThanFirstName(words("Jan měl veselé ráno"), {
                name: "Jan Veselý",
            }),
        ).toBe(false);
        expect(
            moreThanFirstName(words("To Veselého nezajímá"), {
                name: "Jan Veselý",
            }),
        ).toBe(true);
        // "Jo" is Czech for yes: too short to be told from a word.
        expect(
            moreThanFirstName(words("Jo, pošli"), {
                name: "Jonáš Novák",
                aliases: ["Jo"],
            }),
        ).toBe(false);
    });

    it("tells the name itself from a first name alone", () => {
        expect(heardIsTheName("Martina Zelenýho", "Martin Zelený")).toBe(true);
        expect(heardIsTheName("Tavesi", "Tavesi")).toBe(true);
        expect(heardIsTheName("Mudrcovi", "Mudrc")).toBe(true);
        expect(heardIsTheName("Tavesy", "Tavesi")).toBe(true);
        expect(heardIsTheName("Vonďa", "Michal Vondra")).toBe(false);
        expect(heardIsTheName("Terra doma", "Terradoma")).toBe(false);

        // A misheard surname is corrected, not taken for a first name.
        expect(heardIsFirstNameOnly("Janušek", { name: "Jan Janoušek" })).toBe(
            false,
        );
        // A one-word record: nothing to tell a first name from.
        expect(heardIsFirstNameOnly("Bednař", { name: "Bednář" })).toBe(false);
        expect(
            moreThanFirstName(nameTokens("Ing. Jan, DiS., tady"), {
                name: "Ing. Jan Novák, DiS.",
            }),
        ).toBe(false);
        const michal = { name: "Michal Bednář" };
        expect(heardIsFirstNameOnly("Michale", michal)).toBe(true);
        expect(heardIsFirstNameOnly("Michal", michal)).toBe(true);
        expect(heardIsFirstNameOnly("Michalem Bednářem", michal)).toBe(false);
        expect(heardIsFirstNameOnly("Bednář", michal)).toBe(false);
        expect(
            heardIsFirstNameOnly("Vonďo", {
                name: "Michal Vondra",
                aliases: ["Vonďa"],
            }),
        ).toBe(false);
        expect(heardIsFirstNameOnly("Honzo", { name: "Jan Novotný" })).toBe(
            false,
        );
    });
});
