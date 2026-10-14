import { describe, expect, it } from "vitest";
import {
    promptLocaleForLanguage,
    resolveSummaryPrompt,
    resolveTitlePrompt,
    resolveTopicPrompt,
} from "@/lib/profiles/prompts";
import { defaultProfileSettings } from "@/lib/profiles/settings";

describe("profile prompt resolution", () => {
    it.each([
        ["en", "en"],
        ["en-US", "en"],
        ["cs", "cs-CZ"],
        ["cs_CZ", "cs-CZ"],
        ["de", null],
        [null, null],
    ] as const)("maps output language %s to profile locale %s", (language, locale) => {
        expect(promptLocaleForLanguage(language)).toBe(locale);
    });

    it("keeps an English summary unchanged when only Czech is customized", () => {
        const settings = defaultProfileSettings("audio").steps.summary;
        const english = resolveSummaryPrompt({
            settings,
            outputLanguage: "en",
            contentLanguage: "en",
            uiLocale: "en",
        });
        const customized = {
            ...settings,
            outputFormat: {
                ...settings.outputFormat,
                "cs-CZ": "Vlastní český formát.",
            },
        };

        expect(
            resolveSummaryPrompt({
                settings: customized,
                outputLanguage: "en",
                contentLanguage: "en",
                uiLocale: "en",
            }),
        ).toEqual(english);
        expect(
            resolveSummaryPrompt({
                settings: customized,
                outputLanguage: "cs",
                contentLanguage: "cs",
                uiLocale: "cs-CZ",
            }),
        ).toMatchObject({
            formatLocale: "cs-CZ",
            text: expect.stringContaining("Vlastní český formát."),
        });
    });

    it("restores the Czech built-in when its customization is removed", () => {
        const settings = defaultProfileSettings("audio").steps.summary;
        const customized = {
            ...settings,
            outputFormat: { "cs-CZ": "Vlastní český formát." },
        };
        const restored = { ...customized, outputFormat: {} };

        const builtIn = resolveSummaryPrompt({
            settings,
            outputLanguage: "cs",
            contentLanguage: "cs",
            uiLocale: "cs-CZ",
        });

        expect(
            resolveSummaryPrompt({
                settings: restored,
                outputLanguage: "cs",
                contentLanguage: "cs",
                uiLocale: "cs-CZ",
            }),
        ).toEqual(builtIn);
    });

    it("uses a full prompt without focus or output-format overlays", () => {
        const base = defaultProfileSettings("audio").steps.summary;
        const settings = {
            ...base,
            focus: "FOCUS OVERLAY",
            outputFormat: { en: "FORMAT OVERLAY" },
            fullPrompt: "Complete custom prompt with {transcription}",
        };

        expect(
            resolveSummaryPrompt({
                settings,
                outputLanguage: "en",
                contentLanguage: "en",
                uiLocale: "en",
            }),
        ).toMatchObject({
            text: "Complete custom prompt with {transcription}",
            formatLocale: "custom",
        });
    });

    it("applies a custom focus unchanged in English and Czech", () => {
        const base = defaultProfileSettings("audio").steps.summary;
        const settings = { ...base, focus: "Keep the contractual risks." };

        for (const outputLanguage of ["en", "cs"] as const) {
            expect(
                resolveSummaryPrompt({
                    settings,
                    outputLanguage,
                    contentLanguage: outputLanguage,
                    uiLocale: "en",
                }).text,
            ).toContain("Keep the contractual risks.");
        }
    });

    it("uses the established Czech headings in meeting output format", () => {
        const base = defaultProfileSettings("audio").steps.summary;
        const settings = { ...base, preset: "meeting-notes" as const };
        const text = resolveSummaryPrompt({
            settings,
            outputLanguage: "cs",
            contentLanguage: "cs",
            uiLocale: "cs-CZ",
        }).text;

        for (const heading of [
            "### Účastníci",
            "### Účel",
            "### Diskuse",
            "### Otevřené otázky",
        ]) {
            expect(text).toContain(heading);
        }
    });

    it("falls back to the English built-in for an unsupported output language", () => {
        const base = defaultProfileSettings("audio").steps.summary;
        const settings = {
            ...base,
            outputFormat: { en: "CUSTOM ENGLISH FORMAT" },
        };
        const english = resolveSummaryPrompt({
            settings: base,
            outputLanguage: "en",
            contentLanguage: "en",
            uiLocale: "cs-CZ",
        });

        expect(
            resolveSummaryPrompt({
                settings,
                outputLanguage: "de",
                contentLanguage: "de",
                uiLocale: "cs-CZ",
            }),
        ).toEqual(english);
    });

    it.each([
        "unknown",
        "mixed",
        "und",
        "mul",
        null,
    ])("uses the UI locale for auto with %s content language", (contentLanguage) => {
        const settings = defaultProfileSettings("audio").steps.summary;
        const resolved = resolveSummaryPrompt({
            settings,
            outputLanguage: "auto",
            contentLanguage,
            uiLocale: "cs-CZ",
        });

        expect(resolved.formatLocale).toBe("cs-CZ");
        expect(resolved.text).toContain("Přepis:");
    });

    it("resolves title and topic overrides by output locale", () => {
        const profile = defaultProfileSettings("audio");
        const title = {
            ...profile.steps.title,
            prompt: { "cs-CZ": "Vlastní název: {transcription}" },
        };
        const topics = {
            ...profile.steps.topics,
            prompt: { "cs-CZ": "Vlastní témata: {transcription}" },
        };

        expect(
            resolveTitlePrompt({
                settings: title,
                outputLanguage: "cs",
                contentLanguage: "cs",
                uiLocale: "cs-CZ",
            }),
        ).toMatchObject({
            text: "Vlastní název: {transcription}",
            formatLocale: "cs-CZ",
        });
        expect(
            resolveTopicPrompt({
                settings: topics,
                outputLanguage: "cs",
                contentLanguage: "cs",
                uiLocale: "cs-CZ",
            }),
        ).toMatchObject({
            text: "Vlastní témata: {transcription}",
            formatLocale: "cs-CZ",
        });
    });

    it("uses English title and topic built-ins for unsupported output languages", () => {
        const profile = defaultProfileSettings("audio");
        const title = {
            ...profile.steps.title,
            prompt: { en: "CUSTOM ENGLISH TITLE" },
        };
        const topics = {
            ...profile.steps.topics,
            prompt: { en: "CUSTOM ENGLISH TOPICS" },
        };

        expect(
            resolveTitlePrompt({
                settings: title,
                outputLanguage: "de",
                contentLanguage: "de",
                uiLocale: "en",
            }).text,
        ).not.toBe("CUSTOM ENGLISH TITLE");
        expect(
            resolveTopicPrompt({
                settings: topics,
                outputLanguage: "de",
                contentLanguage: "de",
                uiLocale: "en",
            }).text,
        ).not.toBe("CUSTOM ENGLISH TOPICS");
    });
});
