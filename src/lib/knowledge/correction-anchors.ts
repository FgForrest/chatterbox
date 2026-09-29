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
 *
 * A transcript without times (a Plaud import whose turns all stand at 0)
 * has no timeline to search over: there a correction stays only where the
 * turns are still the same ones (as many, each said by the same speaker)
 * and its turn still has its words at the same place, as through an
 * unchanged re-import or one with words edited. Turns added or removed
 * shift every index, so nothing stays.
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
        !splitsCharacter(text, anchor.charStart) &&
        !splitsCharacter(text, anchor.charEnd) &&
        text.slice(anchor.charStart, anchor.charEnd) === anchor.heard
    );
}

/**
 * The words at a place in a turn's text where they are `heard` in any case
 * and however composed (an accent as its own code point, say), and whole
 * characters of them; null otherwise. A Learn item groups its occurrences
 * so, and each is read, shown and applied at its own words.
 */
export function wordsAt(
    text: string | undefined,
    charStart: number,
    charEnd: number,
    heard: string,
): string | null {
    if (
        text === undefined ||
        charStart < 0 ||
        charStart >= charEnd ||
        charEnd > text.length ||
        splitsCharacter(text, charStart) ||
        splitsCharacter(text, charEnd)
    ) {
        return null;
    }
    const words = text.slice(charStart, charEnd);
    return sameWords(words, heard) ? words : null;
}

/** Whether two texts say the same words, in any case, however composed. */
export function sameWords(a: string, b: string): boolean {
    return (
        a.normalize("NFC").toLocaleLowerCase() ===
        b.normalize("NFC").toLocaleLowerCase()
    );
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Whether an offset falls inside one character as a reader sees it: between
 * the two UTF-16 units of an emoji, a letter and its accent written apart,
 * the halves of a flag, or the people of a family emoji. Text cut there is
 * no longer the text: a replacement would take the accent over, say.
 */
function splitsCharacter(text: string, offset: number): boolean {
    if (offset <= 0 || offset >= text.length) return false;
    return graphemes.segment(text).containing(offset)?.index !== offset;
}

/** Whether two positions cover some of the same characters. */
export function anchorsOverlap(a: AnchorPosition, b: AnchorPosition): boolean {
    return (
        a.turnIndex === b.turnIndex &&
        a.charStart < b.charEnd &&
        b.charStart < a.charEnd
    );
}

/** Whether no turn has a duration: the times are missing, not zero. */
export function isUntimed(turns: readonly TranscriptTurn[]): boolean {
    return turns.every((turn) => turn.endMs <= turn.startMs);
}

/** Where the anchor stands in `nextTurns` without times; see above. */
function keptInPlace(
    anchor: CorrectionAnchor,
    previousTurns: readonly TranscriptTurn[],
    nextTurns: readonly TranscriptTurn[],
): AnchorPosition | null {
    if (!anchorMatches(anchor, previousTurns)) return null;
    if (
        !anchorMatches(anchor, nextTurns) ||
        nextTurns[anchor.turnIndex]?.speaker !==
            previousTurns[anchor.turnIndex]?.speaker
    ) {
        return null;
    }
    return {
        turnIndex: anchor.turnIndex,
        charStart: anchor.charStart,
        charEnd: anchor.charEnd,
    };
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
    if (isUntimed(previousTurns) || isUntimed(nextTurns)) {
        const sameTurns =
            previousTurns.length === nextTurns.length &&
            previousTurns.every(
                (turn, index) => turn.speaker === nextTurns[index]?.speaker,
            );
        if (!sameTurns) return anchors.map(() => null);
    }
    const remap =
        isUntimed(previousTurns) || isUntimed(nextTurns)
            ? keptInPlace
            : remapOne;
    const kept: AnchorPosition[] = [];
    return anchors.map((anchor) => {
        const position = remap(anchor, previousTurns, nextTurns);
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
