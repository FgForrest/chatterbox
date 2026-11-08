import { sentenceStarts } from "@/lib/topics/timeline";
import {
    renderTurnsAsText,
    type TranscriptTurn,
} from "@/lib/transcription/turns";

export interface CutRange {
    startMs: number;
    endMs: number;
}

/** The retained raw slice and its rebased sentence times, or null when none stay. */
export function cutTurn(
    turn: TranscriptTurn,
    range: CutRange,
): {
    turn: TranscriptTurn;
    charStart: number;
    charEnd: number;
} | null {
    const starts = sentenceStarts(turn);
    const first = starts.findIndex(
        ({ ms }) => ms >= range.startMs && ms < range.endMs,
    );
    if (first < 0) return null;
    let end = first + 1;
    while (end < starts.length && starts[end].ms < range.endMs) end++;
    const split = first > 0 || end < starts.length;
    const from = first === 0 ? 0 : starts[first].at;
    const to = end < starts.length ? starts[end].at : turn.text.length;
    const raw = turn.text.slice(from, to);
    const charStart = from + (split ? raw.length - raw.trimStart().length : 0);
    const charEnd = split ? from + raw.trimEnd().length : to;
    const clamped = range.startMs > turn.startMs || range.endMs < turn.endMs;
    const { sentenceStartsMs: _previousTimes, ...rest } = turn;
    return {
        charStart,
        charEnd,
        turn: {
            ...rest,
            text: turn.text.slice(charStart, charEnd),
            startMs:
                (first === 0
                    ? Math.max(turn.startMs, range.startMs)
                    : starts[first].ms) - range.startMs,
            endMs: Math.min(turn.endMs, range.endMs) - range.startMs,
            ...(turn.sentenceStartsMs || split || clamped
                ? {
                      sentenceStartsMs: starts
                          .slice(first, end)
                          .map(({ ms }) => ms - range.startMs),
                  }
                : {}),
        },
    };
}

/** Keep sentences whose starts lie in the half-open range and rebase their turns. */
export function cutTranscript(
    turns: readonly TranscriptTurn[],
    range: CutRange,
): { turns: TranscriptTurn[]; text: string; turnIndices: Map<number, number> } {
    const kept = turns.flatMap((turn, originalIndex) => {
        const retained = cutTurn(turn, range);
        return retained ? [{ turn: retained.turn, originalIndex }] : [];
    });
    kept.sort((a, b) => a.turn.startMs - b.turn.startMs);
    const ordered = kept.map(({ turn }) => turn);
    const turnIndices = new Map(
        kept.map(({ originalIndex }, outputIndex) => [
            originalIndex,
            outputIndex,
        ]),
    );
    return { turns: ordered, text: renderTurnsAsText(ordered), turnIndices };
}

/** Parse a typed mm:ss or h:mm:ss edge, rejecting invalid clock fields. */
export function parseCutTime(value: string): number | null {
    const match = /^(?:(\d+):([0-5]\d):([0-5]\d)|(\d+):([0-5]\d))$/.exec(
        value.trim(),
    );
    if (!match) return null;
    const ms =
        match[1] !== undefined
            ? (Number(match[1]) * 3600 +
                  Number(match[2]) * 60 +
                  Number(match[3])) *
              1000
            : (Number(match[4]) * 60 + Number(match[5])) * 1000;
    return Number.isSafeInteger(ms) ? ms : null;
}

/** Snap to the nearest sentence start; equal distances choose the earlier time. */
export function snapCutEdge(
    turns: readonly TranscriptTurn[],
    positionMs: number,
    edge: "start" | "end",
    durationMs: number,
): number {
    const candidates = [
        edge === "start" ? 0 : durationMs,
        ...turns.flatMap((turn) => sentenceStarts(turn).map(({ ms }) => ms)),
    ].filter((ms) => ms >= 0 && ms <= durationMs);
    return candidates.reduce((best, ms) =>
        Math.abs(ms - positionMs) < Math.abs(best - positionMs) ||
        (Math.abs(ms - positionMs) === Math.abs(best - positionMs) && ms < best)
            ? ms
            : best,
    );
}

/** Validate a destructive range before any file or database writes. */
export function validCutRange(range: CutRange, durationMs: number): boolean {
    return (
        Number.isSafeInteger(range.startMs) &&
        Number.isSafeInteger(range.endMs) &&
        range.startMs >= 0 &&
        range.endMs <= durationMs &&
        range.endMs > range.startMs &&
        (range.startMs !== 0 || range.endMs !== durationMs)
    );
}
