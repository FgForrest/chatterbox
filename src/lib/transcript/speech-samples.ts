import {
    isPlaceholderSpeakerLabel,
    speakerKey,
} from "@/lib/knowledge/speaker-label-rules";
import {
    sentencesOf,
    validSentenceStarts,
} from "@/lib/transcription/sentences";
import type { TranscriptTurn } from "@/lib/transcription/turns";

export const STRETCH_GAP_MS = 1_500;
export const SAMPLE_MIN_DURATION_MS = 6_000;
export const SAMPLE_MIN_WORDS = 12;
export const SAMPLE_MAX_OVERLAP = 0.2;
export const SAMPLE_COUNT = 3;
export const SAMPLE_THIRDS = 3;
export const SAMPLE_RANK_CAP_MS = 20_000;
export const SAMPLE_PRE_ROLL_MS = 300;
export const SAMPLE_PLAY_LIMIT_MS = 12_000;
export const SAMPLE_FALLBACK_MIN_MS = 1_000;
export const SAMPLE_QUOTE_LENGTH = 100;
export const EVIDENCE_PLAY_LIMIT_MS = 15_000;
export const EVIDENCE_QUOTE_LENGTH = 60;

export interface SpeechStretch {
    startMs: number;
    endMs: number;
    text: string;
    words: number;
    overlap: number;
    sentences: string[];
    boundaries: { ms: number; sentenceIndex: number }[];
}

export interface SpeechSample extends SpeechStretch {
    ms: number;
    untilMs: number;
}

export interface SpeakerSamples {
    samples: SpeechSample[];
    fallback: boolean;
    longestTurnMs: number;
    longestStretchMs: number;
}

export interface SpeakingStats {
    durationMs: number;
    replies: number;
}

/** Speaking time and reply counts, kept separately for each transcript label. */
export function speakingStats(
    turns: readonly TranscriptTurn[],
): Map<string, SpeakingStats> {
    const stats = new Map<string, SpeakingStats>();
    for (const turn of turns) {
        if (isPlaceholderSpeakerLabel(turn.speaker)) continue;
        const label = speakerKey(turn.speaker);
        const current = stats.get(label) ?? { durationMs: 0, replies: 0 };
        current.durationMs += Math.max(0, turn.endMs - turn.startMs);
        current.replies++;
        stats.set(label, current);
    }
    return stats;
}

/** Longest-speaking labels first, with numeric label order breaking ties. */
export function compareSpeakingLabels(
    a: string,
    b: string,
    stats: ReadonlyMap<string, SpeakingStats>,
): number {
    const numberA = /\d+$/u.exec(a)?.[0];
    const numberB = /\d+$/u.exec(b)?.[0];
    return (
        (stats.get(speakerKey(b))?.durationMs ?? 0) -
            (stats.get(speakerKey(a))?.durationMs ?? 0) ||
        (numberA !== undefined && numberB !== undefined
            ? Number(numberA) - Number(numberB)
            : 0) ||
        a.localeCompare(b, "en", { numeric: true })
    );
}

function wordCount(text: string): number {
    return text.match(/\S+/gu)?.length ?? 0;
}

function exactSentenceStarts(turn: TranscriptTurn): number[] | undefined {
    const starts = validSentenceStarts(turn.text, turn.sentenceStartsMs);
    return starts?.every((ms) => ms >= turn.startMs && ms <= turn.endMs)
        ? starts
        : undefined;
}

function sentenceParts(
    turn: TranscriptTurn,
): Pick<SpeechStretch, "sentences" | "boundaries"> {
    const starts = exactSentenceStarts(turn);
    return {
        sentences: sentencesOf(turn.text).map((sentence) => sentence.text),
        boundaries:
            starts?.slice(1).map((ms, index) => ({
                ms,
                sentenceIndex: index + 1,
            })) ?? [],
    };
}

function innerBoundaries(stretch: SpeechStretch): SpeechStretch["boundaries"] {
    const inside = stretch.boundaries
        .filter(({ ms }) => ms > stretch.startMs && ms < stretch.endMs)
        .sort((a, b) => a.ms - b.ms || a.sentenceIndex - b.sentenceIndex);
    return [
        ...new Map(inside.map((boundary) => [boundary.ms, boundary])).values(),
    ];
}

/** Consecutive speech joined by short pauses, with union overlap from other labels. */
export function speechStretches(
    turns: readonly TranscriptTurn[],
    label: string,
): SpeechStretch[] {
    const ordered = turns
        .filter(
            (turn) =>
                Number.isFinite(turn.startMs) &&
                Number.isFinite(turn.endMs) &&
                turn.endMs > turn.startMs,
        )
        .toSorted((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    const key = speakerKey(label);
    const stretches: SpeechStretch[] = [];
    const other: { startMs: number; endMs: number }[] = [];
    const overlapping = new Set<SpeechStretch>();
    let consecutive = false;
    for (const turn of ordered) {
        if (speakerKey(turn.speaker) !== key) {
            consecutive = false;
            const last = other.at(-1);
            if (last && turn.startMs <= last.endMs)
                last.endMs = Math.max(last.endMs, turn.endMs);
            else other.push({ startMs: turn.startMs, endMs: turn.endMs });
            continue;
        }
        const last = stretches.at(-1);
        if (
            consecutive &&
            last &&
            turn.startMs - last.endMs <= STRETCH_GAP_MS
        ) {
            if (turn.startMs < last.endMs) overlapping.add(last);
            last.boundaries.push({
                ms: last.endMs,
                sentenceIndex: last.sentences.length,
            });
            const parts = sentenceParts(turn);
            last.boundaries.push(
                ...parts.boundaries.map((boundary) => ({
                    ...boundary,
                    sentenceIndex:
                        last.sentences.length + boundary.sentenceIndex,
                })),
            );
            last.sentences.push(...parts.sentences);
            last.endMs = Math.max(last.endMs, turn.endMs);
            last.text = `${last.text} ${turn.text.trim()}`.trim();
            last.words += wordCount(turn.text);
        } else
            stretches.push({
                startMs: turn.startMs,
                endMs: turn.endMs,
                text: turn.text.trim(),
                words: wordCount(turn.text),
                overlap: 0,
                ...sentenceParts(turn),
            });
        consecutive = true;
    }
    let from = 0;
    for (const stretch of stretches) {
        // Overlapping turns of one label have no sentence order to cut by.
        stretch.boundaries = overlapping.has(stretch)
            ? []
            : innerBoundaries(stretch);
        while (from < other.length && other[from].endMs <= stretch.startMs)
            from++;
        let overlapMs = 0;
        for (
            let index = from;
            index < other.length && other[index].startMs < stretch.endMs;
            index++
        ) {
            overlapMs += Math.max(
                0,
                Math.min(stretch.endMs, other[index].endMs) -
                    Math.max(stretch.startMs, other[index].startMs),
            );
        }
        stretch.overlap = overlapMs / (stretch.endMs - stretch.startMs);
    }
    return stretches;
}

function best(a: SpeechStretch, b: SpeechStretch): number {
    return (
        Math.min(SAMPLE_RANK_CAP_MS, b.endMs - b.startMs) -
            Math.min(SAMPLE_RANK_CAP_MS, a.endMs - a.startMs) ||
        a.overlap - b.overlap ||
        a.startMs - b.startMs
    );
}

function playable(stretch: SpeechStretch): SpeechSample {
    const ms = Math.max(0, stretch.startMs - SAMPLE_PRE_ROLL_MS);
    const limit = ms + SAMPLE_PLAY_LIMIT_MS;
    const boundary =
        stretch.endMs > limit
            ? stretch.boundaries.findLast(
                  ({ ms: end }) =>
                      end >= ms + SAMPLE_MIN_DURATION_MS && end <= limit,
              )
            : undefined;
    return {
        ...stretch,
        text: boundary
            ? stretch.sentences.slice(0, boundary.sentenceIndex).join(" ")
            : stretch.text,
        ms,
        untilMs: boundary?.ms ?? Math.min(stretch.endMs, limit),
    };
}

/** Select up to three bounded listening samples using only transcript timing and text. */
export function speakerSpeechSamples(
    turns: readonly TranscriptTurn[],
    label: string,
    recordingDurationMs?: number | null,
): SpeakerSamples {
    const durationMs =
        recordingDurationMs &&
        Number.isFinite(recordingDurationMs) &&
        recordingDurationMs > 0
            ? recordingDurationMs
            : turns.reduce(
                  (end, turn) =>
                      Number.isFinite(turn.endMs)
                          ? Math.max(end, turn.endMs)
                          : end,
                  0,
              );
    const boundedTurns = turns.flatMap((turn) =>
        Number.isFinite(turn.startMs) &&
        Number.isFinite(turn.endMs) &&
        turn.startMs < durationMs &&
        turn.endMs > Math.max(0, turn.startMs)
            ? [
                  {
                      ...turn,
                      startMs: Math.max(0, turn.startMs),
                      endMs: Math.min(durationMs, turn.endMs),
                      sentenceStartsMs: exactSentenceStarts(turn)?.map((ms) =>
                          Math.max(0, Math.min(durationMs, ms)),
                      ),
                  },
              ]
            : [],
    );
    const stretches = speechStretches(boundedTurns, label);
    const candidates = stretches
        .filter(
            (stretch) =>
                stretch.endMs - stretch.startMs >= SAMPLE_MIN_DURATION_MS &&
                stretch.words >= SAMPLE_MIN_WORDS &&
                stretch.overlap <= SAMPLE_MAX_OVERLAP,
        )
        .sort(best);
    const ownTurns = boundedTurns.filter(
        (turn) => speakerKey(turn.speaker) === speakerKey(label),
    );
    const longestTurnMs = Math.max(
        0,
        ...ownTurns.map((turn) => turn.endMs - turn.startMs),
    );
    const longestStretchMs = Math.max(
        0,
        ...stretches.map((stretch) => stretch.endMs - stretch.startMs),
    );
    const fallback = candidates.length === 0;
    const chosen: SpeechStretch[] = [];
    if (fallback) {
        chosen.push(
            ...ownTurns
                .filter(
                    (turn) =>
                        turn.endMs - turn.startMs >= SAMPLE_FALLBACK_MIN_MS,
                )
                .toSorted(
                    (a, b) =>
                        b.endMs - b.startMs - (a.endMs - a.startMs) ||
                        a.startMs - b.startMs,
                )
                .slice(0, SAMPLE_COUNT)
                .map((turn) => ({
                    ...turn,
                    ...sentenceParts(turn),
                    words: wordCount(turn.text),
                    overlap: 0,
                })),
        );
    } else {
        for (let third = 0; third < SAMPLE_THIRDS; third++) {
            const candidate = candidates.find(
                (stretch) =>
                    Math.min(
                        SAMPLE_THIRDS - 1,
                        Math.floor(
                            (stretch.startMs / durationMs) * SAMPLE_THIRDS,
                        ),
                    ) === third,
            );
            if (candidate) chosen.push(candidate);
        }
        for (const candidate of candidates) {
            if (chosen.length >= SAMPLE_COUNT) break;
            if (!chosen.includes(candidate)) chosen.push(candidate);
        }
    }
    return {
        samples: chosen.toSorted((a, b) => a.startMs - b.startMs).map(playable),
        fallback,
        longestTurnMs,
        longestStretchMs,
    };
}

/** Shorten a quote, centred on a name when present, otherwise from its start. */
export function speechQuote(
    text: string,
    length = SAMPLE_QUOTE_LENGTH,
    name?: string,
): string {
    const clean = text.replace(/\s+/gu, " ").trim();
    const lower = clean.toLocaleLowerCase();
    let at = name ? lower.indexOf(name.toLocaleLowerCase()) : -1;
    const firstName = name?.trim().split(/\s+/u)[0];
    if (at < 0 && firstName) at = lower.indexOf(firstName.toLocaleLowerCase());
    const start =
        at < 0
            ? 0
            : Math.min(
                  Math.max(0, clean.length - length),
                  Math.max(0, at - Math.floor(length / 2)),
              );
    return `${start > 0 ? "…" : ""}${clean.slice(start, start + length)}${start + length < clean.length ? "…" : ""}`;
}

/** A name-evidence clip ends with its containing turn, capped at fifteen seconds. */
export function speakerEvidenceClip(
    turns: readonly TranscriptTurn[],
    ms: number,
    name?: string,
): { ms: number; untilMs: number; quote: string } | null {
    const turn = turns.find((turn) => turn.startMs <= ms && ms < turn.endMs);
    return turn
        ? {
              ms,
              untilMs: Math.min(turn.endMs, ms + EVIDENCE_PLAY_LIMIT_MS),
              quote: speechQuote(turn.text, EVIDENCE_QUOTE_LENGTH, name),
          }
        : null;
}
