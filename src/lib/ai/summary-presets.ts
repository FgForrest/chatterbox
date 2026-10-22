import type { AppLocale } from "@/lib/i18n/config";
import {
    defaultTemplateConfig,
    isValidTemplateConfig,
    normalizeTemplateConfig,
    type TemplateConfiguration,
    type TemplateKind,
} from "./prompt-templates";

export type SummaryPreset =
    | "general"
    | "meeting-notes"
    | "key-points"
    | "action-items";

export interface SummaryPromptConfig {
    id: SummaryPreset;
    name: string;
    description: string;
    prompt: string;
}

/** App-owned skeleton and localized editable parts of a summary prompt. */
export interface SummaryPromptParts {
    skeleton: Readonly<Record<AppLocale, string>>;
    focus: Readonly<Record<AppLocale, string>>;
    outputFormat: Readonly<Record<AppLocale, string>>;
}

const FOCUS_SLOT = "{focus}";
const FOCUS_BLOCK_SLOT = "{focusBlock}";
const OUTPUT_FORMAT_SLOT = "{outputFormat}";
const OUTPUT_FORMAT_BLOCK_SLOT = "{outputFormatBlock}";

/** Assemble an app-owned skeleton with its focus and output-format text. */
export function assembleSummaryPrompt(
    parts: SummaryPromptParts,
    locale: AppLocale,
    focus = parts.focus[locale],
    outputFormat = parts.outputFormat[locale],
): string {
    return parts.skeleton[locale]
        .replaceAll(FOCUS_SLOT, focus)
        .replaceAll(FOCUS_BLOCK_SLOT, focus ? `${focus}\n\n` : "")
        .replaceAll(OUTPUT_FORMAT_SLOT, outputFormat)
        .replaceAll(
            OUTPUT_FORMAT_BLOCK_SLOT,
            outputFormat ? `${outputFormat}\n\n` : "",
        );
}

/** Localized built-in summary parts; skeletons remain app-owned. */
export const SUMMARY_PROMPT_PARTS: Readonly<
    Record<SummaryPreset, SummaryPromptParts>
> = {
    general: {
        skeleton: {
            en: `First extract every supported action item from this audio transcription, then summarize it and extract key points. Complete the task inventory before writing the minutes; return an empty actionItems array if there are no commitments.

Respond with a single JSON object and nothing else. Do not wrap it in code fences.
{
  "actionItems": [{"text": "A supported task", "speaker": null, "assignee": null, "due": null, "quote": null, "candidates": null}],
  "summary": "A Markdown summary of the transcription",
  "keyPoints": ["key point 1", "key point 2"]
}

{focus} {outputFormat}

Transcription:
{transcription}

Before returning the JSON, build actionItems from the entire transcription independently of the minutes. Revisit each speaker's turns in the beginning, middle and end. Retain every distinct deliverable they promise, request and accept, or explicitly undertake to investigate or decide, including brief side commitments and work awaiting an agreed prerequisite. Do not select only the main follow-ups. Fold only steps of the same deliverable for the same doer. Check that every owner, deadline and verbatim quote belongs to that task.`,
            "cs-CZ": `Nejprve z tohoto zvukového přepisu vyberte všechny doložené úkoly, poté jej shrňte a vyberte hlavní body. Seznam úkolů dokončete před psaním zápisu; pokud přepis neobsahuje závazky, vraťte prázdné pole actionItems.

Odpovězte jediným objektem JSON a ničím jiným. Nevkládejte jej do bloku kódu.
{
  "actionItems": [{"text": "Doložený úkol", "speaker": null, "assignee": null, "due": null, "quote": null, "candidates": null}],
  "summary": "Shrnutí přepisu ve formátu Markdown",
  "keyPoints": ["hlavní bod 1", "hlavní bod 2"]
}

{focus} {outputFormat}

Přepis:
{transcription}

Před vrácením JSON sestavte actionItems z celého přepisu nezávisle na zápisu. Znovu projděte promluvy každého mluvčího na začátku, uprostřed i na konci. Zachovejte každý odlišný výsledek, který někdo přislíbil, přijal jako požadavek nebo se zavázal prověřit či rozhodnout, včetně krátkých vedlejších závazků a práce čekající na dohodnutý předpoklad. Nevybírejte jen hlavní navazující kroky. Slučte pouze kroky téhož výsledku u stejného vykonavatele. Ověřte, že každý vlastník, termín i doslovná citace patří právě k danému úkolu.`,
        },
        focus: {
            en: "Match the summary to the recording.",
            "cs-CZ": "Přizpůsobte shrnutí dané nahrávce.",
        },
        outputFormat: {
            en: `For a meeting or multi-person working discussion beyond a few minutes, write proper minutes: thematic "###" sections named after the actual topics in the output language, each with 2–6 concrete bullets. Every section body must be a bullet list, not prose paragraphs. The first section states the subject, purpose, and parties, organizations and roles explicitly mentioned. Within each topic, explain the current state, proposed solutions and variants (who proposed what), agreements, open questions and risks. Use sub-bullets for parts of a variant. Preserve concrete numbers, limits, sizes, named systems, standards, terms and dates. Include the schedule and dependencies when discussed. A 35-minute working meeting usually needs about 350–700 words in "summary"; scale detail to the content, without padding or inventing facts. Even a meeting focused on one topic needs this detail, not one paragraph.

A short or single-topic recording that is not such a meeting gets one tight paragraph. A long monologue or lecture gets topic sections. Put decisions and agreements in keyPoints, one line each; tasks belong in actionItems. Do not copy those lists into the summary; explain their context and consequences within the relevant topic.

If there are no key points or action items, return empty arrays.`,
            "cs-CZ": `U schůzky nebo pracovní diskuse více lidí delší než několik minut vytvořte podrobný zápis: tematické oddíly s nadpisy úrovně „###“ pojmenované podle skutečně probíraných témat v jazyce výstupu, v každém 2–6 konkrétních odrážek. Obsah každého oddílu musí tvořit odrážky, nikoli souvislé odstavce. První oddíl uvede předmět, účel a výslovně zmíněné strany, organizace a role. U každého tématu popište současný stav, navržená řešení a varianty (kdo co navrhl), dohody, otevřené otázky a rizika. Části variant rozveďte v pododrážkách. Zachovejte konkrétní čísla, limity, velikosti, názvy systémů, standardy, pojmy a data. Pokud zazněl harmonogram a návaznosti, zahrňte je. Pracovní schůzka trvající 35 minut obvykle vyžaduje přibližně 350–700 slov v poli summary; rozsah přizpůsobte obsahu, bez výplně a vymyšlených faktů. I schůzka zaměřená na jedno téma potřebuje tuto podrobnost, nikoli jediný odstavec.

Krátkou nahrávku nebo nahrávku s jediným tématem, která není takovou schůzkou, shrňte jedním výstižným odstavcem. Dlouhý monolog nebo přednášku rozdělte do tematických oddílů. Rozhodnutí a dohody patří do keyPoints, každé na jeden řádek; úkoly patří do actionItems. Tyto seznamy do shrnutí nekopírujte; u příslušného tématu vysvětlete jejich souvislosti a důsledky.

Pokud nejsou žádné hlavní body nebo úkoly, vraťte prázdná pole.`,
        },
    },
    "meeting-notes": {
        skeleton: {
            en: `First extract every supported action item from this meeting, then write the minutes with the mentioned parties and decisions. Complete the task inventory before writing the minutes.

Respond with a single JSON object and nothing else. Do not wrap it in code fences.
{
  "actionItems": [{"text": "A supported task", "speaker": null, "assignee": null, "due": null, "quote": null, "candidates": null}],
  "summary": "A Markdown summary of the meeting",
  "keyPoints": ["decision 1", "decision 2", "agreement"]
}

{outputFormatBlock}{focusBlock}If there are no key points or action items, return empty arrays.

Transcription:
{transcription}

Before returning the JSON, build actionItems from the entire transcription independently of the minutes. Revisit each speaker's turns in the beginning, middle and end. Retain every distinct deliverable they promise, request and accept, or explicitly undertake to investigate or decide, including brief side commitments and work awaiting an agreed prerequisite. Do not select only the main follow-ups. Fold only steps of the same deliverable for the same doer. Check that every owner, deadline and verbatim quote belongs to that task.`,
            "cs-CZ": `Nejprve z této schůzky vyberte všechny doložené úkoly, poté napište zápis se zmíněnými stranami a rozhodnutími. Seznam úkolů dokončete před psaním zápisu.

Odpovězte jediným objektem JSON a ničím jiným. Nevkládejte jej do bloku kódu.
{
  "actionItems": [{"text": "Doložený úkol", "speaker": null, "assignee": null, "due": null, "quote": null, "candidates": null}],
  "summary": "Shrnutí schůzky ve formátu Markdown",
  "keyPoints": ["rozhodnutí 1", "rozhodnutí 2", "dohoda"]
}

{outputFormatBlock}{focusBlock}Pokud nejsou žádné hlavní body nebo úkoly, vraťte prázdná pole.

Přepis:
{transcription}

Před vrácením JSON sestavte actionItems z celého přepisu nezávisle na zápisu. Znovu projděte promluvy každého mluvčího na začátku, uprostřed i na konci. Zachovejte každý odlišný výsledek, který někdo přislíbil, přijal jako požadavek nebo se zavázal prověřit či rozhodnout, včetně krátkých vedlejších závazků a práce čekající na dohodnutý předpoklad. Nevybírejte jen hlavní navazující kroky. Slučte pouze kroky téhož výsledku u stejného vykonavatele. Ověřte, že každý vlastník, termín i doslovná citace patří právě k danému úkolu.`,
        },
        focus: {
            en: "Preserve the substance of the whole meeting: concrete facts, reasoning, variants and their proponents, agreements, dependencies and unresolved risks. keyPoints contains decisions and agreements, one line each; actionItems contains tasks. Explain their context in the relevant topic without copying either list into the summary.",
            "cs-CZ":
                "Zachovejte věcný obsah celé schůzky: konkrétní fakta, důvody, varianty a jejich navrhovatele, dohody, návaznosti a nevyřešená rizika. Pole keyPoints obsahuje rozhodnutí a dohody, každé na jeden řádek; actionItems obsahuje úkoly. U příslušného tématu vysvětlete jejich souvislosti, aniž byste některý z těchto seznamů kopírovali do shrnutí.",
        },
        outputFormat: {
            en: 'Write proper minutes as thematic "###" sections named after the actual topics in the output language, not a fixed list of generic headings. The first section states the subject, purpose, and parties, organizations and roles explicitly mentioned. Every section body must be a bullet list, not prose paragraphs. Give each section 2–6 concrete bullets covering the current state, proposed solutions and variants (who proposed what), agreements, open questions and risks within that topic. Use sub-bullets for parts of a variant. Preserve numbers, limits, sizes, named systems, standards, terms and dates. Include the schedule, timing estimates and dependencies when discussed, distinguishing targets from firm deadlines. A 35-minute working meeting usually needs about 350–700 words in "summary"; scale detail to the content, without padding or inventing facts. Omit unsupported sections.',
            "cs-CZ":
                "Vytvořte podrobný zápis s tematickými oddíly a nadpisy úrovně „###“ pojmenovanými podle skutečně probíraných témat v jazyce výstupu, nikoli podle pevného seznamu obecných nadpisů. První oddíl uvede předmět, účel a výslovně zmíněné strany, organizace a role. Obsah každého oddílu musí tvořit odrážky, nikoli souvislé odstavce. Každý oddíl má 2–6 konkrétních odrážek se současným stavem, navrženými řešeními a variantami (kdo co navrhl), dohodami, otevřenými otázkami a riziky daného tématu. Části variant rozveďte v pododrážkách. Zachovejte čísla, limity, velikosti, názvy systémů, standardy, pojmy a data. Pokud zazněl harmonogram, časové odhady a návaznosti, zahrňte je a odlište cílové termíny od pevných lhůt. Pracovní schůzka trvající 35 minut obvykle vyžaduje přibližně 350–700 slov v poli summary; rozsah přizpůsobte obsahu, bez výplně a vymyšlených faktů. Oddíly bez opory v přepisu vynechte.",
        },
    },
    "key-points": {
        skeleton: {
            en: `Extract the key points from this transcription. {focus}

Respond with a single JSON object and nothing else. Do not wrap it in code fences.
{
  "summary": "A brief one-sentence overview of the transcription",
  "keyPoints": ["key point 1", "key point 2", "key point 3"],
  "actionItems": []
}

{outputFormatBlock}Transcription:
{transcription}`,
            "cs-CZ": `Vyberte z tohoto přepisu hlavní body. {focus}

Odpovězte jediným objektem JSON a ničím jiným. Nevkládejte jej do bloku kódu.
{
  "summary": "Stručný přehled přepisu v jedné větě",
  "keyPoints": ["hlavní bod 1", "hlavní bod 2", "hlavní bod 3"],
  "actionItems": []
}

{outputFormatBlock}Přepis:
{transcription}`,
        },
        focus: {
            en: "Focus on the most important information, facts, and insights.",
            "cs-CZ":
                "Zaměřte se na nejdůležitější informace, fakta a poznatky.",
        },
        outputFormat: { en: "", "cs-CZ": "" },
    },
    "action-items": {
        skeleton: {
            en: `Extract all action items, tasks, and follow-ups mentioned in this transcription. {focus}

Respond with a single JSON object and nothing else. Do not wrap it in code fences.
{
  "summary": "A brief overview of what was discussed",
  "keyPoints": [],
  "actionItems": ["action item 1 (owner if known)", "task 2", "follow-up 3"]
}

{outputFormatBlock}Transcription:
{transcription}`,
            "cs-CZ": `Vyberte všechny akční body, úkoly a navazující kroky zmíněné v tomto přepisu. {focus}

Odpovězte jediným objektem JSON a ničím jiným. Nevkládejte jej do bloku kódu.
{
  "summary": "Stručný přehled probíraného obsahu",
  "keyPoints": [],
  "actionItems": ["úkol 1 (odpovědná osoba, pokud je známa)", "úkol 2", "navazující krok 3"]
}

{outputFormatBlock}Přepis:
{transcription}`,
        },
        focus: {
            en: "Include who is responsible if mentioned.",
            "cs-CZ": "Uveďte odpovědnou osobu, pokud byla zmíněna.",
        },
        outputFormat: {
            en: "If there are no action items, return an empty array but still provide a summary.",
            "cs-CZ":
                "Pokud nejsou žádné úkoly, vraťte prázdné pole, ale přesto uveďte shrnutí.",
        },
    },
};

/** Summary templates are the shared prompt-template model. */
export type SummaryPromptConfiguration = TemplateConfiguration;

export const SUMMARY_PRESETS: Record<SummaryPreset, SummaryPromptConfig> = {
    general: {
        id: "general",
        name: "General Summary",
        description: "Concise summary of any audio transcription",
        prompt: assembleSummaryPrompt(SUMMARY_PROMPT_PARTS.general, "en"),
    },
    "meeting-notes": {
        id: "meeting-notes",
        name: "Meeting Notes",
        description:
            "Structured meeting summary with attendees, decisions, and action items",
        prompt: assembleSummaryPrompt(
            SUMMARY_PROMPT_PARTS["meeting-notes"],
            "en",
        ),
    },
    "key-points": {
        id: "key-points",
        name: "Key Points",
        description: "Extract the key points as a bullet list",
        prompt: assembleSummaryPrompt(SUMMARY_PROMPT_PARTS["key-points"], "en"),
    },
    "action-items": {
        id: "action-items",
        name: "Action Items",
        description:
            "Extract all action items, tasks, and follow-ups mentioned",
        prompt: assembleSummaryPrompt(
            SUMMARY_PROMPT_PARTS["action-items"],
            "en",
        ),
    },
};

/** Use a localized built-in only when the user has not edited its text. */
export function localizedSummaryPrompt(
    id: string,
    prompt: string,
    language: string | null,
    isUneditedBuiltIn: boolean,
): string {
    if (!isUneditedBuiltIn || (id !== "general" && id !== "meeting-notes")) {
        return prompt;
    }
    const locale =
        language?.toLowerCase().split(/[-_]/)[0] === "cs" ? "cs-CZ" : "en";
    return assembleSummaryPrompt(SUMMARY_PROMPT_PARTS[id], locale);
}

export const SUMMARY_TEMPLATE_KIND: TemplateKind<SummaryPreset> = {
    presets: SUMMARY_PRESETS,
    fallbackId: "general",
};

export function getDefaultSummaryPromptConfig(): SummaryPromptConfiguration {
    return defaultTemplateConfig(SUMMARY_TEMPLATE_KIND);
}

/** Read a stored (decrypted) `summaryPrompt` value; see normalizeTemplateConfig. */
export function normalizeSummaryPromptConfig(
    raw: unknown,
): SummaryPromptConfiguration {
    return normalizeTemplateConfig(raw, SUMMARY_TEMPLATE_KIND);
}

export interface AiOutputLanguageOption {
    code: string;
    label: string;
}

export const AI_OUTPUT_LANGUAGES: readonly AiOutputLanguageOption[] = [
    { code: "auto", label: "Auto (match transcript)" },
    { code: "en", label: "English" },
    { code: "es", label: "Spanish" },
    { code: "fr", label: "French" },
    { code: "de", label: "German" },
    { code: "it", label: "Italian" },
    { code: "pt", label: "Portuguese" },
    { code: "nl", label: "Dutch" },
    { code: "pl", label: "Polish" },
    { code: "ru", label: "Russian" },
    { code: "tr", label: "Turkish" },
    { code: "uk", label: "Ukrainian" },
    { code: "cs", label: "Czech" },
    { code: "sk", label: "Slovak" },
    { code: "sv", label: "Swedish" },
    { code: "da", label: "Danish" },
    { code: "no", label: "Norwegian" },
    { code: "fi", label: "Finnish" },
    { code: "el", label: "Greek" },
    { code: "ro", label: "Romanian" },
    { code: "hu", label: "Hungarian" },
    { code: "ja", label: "Japanese" },
    { code: "zh", label: "Chinese (Simplified)" },
    { code: "ko", label: "Korean" },
    { code: "ar", label: "Arabic" },
    { code: "he", label: "Hebrew" },
    { code: "hi", label: "Hindi" },
    { code: "id", label: "Indonesian" },
    { code: "vi", label: "Vietnamese" },
    { code: "th", label: "Thai" },
] as const;

const LANGUAGE_CODES = new Set(AI_OUTPUT_LANGUAGES.map((l) => l.code));

export const DETECTED_LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
    eng: "en",
    spa: "es",
    fra: "fr",
    fre: "fr",
    deu: "de",
    ger: "de",
    ita: "it",
    por: "pt",
    nld: "nl",
    dut: "nl",
    pol: "pl",
    rus: "ru",
    tur: "tr",
    ukr: "uk",
    ces: "cs",
    cze: "cs",
    slk: "sk",
    slo: "sk",
    swe: "sv",
    dan: "da",
    nor: "no",
    fin: "fi",
    ell: "el",
    gre: "el",
    ron: "ro",
    rum: "ro",
    hun: "hu",
    jpn: "ja",
    zho: "zh",
    chi: "zh",
    kor: "ko",
    ara: "ar",
    heb: "he",
    hin: "hi",
    ind: "id",
    vie: "vi",
    tha: "th",
};

/** Return a chosen output language, or null when the model should follow the text. */
export function explicitAiOutputLanguage(
    preference: string | null | undefined,
): string | null {
    return preference === "auto" ? null : normalizeAiOutputLanguage(preference);
}

/** Resolve an explicit output preference or a recognized transcription language. */
export function resolveAiOutputLanguage(
    preference: string | null | undefined,
    detectedLanguage: string | null | undefined,
): string | null {
    if (preference && preference !== "auto") {
        return normalizeAiOutputLanguage(preference);
    }
    const detected = detectedLanguage?.trim().toLowerCase().split(/[-_]/)[0];
    if (!detected) return null;
    if (LANGUAGE_CODES.has(detected)) return detected;
    const alias = DETECTED_LANGUAGE_ALIASES[detected];
    if (alias && LANGUAGE_CODES.has(alias)) return alias;
    return (
        AI_OUTPUT_LANGUAGES.find(
            (language) => language.label.toLowerCase() === detected,
        )?.code ?? null
    );
}

/** Validate against `AI_OUTPUT_LANGUAGES`; returns the code or null. */
export function normalizeAiOutputLanguage(value: unknown): string | null {
    if (typeof value !== "string") return null;
    return LANGUAGE_CODES.has(value) ? value : null;
}

/**
 * What the model reads to find the language under `auto`: the transcription
 * itself, or -- for the multi-pass merge, which never sees the transcription
 * -- the extractions produced from it.
 */
export type LanguageSource = "transcription" | "extractions";

/**
 * Directive for the model's output language.
 *
 * `auto` (and a missing or unknown code) gets a directive too, not silence:
 * every prompt is written in English, and a model left to itself answers a
 * Czech transcript in English, or in Czech under the English "###" headings
 * the preset named. A chosen language has the same heading problem, so both
 * share the rules after the first sentence. The speaker placeholders are
 * exempted by name because `speaker-references.ts` resolves only the English
 * `[Speaker N]` form.
 */
export function getAiOutputLanguageDirective(
    code: string | null | undefined,
    source: LanguageSource = "transcription",
): string {
    const match =
        code && code !== "auto"
            ? AI_OUTPUT_LANGUAGES.find((l) => l.code === code)
            : undefined;
    const rules =
        "That includes every heading, label, and example wording these instructions give in English: write it in that language rather than copying it. Keep names and technical terms as they were spoken. Keep any JSON keys in English exactly as specified, and keep speaker references such as [Speaker 1](#speaker-1) exactly as written.";
    if (match) {
        return `IMPORTANT: Write all natural-language output in ${match.label}, regardless of the transcription's language. ${rules}`;
    }
    const target =
        source === "extractions"
            ? "the language the extractions are written in, which is the language of the transcription they came from"
            : "the language the transcription is predominantly spoken in";
    return `IMPORTANT: Write all natural-language output in ${target}, even though these instructions are written in English. ${rules} Follow a different output language only if the user's instructions explicitly ask for one.`;
}

/**
 * Appended to every summary prompt, including custom ones.
 *
 * Carries the rules that hold regardless of which prompt asked for the
 * summary, so the presets do not restate them and a prompt the user wrote
 * gets them too. A user-written prompt is in fact the one most likely to
 * still carry the old "no markdown" wording, which models read as applying to
 * the prose and not just to the envelope.
 */
export const SUMMARY_MARKDOWN_DIRECTIVE = `FORMATTING: the "summary" value is rendered as Markdown.

- Match structure and detail to the content and the requested format. Working meetings beyond a few minutes need thematic "###" sections and concrete bullets, including meetings about one main topic. Long monologues or lectures can use topic sections; a short recording can use one plain paragraph. Preserve the substance rather than compressing a long meeting into an overview. Never invent content to fill a section, and never open a heading above level 3.
- Do not restate the key points or action items as a list inside "summary". They are rendered as their own lists directly beneath it, so a copy there is read twice. Explain their context, reasoning and consequences within the relevant topic without copying the list entries.
- Key points and action items are rendered as Markdown as well, but each is already one entry in a list, so keep each to a single line and do not give it a bullet marker of its own.
- The reply itself is still one raw JSON object: escape newlines inside strings as \\n, and do not wrap the object in code fences.`;

/** Stable speaker references that can be projected after attribution. */
export const SUMMARY_SPEAKER_DIRECTIVE = `SPEAKER REFERENCES:

- Never infer, guess, or invent a speaker's name, identity, or role from context. Do not replace an anonymous speaker label even when the identity seems obvious.
- Whenever referring to transcript label speaker_N, write exactly [Speaker N](#speaker-N), using the same number. Apply this in summary, keyPoints, and actionItems.
- Preserve these Markdown references exactly during rewriting or merging. They are stable placeholders that the app resolves only after the user confirms an attribution.`;

/** Validate an untrusted `summaryPrompt` payload; see isValidTemplateConfig. */
export function isValidSummaryPromptConfig(value: unknown): boolean {
    return isValidTemplateConfig(value, SUMMARY_TEMPLATE_KIND);
}
