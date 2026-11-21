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
        (Object.hasOwn(DETECTED_LANGUAGE_ALIASES, code)
            ? DETECTED_LANGUAGE_ALIASES[code]
            : undefined) ??
        SELECTABLE_RECORDING_LANGUAGES.find(
            (language) => language.label.toLowerCase() === input,
        )?.code ??
        null
    );
}

// Alpha-2 column of https://www.loc.gov/standards/iso639-2/php/code_list.php.
const ISO_639_1 = new Set(
    "aa ab ae af ak am an ar as av ay az ba be bg bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu".split(
        " ",
    ),
);

/** Normalize imported detected language to an assigned ISO 639-1 code. */
export function importedDetectedLanguage(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const language = value.trim().toLowerCase();
    const tag =
        /^([a-z]{2,3})(?:[-_][a-z]{4})?(?:[-_](?:[a-z]{2}|[0-9]{3}))?$/.exec(
            language,
        );
    const candidate = tag?.[1] ?? language;
    if (ISO_639_1.has(candidate)) return candidate;
    if (!/^[a-z ]+$/.test(candidate)) return null;
    const alias = normalizeDetectedLanguage(candidate);
    return alias && ISO_639_1.has(alias) ? alias : null;
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
