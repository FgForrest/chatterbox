import { speakerKey } from "@/lib/knowledge/speaker-label-rules";
import type { SpeakerNameResolver } from "@/lib/transcription/turns";

export interface SpeakerAttribution {
    personId: string;
    name: string;
}

export type SpeakerAttributions = Readonly<Record<string, SpeakerAttribution>>;

const SUMMARY_SPEAKER_REFERENCE =
    /\[Speaker ([0-9]+)\]\(#speaker-\1\)|\bSpeaker ([0-9]+)\b/g;
const NUMBERED_SPEAKER = /^speaker[_ -]([0-9]+)$/i;
const SPEAKER_LINK_TARGET = /\]\(#speaker-([0-9]+)\)/g;

/** Stable fragment id used by summary placeholders and transcript speaker tags. */
export function speakerAnchorId(speaker: string): string {
    const numbered = NUMBERED_SPEAKER.exec(speaker.trim());
    if (numbered) return `speaker-${numbered[1]}`;
    const slug = speaker
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    return `speaker-${slug || "unknown"}`;
}

/**
 * Detect an LLM summary that shifted a zero-based transcript to one-based
 * placeholders (`Speaker 1…N`). The match is deliberately strict: both sides
 * must contain the complete contiguous range, so a summary that merely omits
 * Speaker 0 is not accidentally shifted.
 */
export function inferSummarySpeakerNumberOffset(
    markdown: string,
    transcriptSpeakers: readonly string[],
): number {
    const transcriptNumbers = Array.from(
        new Set(
            transcriptSpeakers.flatMap((speaker) => {
                const match = NUMBERED_SPEAKER.exec(speaker.trim());
                return match ? [Number(match[1])] : [];
            }),
        ),
    ).sort((left, right) => left - right);
    const summaryNumbers = Array.from(
        new Set(
            Array.from(markdown.matchAll(SUMMARY_SPEAKER_REFERENCE)).flatMap(
                (match) => {
                    const value = match[1] ?? match[2];
                    return value === undefined ? [] : [Number(value)];
                },
            ),
        ),
    ).sort((left, right) => left - right);

    const transcriptIsZeroBased =
        transcriptNumbers.length > 0 &&
        transcriptNumbers.every((number, index) => number === index);
    const summaryIsOneBased =
        summaryNumbers.length === transcriptNumbers.length &&
        summaryNumbers.every((number, index) => number === index + 1);
    return transcriptIsZeroBased && summaryIsOneBased ? -1 : 0;
}

/** Apply a previously inferred numeric offset to a raw speaker label. */
export function offsetSpeakerLabel(speaker: string, offset: number): string {
    if (offset === 0) return speaker;
    const match = NUMBERED_SPEAKER.exec(speaker.trim());
    if (!match) return speaker;
    const shifted = Number(match[1]) + offset;
    return shifted >= 0 ? `speaker_${shifted}` : speaker;
}

/** Resolve an exact summary placeholder href back to its raw transcript label. */
export function speakerLabelFromSummaryHref(
    href: string | undefined,
): string | null {
    const match = /^#speaker-([0-9]+)$/.exec(href ?? "");
    return match ? `speaker_${match[1]}` : null;
}

/** Find an attribution across equivalent provider label formats. */
export function resolveSpeakerAttribution(
    attributions: SpeakerAttributions | undefined,
    speaker: string,
): SpeakerAttribution | undefined {
    const direct = attributions?.[speakerKey(speaker)];
    if (direct) return direct;

    const anchor = speakerAnchorId(speaker);
    return Object.entries(attributions ?? {}).find(
        ([label]) => speakerAnchorId(label) === anchor,
    )?.[1];
}

/** Convert speaker labels into stable links, optionally shifting to transcript numbering. */
export function canonicalizeSummarySpeakerReferences(
    markdown: string,
    numberOffset = 0,
): string {
    return markdown.replace(
        SUMMARY_SPEAKER_REFERENCE,
        (
            reference,
            linkedNumber: string | undefined,
            plainNumber: string | undefined,
        ) => {
            const speakerNumber = linkedNumber ?? plainNumber;
            if (!speakerNumber) return reference;
            const shifted = offsetSpeakerLabel(
                `speaker_${speakerNumber}`,
                numberOffset,
            ).slice("speaker_".length);
            return `[Speaker ${shifted}](#speaker-${shifted})`;
        },
    );
}

/**
 * Restore edited speaker links without changing their original numbering or
 * plain names. Link text typed by hand may hold nested or stray brackets.
 */
export function storeEditedSpeakerReferences(markdown: string): string {
    const escaped = new Uint8Array(markdown.length + 1);
    for (let index = 0; index < markdown.length; index++) {
        if (markdown[index] === "\\" && !escaped[index]) escaped[index + 1] = 1;
    }
    let stored = "";
    let floor = 0;
    for (const target of markdown.matchAll(SPEAKER_LINK_TARGET)) {
        const close = target.index;
        if (escaped[close]) continue;
        let balanced = -1;
        let nearest = -1;
        let depth = 0;
        for (let index = close - 1; index >= floor; index--) {
            if (escaped[index]) continue;
            const char = markdown[index];
            if (char === "\n") break;
            if (char === "]") {
                // Another link ends here: never fold it into this one.
                if (markdown[index + 1] === "(") break;
                depth++;
            } else if (char === "[") {
                if (nearest < 0) nearest = index;
                if (depth === 0) {
                    balanced = index;
                    break;
                }
                depth--;
            }
        }
        const open = balanced >= 0 ? balanced : nearest;
        if (open < 0) continue;
        const number = target[1];
        stored += `${markdown.slice(floor, open)}[Speaker ${number}](#speaker-${number})`;
        floor = close + target[0].length;
    }
    return stored + markdown.slice(floor);
}

/** Show attributed names in the editor while retaining portable speaker hrefs. */
export function summarySpeakerReferencesForEditor(
    markdown: string,
    attributions: SpeakerAttributions,
    numberOffset = 0,
): string {
    return markdown.replace(
        /\[Speaker ([0-9]+)\]\(#speaker-\1\)/g,
        (reference, number: string) => {
            const attribution = resolveSpeakerAttribution(
                attributions,
                offsetSpeakerLabel(`speaker_${number}`, numberOffset),
            );
            if (!attribution) return reference;
            const name = attribution.name.replace(/[\\[\]]/g, "\\$&");
            return `[${name}](#speaker-${number})`;
        },
    );
}

/**
 * Project stored speaker references into portable text for disk exports.
 *
 * The stored summary remains untouched. Known speakers become their confirmed
 * names; unknown speakers keep their display labels. Neither keeps a link,
 * because an exported document cannot know the instance's public URL.
 */
export function projectSummarySpeakerReferencesForExport(
    markdown: string,
    resolve?: SpeakerNameResolver,
    speakerNumberOffset = 0,
): string {
    return markdown.replace(
        SUMMARY_SPEAKER_REFERENCE,
        (
            reference,
            linkedNumber: string | undefined,
            plainNumber: string | undefined,
        ) => {
            const speakerNumber = linkedNumber ?? plainNumber;
            if (!speakerNumber) return reference;
            const speaker = offsetSpeakerLabel(
                `speaker_${speakerNumber}`,
                speakerNumberOffset,
            );
            const projectedNumber = speaker.slice("speaker_".length);
            return (
                resolve?.(speaker) ??
                resolve?.(`Speaker ${projectedNumber}`) ??
                resolve?.(`speaker-${projectedNumber}`) ??
                `Speaker ${projectedNumber}`
            );
        },
    );
}

/** Read the numbering captured before a human could remove speaker references. */
export function storedSummarySpeakerNumberOffset(
    inputs: unknown,
): number | null {
    if (
        !inputs ||
        typeof inputs !== "object" ||
        !("speakerNumberOffset" in inputs)
    )
        return null;
    const offset = inputs.speakerNumberOffset;
    return typeof offset === "number" && Number.isSafeInteger(offset)
        ? offset
        : null;
}
