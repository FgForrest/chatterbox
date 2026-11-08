import {
    sentencesOf,
    validSentenceStarts,
} from "@/lib/transcription/sentences";

/**
 * One speaker's uninterrupted turn, as returned by a diarizing provider.
 *
 * `speaker` is the raw provider label (`speaker_0`, `S1`). It is identity,
 * never display: knowledge-base names are applied on top of it at render
 * time and the stored value never changes.
 */
export interface TranscriptTurn {
    speaker: string;
    /** Milliseconds from the start of the recording audio, once normalized here. */
    startMs: number;
    /** Milliseconds from the start of the recording audio, once normalized here. */
    endMs: number;
    text: string;
    /** Absolute audio milliseconds, aligned with `sentencesOf(text)`. */
    sentenceStartsMs?: number[];
}

/** Resolves a raw speaker label to a display name, or null to keep the label. */
export type SpeakerNameResolver = (speaker: string) => string | null;

/** A transient timed unit with UTF-16 offsets into its segment text. */
export interface TimedTextUnit {
    charStart: number;
    charEnd: number;
    startMs: number;
    endMs: number;
    word?: boolean;
}

/** A provider segment before consecutive same-speaker runs are merged. */
export interface LabelledSegment {
    speaker: string;
    startMs: number;
    endMs: number;
    text: string;
    units?: readonly TimedTextUnit[];
}

/**
 * Render turns as the flat `speaker: text` transcript Riffado stores and
 * displays.
 *
 * The resolver is the single seam through which knowledge-base names reach
 * any output, so stored transcript text is never rewritten to apply a name.
 */
export function renderTurnsAsText(
    turns: readonly TranscriptTurn[],
    resolve?: SpeakerNameResolver,
): string {
    const lines: string[] = [];

    for (const turn of turns) {
        const body = turn.text.trim();
        if (!body) continue;
        if (!turn.speaker) {
            lines.push(body);
            continue;
        }
        lines.push(`${resolve?.(turn.speaker) ?? turn.speaker}: ${body}`);
    }

    return lines.join("\n");
}

/**
 * Merge provider segments into turns, joining consecutive runs by the same
 * speaker and widening each turn's span to cover the segments it absorbed.
 *
 * Returns null when nothing usable survives, so a caller can fall back to
 * an undiarized transcript rather than storing an empty turn list that
 * would render as a dialog with no participants.
 */
export function turnsFromLabelledSegments(
    segments: readonly LabelledSegment[],
): TranscriptTurn[] | null {
    const turns: TranscriptTurn[] = [];
    const units: TimedTextUnit[][] = [];

    for (const segment of segments) {
        const text = segment.text.trim();
        if (!text) continue;

        const previous = turns.at(-1);
        if (previous && previous.speaker === segment.speaker) {
            units.at(-1)?.push(...unitsOf(segment, previous.text.length + 1));
            previous.text = `${previous.text} ${text}`;
            previous.endMs = Math.max(previous.endMs, segment.endMs);
            continue;
        }

        units.push(unitsOf(segment));
        turns.push({
            speaker: segment.speaker,
            startMs: segment.startMs,
            endMs: segment.endMs,
            text,
        });
    }

    return turns.length > 0
        ? turns.map((turn, index) => withSentenceTiming(turn, units[index]))
        : null;
}

/** A pause at least this long starts a new paragraph. */
const PARAGRAPH_PAUSE_MS = 1500;
/** Past this length a paragraph ends at the next sentence end. */
const PARAGRAPH_SOFT_MAX_MS = 30_000;
/** Past this length a paragraph ends even mid-sentence. */
const PARAGRAPH_HARD_MAX_MS = 60_000;

const SENTENCE_END = /[.!?…]["'”»)\]]*$/;

/**
 * Group an undiarized provider's timed segments into speakerless turns, one
 * per paragraph.
 *
 * Whisper-style segments are a sentence or two each: stored as they come,
 * they read as a column of fragments, and a topic or a seek could only land
 * on the whole transcript if they were merged into one. So consecutive
 * segments join until a pause, or until the paragraph has grown long enough
 * to end at the next sentence. `turnsFromLabelledSegments` cannot do this:
 * every segment here carries the same empty label, and it would merge them
 * all into a single turn.
 *
 * Returns null when nothing usable survives, like `turnsFromLabelledSegments`.
 */
export function paragraphsFromTimedSegments(
    segments: readonly Omit<LabelledSegment, "speaker">[],
): TranscriptTurn[] | null {
    const paragraphs: TranscriptTurn[] = [];
    const units: TimedTextUnit[][] = [];

    for (const segment of segments) {
        const text = segment.text.trim();
        if (!text) continue;

        const previous = paragraphs.at(-1);
        if (previous) {
            const length = previous.endMs - previous.startMs;
            const endsParagraph =
                segment.startMs - previous.endMs >= PARAGRAPH_PAUSE_MS ||
                length >= PARAGRAPH_HARD_MAX_MS ||
                (length >= PARAGRAPH_SOFT_MAX_MS &&
                    SENTENCE_END.test(previous.text));
            if (!endsParagraph) {
                units
                    .at(-1)
                    ?.push(...unitsOf(segment, previous.text.length + 1));
                previous.text = `${previous.text} ${text}`;
                previous.endMs = Math.max(previous.endMs, segment.endMs);
                continue;
            }
        }

        units.push(unitsOf(segment));
        paragraphs.push({
            speaker: "",
            startMs: segment.startMs,
            endMs: segment.endMs,
            text,
        });
    }

    return paragraphs.length > 0
        ? paragraphs.map((turn, index) =>
              withSentenceTiming(turn, units[index]),
          )
        : null;
}

function unitsOf(
    segment: Omit<LabelledSegment, "speaker">,
    offset = 0,
): TimedTextUnit[] {
    return trimTimedText(
        segment.text,
        segment.units ?? [
            {
                charStart: 0,
                charEnd: segment.text.length,
                startMs: segment.startMs,
                endMs: segment.endMs,
            },
        ],
    ).units.map((unit) => ({
        ...unit,
        charStart: unit.charStart + offset,
        charEnd: unit.charEnd + offset,
    }));
}

/** Trim text and clip timed bounds to its surviving non-whitespace characters. */
export function trimTimedText(
    text: string,
    units: readonly TimedTextUnit[],
): { text: string; units: TimedTextUnit[] } {
    const leading = text.length - text.trimStart().length;
    const end = text.trimEnd().length;
    return {
        text: text.trim(),
        units: units.flatMap((unit) => {
            let start = Math.max(leading, unit.charStart);
            let stop = Math.min(end, unit.charEnd);
            if (unit.word) {
                const body = text.slice(start, stop);
                start += body.length - body.trimStart().length;
                stop -= body.length - body.trimEnd().length;
            }
            return stop > start
                ? [
                      {
                          ...unit,
                          charStart: start - leading,
                          charEnd: stop - leading,
                      },
                  ]
                : [];
        }),
    };
}

/** Derive sentence starts while the provider's finer timed units still exist. */
export function withSentenceTiming(
    turn: TranscriptTurn,
    rawUnits: readonly TimedTextUnit[],
): TranscriptTurn {
    if (
        !Number.isFinite(turn.startMs) ||
        !Number.isFinite(turn.endMs) ||
        turn.endMs < turn.startMs
    )
        return turn;
    const units = rawUnits.filter(
        (unit) =>
            Number.isFinite(unit.startMs) &&
            Number.isFinite(unit.endMs) &&
            unit.endMs >= unit.startMs &&
            unit.charEnd > unit.charStart,
    );
    const only = units[0];
    if (
        !only ||
        (units.length === 1 &&
            (!only.word ||
                (only.startMs === turn.startMs && only.endMs === turn.endMs)))
    )
        return turn;
    let previous = turn.startMs;
    let unitIndex = 0;
    const sentences = sentencesOf(turn.text);
    const sentenceStartsMs: number[] = [];
    for (const [index, { at }] of sentences.entries()) {
        while (
            unitIndex < units.length &&
            (units[unitIndex].charEnd <= at ||
                (units[unitIndex].word && units[unitIndex].charStart < at))
        )
            unitIndex++;
        const unit = units[unitIndex];
        const sentenceEnd = sentences[index + 1]?.at ?? turn.text.length;
        if (
            !unit ||
            (unit.word ? unit.charStart >= sentenceEnd : unit.charStart > at)
        )
            return turn;
        const fraction =
            unit.word || at <= unit.charStart
                ? 0
                : Math.min(
                      1,
                      (at - unit.charStart) /
                          Math.max(1, unit.charEnd - unit.charStart),
                  );
        const ms =
            unit.startMs + Math.round(fraction * (unit.endMs - unit.startMs));
        previous = Math.max(previous, Math.min(turn.endMs, ms));
        sentenceStartsMs.push(previous);
    }
    return { ...turn, sentenceStartsMs };
}

/** Replace text, retaining sentence times only when the sentence count stays aligned. */
export function withTurnText<T extends TranscriptTurn>(
    turn: T,
    text: string,
): T {
    const { sentenceStartsMs, ...rest } = turn;
    const kept =
        sentencesOf(turn.text).length === sentencesOf(text).length
            ? validSentenceStarts(text, sentenceStartsMs)
            : undefined;
    return { ...rest, text, ...(kept ? { sentenceStartsMs: kept } : {}) } as T;
}

/** Discard malformed optional timing without refusing an otherwise readable turn. */
export function sanitizeTurnTiming(
    turn: Omit<TranscriptTurn, "sentenceStartsMs"> & {
        sentenceStartsMs?: unknown;
    },
): TranscriptTurn {
    const { sentenceStartsMs, ...rest } = turn;
    const kept = validSentenceStarts(turn.text, sentenceStartsMs);
    return { ...rest, ...(kept ? { sentenceStartsMs: kept } : {}) };
}

/** Align timed words to provider text without persisting the word array. */
export function timedWordsInText(
    text: string,
    words: readonly { text: string; startMs: number; endMs: number }[],
): TimedTextUnit[] | undefined {
    const units: TimedTextUnit[] = [];
    let at = 0;
    for (const word of words) {
        const body = word.text.trim();
        if (
            !body ||
            !Number.isFinite(word.startMs) ||
            !Number.isFinite(word.endMs) ||
            word.endMs < word.startMs
        )
            return undefined;
        const charStart = text.indexOf(body, at);
        if (charStart < 0 || !/^[\s\p{P}]*$/u.test(text.slice(at, charStart)))
            return undefined;
        at = charStart + body.length;
        units.push({
            charStart,
            charEnd: at,
            startMs: word.startMs,
            endMs: word.endMs,
            word: true,
        });
    }
    return units.length > 0 && /^[\s\p{P}]*$/u.test(text.slice(at))
        ? units
        : undefined;
}
