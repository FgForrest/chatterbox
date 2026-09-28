/**
 * Where a transcript correction stands, and where it stands after the
 * transcript is rewritten. Pure, so the rules are tested without a database.
 *
 * A correction is anchored to a turn and character offsets of one revision.
 * Every transcript of a recording shares the audio's timeline, so a rewrite
 * is searched over the same stretch of time: the old turn's text word for
 * word keeps the offsets; otherwise the heard text itself, where it now
 * stands nearest the old anchor's moment. Nothing else is guessed: an
 * anchor that is not found exactly is dropped, and so the correction.
 */

import type { TranscriptTurn } from "@/lib/transcription/turns";

export interface CorrectionAnchor {
    turnIndex: number;
    /** UTF-16 offsets into the turn's text, as JavaScript slices it. */
    charStart: number;
    charEnd: number;
    /** The text at the offsets when the correction was made. */
    heard: string;
}

export type AnchorPosition = Omit<CorrectionAnchor, "heard">;

/** Whether `anchor.heard` stands at the anchor in `turns`. */
export function anchorMatches(
    anchor: CorrectionAnchor,
    turns: readonly TranscriptTurn[] | null,
): boolean {
    const text = turns?.[anchor.turnIndex]?.text;
    return (
        text !== undefined &&
        anchor.charStart >= 0 &&
        anchor.charStart < anchor.charEnd &&
        text.slice(anchor.charStart, anchor.charEnd) === anchor.heard
    );
}

/** Whether two positions cover some of the same characters. */
export function anchorsOverlap(a: AnchorPosition, b: AnchorPosition): boolean {
    return (
        a.turnIndex === b.turnIndex &&
        a.charStart < b.charEnd &&
        b.charStart < a.charEnd
    );
}

/** How long two turns speak at the same time; -1 when never. */
function overlapMs(old: TranscriptTurn, next: TranscriptTurn): number {
    if (old.endMs <= old.startMs) {
        return next.startMs <= old.startMs && old.startMs <= next.endMs
            ? 0
            : -1;
    }
    const overlap =
        Math.min(old.endMs, next.endMs) - Math.max(old.startMs, next.startMs);
    return overlap > 0 ? overlap : -1;
}

/** The moment a character offset falls at, spreading the turn evenly. */
function momentOf(turn: TranscriptTurn, offset: number): number {
    const share = turn.text.length > 0 ? offset / turn.text.length : 0;
    return turn.startMs + share * (turn.endMs - turn.startMs);
}

function remapOne(
    anchor: CorrectionAnchor,
    previousTurns: readonly TranscriptTurn[],
    nextTurns: readonly TranscriptTurn[],
): AnchorPosition | null {
    if (!anchorMatches(anchor, previousTurns)) return null;
    const old = previousTurns[anchor.turnIndex] as TranscriptTurn;
    const candidates = nextTurns
        .map((turn, index) => ({ turn, index, overlap: overlapMs(old, turn) }))
        .filter((candidate) => candidate.overlap >= 0);

    let same: (typeof candidates)[number] | null = null;
    for (const candidate of candidates) {
        if (
            candidate.turn.text === old.text &&
            (!same || candidate.overlap > same.overlap)
        ) {
            same = candidate;
        }
    }
    if (same) {
        return {
            turnIndex: same.index,
            charStart: anchor.charStart,
            charEnd: anchor.charEnd,
        };
    }

    const moment = momentOf(old, anchor.charStart);
    let best: { position: AnchorPosition; distance: number } | null = null;
    for (const { turn, index } of candidates) {
        for (
            let at = turn.text.indexOf(anchor.heard);
            at >= 0;
            at = turn.text.indexOf(anchor.heard, at + 1)
        ) {
            const distance = Math.abs(momentOf(turn, at) - moment);
            if (!best || distance < best.distance) {
                best = {
                    position: {
                        turnIndex: index,
                        charStart: at,
                        charEnd: at + anchor.heard.length,
                    },
                    distance,
                };
            }
        }
    }
    return best?.position ?? null;
}

/**
 * Where each anchor stands in `nextTurns`, in the order given, or null
 * where it is lost. An anchor that lands on words an earlier one already
 * took is lost too, so the order given decides.
 */
export function remapCorrectionAnchors(
    anchors: readonly CorrectionAnchor[],
    previousTurns: readonly TranscriptTurn[] | null,
    nextTurns: readonly TranscriptTurn[] | null,
): (AnchorPosition | null)[] {
    if (!previousTurns?.length || !nextTurns?.length) {
        return anchors.map(() => null);
    }
    const kept: AnchorPosition[] = [];
    return anchors.map((anchor) => {
        const position = remapOne(anchor, previousTurns, nextTurns);
        if (
            !position ||
            kept.some((other) => anchorsOverlap(other, position))
        ) {
            return null;
        }
        kept.push(position);
        return position;
    });
}
