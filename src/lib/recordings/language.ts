import {
    AI_OUTPUT_LANGUAGES,
    DETECTED_LANGUAGE_ALIASES,
    normalizeAiOutputLanguage,
} from "@/lib/ai/summary-presets";

/** Every language a person can pick, excluding automatic detection. */
export const SELECTABLE_RECORDING_LANGUAGES = AI_OUTPUT_LANGUAGES.filter(
    (language) => language.code !== "auto",
);

/** A selectable ISO 639-1 language, excluding automatic detection. */
export function recordingLanguage(value: unknown): string | null {
    const code = normalizeAiOutputLanguage(value);
    return code === "auto" ? null : code;
}

/** Normalize a provider's code, regional tag or language name for comparison. */
export function normalizeDetectedLanguage(
    value: string | null | undefined,
): string | null {
    const input = value?.trim().toLowerCase();
    if (!input) return null;
    const code = input.split(/[-_]/)[0] ?? "";
    return (
        recordingLanguage(code) ??
        DETECTED_LANGUAGE_ALIASES[code] ??
        SELECTABLE_RECORDING_LANGUAGES.find(
            (language) => language.label.toLowerCase() === input,
        )?.code ??
        null
    );
}

/** Explicit output choice, then confirmed recording language, then generic auto. */
export function recordingOutputLanguage(
    preference: string | null | undefined,
    confirmed: string | null | undefined,
): string | null {
    return recordingLanguage(preference) ?? recordingLanguage(confirmed);
}

/** A localized language name for the transcript and its review. */
export function recordingLanguageName(code: string, locale: string): string {
    const normalized = normalizeDetectedLanguage(code);
    return normalized
        ? (new Intl.DisplayNames([locale], { type: "language" }).of(
              normalized,
          ) ?? code)
        : code;
}
