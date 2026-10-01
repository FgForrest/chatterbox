/**
 * The people and things a Learn answer proposes to add (`newRecords`), as
 * the validation keeps them (`validate.ts`). Pure.
 *
 * - A name the Almanac already has (a person's name or nickname, a thing's
 *   name or nickname, the thing's own type first) is not new: the ref
 *   stands for that record, and what refers to it is checked as usual.
 *   Two people of that name name neither, and nothing refers to it.
 * - A thing takes one of the types a new thing may take; a person none.
 * - The name must be said where its evidence is (inflected as Czech says
 *   it), or be what a correction the answer proposes for it writes there:
 *   a record named only by a misheard form is still found.
 * - Not a common word: a person's name has a capital; a thing's has one or
 *   is said in two turns at least. Not a name on a denied topic.
 * - One record per name (and type): refs that name it again join it. A
 *   ref defined twice, differently, stands for nothing.
 * - A record a person rejected before is not proposed again, on any
 *   recording of the scope (`["new", kind, type, name]`, dismissed
 *   scope-wide), and nothing refers to it.
 * - At most `MAX_NEW_RECORDS`; a person named by a first name alone is
 *   marked so, for the reviewer. None is pre-ticked.
 */

import { anchorMatches } from "@/lib/knowledge/correction-anchors";
import {
    type MatchReason,
    NameIndex,
    type WordStemmer,
} from "@/lib/knowledge/name-match";
import { stemmingLanguage, stemVariants } from "@/lib/knowledge/stemming";
import { deniedTopicOf } from "@/lib/knowledge/vocabulary-core";
import { isNameWord, nameParts, nameWords } from "@/lib/learn/name-match";
import { type RecordTarget, recordNameKey } from "@/lib/learn/new-refs";
import type { LearnCorrection, LearnNewRecord } from "@/lib/learn/output";
import type { TranscriptTurn } from "@/lib/transcription/turns";

export const MAX_NEW_RECORDS = 20;

/** Turns either side of an evidence turn the name may be said in. */
const EVIDENCE_RADIUS = 1;
/**
 * Lookup matches that may make a new record a known one, misheard. Not a
 * known name inside a longer one ("Google" in "Google Cloud Platform"),
 * nor trigrams alone; and for a person not word forms either, which join
 * "Martina Nováková" with Martin Novák and "Pavla" with Pavel.
 */
const MAYBE_REASONS: Record<"person" | "entity", ReadonlySet<MatchReason>> = {
    person: new Set(["exact", "token", "edit"]),
    entity: new Set(["exact", "token", "edit", "stem"]),
};

export interface NewRecordPayload {
    ref: string;
    kind: "person" | "entity";
    /** The thing's type; null for a person. */
    typeKey: string | null;
    name: string;
    evidenceMs: number[];
    reason: string;
    /** The label this person speaks under, where the answer said so. */
    speakerLabel?: string;
    /** A person named by one word: a first name, most likely. */
    onlyFirstName?: true;
    /**
     * A record the Almanac has whose name is close to this one (a misheard
     * "Weltrix" for Veltrix): the reviewer is asked whether it is that one.
     */
    maybe?: RecordTarget;
}

export interface NewRecordCandidate {
    kind: "new_record";
    fingerprint: string;
    preTicked: false;
    payload: NewRecordPayload;
}

export type NewRecordDrop =
    | "conflicting"
    | "sensitive"
    | "badType"
    | "badTime"
    | "notInEvidence"
    | "generic"
    | "ambiguousName"
    | "dismissed"
    | "budget";

export interface NewRecordsFrame {
    turns: readonly TranscriptTurn[];
    people: ReadonlyMap<string, { name: string; aliases?: readonly string[] }>;
    entities: ReadonlyMap<
        string,
        { typeKey: string; name: string; aliases?: readonly string[] }
    >;
    /** The types a new thing may take in the run's scope. */
    entityTypes?: ReadonlySet<string>;
    /** The transcript's language: names are compared in their forms. */
    language?: string | null;
}

export interface NewRecords {
    items: NewRecordCandidate[];
    /**
     * What a ref of the answer stands for: a record the Almanac has, the
     * new record it joined (by its kept ref), or nothing (dropped).
     */
    resolve: (ref: string) => RecordTarget | { newRef: string } | undefined;
    /** A kept record by its ref. */
    record: (ref: string) => NewRecordPayload | undefined;
    /** How a kept record is keyed where a node's key is (`nodeKey`). */
    keyOf: (ref: string) => string;
    /** Speakers the answer said these records are, known or new. */
    speakers: {
        label: string;
        target: { personId: string } | { newRef: string };
        evidenceMs: number[];
        reason: string;
    }[];
}

/** How a new record's rejection is remembered, whatever it was proposed on. */
export function newRecordFingerprint(
    kind: "person" | "entity",
    typeKey: string | null,
    name: string,
): string {
    return JSON.stringify([
        "new",
        kind,
        kind === "person" ? null : typeKey,
        recordNameKey(name),
    ]);
}

/**
 * Whether a heard name `a` is a known name `b` (letters only, lower case)
 * misheard or shortened: they differ by an edit (two, from seven letters
 * on), or, with `shortened`, `a` starts `b` (four letters at least: "evita"
 * for "evitadb"). Never `b` starting `a`: "orbitaserver" is something
 * besides Orbita, and "holubova" someone besides Holub.
 */
export function close(a: string, b: string, shortened = true): boolean {
    if (!a || !b || a === b) return a === b && a.length > 0;
    if (shortened && a.length >= 4 && b.startsWith(a)) return true;
    const limit = Math.min(a.length, b.length) >= 7 ? 2 : 1;
    if (
        Math.min(a.length, b.length) < 4 ||
        Math.abs(a.length - b.length) > limit
    ) {
        return false;
    }
    let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i++) {
        const current = [i];
        for (let j = 1; j <= b.length; j++) {
            current[j] = Math.min(
                (previous[j] ?? 0) + 1,
                (current[j - 1] ?? 0) + 1,
                (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
        }
        previous = current;
    }
    return (previous[b.length] ?? limit + 1) <= limit;
}

/** Whether every word of `name` is said in `texts`, inflected or not. */
export function nameSaidIn(name: string, texts: readonly string[]): boolean {
    const words = texts.flatMap((text) => nameWords(text));
    const parts = nameParts(name);
    if (parts.length === 0) {
        // One letter, or only a title: the words as they stand.
        const wanted = nameWords(name).join(" ");
        return (
            wanted.length > 0 &&
            texts.some((text) =>
                ` ${nameWords(text).join(" ")} `.includes(` ${wanted} `),
            )
        );
    }
    return parts.every((part) => words.some((word) => isNameWord(word, part)));
}

export function validateNewRecords(
    records: readonly LearnNewRecord[],
    corrections: readonly LearnCorrection[],
    frame: NewRecordsFrame,
    {
        startOf,
        dismissed,
        drop,
    }: {
        /** The start of the turn a clock names, or null. */
        startOf: (clock: string) => number | null;
        /** Whether a person dismissed this fingerprint (counted if so). */
        dismissed: (fingerprint: string) => boolean;
        drop: (reason: NewRecordDrop) => void;
    },
): NewRecords {
    const turns = frame.turns;
    const peopleByName = new Map<string, string[]>();
    for (const [id, person] of frame.people) {
        for (const name of [person.name, ...(person.aliases ?? [])]) {
            const key = recordNameKey(name);
            const ids = peopleByName.get(key) ?? [];
            if (!ids.includes(id)) ids.push(id);
            peopleByName.set(key, ids);
        }
    }
    const entitiesByName = new Map<string, { id: string; typeKey: string }[]>();
    for (const [id, entity] of frame.entities) {
        for (const name of [entity.name, ...(entity.aliases ?? [])]) {
            const key = recordNameKey(name);
            const found = entitiesByName.get(key) ?? [];
            if (!found.some((one) => one.id === id)) {
                found.push({ id, typeKey: entity.typeKey });
            }
            entitiesByName.set(key, found);
        }
    }
    const turnAt = (ms: number) => {
        let best = 0;
        turns.forEach((turn, index) => {
            const held = turns[best] as TranscriptTurn;
            if (Math.abs(turn.startMs - ms) < Math.abs(held.startMs - ms)) {
                best = index;
            }
        });
        return best;
    };
    /**
     * The evidence that names a speaker: where that label speaks (an
     * introduction) or answers next (addressed by name). A name said
     * elsewhere is about someone, not proof of who speaks; and whether
     * more than a first name backs the speaker is judged on these alone.
     * The turn itself must say the name (any word of it, or of `names`):
     * the label speaking near the name proves nothing.
     */
    const speakingAs = (
        label: string,
        names: readonly string[],
        evidenceMs: readonly number[],
    ) =>
        evidenceMs.filter((ms) => {
            const at = turnAt(ms);
            const text = turns[at]?.text ?? "";
            return (
                (turns[at]?.speaker === label ||
                    turns[at + 1]?.speaker === label) &&
                names.some((name) => {
                    const parts = nameParts(name);
                    return parts.length === 0
                        ? nameSaidIn(name, [text])
                        : parts.some((part) => nameSaidIn(part, [text]));
                })
            );
        });
    // Known names, matched as the lookups match them: by word forms in the
    // transcript's language, a letter off, or inside a longer name.
    const index = new NameIndex([
        ...[...frame.people].map(([id, person]) => ({
            id,
            names: [person.name, ...(person.aliases ?? [])],
        })),
        ...[...frame.entities].map(([id, entity]) => ({
            id,
            names: [entity.name, ...(entity.aliases ?? [])],
        })),
    ]);
    const language = stemmingLanguage(frame.language);
    const stemmer: WordStemmer | undefined = language
        ? { key: language, stem: (word) => stemVariants(word, language) }
        : undefined;
    /**
     * The one known record of that kind whose name is close to `name` (of
     * the same type, for a thing, when one is): none when several are.
     * Close is a match the lookups make (`MAYBE_REASONS`: a first name
     * only one person has, a letter off, a thing's word forms: "Forest"
     * for FG Forrest), a surname or a thing's name a letter or two off, or
     * one starting the other ("Evita" for evitaDB).
     */
    const maybeOf = (
        kind: "person" | "entity",
        typeKey: string | null,
        name: string,
    ): { maybe?: RecordTarget } => {
        const found = new Set(
            index
                .match(name, stemmer)
                .filter((match) => MAYBE_REASONS[kind].has(match.reason))
                .map((match) => match.id),
        );
        if (kind === "person") {
            const surname = nameWords(name).at(-1) ?? "";
            for (const [id, person] of frame.people) {
                if (
                    nameParts(name).length >= 2 &&
                    nameParts(person.name).length >= 2 &&
                    close(surname, nameWords(person.name).at(-1) ?? "", false)
                ) {
                    found.add(id);
                }
            }
            const people = [...found].filter((id) => frame.people.has(id));
            const [only] = people;
            return people.length === 1 && only
                ? { maybe: { personId: only } }
                : {};
        }
        const mine = nameWords(name).join("");
        for (const [id, entity] of frame.entities) {
            if (
                [entity.name, ...(entity.aliases ?? [])].some((theirs) =>
                    close(mine, nameWords(theirs).join("")),
                )
            ) {
                found.add(id);
            }
        }
        const things = [...found].filter((id) => frame.entities.has(id));
        const sameType = things.filter(
            (id) => frame.entities.get(id)?.typeKey === typeKey,
        );
        const match = sameType.length > 0 ? sameType : things;
        const [only] = match;
        return match.length === 1 && only ? { maybe: { entityId: only } } : {};
    };
    const turnsSaying = (name: string) =>
        turns.filter((turn) => nameSaidIn(name, [turn.text])).length;

    const known = new Map<string, RecordTarget>();
    const joined = new Map<string, string>();
    const kept = new Map<string, NewRecordPayload>();
    const identities = new Map<string, string>();
    /** Names dismissed or over the budget: said again, dropped silently. */
    const gone = new Set<string>();
    const keys = new Map<string, string>();
    const items: NewRecordCandidate[] = [];
    const speakers: NewRecords["speakers"] = [];

    // A ref the answer defines twice, differently, stands for nothing:
    // what refers to it could mean either.
    const definitions = new Map<string, Set<string>>();
    for (const record of records) {
        const held = definitions.get(record.ref) ?? new Set<string>();
        held.add(
            JSON.stringify([
                record.kind,
                record.kind === "person" ? null : record.typeKey,
                recordNameKey(record.name),
            ]),
        );
        definitions.set(record.ref, held);
    }
    const seen = new Set<string>();
    for (const record of records) {
        // Defined again the same way: once is enough.
        if (seen.has(record.ref)) continue;
        seen.add(record.ref);
        if ((definitions.get(record.ref)?.size ?? 0) > 1) {
            drop("conflicting");
            continue;
        }
        const nameKey = recordNameKey(record.name);

        // Known already: that record, whatever type the answer gave.
        if (record.kind === "person") {
            const ids = peopleByName.get(nameKey) ?? [];
            if (ids.length > 1) {
                drop("ambiguousName");
                continue;
            }
            if (ids[0]) {
                known.set(record.ref, { personId: ids[0] });
                if (record.speakerLabel) {
                    const evidenceMs = record.evidence
                        .map(startOf)
                        .filter((ms): ms is number => ms !== null);
                    const person = frame.people.get(ids[0]);
                    const heard = speakingAs(
                        record.speakerLabel,
                        [
                            record.name,
                            ...(person
                                ? [person.name, ...(person.aliases ?? [])]
                                : []),
                        ],
                        evidenceMs,
                    );
                    if (heard.length > 0) {
                        speakers.push({
                            label: record.speakerLabel,
                            target: { personId: ids[0] },
                            evidenceMs: heard,
                            reason: record.reason,
                        });
                    }
                }
                continue;
            }
        } else {
            const found = entitiesByName.get(nameKey) ?? [];
            const sameType = found.filter(
                (one) => one.typeKey === record.typeKey,
            );
            const match = sameType.length > 0 ? sameType : found;
            if (match.length > 1) {
                drop("ambiguousName");
                continue;
            }
            if (match[0]) {
                known.set(record.ref, { entityId: match[0].id });
                continue;
            }
        }

        // A name on a denied topic stays out of the Almanac, as the
        // types and facts on one do.
        if (deniedTopicOf(record.name)) {
            drop("sensitive");
            continue;
        }
        const typeKey = record.kind === "person" ? null : record.typeKey;
        if (
            record.kind === "entity" &&
            (typeKey === null || !frame.entityTypes?.has(typeKey))
        ) {
            drop("badType");
            continue;
        }
        const evidenceMs = [
            ...new Set(
                record.evidence
                    .map(startOf)
                    .filter((ms): ms is number => ms !== null),
            ),
        ].sort((a, b) => a - b);
        if (evidenceMs.length === 0) {
            drop("badTime");
            continue;
        }
        // Where it is named: its evidence, give or take a turn, and the
        // words a correction the answer proposes for it would rewrite.
        const near = new Set<number>();
        for (const ms of evidenceMs) {
            const at = turnAt(ms);
            for (
                let index = Math.max(0, at - EVIDENCE_RADIUS);
                index <= Math.min(turns.length - 1, at + EVIDENCE_RADIUS);
                index++
            ) {
                near.add(index);
            }
        }
        const misheardAt = corrections.some(
            (correction) =>
                "newRef" in correction.target &&
                correction.target.newRef === record.ref &&
                correction.kind === "correct" &&
                correction.replacement !== null &&
                // In the form the sentence needs: "Veltrixem" for Veltrix.
                nameSaidIn(record.name, [correction.replacement]) &&
                anchorMatches(correction, turns),
        );
        if (
            !misheardAt &&
            !nameSaidIn(
                record.name,
                [...near].map((index) => turns[index]?.text ?? ""),
            )
        ) {
            drop("notInEvidence");
            continue;
        }
        // A common word is no name: a capital, or a term said again.
        const capital = /\p{Lu}/u.test(record.name);
        if (
            !capital &&
            (record.kind === "person" || turnsSaying(record.name) < 2)
        ) {
            drop("generic");
            continue;
        }

        const identity = JSON.stringify([record.kind, typeKey, nameKey]);
        if (gone.has(identity)) continue;
        const same = identities.get(identity);
        if (same) {
            // Named again (another window of the answer): one record.
            joined.set(record.ref, same);
            const held = kept.get(same);
            if (held) {
                held.evidenceMs = [
                    ...new Set([...held.evidenceMs, ...evidenceMs]),
                ].sort((a, b) => a - b);
                if (!held.speakerLabel && record.speakerLabel) {
                    held.speakerLabel = record.speakerLabel;
                }
            }
            continue;
        }
        const fingerprint = newRecordFingerprint(
            record.kind,
            typeKey,
            record.name,
        );
        if (dismissed(fingerprint)) {
            gone.add(identity);
            continue;
        }
        if (items.length >= MAX_NEW_RECORDS) {
            gone.add(identity);
            drop("budget");
            continue;
        }
        const payload: NewRecordPayload = {
            ref: record.ref,
            kind: record.kind,
            typeKey,
            name: record.name.trim().replace(/\s+/g, " "),
            evidenceMs,
            reason: record.reason,
            ...(record.speakerLabel
                ? { speakerLabel: record.speakerLabel }
                : {}),
            ...(record.kind === "person" && nameParts(record.name).length <= 1
                ? { onlyFirstName: true as const }
                : {}),
            ...maybeOf(record.kind, typeKey, record.name),
        };
        identities.set(identity, record.ref);
        keys.set(record.ref, `new:${identity}`);
        kept.set(record.ref, payload);
        items.push({
            kind: "new_record",
            fingerprint,
            preTicked: false,
            payload,
        });
    }

    for (const payload of kept.values()) {
        if (payload.kind !== "person" || !payload.speakerLabel) continue;
        const heard = speakingAs(
            payload.speakerLabel,
            [payload.name],
            payload.evidenceMs,
        );
        if (heard.length === 0) {
            // Named, but never where that speaker speaks or answers.
            delete payload.speakerLabel;
            continue;
        }
        speakers.push({
            label: payload.speakerLabel,
            target: { newRef: payload.ref },
            evidenceMs: heard,
            reason: payload.reason,
        });
    }

    return {
        items,
        resolve: (ref) => {
            const target = known.get(ref);
            if (target) return target;
            const into = joined.get(ref) ?? ref;
            return keys.has(into) ? { newRef: into } : undefined;
        },
        record: (ref) => kept.get(ref),
        keyOf: (ref) => keys.get(ref) ?? `new:${ref}`,
        speakers,
    };
}
