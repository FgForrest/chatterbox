/**
 * The two renderings of a corrected transcript (Task 5.1). Corrections are
 * an overlay anchored to a turn and character offsets; the stored turns
 * never change, and these apply the overlay when something reads them.
 *
 * - For people: a replacement is applied; a link (a nickname, slang) is
 *   kept as spoken and carries what it means, for the view to show on
 *   hover.
 * - For the model: a replacement is applied; a link is written with its
 *   meaning, "Honza [= Jan Novotný]". Speaker labels stay as they are.
 *
 * Which corrections apply is the caller's to choose (confirmed ones, and
 * the ticked items of a review not yet finished; never unticked ones).
 * Pure: no keys, no database, so the browser renders with it too.
 */

import { anchorMatches } from "@/lib/knowledge/correction-anchors";
import {
    renderTurnsAsText,
    type TranscriptTurn,
} from "@/lib/transcription/turns";

export interface OverlayCorrection {
    /** The stored correction's id, where there is one (to undo it). */
    id?: string;
    turnIndex: number;
    /** UTF-16 offsets into the turn's text. */
    charStart: number;
    charEnd: number;
    /** The words at the offsets when the correction was made. */
    heard: string;
    kind: "correct" | "link";
    /** What replaces the words; null on a link. */
    replacement: string | null;
    /** What the words mean: the target's current name. */
    meaning: string;
}

export interface RenderedSegment {
    text: string;
    /** Set on the words a correction changed or explained. */
    correction?: {
        id?: string;
        kind: "correct" | "link";
        heard: string;
        meaning: string;
    };
}

export interface RenderedTurn extends TranscriptTurn {
    /** The turn's text in pieces; `text` is them joined. */
    segments: RenderedSegment[];
}

/**
 * Each turn's corrections that still stand where they were made, in
 * reading order. They are placed in the order given, so one given earlier
 * wins over one overlapping it (callers give the confirmed ones first).
 */
function standingByTurn(
    turns: readonly TranscriptTurn[],
    corrections: readonly OverlayCorrection[],
): Map<number, OverlayCorrection[]> {
    const byTurn = new Map<number, OverlayCorrection[]>();
    for (const correction of corrections) {
        if (!anchorMatches(correction, turns)) continue;
        const held = byTurn.get(correction.turnIndex) ?? [];
        if (
            held.some(
                (other) =>
                    correction.charStart < other.charEnd &&
                    other.charStart < correction.charEnd,
            )
        ) {
            continue;
        }
        held.push(correction);
        byTurn.set(correction.turnIndex, held);
    }
    for (const held of byTurn.values()) {
        held.sort((a, b) => a.charStart - b.charStart);
    }
    return byTurn;
}

function segmentsOf(
    text: string,
    corrections: readonly OverlayCorrection[],
    shown: (correction: OverlayCorrection) => string,
): RenderedSegment[] {
    const segments: RenderedSegment[] = [];
    let at = 0;
    for (const correction of corrections) {
        if (correction.charStart > at) {
            segments.push({ text: text.slice(at, correction.charStart) });
        }
        segments.push({
            text: shown(correction),
            correction: {
                ...(correction.id ? { id: correction.id } : {}),
                kind: correction.kind,
                heard: correction.heard,
                meaning: correction.meaning,
            },
        });
        at = correction.charEnd;
    }
    if (at < text.length || segments.length === 0) {
        segments.push({ text: text.slice(at) });
    }
    return segments;
}

function render(
    turns: readonly TranscriptTurn[],
    corrections: readonly OverlayCorrection[],
    shown: (correction: OverlayCorrection) => string,
): RenderedTurn[] {
    const byTurn = standingByTurn(turns, corrections);
    return turns.map((turn, index) => {
        const segments = segmentsOf(turn.text, byTurn.get(index) ?? [], shown);
        return {
            ...turn,
            text: segments.map((segment) => segment.text).join(""),
            segments,
        };
    });
}

/** The rendering people read: replacements applied, links as spoken. */
export function renderTurnsForPeople(
    turns: readonly TranscriptTurn[],
    corrections: readonly OverlayCorrection[],
): RenderedTurn[] {
    return render(turns, corrections, (correction) =>
        correction.kind === "correct" && correction.replacement !== null
            ? correction.replacement
            : correction.heard,
    );
}

/** The rendering a model reads: replacements applied, links explained. */
export function renderTurnsForLlm(
    turns: readonly TranscriptTurn[],
    corrections: readonly OverlayCorrection[],
): TranscriptTurn[] {
    return render(turns, corrections, llmShown).map(
        ({ segments: _segments, ...turn }) => turn,
    );
}

/** Turns as one text, the way the transcript is stored. */
export function flattenTurns(turns: readonly TranscriptTurn[]): string {
    return renderTurnsAsText(turns);
}

/** How the model's rendering shows a correction's words. */
function llmShown(correction: OverlayCorrection): string {
    return correction.kind === "correct" && correction.replacement !== null
        ? correction.replacement
        : `${correction.heard} [= ${correction.meaning}]`;
}

/**
 * Where a place in a turn of the model's rendering was in the turn as
 * heard, both as a fraction of the turn's text: a replacement changes the
 * text's length but not the audio's, so what is placed in time by its
 * position in a turn (topics' inner marks) is placed by the words as
 * heard. Identity for a turn nothing corrected.
 */
export function correctedTimeline(
    turns: readonly TranscriptTurn[],
    corrections: readonly OverlayCorrection[],
): (turnIndex: number, fraction: number) => number {
    const byTurn = standingByTurn(turns, corrections);
    // Per corrected turn: pieces of [length as heard, length as read].
    const pieces = new Map<number, [number, number][]>();
    for (const [turnIndex, standing] of byTurn) {
        const text = turns[turnIndex]?.text ?? "";
        const parts: [number, number][] = [];
        let at = 0;
        for (const correction of standing) {
            const before = correction.charStart - at;
            if (before > 0) parts.push([before, before]);
            parts.push([
                correction.charEnd - correction.charStart,
                llmShown(correction).length,
            ]);
            at = correction.charEnd;
        }
        if (at < text.length) parts.push([text.length - at, text.length - at]);
        pieces.set(turnIndex, parts);
    }
    return (turnIndex, fraction) => {
        const parts = pieces.get(turnIndex);
        if (!parts) return fraction;
        const heardLength = parts.reduce((sum, [heard]) => sum + heard, 0);
        const readLength = parts.reduce((sum, [, read]) => sum + read, 0);
        if (heardLength === 0 || readLength === 0) return fraction;
        let read = fraction * readLength;
        let heard = 0;
        for (const [heardPart, readPart] of parts) {
            if (read <= readPart) {
                return (
                    (heard +
                        (readPart === 0 ? 0 : (read / readPart) * heardPart)) /
                    heardLength
                );
            }
            read -= readPart;
            heard += heardPart;
        }
        return 1;
    };
}
