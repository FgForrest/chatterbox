/**
 * Where in the audio a task was agreed: the turn its quote came from.
 * Pure. Models copy quotes loosely, so a turn holding most of the quote's
 * words counts when none holds it whole.
 */

import { stemmingLanguage, stemVariants } from "@/lib/knowledge/stemming";

interface QuoteTurn {
    startMs: number;
    text: string;
}

function words(text: string): string[] {
    return text
        .toLocaleLowerCase()
        .normalize("NFC")
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean);
}

function locatorWords(text: string): string[] {
    return text
        .toLocaleLowerCase()
        .normalize("NFKD")
        .replace(/\p{M}+/gu, "")
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean);
}

function locatorStems(
    word: string,
    language: string | null,
): readonly string[] {
    return stemVariants(word, language);
}

/** Below this share of the quote's words in one turn, the quote is not placed. */
const MIN_OVERLAP = 0.6;

/** The start of the turn a quote was taken from, or null when none fits. */
export function locateQuote(
    turns: readonly QuoteTurn[] | null | undefined,
    quote: string | null | undefined,
    language?: string | null,
): number | null {
    if (!turns?.length || !quote) return null;
    const wanted = locatorWords(quote);
    if (wanted.length === 0) return null;
    const stemmer = stemmingLanguage(language);
    const phrase = wanted.join(" ");
    let best: { startMs: number; share: number } | null = null;
    for (const turn of turns) {
        const turnWords = locatorWords(turn.text);
        if (turnWords.join(" ").includes(phrase)) return turn.startMs;
        const present = new Set(
            turnWords.flatMap((word) => locatorStems(word, stemmer)),
        );
        const share =
            wanted.filter((word) =>
                locatorStems(word, stemmer).some((stem) => present.has(stem)),
            ).length / wanted.length;
        if (share >= MIN_OVERLAP && (!best || share > best.share)) {
            best = { startMs: turn.startMs, share };
        }
    }
    return best?.startMs ?? null;
}

interface QuoteSegment {
    index: number;
    text: string;
}

/** A located quote: the segment and the range of its text. */
export interface TextQuoteRange {
    segmentIndex: number;
    charStart: number;
    charEnd: number;
}

function positionedWords(
    text: string,
): { word: string; start: number; end: number }[] {
    return [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => ({
        word:
            locatorWords(match[0])[0] ??
            match[0].toLocaleLowerCase().normalize("NFC"),
        start: match.index ?? 0,
        end: (match.index ?? 0) + match[0].length,
    }));
}

/**
 * Where in a mail's text a quote was copied from: the segment and the
 * range from its first to its last word there. The quote whole, word for
 * word, wins; else the segment holding most of its words.
 */
export function locateTextQuote(
    segments: readonly QuoteSegment[] | null | undefined,
    quote: string | null | undefined,
    language?: string | null,
): TextQuoteRange | null {
    if (!segments?.length || !quote) return null;
    const wanted = locatorWords(quote);
    if (wanted.length === 0) return null;
    const stemmer = stemmingLanguage(language);
    let best: (TextQuoteRange & { share: number }) | null = null;
    for (const segment of segments) {
        const found = positionedWords(segment.text);
        for (let i = 0; i + wanted.length <= found.length; i++) {
            if (wanted.every((word, j) => found[i + j]?.word === word)) {
                return {
                    segmentIndex: segment.index,
                    charStart: found[i]?.start ?? 0,
                    charEnd: found[i + wanted.length - 1]?.end ?? 0,
                };
            }
        }
        const wantedStems = wanted.map((word) => locatorStems(word, stemmer));
        const hits = found.filter((entry) => {
            const stems = new Set(locatorStems(entry.word, stemmer));
            return wantedStems.some((variants) =>
                variants.some((stem) => stems.has(stem)),
            );
        });
        const share =
            wantedStems.filter((variants) =>
                hits.some((hit) => {
                    const stems = new Set(locatorStems(hit.word, stemmer));
                    return variants.some((stem) => stems.has(stem));
                }),
            ).length / wanted.length;
        const [first] = hits;
        const last = hits.at(-1);
        if (
            first &&
            last &&
            share >= MIN_OVERLAP &&
            (!best || share > best.share)
        ) {
            best = {
                segmentIndex: segment.index,
                charStart: first.start,
                charEnd: last.end,
                share,
            };
        }
    }
    if (!best) return null;
    const { share: _share, ...range } = best;
    return range;
}

/**
 * A task's text as compared for "the same task": case, punctuation, speaker
 * references and spacing folded away.
 */
export function normalizeTaskText(text: string): string {
    return words(
        text.replace(/\[Speaker (\d+)\]\(#speaker-\1\)/g, "speaker $1"),
    ).join(" ");
}
