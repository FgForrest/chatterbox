import { describe, expect, it } from "vitest";
import {
    assembleSummaryPrompt,
    SUMMARY_PROMPT_PARTS,
} from "@/lib/ai/summary-presets";
import {
    BUILTIN_PROMPTS_VERSION,
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
        ["ces", "cs-CZ"],
        ["cze", "cs-CZ"],
        ["Czech", "cs-CZ"],
        ["eng", "en"],
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

    it.each([
        "en",
        "cs-CZ",
    ] as const)("keeps unedited summary fields following current %s built-ins", (locale) => {
        for (const preset of ["general", "meeting-notes"] as const) {
            const settings = {
                ...defaultProfileSettings("audio").steps.summary,
                preset,
            };
            const stored = JSON.stringify(settings);
            expect(settings).toMatchObject({
                focus: null,
                outputFormat: {},
                fullPrompt: null,
            });
            const resolved = resolveSummaryPrompt({
                settings,
                outputLanguage: "auto",
                contentLanguage: locale,
                uiLocale: locale,
            });
            expect(resolved).toEqual({
                text: assembleSummaryPrompt(
                    SUMMARY_PROMPT_PARTS[preset],
                    locale,
                ),
                builtinVersion: BUILTIN_PROMPTS_VERSION,
                formatLocale: locale,
            });
            expect(JSON.stringify(settings)).toBe(stored);
            expect(resolved.text).toContain("350–700");
            expect(resolved.text).toContain("2–6");
            expect(resolved.text).not.toContain("### Diskuse");
            expect(resolved.text).not.toContain("### Účastníci");
        }
    });

    it("uses Czech overrides under auto for the provider language code", () => {
        const settings = {
            ...defaultProfileSettings("audio").steps.summary,
            outputFormat: { "cs-CZ": "Vlastní český formát." },
        };
        expect(
            resolveSummaryPrompt({
                settings,
                outputLanguage: "auto",
                contentLanguage: "ces",
                uiLocale: "en",
            }),
        ).toMatchObject({
            formatLocale: "cs-CZ",
            text: expect.stringContaining("Vlastní český formát."),
        });
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

    it.each([
        ["de", "en"],
        ["cs", "cs-CZ"],
    ] as const)("uses language-independent custom title and topic prompts for %s output", (outputLanguage, uiLocale) => {
        const profile = defaultProfileSettings("audio");
        const title = {
            ...profile.steps.title,
            fullPrompt: "Custom title: {transcription}",
        };
        const topics = {
            ...profile.steps.topics,
            fullPrompt: "Custom topics: {transcription}",
        };

        expect(
            resolveTitlePrompt({
                settings: title,
                outputLanguage,
                contentLanguage: outputLanguage,
                uiLocale,
            }),
        ).toMatchObject({
            text: "Custom title: {transcription}",
            formatLocale: "custom",
            builtinVersion: null,
        });
        expect(
            resolveTopicPrompt({
                settings: topics,
                outputLanguage,
                contentLanguage: outputLanguage,
                uiLocale,
            }),
        ).toMatchObject({
            text: "Custom topics: {transcription}",
            formatLocale: "custom",
            builtinVersion: null,
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
