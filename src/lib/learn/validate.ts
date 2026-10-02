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
 *   answered: a label's suggestions (one per window) join, a name beats
 *   "nobody known", and names that disagree give nothing; a name heard
 *   only as a first name (no surname or nickname of theirs near the
 *   evidence) is marked so, for the reviewer; the person who made the
 *   recording (`recorderPersonId`) may be named for one label without
 *   their name being heard, on the role the transcript gives them, and is
 *   marked so;
 * - a correction of a thing takes every other place its words stand
 *   alone, exactly as heard: a thing misheard once is misheard alike
 *   wherever it is said (never a person's, who may be a namesake);
 * - a fact whose speaker a person already answered otherwise
 *   goes; at most `MAX_NEW_FACTS` new facts, and bounded corrections and
 *   phrases;
 * - what a person dismissed before goes, on a run they asked for too
 *   (Re-learn brings back only what is new);
 * - people and things the answer proposes to add are kept as
 *   `validate-new-records.ts` says; what refers to one it dropped goes,
 *   and what refers to one the Almanac has refers to that record.
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
import {
    heardIsFirstNameOnly,
    heardIsTheName,
    moreThanFirstName,
    nameParts,
    nameTokens,
} from "@/lib/learn/name-match";
import { replaceRefs } from "@/lib/learn/new-refs";
import type {
    LearnCorrection,
    LearnFact,
    LearnObject,
    LearnOutput,
    LearnSubject,
} from "@/lib/learn/output";
import {
    type NewRecordCandidate,
    type NewRecordDrop,
    validateNewRecords,
} from "@/lib/learn/validate-new-records";
import { parseClock } from "@/lib/topics/timeline";
import type { TranscriptTurn } from "@/lib/transcription/turns";

export const MAX_NEW_FACTS = 10;
export const MAX_CORRECTION_ITEMS = 50;
/** Places one correction of a thing takes, the ones the model gave first. */
export const MAX_CORRECTION_ANCHORS = 50;
export const MAX_PHRASE_ITEMS = 20;

export interface VisibleRelation {
    subjectTypes: readonly string[];
    /** The types an entity object may have; a literal relation has none. */
    objectTypes: readonly string[];
    objectKind: "entity" | "literal";
    /** One value at a time (a new one replaces it), or many. */
    cardinality?: "one" | "many";
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
    /** The people and entities in the run's scopes, with their nicknames. */
    people: ReadonlyMap<string, { name: string; aliases?: readonly string[] }>;
    entities: ReadonlyMap<
        string,
        { typeKey: string; name: string; aliases?: readonly string[] }
    >;
    /** The types a new thing may take in the run's scope. */
    entityTypes?: ReadonlySet<string>;
    /** The relations visible to the run's scope, active. */
    relations: ReadonlyMap<string, VisibleRelation>;
    /** Labels a person already answered: the person named, or null for unknown. */
    answeredLabels: ReadonlyMap<string, string | null>;
    /**
     * The person who made the recording (whose record carries the account's
     * email), when the run's scopes have them.
     */
    recorderPersonId?: string | null;
    /** `heardAsKey` of every heard-as form a person confirmed. */
    confirmedHeardAs: ReadonlySet<string>;
    /** Current facts in the run's own scope: `factKey` -> fact id. */
    knownFacts: ReadonlyMap<string, string>;
    /**
     * `factKey` of current facts in the other scopes the run reads (the
     * Organization's, on a private recording): known there, and not
     * proposed to be copied into the run's scope.
     */
    foreignFacts?: ReadonlySet<string>;
    /**
     * The current value of a subject's relation in the run's own scope,
     * by `currentFactKey`: what a new fact on a relation of one value
     * replaces.
     */
    currentFacts?: ReadonlyMap<string, { factId: string; object: LearnObject }>;
    /**
     * Where the transcript already carries a confirmed correction (in the
     * run's view): nothing is proposed on those words again.
     */
    corrected?: readonly AnchorPosition[];
    /**
     * Items a person dismissed on this recording, and new records they
     * rejected on any, as `fingerprintKey` gives them.
     */
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
    | "knownElsewhere"
    | "conflicting"
    | "firstNameOnly"
    | "ambiguousFirstName"
    | "unknownRef"
    | NewRecordDrop
    | "budget";

interface AnchorPosition {
    turnIndex: number;
    charStart: number;
    charEnd: number;
}

type Target = { personId: string } | { entityId: string };
/** A known record, or a new one the same run proposes. */
type TargetOrNew = Target | { newRef: string };

export type ReviewCandidate =
    | NewRecordCandidate
    | {
          kind: "speaker";
          fingerprint: string;
          preTicked: false;
          payload: {
              label: string;
              personId: string | null;
              /** A person the same run proposes to add, when it is them. */
              newRef?: string;
              evidenceMs: number[];
              reason: string;
              /** Heard by a first name alone: no surname or nickname near it. */
              onlyFirstName?: true;
              /** The person who made the recording, named on their role. */
              recorder?: true;
          };
      }
    | {
          kind: "correction";
          fingerprint: string;
          preTicked: boolean;
          payload: {
              kind: "correct" | "link";
              heard: string;
              target: TargetOrNew;
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
              /**
               * On a relation with one value: the value current when the
               * run looked, which confirming replaces (and nothing else).
               */
              replaces?: { factId: string; object: LearnObject };
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
              object?: TargetOrNew;
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

/** How `currentFacts` is keyed: a subject's relation. */
export function currentFactKey(
    subjectKey: string,
    relationKey: string,
): string {
    return JSON.stringify(["current", subjectKey, relationKey]);
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
        if (!frame.dismissed.has(stored(fingerprint))) return false;
        drop("dismissed");
        return true;
    };
    const denied = (...texts: (string | undefined)[]) =>
        texts.some((text) => text !== undefined && deniedTopicOf(text));

    // New people and things first: what refers to them is checked against
    // what they became (a known record, one of them, or nothing).
    const news = validateNewRecords(
        output.newRecords,
        output.corrections,
        frame,
        { startOf: time.start, dismissed, drop },
    );
    items.push(...news.items);
    const withRefs = <T>(value: T): T | null => {
        const resolved = replaceRefs(value, news.resolve);
        if (resolved === null) drop("unknownRef");
        return resolved;
    };
    const inScope = (node: TargetOrNew) =>
        "newRef" in node
            ? news.record(node.newRef) !== undefined
            : "personId" in node
              ? frame.people.has(node.personId)
              : frame.entities.has(node.entityId);
    const keyOf = (node: TargetOrNew) =>
        "newRef" in node ? news.keyOf(node.newRef) : nodeKey(node);
    const typeOf = (node: TargetOrNew): string => {
        if ("personId" in node) return "person";
        if ("entityId" in node) {
            return frame.entities.get(node.entityId)?.typeKey ?? "";
        }
        const record = news.record(node.newRef);
        return record?.kind === "entity" ? (record.typeKey ?? "") : "person";
    };
    /** A person, known or new, as a name is matched against them. */
    const personOf = (node: TargetOrNew) => {
        if ("personId" in node) return frame.people.get(node.personId);
        if (!("newRef" in node)) return undefined;
        const record = news.record(node.newRef);
        return record?.kind === "person" ? { name: record.name } : undefined;
    };
    const nameOf = (node: TargetOrNew) =>
        "entityId" in node
            ? frame.entities.get(node.entityId)?.name
            : "newRef" in node
              ? news.record(node.newRef)?.name
              : frame.people.get(node.personId)?.name;

    // Speakers: one per label a person has not answered, the label's
    // suggestions (a run makes one per window) joined.
    const perLabel = new Map<
        string,
        {
            personId: string | null;
            newRef?: string;
            evidenceMs: number[];
            reason: string;
        }[]
    >();
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
        const evidenceMs = speaker.evidence
            .map((clock) => time.start(clock))
            .filter((ms): ms is number => ms !== null);
        if (evidenceMs.length === 0) {
            drop("badTime");
            continue;
        }
        const held = perLabel.get(speaker.label) ?? [];
        held.push({
            personId: speaker.personId,
            evidenceMs,
            reason: speaker.reason,
        });
        perLabel.set(speaker.label, held);
    }
    // The people the answer adds, or found known, where it said they speak.
    for (const link of news.speakers) {
        if (!labels.has(link.label) || frame.answeredLabels.has(link.label)) {
            continue;
        }
        const held = perLabel.get(link.label) ?? [];
        held.push({
            personId: "personId" in link.target ? link.target.personId : null,
            ...("newRef" in link.target ? { newRef: link.target.newRef } : {}),
            evidenceMs: link.evidenceMs,
            reason: link.reason,
        });
        perLabel.set(link.label, held);
    }
    for (const [label, suggestions] of perLabel) {
        const named = suggestions.filter(
            (one) => one.personId !== null || one.newRef !== undefined,
        );
        const people = new Set(
            named.map(
                (one) => one.personId ?? keyOf({ newRef: one.newRef ?? "" }),
            ),
        );
        if (people.size > 1) {
            // Windows that disagree: no side is shown as Learn's answer.
            for (const _ of named) drop("conflicting");
            continue;
        }
        // A name beats "nobody known", which only a window without the
        // evidence may have said.
        const kept = named.length > 0 ? named : suggestions;
        const personId = kept[0]?.personId ?? null;
        const newRef = personId === null ? kept[0]?.newRef : undefined;
        const evidenceMs = [
            ...new Set(kept.flatMap((one) => one.evidenceMs)),
        ].sort((a, b) => a - b);
        const reason = [...new Set(kept.map((one) => one.reason))]
            .filter(Boolean)
            .join(" ");
        const fingerprint = JSON.stringify([
            "speaker",
            transcriptKey,
            label,
            personId ?? (newRef ? keyOf({ newRef }) : null),
        ]);
        if (dismissed(fingerprint)) continue;
        const person = personId
            ? frame.people.get(personId)
            : newRef
              ? personOf({ newRef })
              : undefined;
        // Whoever made the recording is rarely called by name in it: no
        // name to have heard.
        const recorder =
            personId !== null && personId === frame.recorderPersonId;
        const onlyFirstName =
            !recorder &&
            person !== undefined &&
            !fullNameNear(person, frame.turns, evidenceMs);
        // A first name alone that two people known here share names
        // neither: "Michale" is Michal Vondra or Michal Bednář (the
        // model sees only what its lookups found, often one of them).
        if (
            onlyFirstName &&
            personId &&
            sharesFirstName(personId, frame.people)
        ) {
            drop("ambiguousFirstName");
            continue;
        }
        items.push({
            kind: "speaker",
            fingerprint,
            preTicked: false,
            payload: {
                label,
                personId,
                ...(newRef ? { newRef } : {}),
                evidenceMs,
                reason,
                ...(onlyFirstName ? { onlyFirstName: true as const } : {}),
                ...(recorder ? { recorder: true as const } : {}),
            },
        });
    }
    // The recorder named on their role is one voice: on two labels (or
    // with a label answered as them already) the role tells nobody which.
    const recorderId = frame.recorderPersonId ?? null;
    const recorderNamed =
        recorderId !== null &&
        [...frame.answeredLabels.values()].includes(recorderId);
    const asRecorder = items.filter(
        (item) => item.kind === "speaker" && item.payload.recorder,
    );
    if (asRecorder.length > 1 || (asRecorder.length > 0 && recorderNamed)) {
        for (const item of asRecorder) {
            items.splice(items.indexOf(item), 1);
            drop("conflicting");
        }
    }

    // Corrections: exact anchors, in scope, grouped per target and words.
    const taken: AnchorPosition[] = [...(frame.corrected ?? [])];
    const groups = new Map<
        string,
        Extract<ReviewCandidate, { kind: "correction" }>
    >();
    for (const proposed of output.corrections) {
        const correction = withRefs(proposed);
        if (!correction) continue;
        const replacement =
            correction.kind === "link" ? null : (correction.replacement ?? "");
        const group = JSON.stringify([
            "correction",
            correction.kind,
            keyOf(correction.target),
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
        const target = correction.target;
        const entity =
            "entityId" in target
                ? frame.entities.get(target.entityId)
                : undefined;
        const item: Extract<ReviewCandidate, { kind: "correction" }> = {
            kind: "correction",
            fingerprint: group,
            // Confirmed before, and writing exactly the entity's name:
            // nothing else a model says may be applied by default.
            preTicked:
                correction.kind === "correct" &&
                entity !== undefined &&
                "entityId" in target &&
                replacement !== null &&
                normalizeText(replacement) === normalizeText(entity.name) &&
                frame.confirmedHeardAs.has(
                    heardAsKey(
                        target,
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

    // A thing's words, wherever else they stand alone exactly as heard.
    for (const item of groups.values()) {
        if (personOf(item.payload.target)) continue;
        const anchors = item.payload.anchors;
        for (const position of occurrences(item.payload.heard, frame.turns)) {
            if (anchors.length >= MAX_CORRECTION_ANCHORS) break;
            if (taken.some((other) => anchorsOverlap(other, position))) {
                continue;
            }
            taken.push(position);
            anchors.push(position);
        }
        anchors.sort(
            (a, b) => a.turnIndex - b.turnIndex || a.charStart - b.charStart,
        );
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
        const person = personOf(correction.target);
        // A person named by their first name alone is a guess among
        // everyone of that name (the meeting may hold someone nobody
        // knows): not proposed, as a link or as a rewrite.
        if (person && heardIsFirstNameOnly(correction.heard, person)) {
            drop("firstNameOnly");
            return null;
        }
        // Linking the name itself, as said, tells nobody anything.
        const name = nameOf(correction.target);
        if (
            correction.kind === "link" &&
            name !== undefined &&
            heardIsTheName(correction.heard, name)
        ) {
            drop("unchanged");
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
        return { type: typeOf(subject), key: keyOf(subject) };
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
        return { type: typeOf(object), key: keyOf(object) };
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
    for (const proposed of output.facts) {
        const fact = withRefs(proposed);
        if (!fact) continue;
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
        // A fact about a speaker depends on who that speaker is, whoever
        // said it: its evidence is tied to them.
        const tiedTo =
            "speakerLabel" in fact.subject
                ? fact.subject.speakerLabel
                : fact.speakerLabel;
        const payload = {
            subject,
            relationKey: fact.relationKey,
            object: fact.object,
            ...times,
            speakerLabel: tiedTo,
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
        if (
            subjectSide.key !== null &&
            frame.foreignFacts?.has(
                factKey(subjectSide.key, fact.relationKey, object.key),
            )
        ) {
            drop("knownElsewhere");
            continue;
        }
        const fingerprint = factFingerprint(
            fact,
            subjectSide.key,
            object.key,
            transcriptKey,
        );
        if (dismissed(fingerprint)) continue;
        const replaces =
            relation.cardinality === "one" && subjectSide.key !== null
                ? frame.currentFacts?.get(
                      currentFactKey(subjectSide.key, fact.relationKey),
                  )
                : undefined;
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
            payload: replaces ? { ...payload, replaces } : payload,
        });
    }

    for (const phrase of output.relationPhrases) {
        const proposed = withRefs(phrase);
        if (!proposed) continue;
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

/** Whether another person known here has this person's first name. */
function sharesFirstName(
    personId: string,
    people: LearnRunFrame["people"],
): boolean {
    const first = nameParts(people.get(personId)?.name ?? "")[0];
    if (!first) return false;
    for (const [id, other] of people) {
        if (id !== personId && nameParts(other.name)[0] === first) return true;
    }
    return false;
}

/** Turns either side of an evidence turn searched for the rest of a name. */
const NAME_RADIUS = 3;

/**
 * Whether more than a first name backs a speaker: the person's surname or
 * a nickname of theirs, said within `NAME_RADIUS` turns of the evidence
 * (`moreThanFirstName`: Czech inflection, no titles or initials, a one-word
 * name counts as a first name).
 */
/** Where `heard` stands in the turns as whole words, exactly as written. */
export function occurrences(
    heard: string,
    turns: readonly TranscriptTurn[],
): AnchorPosition[] {
    const found: AnchorPosition[] = [];
    if (!heard.trim()) return found;
    const wordChar = /[\p{L}\p{N}]/u;
    turns.forEach((turn, turnIndex) => {
        let from = 0;
        for (;;) {
            const charStart = turn.text.indexOf(heard, from);
            if (charStart < 0) break;
            const charEnd = charStart + heard.length;
            from = charStart + 1;
            const before = turn.text.slice(0, charStart).at(-1) ?? "";
            const after = turn.text.slice(charEnd)[0] ?? "";
            if (wordChar.test(before) || wordChar.test(after)) continue;
            if (
                !anchorMatches({ turnIndex, charStart, charEnd, heard }, turns)
            ) {
                continue;
            }
            found.push({ turnIndex, charStart, charEnd });
        }
    });
    return found;
}

export function fullNameNear(
    person: { name: string; aliases?: readonly string[] },
    turns: readonly TranscriptTurn[],
    evidenceMs: readonly number[],
): boolean {
    const near = new Set<number>();
    for (const ms of evidenceMs) {
        let at = 0;
        turns.forEach((turn, index) => {
            const best = turns[at] as TranscriptTurn;
            if (Math.abs(turn.startMs - ms) < Math.abs(best.startMs - ms)) {
                at = index;
            }
        });
        for (
            let index = Math.max(0, at - NAME_RADIUS);
            index <= Math.min(turns.length - 1, at + NAME_RADIUS);
            index++
        ) {
            near.add(index);
        }
    }
    const tokens = [...near].flatMap((index) =>
        nameTokens(turns[index]?.text ?? ""),
    );
    return moreThanFirstName(tokens, person);
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
