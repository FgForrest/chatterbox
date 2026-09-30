/**
 * The rules facts and their evidence follow, without a database. Pure, so
 * the evidence recheck, which the transcript writers load, can use them.
 */

import type { TranscriptTurn } from "@/lib/transcription/turns";

/** A person or an entity a fact is about. */
export type FactNode = { personId: string } | { entityId: string };

/**
 * The key a subject or an object node takes in a fact's unique key. The
 * ids are opaque already; literals are keyed by an HMAC instead
 * (`facts.ts`).
 */
export function nodeKey(node: FactNode): string {
    return "personId" in node ? `p:${node.personId}` : `e:${node.entityId}`;
}

export interface RelationShape {
    subjectTypes: readonly string[];
    objectTypes: readonly string[];
    objectKind: "entity" | "literal";
}

/**
 * Whether a relation takes this subject and object: the subject's type is
 * one it names, and the object is text where the relation's object is text,
 * or of a type it names. A person's type is `person`.
 */
export function relationFits(
    relation: RelationShape,
    subjectType: string,
    object: { literal: true } | { type: string },
): boolean {
    if (!relation.subjectTypes.includes(subjectType)) return false;
    if ("literal" in object) return relation.objectKind === "literal";
    return (
        relation.objectKind === "entity" &&
        relation.objectTypes.includes(object.type)
    );
}

function isSpace(char: string | undefined): boolean {
    return char === undefined || /\s/.test(char);
}

/**
 * The words spoken between `startMs` and `endMs`: of each turn the range
 * covers, the share of its text its time covers (spreading the text evenly
 * over the turn), widened to whole words. Null where nobody spoke.
 */
export function quoteFromTurns(
    turns: readonly TranscriptTurn[] | null,
    startMs: number,
    endMs: number,
): string | null {
    if (!turns) return null;
    const parts: string[] = [];
    for (const turn of turns) {
        const duration = turn.endMs - turn.startMs;
        if (duration <= 0) {
            if (turn.startMs >= startMs && turn.startMs <= endMs) {
                parts.push(turn.text.trim());
            }
            continue;
        }
        const from = Math.max(startMs, turn.startMs);
        const to = Math.min(endMs, turn.endMs);
        if (to <= from) continue;
        const text = turn.text;
        let charFrom = Math.floor(
            ((from - turn.startMs) / duration) * text.length,
        );
        let charTo = Math.ceil(((to - turn.startMs) / duration) * text.length);
        while (charFrom > 0 && !isSpace(text[charFrom - 1])) charFrom--;
        while (charTo < text.length && !isSpace(text[charTo])) charTo++;
        parts.push(text.slice(charFrom, charTo).trim());
    }
    const quote = parts.filter(Boolean).join(" ");
    return quote || null;
}

/** Lowercased words without diacritics or punctuation, for comparing quotes. */
function wordsOf(text: string): string[] {
    return text
        .normalize("NFKD")
        .replace(/\p{M}+/gu, "")
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean);
}

/**
 * How alike two quotes are, from 0 to 1: the share of words they have in
 * common (the Dice coefficient over the words, counted with repeats).
 * Blind to order, case, accents and punctuation, so a re-transcription
 * that cuts turns elsewhere or spells a word differently stays alike.
 */
export function quoteSimilarity(a: string, b: string): number {
    const left = wordsOf(a);
    const right = wordsOf(b);
    if (left.length === 0 || right.length === 0) return 0;
    const counts = new Map<string, number>();
    for (const word of left) counts.set(word, (counts.get(word) ?? 0) + 1);
    let common = 0;
    for (const word of right) {
        const count = counts.get(word) ?? 0;
        if (count > 0) {
            common++;
            counts.set(word, count - 1);
        }
    }
    return (2 * common) / (left.length + right.length);
}

/**
 * Below this, the words at a piece of evidence's time are no longer the
 * ones a person confirmed, and the evidence goes to review
 * (`wording_changed`).
 */
export const QUOTE_SIMILARITY_THRESHOLD = 0.6;
