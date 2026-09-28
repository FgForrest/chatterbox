/**
 * What a ready Learn review shows in the transcript itself: the name
 * proposed for a speaker nobody named yet, and the words a correction
 * would change, underlined. Ticking one there ticks it in the review, as
 * the checkbox does; nothing is applied until the review is finished, so
 * an unticked one stays shown, as the proposal it still is.
 */

import { speakerKey } from "@/lib/knowledge/speaker-label-rules";

type Target = { personId: string } | { entityId: string };

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

export interface LearnMarks {
    /** Proposed names, by speaker key. */
    speakers: Record<string, { itemId: string; name: string; ticked: boolean }>;
    corrections: LearnCorrectionMark[];
    decide: (itemId: string, decision: "accepted" | "rejected") => void;
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
        payload: Record<string, unknown>;
    }[];
}

/** The marks of a ready review, or null when there is none to show. */
export function learnMarksFrom(
    state: LearnMarksSource | null,
    decide: LearnMarks["decide"],
): LearnMarks | null {
    if (state?.run?.status !== "ready") return null;
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
            };
            const name = payload.personId
                ? state.names[payload.personId]
                : undefined;
            if (!name) continue;
            speakers[speakerKey(payload.label)] = {
                itemId: item.id,
                name,
                ticked,
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
            const targetId =
                "personId" in payload.target
                    ? payload.target.personId
                    : payload.target.entityId;
            const suggestion =
                (payload.kind === "correct" ? payload.replacement : null) ??
                state.names[targetId];
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
    return { speakers, corrections, decide };
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
        const quoted = text.slice(mark.charStart, mark.charEnd);
        if (quoted.toLocaleLowerCase() !== mark.heard.toLocaleLowerCase()) {
            continue;
        }
        if (mark.charStart > at) {
            segments.push({ text: text.slice(at, mark.charStart) });
        }
        segments.push({ text: quoted, mark });
        at = mark.charEnd;
    }
    if (at < text.length) segments.push({ text: text.slice(at) });
    return segments;
}
