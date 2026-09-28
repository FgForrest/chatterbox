/**
 * Turning a Learn run's answer into review items, on the server, against
 * the run (Task 3.3). Pure: the caller freezes what the run may know into
 * a `LearnRunFrame`.
 *
 * The answer is data. Whatever the transcript asked the model to do, the
 * only thing an answer can become is a review item a person then decides
 * on, and only where it holds against the transcript and the run's scopes:
 * - the transcript must still be the revision the run read, else nothing
 *   (the run is superseded);
 * - times snap to the transcript's marks; heard text must stand exactly
 *   at its anchor; ids must be in the run's scopes; relation keys must be
 *   visible, and fit (an unknown relation becomes a phrase to review);
 * - facts the model marks sensitive go, whatever the language;
 * - one speaker suggestion per label, and none for a label a person
 *   answered; at most `MAX_NEW_FACTS` new facts;
 * - what a person dismissed before goes, except on a manual run.
 *
 * Two defaults (the design's fixed rule, never the model's confidence):
 * pre-ticked are a `correct` of a non-person a person confirmed before,
 * heard alike by the same provider in the same language, and a known fact
 * mentioned again; everything else is unticked. A fact about a speaker
 * depends on that speaker's answer, so a speaker is never named by a fact
 * of the same run (no circular evidence).
 */

import {
    anchorMatches,
    anchorsOverlap,
} from "@/lib/knowledge/correction-anchors";
import { nodeKey, relationFits } from "@/lib/knowledge/fact-rules";
import type {
    LearnCorrection,
    LearnFact,
    LearnObject,
    LearnOutput,
    LearnSubject,
} from "@/lib/learn/output";
import { parseClock } from "@/lib/topics/timeline";
import type { TranscriptTurn } from "@/lib/transcription/turns";

export const MAX_NEW_FACTS = 10;

export interface VisibleRelation {
    subjectTypes: readonly string[];
    /** The types an entity object may have; a literal relation has none. */
    objectTypes: readonly string[];
    objectKind: "entity" | "literal";
}

/** What a run may know, frozen when its answer is validated. */
export interface LearnRunFrame {
    /** The transcript revision the run read. */
    revision: number;
    /** The transcript's revision now. */
    currentRevision: number;
    turns: readonly TranscriptTurn[];
    language: string | null;
    provider: string | null;
    manual: boolean;
    /** The people and entities in the run's scopes. */
    people: ReadonlyMap<string, { name: string }>;
    entities: ReadonlyMap<string, { typeKey: string; name: string }>;
    /** The relations visible to the run's scope, active. */
    relations: ReadonlyMap<string, VisibleRelation>;
    /** Labels a person already answered (named, or marked unknown). */
    answeredLabels: ReadonlySet<string>;
    /** `heardAsKey` of every heard-as form a person confirmed. */
    confirmedHeardAs: ReadonlySet<string>;
    /** Current facts in the run's scopes: `factKey` -> fact id. */
    knownFacts: ReadonlyMap<string, string>;
    /** Fingerprints of items a person dismissed on this recording. */
    dismissed: ReadonlySet<string>;
    /** How a literal object is keyed (`objectKeyOf`); plain by default. */
    literalKey?: (literal: string) => string;
}

export type DropReason =
    | "answered"
    | "unknownLabel"
    | "outOfScope"
    | "notAtAnchor"
    | "unchanged"
    | "overlapping"
    | "sensitive"
    | "doesNotFit"
    | "badTime"
    | "dismissed"
    | "budget";

interface AnchorPosition {
    turnIndex: number;
    charStart: number;
    charEnd: number;
}

type Target = { personId: string } | { entityId: string };

export type ReviewCandidate =
    | {
          kind: "speaker";
          fingerprint: string;
          preTicked: false;
          payload: {
              label: string;
              personId: string | null;
              evidenceMs: number[];
              reason: string;
          };
      }
    | {
          kind: "correction";
          fingerprint: string;
          preTicked: boolean;
          payload: {
              kind: "correct" | "link";
              heard: string;
              target: Target;
              replacement: string | null;
              anchors: AnchorPosition[];
          };
      }
    | {
          kind: "known_fact" | "fact";
          fingerprint: string;
          preTicked: boolean;
          dependsOnLabel?: string;
          payload: {
              factId?: string;
              subject: LearnSubject;
              relationKey: string;
              object: LearnObject;
              startMs: number;
              endMs: number;
              speakerLabel: string | null;
          };
      }
    | {
          kind: "relation_phrase";
          fingerprint: string;
          preTicked: false;
          dependsOnLabel?: string;
          payload: {
              phrase: string;
              subject: LearnSubject;
              object: LearnObject;
              startMs: number;
              endMs: number;
              count: number;
          };
      };

export interface ValidationResult {
    superseded: boolean;
    items: ReviewCandidate[];
    dropped: Partial<Record<DropReason, number>>;
}

/** How a heard-as form is compared: its words, case and form aside. */
export function heardAsKey(
    target: Target,
    heard: string,
    language: string | null,
    provider: string | null,
): string {
    return [
        "personId" in target ? target.personId : target.entityId,
        heard.trim().normalize("NFC").toLowerCase(),
        language ?? "",
        provider ?? "",
    ].join("|");
}

/** A fact's identity in a scope: subject, relation, object. */
export function factKey(
    subject: string,
    relationKey: string,
    object: string,
): string {
    return `${subject}|${relationKey}|${object}`;
}

function normalizePhrase(text: string): string {
    return text.replaceAll("_", " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeText(text: string): string {
    return text.trim().normalize("NFC").toLowerCase();
}

function targetKey(target: Target): string {
    return nodeKey(target);
}

/** Transcript times a clock may snap to: every turn's start, and the end. */
function timeline(turns: readonly TranscriptTurn[]) {
    const starts = turns.map((turn) => turn.startMs);
    const endMs = Math.max(0, ...turns.map((turn) => turn.endMs));
    const points = [...new Set([...starts, endMs])].sort((a, b) => a - b);
    return {
        endMs,
        /** The nearest point to a clock, or null past the end or unparsable. */
        snap(clock: string): number | null {
            const ms = parseClock(clock);
            if (ms === null || ms > endMs || points.length === 0) return null;
            let best = points[0] as number;
            for (const point of points) {
                if (Math.abs(point - ms) < Math.abs(best - ms)) best = point;
            }
            return best;
        },
    };
}

export function validateLearnOutput(
    output: LearnOutput,
    frame: LearnRunFrame,
): ValidationResult {
    const dropped: Partial<Record<DropReason, number>> = {};
    const drop = (reason: DropReason) => {
        dropped[reason] = (dropped[reason] ?? 0) + 1;
    };
    if (frame.revision !== frame.currentRevision) {
        return { superseded: true, items: [], dropped };
    }
    const items: ReviewCandidate[] = [];
    const time = timeline(frame.turns);
    const labels = new Set(frame.turns.map((turn) => turn.speaker));
    const literalKey =
        frame.literalKey ??
        ((literal: string) => `l:${normalizeText(literal)}`);
    const dismissed = (fingerprint: string) => {
        if (frame.manual || !frame.dismissed.has(fingerprint)) return false;
        drop("dismissed");
        return true;
    };
    const inScope = (node: Target) =>
        "personId" in node
            ? frame.people.has(node.personId)
            : frame.entities.has(node.entityId);

    // Speakers: one per label a person has not answered.
    const suggested = new Set<string>();
    for (const speaker of output.speakers) {
        if (!labels.has(speaker.label)) {
            drop("unknownLabel");
            continue;
        }
        if (frame.answeredLabels.has(speaker.label)) {
            drop("answered");
            continue;
        }
        if (speaker.personId !== null && !frame.people.has(speaker.personId)) {
            drop("outOfScope");
            continue;
        }
        if (suggested.has(speaker.label)) {
            drop("budget");
            continue;
        }
        const evidenceMs = speaker.evidence
            .map((clock) => time.snap(clock))
            .filter((ms): ms is number => ms !== null);
        if (evidenceMs.length === 0) {
            drop("badTime");
            continue;
        }
        const fingerprint = `speaker|${speaker.label}|${speaker.personId ?? "-"}`;
        if (dismissed(fingerprint)) continue;
        suggested.add(speaker.label);
        items.push({
            kind: "speaker",
            fingerprint,
            preTicked: false,
            payload: {
                label: speaker.label,
                personId: speaker.personId,
                evidenceMs: [...new Set(evidenceMs)],
                reason: speaker.reason,
            },
        });
    }

    // Corrections: exact anchors, in scope, grouped per target and words.
    const taken: AnchorPosition[] = [];
    const groups = new Map<
        string,
        Extract<ReviewCandidate, { kind: "correction" }>
    >();
    for (const correction of output.corrections) {
        const kept = validCorrection(correction);
        if (!kept) continue;
        const replacement =
            correction.kind === "link" ? null : (correction.replacement ?? "");
        const group = [
            "correction",
            correction.kind,
            targetKey(correction.target),
            normalizeText(correction.heard),
            replacement === null ? "-" : normalizeText(replacement),
        ].join("|");
        const held = groups.get(group);
        if (held) {
            held.payload.anchors.push(kept);
            continue;
        }
        if (dismissed(group)) continue;
        const item: Extract<ReviewCandidate, { kind: "correction" }> = {
            kind: "correction",
            fingerprint: group,
            preTicked:
                correction.kind === "correct" &&
                "entityId" in correction.target &&
                frame.confirmedHeardAs.has(
                    heardAsKey(
                        correction.target,
                        correction.heard,
                        frame.language,
                        frame.provider,
                    ),
                ),
            payload: {
                kind: correction.kind,
                heard: correction.heard,
                target: correction.target,
                replacement,
                anchors: [kept],
            },
        };
        groups.set(group, item);
        items.push(item);
    }

    function validCorrection(
        correction: LearnCorrection,
    ): AnchorPosition | null {
        const anchor = {
            turnIndex: correction.turnIndex,
            charStart: correction.charStart,
            charEnd: correction.charEnd,
            heard: correction.heard,
        };
        if (!anchorMatches(anchor, frame.turns)) {
            drop("notAtAnchor");
            return null;
        }
        if (!inScope(correction.target)) {
            drop("outOfScope");
            return null;
        }
        if (
            correction.kind === "correct" &&
            (!correction.replacement ||
                correction.replacement.trim() === correction.heard.trim())
        ) {
            drop("unchanged");
            return null;
        }
        const position = {
            turnIndex: anchor.turnIndex,
            charStart: anchor.charStart,
            charEnd: anchor.charEnd,
        };
        if (taken.some((other) => anchorsOverlap(other, position))) {
            drop("overlapping");
            return null;
        }
        taken.push(position);
        return position;
    }

    // Facts, and relation phrases (proposed, or facts of an unknown relation).
    const phrases = new Map<
        string,
        Extract<ReviewCandidate, { kind: "relation_phrase" }>
    >();
    const addPhrase = (
        text: string,
        subject: LearnSubject,
        object: LearnObject,
        startMs: number,
        endMs: number,
    ) => {
        const phrase = normalizePhrase(text);
        if (!phrase) return;
        const held = phrases.get(phrase);
        if (held) {
            held.payload.count++;
            return;
        }
        const fingerprint = `phrase|${phrase}`;
        if (dismissed(fingerprint)) return;
        const dependsOnLabel =
            "speakerLabel" in subject ? subject.speakerLabel : undefined;
        const item: Extract<ReviewCandidate, { kind: "relation_phrase" }> = {
            kind: "relation_phrase",
            fingerprint,
            preTicked: false,
            ...(dependsOnLabel ? { dependsOnLabel } : {}),
            payload: { phrase, subject, object, startMs, endMs, count: 1 },
        };
        phrases.set(phrase, item);
        items.push(item);
    };

    /** The subject's type and key, or null when it may not be named. */
    const subjectOf = (
        subject: LearnSubject,
    ): { type: string; key: string | null } | null => {
        if ("speakerLabel" in subject) {
            if (!labels.has(subject.speakerLabel)) {
                drop("unknownLabel");
                return null;
            }
            return { type: "person", key: null };
        }
        if (!inScope(subject)) {
            drop("outOfScope");
            return null;
        }
        return {
            type:
                "personId" in subject
                    ? "person"
                    : (frame.entities.get(subject.entityId)?.typeKey ?? ""),
            key: nodeKey(subject),
        };
    };
    const objectOf = (
        object: LearnObject,
    ): { type: string | null; key: string } | null => {
        if ("literal" in object) {
            return { type: null, key: literalKey(object.literal) };
        }
        if (!inScope(object)) {
            drop("outOfScope");
            return null;
        }
        return {
            type:
                "personId" in object
                    ? "person"
                    : (frame.entities.get(object.entityId)?.typeKey ?? ""),
            key: nodeKey(object),
        };
    };
    const span = (start: string, end: string) => {
        const startMs = time.snap(start);
        const endMs = time.snap(end);
        if (startMs === null || endMs === null) {
            drop("badTime");
            return null;
        }
        return { startMs, endMs: Math.max(startMs, endMs) };
    };

    let newFacts = 0;
    for (const fact of output.facts) {
        if (fact.sensitivity !== "none") {
            drop("sensitive");
            continue;
        }
        const subject = subjectOf(fact.subject);
        if (!subject) continue;
        const object = objectOf(fact.object);
        if (!object) continue;
        if (fact.speakerLabel !== null && !labels.has(fact.speakerLabel)) {
            drop("unknownLabel");
            continue;
        }
        const times = span(fact.start, fact.end);
        if (!times) continue;
        const relation = frame.relations.get(fact.relationKey);
        if (!relation) {
            addPhrase(
                fact.relationKey,
                fact.subject,
                fact.object,
                times.startMs,
                times.endMs,
            );
            continue;
        }
        if (!fits(relation, subject.type, object.type)) {
            drop("doesNotFit");
            continue;
        }
        const dependsOnLabel =
            "speakerLabel" in fact.subject
                ? fact.subject.speakerLabel
                : (fact.speakerLabel ?? undefined);
        const payload = {
            subject: fact.subject,
            relationKey: fact.relationKey,
            object: fact.object,
            ...times,
            speakerLabel: fact.speakerLabel,
        };
        const known =
            subject.key !== null
                ? frame.knownFacts.get(
                      factKey(subject.key, fact.relationKey, object.key),
                  )
                : undefined;
        if (known) {
            const fingerprint = `known|${known}`;
            if (dismissed(fingerprint)) continue;
            items.push({
                kind: "known_fact",
                fingerprint,
                preTicked: true,
                ...(dependsOnLabel ? { dependsOnLabel } : {}),
                payload: { ...payload, factId: known },
            });
            continue;
        }
        const fingerprint = factFingerprint(fact, subject.key, object.key);
        if (dismissed(fingerprint)) continue;
        if (newFacts >= MAX_NEW_FACTS) {
            drop("budget");
            continue;
        }
        newFacts++;
        items.push({
            kind: "fact",
            fingerprint,
            preTicked: false,
            ...(dependsOnLabel ? { dependsOnLabel } : {}),
            payload,
        });
    }

    for (const proposed of output.relationPhrases) {
        if (!subjectOf(proposed.subject)) continue;
        if (!objectOf(proposed.object)) continue;
        const times = span(proposed.start, proposed.end);
        if (!times) continue;
        addPhrase(
            proposed.phrase,
            proposed.subject,
            proposed.object,
            times.startMs,
            times.endMs,
        );
    }

    return { superseded: false, items, dropped };
}

/** The same rule a person's confirmation applies (`relationFits`). */
function fits(
    relation: VisibleRelation,
    subjectType: string,
    objectType: string | null,
): boolean {
    return relationFits(
        relation,
        subjectType,
        objectType === null ? { literal: true } : { type: objectType },
    );
}

function factFingerprint(
    fact: LearnFact,
    subjectKey: string | null,
    objectKey: string,
): string {
    const subject =
        subjectKey ??
        ("speakerLabel" in fact.subject
            ? `s:${fact.subject.speakerLabel}`
            : "");
    return `fact|${subject}|${fact.relationKey}|${objectKey}`;
}
