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

import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
    learnDismissals,
    learnReviewItems,
    learnRuns,
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
import type { LearnObject, LearnSubject } from "@/lib/learn/output";
import type { ReviewCandidate } from "@/lib/learn/validate";
import type { RecordingViewContext } from "@/lib/sharing/access";
import { sharingOrgUserId } from "@/lib/sharing/writer";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ItemKind = ReviewCandidate["kind"];

/** What a person chose along with a decision, where the kind needs one. */
export type ReviewChoice =
    | { personId: string }
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

function reviewNotFound(): AppError {
    return new AppError(ErrorCode.NOT_FOUND, "Nothing to review", 404);
}

/** The run a review is about: the latest in the recording's view. */
async function latestRun(access: RecordingViewContext) {
    const [run] = await db
        .select()
        .from(learnRuns)
        .where(
            and(
                eq(learnRuns.recordingId, access.recordingId),
                eq(learnRuns.view, access.view),
            ),
        )
        .orderBy(desc(learnRuns.createdAt))
        .limit(1);
    return run ?? null;
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
): Promise<ReviewView> {
    const run = await latestRun(access);
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

function validChoice(kind: ItemKind, choice: unknown): ReviewChoice | null {
    if (choice === null || choice === undefined) return null;
    if (typeof choice !== "object") return invalidChoice();
    const value = choice as Record<string, unknown>;
    if (kind === "speaker") {
        if (value.unknown === true) return { unknown: true };
        if (typeof value.personId === "string" && value.personId) {
            return { personId: value.personId };
        }
        return invalidChoice();
    }
    if (kind === "relation_phrase") {
        if (value.action === "suggest") return { action: "suggest" };
        const spec = value.spec as Record<string, unknown> | undefined;
        if (
            value.action === "create" &&
            spec &&
            typeof spec.label === "string" &&
            Array.isArray(spec.subjectTypes) &&
            Array.isArray(spec.objectTypes) &&
            (spec.objectKind === "entity" || spec.objectKind === "literal") &&
            (spec.cardinality === "one" || spec.cardinality === "many")
        ) {
            return {
                action: "create",
                spec: {
                    kind: "relation",
                    label: spec.label,
                    subjectTypes: spec.subjectTypes.map(String),
                    objectTypes: spec.objectTypes.map(String),
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
): Promise<{ version: number }> {
    const run = await latestRun(access);
    if (!run || run.status !== "ready") throw reviewNotFound();
    const [item] = await db
        .select({ kind: learnReviewItems.kind })
        .from(learnReviewItems)
        .where(
            and(
                eq(learnReviewItems.id, itemId),
                eq(learnReviewItems.runId, run.id),
            ),
        );
    if (!item) throw reviewNotFound();
    const choice = validChoice(item.kind, input.choice);
    const [updated] = await db
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
    { versions = {} }: { versions?: Record<string, number> } = {},
): Promise<FinishedReview> {
    const orgUserId = await sharingOrgUserId();
    const latest = await latestRun(access);
    if (!latest || latest.status !== "ready") throw reviewNotFound();
    return db.transaction(async (tx) => {
        await lockOrgPeopleShared(tx);
        const version = {
            userId: latest.userId,
            transcriptionId: latest.transcriptionId,
        };
        const { revision } = await lockTranscriptForChange(tx, version, {
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
        for (const row of rows) {
            const seen = versions[row.id];
            if (seen !== undefined && seen !== row.version) {
                throw new AppError(
                    ErrorCode.CONFLICT,
                    "The review changed; reload it",
                    409,
                );
            }
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
                if (!(error instanceof AppError)) throw error;
                skipped.push({ itemId, reason: error.message });
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
                      : payload.personId
                        ? { kind: "name", personId: payload.personId }
                        : null;
            if (!answer) {
                skipped.push({ itemId: item.id, reason: "Nobody chosen" });
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
            for (const anchor of payload.anchors) {
                await attempt(item.id, async (sp) => {
                    await acceptCorrectionInTx(sp, {
                        ...writer,
                        ...transcript,
                        anchor: { ...anchor, heard: payload.heard },
                        kind: payload.kind,
                        target: payload.target,
                        replacement: payload.replacement,
                    });
                });
            }
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
                replaceCurrent: true,
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
            const subject = await resolveSubject(payload.subject);
            if (!subject) {
                skipped.push({
                    itemId: item.id,
                    reason: "Its speaker is not named yet",
                });
                continue;
            }
            // Evidence depends on the speaker only when that speaker is named.
            const speakerLabel =
                payload.speakerLabel &&
                (await speakerPerson(payload.speakerLabel))
                    ? payload.speakerLabel
                    : null;
            await attempt(item.id, (sp) =>
                confirm(sp, payload.relationKey, subject, payload.object, {
                    ...payload,
                    speakerLabel,
                }),
            );
        }

        const organization = orgUserId !== null && actorUserId === orgUserId;
        for (const item of items) {
            if (item.kind !== "relation_phrase" || !item.accepted) continue;
            const payload = item.payload as Extract<
                ReviewCandidate,
                { kind: "relation_phrase" }
            >["payload"];
            const choice = item.choice;
            if (choice && "action" in choice && choice.action === "suggest") {
                await attempt(item.id, (sp) =>
                    proposePhraseInTx(sp, actorUserId, payload.phrase),
                );
                continue;
            }
            if (!(choice && "action" in choice && choice.action === "create")) {
                skipped.push({ itemId: item.id, reason: "Nothing chosen" });
                continue;
            }
            const subject = await resolveSubject(payload.subject);
            await attempt(item.id, async (sp) => {
                const key = await createOwnTypeInTx(
                    sp,
                    actorUserId,
                    organization,
                    choice.spec,
                );
                // The relation works at once: the words that named it are
                // its first fact, where it takes them.
                if (subject) {
                    await confirm(sp, key, subject, payload.object, {
                        ...payload,
                        speakerLabel: null,
                    }).catch((error: unknown) => {
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
