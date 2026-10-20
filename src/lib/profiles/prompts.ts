import { MAIL_SUMMARY_PROMPT_PARTS } from "@/lib/ai/mail-summary-prompts";
import { TITLE_PROMPTS_BY_LOCALE } from "@/lib/ai/prompt-presets";
import {
    assembleSummaryPrompt,
    resolveAiOutputLanguage,
    SUMMARY_PROMPT_PARTS,
    type SummaryPromptParts,
} from "@/lib/ai/summary-presets";
import type { AppLocale } from "@/lib/i18n/config";
import { TOPIC_PROMPTS_BY_LOCALE } from "@/lib/topics/topic-presets";
import type { AudioProfileSettings, MailProfileSettings } from "./settings";

/** Bump this value whenever any built-in prompt text changes. */
export const BUILTIN_PROMPTS_VERSION = "2026-10-20.1";

type SummaryStepSettings =
    | AudioProfileSettings["steps"]["summary"]
    | MailProfileSettings["steps"]["summary"];
type TitleStepSettings =
    | AudioProfileSettings["steps"]["title"]
    | MailProfileSettings["steps"]["title"];
type TopicStepSettings = AudioProfileSettings["steps"]["topics"];

interface PromptLanguageOptions {
    outputLanguage: string;
    contentLanguage: string | null;
    uiLocale: AppLocale;
}

/** Prompt text and the built-in provenance recorded with a processing run. */
export interface ResolvedProfilePrompt {
    text: string;
    builtinVersion: string | null;
    formatLocale: AppLocale | "custom";
}

const UNKNOWN_LANGUAGE_CODES = new Set([
    "",
    "auto",
    "mixed",
    "mul",
    "und",
    "unknown",
]);

function normalizedLanguageCode(
    language: string | null | undefined,
): string | null {
    if (language === null || language === undefined) return null;
    const normalized = language.trim().replaceAll("_", "-").toLowerCase();
    if (UNKNOWN_LANGUAGE_CODES.has(normalized)) return null;
    return normalized;
}

/** Map an ISO output-language code to the corresponding profile UI locale. */
export function promptLocaleForLanguage(
    language: string | null | undefined,
): AppLocale | null {
    const normalized = normalizedLanguageCode(language);
    if (normalized === null) return null;
    const code = resolveAiOutputLanguage("auto", normalized) ?? normalized;
    if (code === "en" || code.startsWith("en-")) return "en";
    if (code === "cs" || code.startsWith("cs-")) return "cs-CZ";
    return null;
}

interface PromptLocaleResolution {
    locale: AppLocale;
    useLocaleOverride: boolean;
}

function resolvePromptLocale({
    outputLanguage,
    contentLanguage,
    uiLocale,
}: PromptLanguageOptions): PromptLocaleResolution {
    if (outputLanguage.trim().toLowerCase() !== "auto") {
        const locale = promptLocaleForLanguage(outputLanguage);
        return locale
            ? { locale, useLocaleOverride: true }
            : { locale: "en", useLocaleOverride: false };
    }
    const contentCode = normalizedLanguageCode(contentLanguage);
    if (contentCode === null) {
        return { locale: uiLocale, useLocaleOverride: true };
    }
    const locale = promptLocaleForLanguage(contentCode);
    return locale
        ? { locale, useLocaleOverride: true }
        : { locale: "en", useLocaleOverride: false };
}

function summaryPromptParts(settings: SummaryStepSettings): SummaryPromptParts {
    return settings.preset === "mail"
        ? MAIL_SUMMARY_PROMPT_PARTS
        : SUMMARY_PROMPT_PARTS[settings.preset];
}

/**
 * Resolve profile-owned summary text without app-owned directives.
 *
 * Markdown, speaker, content-is-data, task and language directives remain the
 * generators' responsibility and are not included in `text`.
 */
export function resolveSummaryPrompt(
    options: PromptLanguageOptions & { settings: SummaryStepSettings },
): ResolvedProfilePrompt {
    const { settings } = options;
    if (settings.fullPrompt !== null) {
        return {
            text: settings.fullPrompt,
            builtinVersion: null,
            formatLocale: "custom",
        };
    }

    const { locale, useLocaleOverride } = resolvePromptLocale(options);
    const parts = summaryPromptParts(settings);
    const focus = settings.focus ?? parts.focus[locale];
    const outputFormat =
        (useLocaleOverride ? settings.outputFormat[locale] : undefined) ??
        parts.outputFormat[locale];
    return {
        text: assembleSummaryPrompt(parts, locale, focus, outputFormat),
        builtinVersion: BUILTIN_PROMPTS_VERSION,
        formatLocale: locale,
    };
}

/** Resolve a localized profile title prompt, falling back to English. */
export function resolveTitlePrompt(
    options: PromptLanguageOptions & { settings: TitleStepSettings },
): ResolvedProfilePrompt {
    const { settings } = options;
    if (settings.fullPrompt !== null) {
        return {
            text: settings.fullPrompt,
            builtinVersion: null,
            formatLocale: "custom",
        };
    }
    const { locale, useLocaleOverride } = resolvePromptLocale(options);
    return {
        text:
            (useLocaleOverride ? settings.prompt[locale] : undefined) ??
            TITLE_PROMPTS_BY_LOCALE[settings.preset][locale],
        builtinVersion: BUILTIN_PROMPTS_VERSION,
        formatLocale: locale,
    };
}

/** Resolve a localized profile topic prompt, falling back to English. */
export function resolveTopicPrompt(
    options: PromptLanguageOptions & { settings: TopicStepSettings },
): ResolvedProfilePrompt {
    const { settings } = options;
    if (settings.fullPrompt !== null) {
        return {
            text: settings.fullPrompt,
            builtinVersion: null,
            formatLocale: "custom",
        };
    }
    const { locale, useLocaleOverride } = resolvePromptLocale(options);
    return {
        text:
            (useLocaleOverride ? settings.prompt[locale] : undefined) ??
            TOPIC_PROMPTS_BY_LOCALE[settings.preset][locale],
        builtinVersion: BUILTIN_PROMPTS_VERSION,
        formatLocale: locale,
    };
}
