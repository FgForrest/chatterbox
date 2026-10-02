/**
 * What a Learn run answers with: the one shape every path produces (the
 * bridge enforces it as a JSON Schema, the fallback parses and repairs it),
 * before the server validates it against the run (`validate.ts`).
 *
 * Only shape here: ids, anchors and relations are checked against the
 * run's transcript and scopes later, and anything the model got wrong
 * there is dropped, not the whole answer. The bounds keep one answer from
 * carrying more than a review can show.
 */

import { z } from "zod";

export const LEARN_LIMITS = {
    speakers: 32,
    corrections: 200,
    facts: 50,
    relationPhrases: 20,
    /** New people and things one answer may name (a window's, in path 2). */
    newRecords: 40,
    /** Characters of any free text: a name, a replacement, a phrase. */
    text: 200,
    /** Characters of a speaker suggestion's reason. */
    reason: 300,
} as const;

/** The categories a fact is screened by; only `none` is kept. */
export const SENSITIVITY_CATEGORIES = [
    "none",
    "health",
    "family",
    "personality",
    "performance",
    "demographics",
    "other_private",
] as const;

const id = z.string().min(1).max(64);
const text = z.string().trim().min(1).max(LEARN_LIMITS.text);
/** `mm:ss` or `h:mm:ss`, one of the times the model was shown. */
const clock = z.string().regex(/^\s*\[?(?:\d+:)?\d{1,3}:\d{2}\]?\s*$/);
const label = z.string().min(1).max(64);

const person = z.strictObject({ personId: id });
const entity = z.strictObject({ entityId: id });
/** A person or thing the answer proposes to add (`newRecords`), by its ref. */
const ref = z.string().min(1).max(16);
const newRecordRef = z.strictObject({ newRef: ref });
/** Whoever speaks under a label, for a fact about the voice itself. */
const speaker = z.strictObject({ speakerLabel: label });
const literal = z.strictObject({ literal: text });

const subject = z.union([person, entity, newRecordRef, speaker]);
const object = z.union([person, entity, newRecordRef, literal]);

/**
 * Someone or something the transcript names that the knowledge base does
 * not have: added only if a person ticks it in the review.
 */
const newRecord = z.strictObject({
    ref,
    kind: z.enum(["person", "entity"]),
    /** One of the entity types for an entity; null for a person. */
    typeKey: label.nullable(),
    /** The name as it is written, in its base form. */
    name: text,
    /** The label this person speaks under, when they speak here. */
    speakerLabel: label.nullable(),
    evidence: z.array(clock).min(1).max(3),
    reason: z.string().trim().max(LEARN_LIMITS.reason),
});

const speakerSuggestion = z.strictObject({
    label,
    /** Null: nobody known; the review offers to pick or leave unknown. */
    personId: id.nullable(),
    evidence: z.array(clock).min(1).max(3),
    reason: z.string().trim().max(LEARN_LIMITS.reason),
});

const correction = z.strictObject({
    turnIndex: z.number().int().min(0),
    charStart: z.number().int().min(0),
    charEnd: z.number().int().min(1),
    heard: text,
    kind: z.enum(["correct", "link"]),
    target: z.union([person, entity, newRecordRef]),
    /** The name as it should read; null on a link, which keeps the words. */
    replacement: text.nullable(),
});

const fact = z.strictObject({
    subject,
    relationKey: z.string().min(1).max(64),
    object,
    start: clock,
    end: clock,
    /** The label whose speaker the fact depends on, when it does. */
    speakerLabel: label.nullable(),
    sensitivity: z.enum(SENSITIVITY_CATEGORIES),
});

const relationPhrase = z.strictObject({
    phrase: text,
    subject,
    object,
    start: clock,
    end: clock,
    sensitivity: z.enum(SENSITIVITY_CATEGORIES),
});

export const learnOutputSchema = z.strictObject({
    // First, so an answer names what it adds before it refers to it. An
    // answer from before there were any may leave it out.
    newRecords: z.array(newRecord).max(LEARN_LIMITS.newRecords).default([]),
    speakers: z.array(speakerSuggestion).max(LEARN_LIMITS.speakers),
    corrections: z.array(correction).max(LEARN_LIMITS.corrections),
    facts: z.array(fact).max(LEARN_LIMITS.facts),
    relationPhrases: z.array(relationPhrase).max(LEARN_LIMITS.relationPhrases),
});

export type LearnOutput = z.infer<typeof learnOutputSchema>;
export type LearnNewRecord = LearnOutput["newRecords"][number];
export type LearnSpeaker = LearnOutput["speakers"][number];
export type LearnCorrection = LearnOutput["corrections"][number];
export type LearnFact = LearnOutput["facts"][number];
export type LearnRelationPhrase = LearnOutput["relationPhrases"][number];
export type LearnSubject = z.infer<typeof subject>;
export type LearnObject = z.infer<typeof object>;

/**
 * The JSON Schema the bridge's CLIs enforce (`--json-schema`,
 * `--output-schema`): every field required, and no `default`, which a
 * strict schema does not take (the parse above still tolerates its lack).
 */
export function learnOutputJsonSchema(): Record<string, unknown> {
    return strictJsonSchema(learnOutputSchema);
}

/** A schema as the bridge's CLIs enforce it: no `default` anywhere. */
export function strictJsonSchema(schema: z.ZodType): Record<string, unknown> {
    return withoutDefaults(z.toJSONSchema(schema)) as Record<string, unknown>;
}

function withoutDefaults(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(withoutDefaults);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(
        Object.entries(value)
            .filter(([key]) => key !== "default")
            .map(([key, inner]) => [key, withoutDefaults(inner)]),
    );
}

/** The JSON object in a reply: the whole text, or the first `{`..last `}`. */
function jsonIn(raw: string): unknown {
    const trimmed = raw.trim();
    try {
        return JSON.parse(trimmed);
    } catch {
        const start = trimmed.indexOf("{");
        const end = trimmed.lastIndexOf("}");
        if (start < 0 || end <= start) return undefined;
        try {
            return JSON.parse(trimmed.slice(start, end + 1));
        } catch {
            return undefined;
        }
    }
}

export type ParsedLearnOutput =
    | { ok: true; output: LearnOutput }
    | { ok: false; error: string };

/**
 * A reply as Learn output, or why not: the error names the paths that are
 * wrong, for a repair request (path 2) or the run's record.
 */
export function parseLearnOutput(raw: string): ParsedLearnOutput {
    return parseJsonAnswer(learnOutputSchema, raw);
}

/**
 * A reply as `schema` reads it, or why not, as `parseLearnOutput` says it.
 */
export function parseJsonAnswer<T>(
    schema: z.ZodType<T>,
    raw: string,
): { ok: true; output: T } | { ok: false; error: string } {
    const value = jsonIn(raw);
    if (value === undefined) return { ok: false, error: "not JSON" };
    const parsed = schema.safeParse(value);
    if (parsed.success) return { ok: true, output: parsed.data };
    return {
        ok: false,
        error: parsed.error.issues
            .slice(0, 10)
            .map(
                (issue) =>
                    `${issue.path.join(".") || "(root)"}: ${issue.message}`,
            )
            .join("; "),
    };
}
