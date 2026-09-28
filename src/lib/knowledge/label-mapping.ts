import type {
    AttributionSource,
    AttributionStatus,
} from "@/lib/knowledge/attribution";
import {
    isPlaceholderSpeakerLabel,
    labelsFromTurns,
    speakerKey,
} from "@/lib/knowledge/speaker-label-rules";
import type { TranscriptTurn } from "@/lib/transcription/turns";

/** How the labels of a replaced transcript correspond to the new one's; one-to-one. */
export interface LabelMapping {
    /** Old label to new label, clean enough to keep a name as it was. */
    carried: Map<string, string>;
    /** Old label to its most likely new label, offered only as a suggestion. */
    uncertain: Map<string, string>;
}

export interface LabelMappingOptions {
    /** Share of the old label's speech that must fall in the new label. */
    minRecall?: number;
    /** Share of the new label's speech that must come from the old label. */
    minPrecision?: number;
    /** Label order for transcripts without timings, first speaker first. */
    previousLabels?: readonly string[];
    nextLabels?: readonly string[];
}

const DEFAULT_MIN_RECALL = 0.7;
const DEFAULT_MIN_PRECISION = 0.9;

type Interval = [number, number];

interface Pair {
    oldLabel: string;
    newLabel: string;
    shared: number;
}

/**
 * Match two diarizations of the same audio.
 *
 * Every transcript of a recording shares the audio's timeline, so the new
 * label that speaks when an old label spoke is the same voice. A name is
 * carried only when the new label is almost entirely that old speaker, holds
 * most of their speech, and each is the other's unique best match. Anything
 * weaker becomes a suggestion, assigned one-to-one by shared time. Labels
 * without usable timings pair up by speaking order, as suggestions only, and
 * only when both sides have as many of them. Labels are compared as keys.
 */
export function mapLabels(
    previous: readonly TranscriptTurn[] | null,
    next: readonly TranscriptTurn[] | null,
    options: LabelMappingOptions = {},
): LabelMapping {
    const mapping: LabelMapping = { carried: new Map(), uncertain: new Map() };
    const previousSpeech = previous
        ? speechByLabel(previous)
        : new Map<string, Interval[]>();
    const nextSpeech = next
        ? speechByLabel(next)
        : new Map<string, Interval[]>();
    // Without timings on one side nothing can be matched by overlap, so every
    // label is left for speaking order; otherwise only the untimed ones are.
    const overlapPossible = previousSpeech.size > 0 && nextSpeech.size > 0;
    if (overlapPossible) {
        mapByOverlap(
            previousSpeech,
            nextSpeech,
            options.minRecall ?? DEFAULT_MIN_RECALL,
            options.minPrecision ?? DEFAULT_MIN_PRECISION,
            mapping,
        );
    }
    const taken = new Set([
        ...mapping.carried.values(),
        ...mapping.uncertain.values(),
    ]);
    const oldLeft = (
        options.previousLabels ?? (previous ? labelsFromTurns(previous) : [])
    )
        .map(speakerKey)
        .filter(
            (label) =>
                !isPlaceholderSpeakerLabel(label) &&
                !(overlapPossible && previousSpeech.has(label)),
        );
    const newLeft = (options.nextLabels ?? (next ? labelsFromTurns(next) : []))
        .map(speakerKey)
        .filter(
            (label) =>
                !isPlaceholderSpeakerLabel(label) &&
                !(overlapPossible && nextSpeech.has(label)) &&
                !taken.has(label),
        );
    if (oldLeft.length > 0 && oldLeft.length === newLeft.length) {
        for (let index = 0; index < oldLeft.length; index++) {
            mapping.uncertain.set(oldLeft[index], newLeft[index]);
        }
    }
    return mapping;
}

/** The parts of a speaker row that move with its label. */
export interface RemappableAttribution {
    label: string;
    personId: string | null;
    status: AttributionStatus;
    source: AttributionSource;
    markedUnknown: boolean;
    confirmedByUserId: string | null;
    confidence: number | null;
    evidenceStartMs: number | null;
}

/**
 * Carry a replaced transcript's speaker rows onto the new labels.
 *
 * A clean pair keeps its row as it was: a name, an "unknown", or a
 * suggestion. An uncertain pair keeps only a name, as a suggestion nobody
 * confirmed. The evidence time pointed into the old text, so it never
 * survives. Rows with nothing to place are dropped. The mapping is
 * one-to-one, so two rows never land on one label.
 */
export function remapAttributionRows(
    rows: readonly RemappableAttribution[],
    mapping: LabelMapping,
): RemappableAttribution[] {
    const result: RemappableAttribution[] = [];
    for (const row of rows) {
        if (row.status === "rejected") continue;
        const carried = mapping.carried.get(row.label);
        if (carried) {
            result.push({ ...row, label: carried, evidenceStartMs: null });
            continue;
        }
        const uncertain = mapping.uncertain.get(row.label);
        if (uncertain && row.personId) {
            result.push({
                ...row,
                label: uncertain,
                status: "suggested",
                source: "heuristic",
                markedUnknown: false,
                confirmedByUserId: null,
                evidenceStartMs: null,
            });
        }
    }
    return result;
}

function speechByLabel(
    turns: readonly TranscriptTurn[],
): Map<string, Interval[]> {
    const byLabel = new Map<string, Interval[]>();
    for (const turn of turns) {
        // `!(end > start)` also drops a turn whose timings are not numbers.
        const timed = turn.endMs > turn.startMs;
        if (isPlaceholderSpeakerLabel(turn.speaker) || !timed) continue;
        const label = speakerKey(turn.speaker);
        const intervals = byLabel.get(label) ?? [];
        intervals.push([turn.startMs, turn.endMs]);
        byLabel.set(label, intervals);
    }
    const unions = new Map<string, Interval[]>();
    for (const [label, intervals] of byLabel) {
        unions.set(label, union(intervals));
    }
    return unions;
}

function union(intervals: Interval[]): Interval[] {
    const merged: Interval[] = [];
    for (const [start, end] of [...intervals].sort((a, b) => a[0] - b[0])) {
        const last = merged[merged.length - 1];
        if (last && start <= last[1]) last[1] = Math.max(last[1], end);
        else merged.push([start, end]);
    }
    return merged;
}

function duration(intervals: readonly Interval[]): number {
    let total = 0;
    for (const [start, end] of intervals) total += end - start;
    return total;
}

function overlap(a: readonly Interval[], b: readonly Interval[]): number {
    let i = 0;
    let j = 0;
    let total = 0;
    while (i < a.length && j < b.length) {
        const [aStart, aEnd] = a[i];
        const [bStart, bEnd] = b[j];
        const shared = Math.min(aEnd, bEnd) - Math.max(aStart, bStart);
        if (shared > 0) total += shared;
        if (aEnd < bEnd) i++;
        else j++;
    }
    return total;
}

function uniqueBest(
    scores: ReadonlyMap<string, number> | undefined,
): string | null {
    let best: string | null = null;
    let bestScore = 0;
    let tied = false;
    for (const [key, score] of scores ?? []) {
        if (score > bestScore) {
            best = key;
            bestScore = score;
            tied = false;
        } else if (score === bestScore && score > 0) {
            tied = true;
        }
    }
    return tied ? null : best;
}

function remember(
    table: Map<string, Map<string, number>>,
    key: string,
    other: string,
    value: number,
): void {
    const row = table.get(key) ?? new Map<string, number>();
    row.set(other, value);
    table.set(key, row);
}

function mapByOverlap(
    previous: ReadonlyMap<string, Interval[]>,
    next: ReadonlyMap<string, Interval[]>,
    minRecall: number,
    minPrecision: number,
    mapping: LabelMapping,
): void {
    const pairs: Pair[] = [];
    const byOld = new Map<string, Map<string, number>>();
    const byNew = new Map<string, Map<string, number>>();
    for (const [oldLabel, oldSpeech] of previous) {
        for (const [newLabel, newSpeech] of next) {
            const shared = overlap(oldSpeech, newSpeech);
            if (shared <= 0) continue;
            pairs.push({ oldLabel, newLabel, shared });
            remember(byOld, oldLabel, newLabel, shared);
            remember(byNew, newLabel, oldLabel, shared);
        }
    }
    for (const { oldLabel, newLabel, shared } of pairs) {
        const mutual =
            uniqueBest(byOld.get(oldLabel)) === newLabel &&
            uniqueBest(byNew.get(newLabel)) === oldLabel;
        if (!mutual) continue;
        const recall = shared / duration(previous.get(oldLabel) ?? []);
        const precision = shared / duration(next.get(newLabel) ?? []);
        if (recall >= minRecall && precision >= minPrecision) {
            mapping.carried.set(oldLabel, newLabel);
        }
    }
    const taken = new Set(mapping.carried.values());
    const ranked = [...pairs].sort(
        (a, b) =>
            b.shared - a.shared ||
            a.oldLabel.localeCompare(b.oldLabel) ||
            a.newLabel.localeCompare(b.newLabel),
    );
    for (const { oldLabel, newLabel } of ranked) {
        const placed =
            mapping.carried.has(oldLabel) || mapping.uncertain.has(oldLabel);
        if (placed || taken.has(newLabel)) continue;
        mapping.uncertain.set(oldLabel, newLabel);
        taken.add(newLabel);
    }
}
