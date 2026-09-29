/**
 * Reviewing a Learn run (Task 4.2): reading what it proposed, deciding item
 * by item (drafts kept on the server, versioned), and finishing the review
 * in one transaction that applies what was ticked and remembers what was
 * not, so the next run does not propose it again.
 *
 * Whoever may change the recording in the run's view reviews it: the owner
 * on the private view, the organization account on the Organization view
 * of a shared recording. Unconfirmed suggestions are theirs alone to see.
 *
 * Finishing re-checks everything under the locks the executors take:
 * the run is still ready, the transcript still the revision it read, the
 * actor still its writer, and every item still at the version the person
 * saw. Each ticked item is applied in a savepoint, so one that no longer
 * holds (its target deleted, its words corrected meanwhile) is skipped and
 * reported, not the whole review lost.
 */

import { and, desc, eq, or } from "drizzle-orm";
import { db } from "@/db";
import {
    knowledgeFacts,
    learnDismissals,
    learnReviewItems,
    learnRuns,
    transcriptions,
    transcriptSpeakers,
} from "@/db/schema";
import { decryptJsonField, encryptJsonField } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import type { KnowledgeTarget } from "@/lib/knowledge/aliases";
import { acceptCorrectionInTx } from "@/lib/knowledge/corrections";
import { confirmFactFromRecordingInTx } from "@/lib/knowledge/facts";
import { knowledgeView } from "@/lib/knowledge/knowledge-loader";
import { lockOrgPeopleShared } from "@/lib/knowledge/org-people";
import { bumpScopeInTx } from "@/lib/knowledge/scope-generation";
import {
    answerSpeakerInTx,
    type SpeakerAnswer,
} from "@/lib/knowledge/speaker-changes";
import { lockTranscriptForChange } from "@/lib/knowledge/transcript-lock";
import {
    createOwnTypeInTx,
    type NewTypeSpec,
    proposePhraseInTx,
    vocabularyVisibleTo,
} from "@/lib/knowledge/vocabulary";
import { settleDeadLearnRuns } from "@/lib/learn/learn-job";
import type { LearnObject, LearnSubject } from "@/lib/learn/output";
import type { ReviewCandidate } from "@/lib/learn/validate";
import type { RecordingViewContext } from "@/lib/sharing/access";
import { sharingOrgUserId } from "@/lib/sharing/writer";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ItemKind = ReviewCandidate["kind"];

/** What a person chose along with a decision, where the kind needs one. */
export type ReviewChoice =
    | { personId: string }
    | { displayName: string }
    | { unknown: true }
    | { action: "create"; spec: Extract<NewTypeSpec, { kind: "relation" }> }
    | { action: "suggest" };

export interface ReviewItemView {
    id: string;
    kind: ItemKind;
    preTicked: boolean;
    decision: "accepted" | "rejected" | null;
    choice: ReviewChoice | null;
    version: number;
    dependsOnLabel: string | null;
    payload: ReviewCandidate["payload"];
}

export interface ReviewView {
    run: {
        id: string;
        status: string;
        transcriptionId: string;
        createdAt: string;
    } | null;
    items: ReviewItemView[];
    /** Names of the people and entities the items refer to, by id. */
    names: Record<string, string>;
    /** Their types (`person` for people), for "create as my relation". */
    types: Record<string, string>;
    /** Labels of the relations the items use, by key. */
    relations: Record<string, string>;
}

/** A unique index refused a row another transaction wrote meanwhile. */
function isUniqueViolation(error: unknown): boolean {
    const value = error as { code?: unknown; cause?: { code?: unknown } };
    return value?.code === "23505" || value?.cause?.code === "23505";
}

/**
 * The speaker a fact depends on: the one it is about, else the one who
 * said it; null when neither.
 */
function speakerOf(payload: {
    subject: LearnSubject;
    speakerLabel: string | null;
}): string | null {
    return "speakerLabel" in payload.subject
        ? payload.subject.speakerLabel
        : payload.speakerLabel;
}

function reviewNotFound(): AppError {
    return new AppError(ErrorCode.NOT_FOUND, "Nothing to review", 404);
}

/** Which of a recording's transcripts a review is about. */
export type ReviewSource = "plaud" | "riffado";

/** `?source=` of a review request; absent means any transcript. */
export function requestedReviewSource(
    request: Request,
): ReviewSource | undefined {
    const source = new URL(request.url).searchParams.get("source");
    return source === "plaud" || source === "riffado" ? source : undefined;
}

/**
 * The run a review is about: the latest in the recording's view, on the
 * transcript of `source` when one is given (each transcript has its own).
 */
async function latestRun(access: RecordingViewContext, source?: ReviewSource) {
    const [row] = await db
        .select({ run: learnRuns })
        .from(learnRuns)
        .innerJoin(
            transcriptions,
            eq(transcriptions.id, learnRuns.transcriptionId),
        )
        .where(
            and(
                eq(learnRuns.recordingId, access.recordingId),
                eq(learnRuns.view, access.view),
                source ? eq(transcriptions.source, source) : undefined,
            ),
        )
        .orderBy(desc(learnRuns.createdAt))
        .limit(1);
    return row?.run ?? null;
}

function idsIn(value: unknown, into: Set<string>): void {
    if (Array.isArray(value)) {
        for (const item of value) idsIn(item, into);
        return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, inner] of Object.entries(value)) {
        if (
            (key === "personId" || key === "entityId") &&
            typeof inner === "string"
        ) {
            into.add(inner);
        } else {
            idsIn(inner, into);
        }
    }
}

/** The latest run in the view and, when it is ready, what it proposed. */
export async function loadReview(
    access: RecordingViewContext,
    source?: ReviewSource,
): Promise<ReviewView> {
    // A run whose job died reads as failed, not as learning forever.
    await settleDeadLearnRuns(access.recordingId);
    const run = await latestRun(access, source);
    if (!run) {
        return { run: null, items: [], names: {}, types: {}, relations: {} };
    }
    const summary = {
        id: run.id,
        status: run.status,
        transcriptionId: run.transcriptionId,
        createdAt: run.createdAt.toISOString(),
    };
    if (run.status !== "ready") {
        return { run: summary, items: [], names: {}, types: {}, relations: {} };
    }
    const rows = await db
        .select()
        .from(learnReviewItems)
        .where(eq(learnReviewItems.runId, run.id))
        .orderBy(learnReviewItems.createdAt, learnReviewItems.id);
    const items: ReviewItemView[] = rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        preTicked: row.preTicked,
        decision: row.decision ?? null,
        choice: row.choice ? decryptJsonField<ReviewChoice>(row.choice) : null,
        version: row.version,
        dependsOnLabel: row.dependsOnLabel,
        payload: decryptJsonField<ReviewCandidate["payload"]>(
            row.payload,
        ) as ReviewCandidate["payload"],
    }));
    const referenced = new Set<string>();
    for (const item of items) idsIn([item.payload, item.choice], referenced);
    const view = await knowledgeView({
        kind: "recording",
        ownerUserId: run.userId,
        shared: run.view === "org",
    });
    const names: Record<string, string> = {};
    const types: Record<string, string> = {};
    for (const item of view.items) {
        if (!referenced.has(item.id)) continue;
        names[item.id] = item.name;
        types[item.id] = item.kind === "person" ? "person" : item.typeKey;
    }
    const vocabulary = await vocabularyVisibleTo(run.scopeUserId, {
        sharedOnly: run.view === "org",
    });
    const relations: Record<string, string> = {};
    for (const relation of vocabulary.relationTypes) {
        relations[relation.key] = relation.label;
    }
    return { run: summary, items, names, types, relations };
}

const MAX_ID_LENGTH = 64;
const MAX_NAME_LENGTH = 200;
const MAX_TYPES = 20;

/** A string with something in it, and not too much. */
function short(value: unknown, max: number): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= max;
}

function validChoice(kind: ItemKind, choice: unknown): ReviewChoice | null {
    if (choice === null || choice === undefined) return null;
    if (typeof choice !== "object") return invalidChoice();
    const value = choice as Record<string, unknown>;
    if (kind === "speaker") {
        if (value.unknown === true) return { unknown: true };
        if (short(value.personId, MAX_ID_LENGTH)) {
            return { personId: value.personId };
        }
        // Someone new, created and named when the review is finished.
        if (typeof value.displayName === "string") {
            const displayName = value.displayName.trim();
            if (short(displayName, MAX_NAME_LENGTH)) return { displayName };
        }
        return invalidChoice();
    }
    if (kind === "relation_phrase") {
        if (value.action === "suggest") return { action: "suggest" };
        const spec = value.spec as Record<string, unknown> | undefined;
        const types = (list: unknown): list is string[] =>
            Array.isArray(list) &&
            list.length <= MAX_TYPES &&
            list.every((type) => short(type, MAX_ID_LENGTH));
        if (
            value.action === "create" &&
            spec &&
            typeof spec.label === "string" &&
            short(spec.label.trim(), MAX_NAME_LENGTH) &&
            types(spec.subjectTypes) &&
            types(spec.objectTypes) &&
            (spec.objectKind === "entity" || spec.objectKind === "literal") &&
            (spec.cardinality === "one" || spec.cardinality === "many")
        ) {
            return {
                action: "create",
                spec: {
                    kind: "relation",
                    label: spec.label.trim(),
                    subjectTypes: spec.subjectTypes,
                    objectTypes: spec.objectTypes,
                    objectKind: spec.objectKind,
                    cardinality: spec.cardinality,
                },
            };
        }
        return invalidChoice();
    }
    return invalidChoice();
}

function invalidChoice(): never {
    throw new AppError(
        ErrorCode.INVALID_INPUT,
        "That choice does not fit this item",
        400,
        { field: "choice" },
    );
}

/**
 * Keep a draft decision on one item of the ready run, if the person saw its
 * latest version (409 otherwise). `decision: null` goes back to the
 * default. Returns the item's new version.
 */
export async function decideReviewItem(
    access: RecordingViewContext,
    itemId: string,
    input: {
        decision: "accepted" | "rejected" | null;
        version: number;
        choice?: unknown;
    },
    source?: ReviewSource,
): Promise<{ version: number }> {
    const latest = await latestRun(access, source);
    if (!latest || latest.status !== "ready") throw reviewNotFound();
    // Under the run held for share: a finish holds it for update, so a
    // draft either lands before it (and is applied) or finds it finished.
    return db.transaction(async (tx) => {
        const [run] = await tx
            .select({ status: learnRuns.status })
            .from(learnRuns)
            .where(eq(learnRuns.id, latest.id))
            .for("share");
        if (run?.status !== "ready") throw reviewNotFound();
        return keepDraft(tx, latest.id, itemId, input);
    });
}

async function keepDraft(
    tx: Tx,
    runId: string,
    itemId: string,
    input: {
        decision: "accepted" | "rejected" | null;
        version: number;
        choice?: unknown;
    },
): Promise<{ version: number }> {
    const [item] = await tx
        .select({ kind: learnReviewItems.kind })
        .from(learnReviewItems)
        .where(
            and(
                eq(learnReviewItems.id, itemId),
                eq(learnReviewItems.runId, runId),
            ),
        );
    if (!item) throw reviewNotFound();
    const choice = validChoice(item.kind, input.choice);
    const [updated] = await tx
        .update(learnReviewItems)
        .set({
            decision: input.decision,
            choice: choice ? encryptJsonField(choice) : null,
            version: input.version + 1,
            updatedAt: new Date(),
        })
        .where(
            and(
                eq(learnReviewItems.id, itemId),
                eq(learnReviewItems.version, input.version),
            ),
        )
        .returning({ version: learnReviewItems.version });
    if (!updated) {
        throw new AppError(
            ErrorCode.CONFLICT,
            "This item changed; reload the review",
            409,
        );
    }
    return updated;
}

export interface FinishedReview {
    status: "finished" | "superseded";
    applied: number;
    dismissed: number;
    skipped: { itemId: string; reason: string }[];
}

/**
 * Finish the review of the ready run: apply the ticked items, remember the
 * unticked ones as dismissed, mark the run finished, in one transaction.
 * `versions` are the item versions the person saw; any other is a 409.
 * A transcript changed since the run read it supersedes the run instead.
 */
export async function finishReview(
    access: RecordingViewContext,
    actorUserId: string,
    {
        versions = {},
        source,
    }: { versions?: Record<string, number>; source?: ReviewSource } = {},
): Promise<FinishedReview> {
    const orgUserId = await sharingOrgUserId();
    const latest = await latestRun(access, source);
    if (!latest || latest.status !== "ready") throw reviewNotFound();
    return db.transaction(async (tx) => {
        await lockOrgPeopleShared(tx);
        const version = {
            userId: latest.userId,
            transcriptionId: latest.transcriptionId,
        };
        const { revision, turns } = await lockTranscriptForChange(tx, version, {
            actorUserId,
            orgUserId,
        });
        const [run] = await tx
            .select()
            .from(learnRuns)
            .where(eq(learnRuns.id, latest.id))
            .for("update");
        if (!run || run.status !== "ready") throw reviewNotFound();
        if (revision !== run.transcriptRevision) {
            await tx
                .update(learnRuns)
                .set({ status: "superseded", updatedAt: new Date() })
                .where(eq(learnRuns.id, run.id));
            return {
                status: "superseded",
                applied: 0,
                dismissed: 0,
                skipped: [],
            };
        }
        const rows = await tx
            .select()
            .from(learnReviewItems)
            .where(eq(learnReviewItems.runId, run.id))
            .for("update");
        // Every item as the person saw it, and nothing else: a default
        // applied to an item they never loaded is no decision of theirs.
        const shown = Object.keys(versions);
        if (
            shown.length !== rows.length ||
            rows.some((row) => versions[row.id] !== row.version)
        ) {
            throw new AppError(
                ErrorCode.CONFLICT,
                "The review changed; reload it",
                409,
            );
        }
        const items = rows.map((row) => ({
            id: row.id,
            kind: row.kind,
            fingerprintHmac: row.fingerprintHmac,
            accepted:
                (row.decision ?? (row.preTicked ? "accepted" : "rejected")) ===
                "accepted",
            choice: row.choice
                ? decryptJsonField<ReviewChoice>(row.choice)
                : null,
            payload: decryptJsonField<ReviewCandidate["payload"]>(row.payload),
        }));

        const scopes = new Set<string>([actorUserId]);
        const skipped: FinishedReview["skipped"] = [];
        let applied = 0;
        const attempt = async (
            itemId: string,
            apply: (sp: Tx) => Promise<void>,
        ) => {
            try {
                await tx.transaction(async (sp) => apply(sp as Tx));
                applied++;
            } catch (error) {
                if (error instanceof AppError) {
                    skipped.push({ itemId, reason: error.message });
                    return;
                }
                // A name taken meanwhile by another transaction.
                if (isUniqueViolation(error)) {
                    skipped.push({ itemId, reason: "Already exists" });
                    return;
                }
                throw error;
            }
        };
        const writer = { actorUserId, orgUserId };
        const transcript = {
            userId: run.userId,
            transcriptionId: run.transcriptionId,
            revision,
        };

        // Speakers first: the facts that depend on them read their answer.
        for (const item of items) {
            if (item.kind !== "speaker" || !item.accepted) continue;
            const payload = item.payload as Extract<
                ReviewCandidate,
                { kind: "speaker" }
            >["payload"];
            const choice = item.choice;
            const answer: SpeakerAnswer | null =
                choice && "unknown" in choice
                    ? { kind: "unknown" }
                    : choice && "personId" in choice
                      ? { kind: "name", personId: choice.personId }
                      : choice && "displayName" in choice
                        ? { kind: "name", displayName: choice.displayName }
                        : payload.personId
                          ? { kind: "name", personId: payload.personId }
                          : null;
            if (!answer) {
                skipped.push({ itemId: item.id, reason: "Nobody chosen" });
                continue;
            }
            // Proposed for a label nobody had answered; an answer given
            // since is the person's, and stays.
            const [answered] = await tx
                .select({ id: transcriptSpeakers.id })
                .from(transcriptSpeakers)
                .where(
                    and(
                        eq(
                            transcriptSpeakers.transcriptionId,
                            run.transcriptionId,
                        ),
                        eq(transcriptSpeakers.label, payload.label),
                        or(
                            eq(transcriptSpeakers.status, "confirmed"),
                            eq(transcriptSpeakers.markedUnknown, true),
                        ),
                    ),
                )
                .limit(1);
            if (answered) {
                skipped.push({ itemId: item.id, reason: "Answered since" });
                continue;
            }
            await attempt(item.id, async (sp) => {
                await answerSpeakerInTx(
                    sp,
                    {
                        ...writer,
                        ...transcript,
                        label: payload.label,
                        answer,
                    },
                    scopes,
                );
            });
        }

        for (const item of items) {
            if (item.kind !== "correction" || !item.accepted) continue;
            const payload = item.payload as Extract<
                ReviewCandidate,
                { kind: "correction" }
            >["payload"];
            // All its occurrences or none. The item groups them by their
            // words in any case; each is applied at its own.
            await attempt(item.id, async (sp) => {
                for (const anchor of payload.anchors) {
                    const words =
                        turns?.[anchor.turnIndex]?.text.slice(
                            anchor.charStart,
                            anchor.charEnd,
                        ) ?? "";
                    await acceptCorrectionInTx(sp, {
                        ...writer,
                        ...transcript,
                        anchor: {
                            ...anchor,
                            heard:
                                words.toLocaleLowerCase() ===
                                payload.heard.toLocaleLowerCase()
                                    ? words
                                    : payload.heard,
                        },
                        kind: payload.kind,
                        target: payload.target,
                        replacement: payload.replacement,
                    });
                }
            });
        }

        /** Whom a fact's speaker-bound side names now, or null. */
        const speakerPerson = async (label: string) => {
            const [row] = await tx
                .select({ personId: transcriptSpeakers.personId })
                .from(transcriptSpeakers)
                .where(
                    and(
                        eq(
                            transcriptSpeakers.transcriptionId,
                            run.transcriptionId,
                        ),
                        eq(transcriptSpeakers.label, label),
                        eq(transcriptSpeakers.status, "confirmed"),
                    ),
                )
                .limit(1);
            return row?.personId ?? null;
        };
        const resolveSubject = async (
            subject: LearnSubject,
        ): Promise<KnowledgeTarget | null> => {
            if (!("speakerLabel" in subject)) return subject;
            const personId = await speakerPerson(subject.speakerLabel);
            return personId ? { personId } : null;
        };
        const confirm = async (
            sp: Tx,
            relationKey: string,
            subject: KnowledgeTarget,
            object: LearnObject,
            fact: {
                startMs: number;
                endMs: number;
                speakerLabel: string | null;
            },
            expectedCurrentFactId: string | null,
        ) => {
            await confirmFactFromRecordingInTx(sp, {
                ...writer,
                ownerUserId: run.userId,
                transcriptionId: run.transcriptionId,
                revision,
                subject,
                relationKey,
                object,
                startMs: fact.startMs,
                endMs: fact.endMs,
                speakerLabel: fact.speakerLabel,
                // Replaces only the value the item showed as current (none
                // when it showed none): one changed since is the person's.
                expectedCurrentFactId,
            });
        };

        for (const item of items) {
            if (
                (item.kind !== "fact" && item.kind !== "known_fact") ||
                !item.accepted
            ) {
                continue;
            }
            const payload = item.payload as Extract<
                ReviewCandidate,
                { kind: "fact" | "known_fact" }
            >["payload"];
            // A known fact of another scope (the Organization's, on a
            // private recording) is not copied into the actor's.
            if (item.kind === "known_fact" && payload.factId) {
                const [known] = await tx
                    .select({ userId: knowledgeFacts.userId })
                    .from(knowledgeFacts)
                    .where(eq(knowledgeFacts.id, payload.factId))
                    .limit(1);
                if (known?.userId !== run.scopeUserId) {
                    skipped.push({
                        itemId: item.id,
                        reason: "Known in another scope",
                    });
                    continue;
                }
            }
            // A fact about a speaker, or said by one, holds only once that
            // speaker is named, and its evidence stays tied to them.
            const speakerLabel = speakerOf(payload);
            const subject = await resolveSubject(payload.subject);
            if (
                !subject ||
                (speakerLabel !== null && !(await speakerPerson(speakerLabel)))
            ) {
                skipped.push({
                    itemId: item.id,
                    reason: "Its speaker is not named yet",
                });
                continue;
            }
            const expected =
                item.kind === "known_fact"
                    ? (payload.factId ?? null)
                    : (payload.replaces?.factId ?? null);
            await attempt(item.id, (sp) =>
                confirm(
                    sp,
                    payload.relationKey,
                    subject,
                    payload.object,
                    { ...payload, speakerLabel },
                    expected,
                ),
            );
        }

        const organization = orgUserId !== null && actorUserId === orgUserId;
        const phrases = items.flatMap((item) =>
            item.kind === "relation_phrase" && item.accepted
                ? [
                      {
                          item,
                          payload: item.payload as Extract<
                              ReviewCandidate,
                              { kind: "relation_phrase" }
                          >["payload"],
                          choice: item.choice,
                      },
                  ]
                : [],
        );
        // Suggestions first, then new types: every finish takes the
        // proposal rows before the vocabulary's version row, so two never
        // wait on each other the wrong way round.
        for (const { item, payload, choice } of phrases) {
            if (
                !(choice && "action" in choice && choice.action === "suggest")
            ) {
                continue;
            }
            await attempt(item.id, (sp) =>
                proposePhraseInTx(sp, actorUserId, payload.phrase),
            );
        }
        for (const { item, payload, choice } of phrases) {
            if (choice && "action" in choice && choice.action === "suggest") {
                continue;
            }
            if (!(choice && "action" in choice && choice.action === "create")) {
                skipped.push({ itemId: item.id, reason: "Nothing chosen" });
                continue;
            }
            const subject = await resolveSubject(payload.subject);
            const speakerLabel =
                "speakerLabel" in payload.subject
                    ? payload.subject.speakerLabel
                    : null;
            await attempt(item.id, async (sp) => {
                const key = await createOwnTypeInTx(
                    sp,
                    actorUserId,
                    organization,
                    choice.spec,
                );
                // The relation works at once: the words that named it are
                // its first fact, where it takes them (never text, which a
                // review item does not keep). In a savepoint of its own, so
                // the type stays when the fact does not fit it.
                const object = payload.object;
                if (subject && object) {
                    await sp
                        .transaction((inner) =>
                            confirm(
                                inner as Tx,
                                key,
                                subject,
                                object,
                                { ...payload, speakerLabel },
                                null,
                            ),
                        )
                        .catch((error: unknown) => {
                            if (!(error instanceof AppError)) throw error;
                        });
                }
            });
        }

        const rejected = items.filter((item) => !item.accepted);
        if (rejected.length > 0) {
            await tx
                .insert(learnDismissals)
                .values(
                    rejected.map((item) => ({
                        userId: run.scopeUserId,
                        recordingId: run.recordingId,
                        fingerprintHmac: item.fingerprintHmac,
                    })),
                )
                .onConflictDoNothing();
        }
        await tx
            .update(learnRuns)
            .set({
                status: "finished",
                finishedAt: new Date(),
                updatedAt: new Date(),
            })
            .where(eq(learnRuns.id, run.id));
        await bumpScopeInTx(tx, scopes);
        return {
            status: "finished",
            applied,
            dismissed: rejected.length,
            skipped,
        };
    });
}
