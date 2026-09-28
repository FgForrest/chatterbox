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
 * - times snap to the transcript's turns: a span runs from the start of
 *   the turn its start names to the end of the turn its end names, and
 *   must quote something;
 * - heard text must stand exactly at its anchor; ids must be in the run's
 *   scopes; relation keys must be visible, and fit as a person's
 *   confirmation checks them (an unknown relation becomes a phrase to
 *   review);
 * - anything the model marks sensitive goes, whatever the language, and
 *   so does anything whose words name a denied topic (`deniedTopicOf`, a
 *   floor under the model's judgement);
 * - one speaker suggestion per label, and none for a label a person
 *   answered; a fact whose speaker a person already answered otherwise
 *   goes; at most `MAX_NEW_FACTS` new facts, and bounded corrections and
 *   phrases;
 * - what a person dismissed before goes, except on a manual run.
 *
 * Two defaults (the design's fixed rule, never the model's confidence):
 * pre-ticked are a `correct` of a non-person a person confirmed before
 * (heard alike, same provider and language) that writes exactly that
 * entity's name, and a known fact mentioned again whose speaker, if it
 * depends on one, is answered; everything else is unticked. A fact about
 * an unanswered speaker depends on that speaker's answer, so a speaker is
 * never named by a fact of the same run (no circular evidence).
 */

import {
    anchorMatches,
    anchorsOverlap,
} from "@/lib/knowledge/correction-anchors";
import {
    nodeKey,
    quoteFromTurns,
    relationFits,
} from "@/lib/knowledge/fact-rules";
import { deniedTopicOf } from "@/lib/knowledge/vocabulary-core";
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
export const MAX_CORRECTION_ITEMS = 50;
export const MAX_PHRASE_ITEMS = 20;

export interface VisibleRelation {
    subjectTypes: readonly string[];
    /** The types an entity object may have; a literal relation has none. */
    objectTypes: readonly string[];
    objectKind: "entity" | "literal";
    /** Its name, screened against the denied topics. */
    label?: string;
}

/** What a run may know, frozen when its answer is validated. */
export interface LearnRunFrame {
    /** The transcript revision the run read. */
    revision: number;
    /** The transcript's revision now. */
    currentRevision: number;
    /**
     * The transcript's identity, in the fingerprints of what depends on its
     * labels (a label names one voice in one diarization only).
     */
    transcriptKey?: string;
    turns: readonly TranscriptTurn[];
    language: string | null;
    provider: string | null;
    manual: boolean;
    /** The people and entities in the run's scopes. */
    people: ReadonlyMap<string, { name: string }>;
    entities: ReadonlyMap<string, { typeKey: string; name: string }>;
    /** The relations visible to the run's scope, active. */
    relations: ReadonlyMap<string, VisibleRelation>;
    /** Labels a person already answered: the person named, or null for unknown. */
    answeredLabels: ReadonlyMap<string, string | null>;
    /** `heardAsKey` of every heard-as form a person confirmed. */
    confirmedHeardAs: ReadonlySet<string>;
    /** Current facts in the run's scopes: `factKey` -> fact id. */
    knownFacts: ReadonlyMap<string, string>;
    /** Items a person dismissed on this recording, as `fingerprintKey` gives them. */
    dismissed: ReadonlySet<string>;
    /** How a fingerprint is stored (a keyed HMAC); as is by default. */
    fingerprintKey?: (fingerprint: string) => string;
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
    | "speakerDecided"
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
              /** The thing it relates to; absent where that was text. */
              object?: Target;
              objectKind: "entity" | "literal";
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
    return JSON.stringify([
        "personId" in target ? target.personId : target.entityId,
        normalizeText(heard),
        language ?? "",
        provider ?? "",
    ]);
}

/** A fact's identity in a scope: subject, relation, object. */
export function factKey(
    subject: string,
    relationKey: string,
    object: string,
): string {
    return JSON.stringify([subject, relationKey, object]);
}

function normalizePhrase(text: string): string {
    return text.replaceAll("_", " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeText(text: string): string {
    return text.trim().normalize("NFC").toLowerCase();
}

/**
 * The transcript's turns as the times a clock may name: a start snaps to
 * the start of the turn whose start is nearest, an end to the end of the
 * turn whose start is nearest (so a fact said within one line spans it).
 */
function timeline(turns: readonly TranscriptTurn[]) {
    const endMs = Math.max(0, ...turns.map((turn) => turn.endMs));
    const nearestTurn = (clock: string): TranscriptTurn | null => {
        const ms = parseClock(clock);
        if (ms === null || ms > endMs || turns.length === 0) return null;
        let best = turns[0] as TranscriptTurn;
        for (const turn of turns) {
            if (Math.abs(turn.startMs - ms) < Math.abs(best.startMs - ms)) {
                best = turn;
            }
        }
        return best;
    };
    return {
        start: (clock: string) => nearestTurn(clock)?.startMs ?? null,
        end: (clock: string) => nearestTurn(clock)?.endMs ?? null,
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
    const transcriptKey = frame.transcriptKey ?? "";
    const literalKey =
        frame.literalKey ??
        ((literal: string) => `l:${normalizeText(literal)}`);
    const stored =
        frame.fingerprintKey ?? ((fingerprint: string) => fingerprint);
    const dismissed = (fingerprint: string) => {
        if (frame.manual || !frame.dismissed.has(stored(fingerprint))) {
            return false;
        }
        drop("dismissed");
        return true;
    };
    const inScope = (node: Target) =>
        "personId" in node
            ? frame.people.has(node.personId)
            : frame.entities.has(node.entityId);
    const denied = (...texts: (string | undefined)[]) =>
        texts.some((text) => text !== undefined && deniedTopicOf(text));

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
            .map((clock) => time.start(clock))
            .filter((ms): ms is number => ms !== null);
        if (evidenceMs.length === 0) {
            drop("badTime");
            continue;
        }
        const fingerprint = JSON.stringify([
            "speaker",
            transcriptKey,
            speaker.label,
            speaker.personId,
        ]);
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
        const replacement =
            correction.kind === "link" ? null : (correction.replacement ?? "");
        const group = JSON.stringify([
            "correction",
            correction.kind,
            nodeKey(correction.target),
            normalizeText(correction.heard),
            replacement === null ? null : normalizeText(replacement),
        ]);
        const held = groups.get(group);
        // Dismissed words stay free for another correction.
        if (!held && dismissed(group)) continue;
        const kept = validCorrection(correction);
        if (!kept) continue;
        if (held) {
            held.payload.anchors.push(kept);
            continue;
        }
        if (groups.size >= MAX_CORRECTION_ITEMS) {
            drop("budget");
            continue;
        }
        const entity =
            "entityId" in correction.target
                ? frame.entities.get(correction.target.entityId)
                : undefined;
        const item: Extract<ReviewCandidate, { kind: "correction" }> = {
            kind: "correction",
            fingerprint: group,
            // Confirmed before, and writing exactly the entity's name:
            // nothing else a model says may be applied by default.
            preTicked:
                correction.kind === "correct" &&
                entity !== undefined &&
                replacement !== null &&
                normalizeText(replacement) === normalizeText(entity.name) &&
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
        if (
            correction.kind === "correct" &&
            denied(correction.replacement ?? "")
        ) {
            drop("sensitive");
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

    // What a speaker label stands for, where a person answered it.
    const resolveSubject = (subject: LearnSubject): LearnSubject | null => {
        if (!("speakerLabel" in subject)) return subject;
        if (!labels.has(subject.speakerLabel)) {
            drop("unknownLabel");
            return null;
        }
        if (!frame.answeredLabels.has(subject.speakerLabel)) return subject;
        const personId = frame.answeredLabels.get(subject.speakerLabel);
        if (!personId) {
            // Answered as unknown: nobody the fact could be about.
            drop("speakerDecided");
            return null;
        }
        return { personId };
    };
    const subjectOf = (
        subject: LearnSubject,
    ): { type: string; key: string | null } | null => {
        if ("speakerLabel" in subject) return { type: "person", key: null };
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
        const startMs = time.start(start);
        const endMs = time.end(end);
        if (
            startMs === null ||
            endMs === null ||
            endMs <= startMs ||
            !quoteFromTurns(frame.turns, startMs, endMs)
        ) {
            drop("badTime");
            return null;
        }
        return { startMs, endMs };
    };
    const literalOf = (object: LearnObject) =>
        "literal" in object ? object.literal : undefined;

    // Relation phrases, proposed or from facts of an unknown relation: only
    // the phrase and what it relates, never text it relates to.
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
        if (denied(phrase, literalOf(object))) {
            drop("sensitive");
            return;
        }
        const held = phrases.get(phrase);
        if (held) {
            held.payload.count++;
            return;
        }
        const fingerprint = JSON.stringify(["phrase", phrase]);
        if (dismissed(fingerprint)) return;
        if (phrases.size >= MAX_PHRASE_ITEMS) {
            drop("budget");
            return;
        }
        const dependsOnLabel =
            "speakerLabel" in subject ? subject.speakerLabel : undefined;
        const item: Extract<ReviewCandidate, { kind: "relation_phrase" }> = {
            kind: "relation_phrase",
            fingerprint,
            preTicked: false,
            ...(dependsOnLabel ? { dependsOnLabel } : {}),
            payload: {
                phrase,
                subject,
                ...("literal" in object ? {} : { object }),
                objectKind: "literal" in object ? "literal" : "entity",
                startMs,
                endMs,
                count: 1,
            },
        };
        phrases.set(phrase, item);
        items.push(item);
    };

    const known = new Set<string>();
    let newFacts = 0;
    for (const fact of output.facts) {
        if (fact.sensitivity !== "none") {
            drop("sensitive");
            continue;
        }
        const relation = frame.relations.get(fact.relationKey);
        if (denied(literalOf(fact.object), relation?.label)) {
            drop("sensitive");
            continue;
        }
        const subject = resolveSubject(fact.subject);
        if (!subject) continue;
        const subjectSide = subjectOf(subject);
        if (!subjectSide) continue;
        const object = objectOf(fact.object);
        if (!object) continue;
        if (fact.speakerLabel !== null) {
            if (!labels.has(fact.speakerLabel)) {
                drop("unknownLabel");
                continue;
            }
            // Answered already: the fact holds only if it is about them.
            if (frame.answeredLabels.has(fact.speakerLabel)) {
                const personId = frame.answeredLabels.get(fact.speakerLabel);
                const about = [subject, fact.object].some(
                    (side) =>
                        personId &&
                        "personId" in side &&
                        side.personId === personId,
                );
                if (!about) {
                    drop("speakerDecided");
                    continue;
                }
            }
        }
        const times = span(fact.start, fact.end);
        if (!times) continue;
        if (!relation) {
            addPhrase(
                fact.relationKey,
                subject,
                fact.object,
                times.startMs,
                times.endMs,
            );
            continue;
        }
        if (
            !relationFits(
                relation,
                subjectSide.type,
                object.type === null
                    ? { literal: true }
                    : { type: object.type },
            )
        ) {
            drop("doesNotFit");
            continue;
        }
        // Waits for a speaker's answer only while nobody gave it.
        const pendingLabel =
            "speakerLabel" in subject
                ? subject.speakerLabel
                : fact.speakerLabel !== null &&
                    !frame.answeredLabels.has(fact.speakerLabel)
                  ? fact.speakerLabel
                  : undefined;
        const payload = {
            subject,
            relationKey: fact.relationKey,
            object: fact.object,
            ...times,
            speakerLabel: fact.speakerLabel,
        };
        const knownId =
            subjectSide.key !== null
                ? frame.knownFacts.get(
                      factKey(subjectSide.key, fact.relationKey, object.key),
                  )
                : undefined;
        if (knownId) {
            if (known.has(knownId)) continue;
            known.add(knownId);
            const fingerprint = JSON.stringify(["known", knownId]);
            if (dismissed(fingerprint)) continue;
            items.push({
                kind: "known_fact",
                fingerprint,
                preTicked: pendingLabel === undefined,
                ...(pendingLabel ? { dependsOnLabel: pendingLabel } : {}),
                payload: { ...payload, factId: knownId },
            });
            continue;
        }
        const fingerprint = factFingerprint(
            fact,
            subjectSide.key,
            object.key,
            transcriptKey,
        );
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
            ...(pendingLabel ? { dependsOnLabel: pendingLabel } : {}),
            payload,
        });
    }

    for (const proposed of output.relationPhrases) {
        if (proposed.sensitivity !== "none") {
            drop("sensitive");
            continue;
        }
        const subject = resolveSubject(proposed.subject);
        if (!subject) continue;
        if (!subjectOf(subject)) continue;
        if (!objectOf(proposed.object)) continue;
        const times = span(proposed.start, proposed.end);
        if (!times) continue;
        addPhrase(
            proposed.phrase,
            subject,
            proposed.object,
            times.startMs,
            times.endMs,
        );
    }

    return { superseded: false, items, dropped };
}

function factFingerprint(
    fact: LearnFact,
    subjectKey: string | null,
    objectKey: string,
    transcriptKey: string,
): string {
    // About a voice: that voice is one label of one transcript.
    const subject =
        subjectKey ??
        ("speakerLabel" in fact.subject
            ? `s:${transcriptKey}:${fact.subject.speakerLabel}`
            : "");
    return JSON.stringify(["fact", subject, fact.relationKey, objectKey]);
}
