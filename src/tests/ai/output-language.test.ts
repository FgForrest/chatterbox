import { describe, expect, it } from "vitest";
import {
    getAiOutputLanguageDirective,
    resolveAiOutputLanguage,
} from "@/lib/ai/summary-presets";

describe("detected AI output languages", () => {
    it.each([
        ["eng", "en"],
        ["spa", "es"],
        ["fra", "fr"],
        ["fre", "fr"],
        ["deu", "de"],
        ["ger", "de"],
        ["ita", "it"],
        ["por", "pt"],
        ["nld", "nl"],
        ["dut", "nl"],
        ["pol", "pl"],
        ["rus", "ru"],
        ["tur", "tr"],
        ["ukr", "uk"],
        ["ces", "cs"],
        ["cze", "cs"],
        ["slk", "sk"],
        ["slo", "sk"],
        ["swe", "sv"],
        ["dan", "da"],
        ["nor", "no"],
        ["fin", "fi"],
        ["ell", "el"],
        ["gre", "el"],
        ["ron", "ro"],
        ["rum", "ro"],
        ["hun", "hu"],
        ["jpn", "ja"],
        ["zho", "zh"],
        ["chi", "zh"],
        ["kor", "ko"],
        ["ara", "ar"],
        ["heb", "he"],
        ["hin", "hi"],
        ["ind", "id"],
        ["vie", "vi"],
        ["tha", "th"],
    ] as const)("maps %s to %s", (detected, expected) => {
        expect(resolveAiOutputLanguage("auto", detected)).toBe(expected);
    });

    it("keeps language names and gives ces an explicit Czech directive", () => {
        expect(resolveAiOutputLanguage("auto", "czech")).toBe("cs");
        const language = resolveAiOutputLanguage("auto", "ces");
        expect(language).toBe("cs");
        expect(getAiOutputLanguageDirective(language)).toContain(
            "Write all natural-language output in Czech",
        );
    });
});
