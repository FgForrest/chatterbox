import {
    renderTurnsAsText,
    type TranscriptTurn,
} from "@/lib/transcription/turns";

export interface CutRange {
    startMs: number;
    endMs: number;
}

/** Whether a turn belongs to the retained interval, including its start. */
export function turnStays(turn: TranscriptTurn, range: CutRange): boolean {
    const middle = (turn.startMs + turn.endMs) / 2;
    return middle >= range.startMs && middle < range.endMs;
}

/** Clamp retained turns, shift their clock, and use the normal transcript renderer. */
export function cutTranscript(
    turns: readonly TranscriptTurn[],
    range: CutRange,
): {
    turns: TranscriptTurn[];
    text: string;
} {
    const kept = turns
        .filter((turn) => turnStays(turn, range))
        .map((turn) => ({
            ...turn,
            startMs: Math.max(turn.startMs, range.startMs) - range.startMs,
            endMs: Math.min(turn.endMs, range.endMs) - range.startMs,
        }));
    return { turns: kept, text: renderTurnsAsText(kept) };
}

/** Snap a playhead edge to its turn, or the next/previous turn across a gap. */
export function snapCutEdge(
    turns: readonly TranscriptTurn[],
    positionMs: number,
    edge: "start" | "end",
): number {
    const containing = turns.find(
        (turn) => turn.startMs <= positionMs && positionMs < turn.endMs,
    );
    if (containing)
        return edge === "start" ? containing.startMs : containing.endMs;
    if (edge === "start")
        return (
            turns.find((turn) => turn.startMs >= positionMs)?.startMs ??
            positionMs
        );
    return (
        [...turns].reverse().find((turn) => turn.endMs <= positionMs)?.endMs ??
        positionMs
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
