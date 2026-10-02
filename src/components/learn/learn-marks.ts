/**
 * What a ready Learn review shows in the transcript itself: the name
 * proposed for a speaker nobody named yet, and the words a correction
 * would change, underlined. Ticking one there ticks it in the review, as
 * the checkbox does; nothing is applied until the review is finished, so
 * an unticked one stays shown, as the proposal it still is.
 */

import { anchorMatches, wordsAt } from "@/lib/knowledge/correction-anchors";
import { speakerKey } from "@/lib/knowledge/speaker-label-rules";
import type { OverlayCorrection, RenderedSegment } from "@/lib/learn/render";

type Target = { personId: string } | { entityId: string } | { newRef: string };

export interface LearnCorrectionMark {
    itemId: string;
    turnIndex: number;
    charStart: number;
    charEnd: number;
    heard: string;
    /** The replacement, or the name a link points to. */
    suggestion: string;
    ticked: boolean;
}

/**
 * Whom a speaker guess names, as the speakers route takes it: someone
 * known, or someone new the review proposes to add (`recordItemId`, its
 * new record, which then links to whoever the name made).
 */
export type SpeakerGuessAnswer =
    | { personId: string }
    | { displayName: string; recordItemId?: string };

export interface LearnSpeakerMark {
    itemId: string;
    /** The transcript's label, as a speaker key (`speaker_0`). */
    label: string;
    name: string;
    ticked: boolean;
    /** Unticked by the reviewer, not merely left as it came. */
    declined: boolean;
    answer: SpeakerGuessAnswer;
    evidenceMs: number[];
    /** Only the first name was heard. */
    onlyFirstName: boolean;
    /** Named as the person who made the recording, on their role. */
    recorder: boolean;
}

export interface LearnMarks {
    /** Proposed names, by speaker key. */
    speakers: Record<string, LearnSpeakerMark>;
    corrections: LearnCorrectionMark[];
    /** Keep a draft decision, with a choice where the kind takes one. */
    decide: (
        itemId: string,
        decision: "accepted" | "rejected",
        choice?: Record<string, unknown> | null,
    ) => Promise<void>;
    /**
     * Hold the review's Finish until `work` settles: something done on its
     * items outside the review (naming a speaker, then ticking it).
     */
    track: <T>(work: Promise<T>) => Promise<T>;
}

/** The part of the review answer the marks are made from. */
export interface LearnMarksSource {
    run: { status: string } | null;
    names: Record<string, string>;
    items: {
        id: string;
        kind: string;
        preTicked: boolean;
        decision: "accepted" | "rejected" | null;
        /** The reviewer's choice for the item, where they made one. */
        choice?: Record<string, unknown> | null;
        payload: Record<string, unknown>;
    }[];
}

/** The marks of a ready review, or null when there is none to show. */
export function learnMarksFrom(
    state: LearnMarksSource | null,
    decide: LearnMarks["decide"],
    track: LearnMarks["track"] = (work) => work,
): LearnMarks | null {
    if (state?.run?.status !== "ready") return null;
    // A person or thing the review proposes to add, by its ref: the name
    // the reviewer left it, or the record they said it is.
    const recordNames = new Map<string, string | undefined>();
    const recordItems = new Map<
        string,
        { id: string; personId: string | null }
    >();
    for (const item of state.items) {
        if (item.kind !== "new_record") continue;
        const payload = item.payload as { ref: string; name: string };
        const choice = item.choice ?? null;
        const linked =
            typeof choice?.personId === "string"
                ? choice.personId
                : typeof choice?.entityId === "string"
                  ? choice.entityId
                  : null;
        recordItems.set(payload.ref, {
            id: item.id,
            personId:
                typeof choice?.personId === "string" ? choice.personId : null,
        });
        recordNames.set(
            payload.ref,
            linked
                ? state.names[linked]
                : typeof choice?.name === "string"
                  ? choice.name
                  : payload.name,
        );
    }
    const speakers: LearnMarks["speakers"] = {};
    const corrections: LearnCorrectionMark[] = [];
    for (const item of state.items) {
        const ticked =
            (item.decision ?? (item.preTicked ? "accepted" : "rejected")) ===
            "accepted";
        if (item.kind === "speaker") {
            const payload = item.payload as {
                label: string;
                personId: string | null;
                newRef?: string;
                evidenceMs?: number[];
                onlyFirstName?: boolean;
                recorder?: boolean;
            };
            // As the reviewer chose (someone known, or someone new), else
            // as Learn proposed; answered unknown, nobody is shown.
            const choice = item.choice ?? null;
            if (choice?.unknown === true) continue;
            const name =
                typeof choice?.personId === "string"
                    ? state.names[choice.personId]
                    : typeof choice?.displayName === "string"
                      ? choice.displayName
                      : payload.personId
                        ? state.names[payload.personId]
                        : payload.newRef
                          ? recordNames.get(payload.newRef)
                          : undefined;
            if (!name) continue;
            const record = payload.newRef
                ? recordItems.get(payload.newRef)
                : undefined;
            const answer: SpeakerGuessAnswer =
                typeof choice?.personId === "string"
                    ? { personId: choice.personId }
                    : typeof choice?.displayName === "string"
                      ? { displayName: choice.displayName }
                      : payload.personId
                        ? { personId: payload.personId }
                        : record?.personId
                          ? { personId: record.personId }
                          : {
                                displayName: name,
                                ...(record ? { recordItemId: record.id } : {}),
                            };
            const label = speakerKey(payload.label);
            speakers[label] = {
                itemId: item.id,
                label,
                name,
                ticked,
                declined: item.decision === "rejected",
                answer,
                evidenceMs: payload.evidenceMs ?? [],
                onlyFirstName: payload.onlyFirstName === true,
                recorder: payload.recorder === true,
            };
        } else if (item.kind === "correction") {
            const payload = item.payload as {
                kind: "correct" | "link";
                heard: string;
                target: Target;
                replacement: string | null;
                anchors: {
                    turnIndex: number;
                    charStart: number;
                    charEnd: number;
                }[];
            };
            const target = payload.target;
            const suggestion =
                (payload.kind === "correct" ? payload.replacement : null) ??
                ("newRef" in target
                    ? recordNames.get(target.newRef)
                    : state.names[
                          "personId" in target
                              ? target.personId
                              : target.entityId
                      ]);
            if (!suggestion) continue;
            for (const anchor of payload.anchors) {
                corrections.push({
                    itemId: item.id,
                    turnIndex: anchor.turnIndex,
                    charStart: anchor.charStart,
                    charEnd: anchor.charEnd,
                    heard: payload.heard,
                    suggestion,
                    ticked,
                });
            }
        }
    }
    return { speakers, corrections, decide, track };
}

/**
 * A turn's text cut at its marks, in order. A mark that no longer quotes
 * what it heard there, or overlaps one before it, is left out.
 */
export function markedSegments(
    text: string,
    marks: readonly LearnCorrectionMark[],
): { text: string; mark?: LearnCorrectionMark }[] {
    const segments: { text: string; mark?: LearnCorrectionMark }[] = [];
    let at = 0;
    for (const mark of [...marks].sort((a, b) => a.charStart - b.charStart)) {
        if (mark.charStart < at) continue;
        const quoted = wordsAt(text, mark.charStart, mark.charEnd, mark.heard);
        if (quoted === null) continue;
        if (mark.charStart > at) {
            segments.push({ text: text.slice(at, mark.charStart) });
        }
        segments.push({ text: quoted, mark });
        at = mark.charEnd;
    }
    if (at < text.length) segments.push({ text: text.slice(at) });
    return segments;
}

export type TurnPiece =
    | { text: string; correction?: undefined; mark?: undefined }
    | {
          text: string;
          correction: NonNullable<RenderedSegment["correction"]>;
          mark?: undefined;
      }
    | { text: string; mark: LearnCorrectionMark; correction?: undefined };

/**
 * A turn's text as people read it, with a waiting review's marks in it:
 * its confirmed corrections applied, and the marks on the words as heard
 * that no confirmed correction covers. Everything is placed on the text
 * as stored; one overlapping an earlier one is left out.
 */
export function turnPieces(
    text: string,
    turnIndex: number,
    corrections: readonly OverlayCorrection[],
    marks: readonly LearnCorrectionMark[],
): TurnPiece[] {
    type Placed =
        | { start: number; end: number; correction: OverlayCorrection }
        | { start: number; end: number; mark: LearnCorrectionMark };
    const overlaps = (a: Placed, b: Placed) =>
        a.start < b.end && b.start < a.end;
    const placed: Placed[] = [];
    const place = (candidate: Placed) => {
        if (placed.some((held) => overlaps(held, candidate))) return;
        placed.push(candidate);
    };
    // Confirmed corrections first: what is applied wins over a proposal.
    for (const correction of corrections) {
        if (correction.turnIndex !== turnIndex) continue;
        // Its words still there, and whole characters of them.
        if (
            !anchorMatches({ ...correction, turnIndex: 0 }, [
                { speaker: "", startMs: 0, endMs: 0, text },
            ])
        ) {
            continue;
        }
        place({
            start: correction.charStart,
            end: correction.charEnd,
            correction,
        });
    }
    for (const mark of marks) {
        if (wordsAt(text, mark.charStart, mark.charEnd, mark.heard) === null) {
            continue;
        }
        place({ start: mark.charStart, end: mark.charEnd, mark });
    }
    placed.sort((a, b) => a.start - b.start);
    const pieces: TurnPiece[] = [];
    let at = 0;
    for (const item of placed) {
        if (item.start > at) pieces.push({ text: text.slice(at, item.start) });
        if ("correction" in item) {
            const { correction } = item;
            pieces.push({
                text:
                    correction.kind === "correct" &&
                    correction.replacement !== null
                        ? correction.replacement
                        : correction.heard,
                correction: {
                    ...(correction.id ? { id: correction.id } : {}),
                    kind: correction.kind,
                    heard: correction.heard,
                    meaning: correction.meaning,
                },
            });
        } else {
            pieces.push({
                text: text.slice(item.start, item.end),
                mark: item.mark,
            });
        }
        at = item.end;
    }
    if (at < text.length) pieces.push({ text: text.slice(at) });
    return pieces;
}
