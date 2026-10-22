import { and, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import type { db } from "@/db";
import { settleTerminalJobInTx } from "@/db/queries/async-jobs";
import {
    asyncJobs,
    chatterItems,
    itemProcessing,
    knowledgeEntities,
    learnReviewItems,
    learnRuns,
    mailContents,
    people,
    processingProfileRevisions,
    processingProfiles,
    transcriptions,
} from "@/db/schema";
import { decryptJsonField, decryptText } from "@/lib/encryption/fields";
import {
    findEntityByNameInTx,
    planEntityPromotionInTx,
    promoteEntityInTx,
} from "@/lib/knowledge/entities";
import { domainLookupHash } from "@/lib/knowledge/lookup-hash";
import { promotePersonInTx } from "@/lib/knowledge/people";
import { scopesNamingInTx } from "@/lib/knowledge/scope-generation";
import {
    adoptTypesForShareInTx,
    dropUnusedAdoptionsInTx,
} from "@/lib/knowledge/vocabulary";
import { type RecordTarget, recordNameKey } from "@/lib/learn/new-refs";
import type { ReviewChoice } from "@/lib/learn/review";
import { cancelPrivateCorrectionsAtShareInTx } from "@/lib/learn/sharing";
import type { NewRecordPayload } from "@/lib/learn/validate-new-records";
import { updatePhaseInTx } from "@/lib/pipeline/state";
import { requestAdvanceInTx } from "@/lib/pipeline/trigger";
import { resolveChannelDefaultProfile } from "@/lib/profiles/resolve-for-placement";
import { parseProfileSettings } from "@/lib/profiles/settings";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Run = typeof learnRuns.$inferSelect;
type ReviewRow = typeof learnReviewItems.$inferSelect;

function recordTarget(value: unknown): RecordTarget | null {
    if (!value || typeof value !== "object") return null;
    if ("personId" in value && typeof value.personId === "string") {
        return { personId: value.personId };
    }
    if ("entityId" in value && typeof value.entityId === "string") {
        return { entityId: value.entityId };
    }
    return null;
}

async function confirmedRecordsInTx(
    tx: Tx,
    run: Run,
    rows: ReviewRow[],
): Promise<RecordTarget[]> {
    const saved = run.inputs?.confirmedRecords;
    if (Array.isArray(saved)) {
        return saved.flatMap((value) => {
            const target = recordTarget(value);
            return target ? [target] : [];
        });
    }
    const targets: RecordTarget[] = [];
    for (const row of rows) {
        if (row.kind !== "new_record" || row.outcome !== "applied") continue;
        const choice = row.choice
            ? decryptJsonField<ReviewChoice>(row.choice)
            : null;
        if (recordTarget(choice)) continue;
        const payload = decryptJsonField<NewRecordPayload>(row.payload);
        if (!payload || !run.finishedAt) continue;
        const name = choice && "name" in choice ? choice.name : payload.name;
        if (payload.kind === "entity") {
            const typeKey =
                choice && "typeKey" in choice
                    ? choice.typeKey
                    : payload.typeKey;
            const entityId = typeKey
                ? await findEntityByNameInTx(tx, run.userId, typeKey, name)
                : null;
            if (entityId) {
                const [created] = await tx
                    .select({ id: knowledgeEntities.id })
                    .from(knowledgeEntities)
                    .where(
                        and(
                            eq(knowledgeEntities.id, entityId),
                            eq(knowledgeEntities.userId, run.userId),
                            gte(knowledgeEntities.createdAt, run.createdAt),
                            lte(knowledgeEntities.createdAt, run.finishedAt),
                        ),
                    )
                    .limit(1);
                if (created) targets.push({ entityId: created.id });
            }
        } else {
            const candidates = await tx
                .select({ id: people.id, name: people.displayName })
                .from(people)
                .where(
                    and(
                        eq(people.userId, run.userId),
                        isNull(people.mergedIntoId),
                        gte(people.createdAt, run.createdAt),
                        lte(people.createdAt, run.finishedAt),
                    ),
                );
            const matching = candidates.filter(
                (person) =>
                    recordNameKey(decryptText(person.name)) ===
                    recordNameKey(name),
            );
            if (matching.length === 1 && matching[0]) {
                targets.push({ personId: matching[0].id });
            }
        }
    }
    return targets;
}

async function publishUnreferencedRecordsInTx(
    tx: Tx,
    run: Run,
    rows: ReviewRow[],
    orgUserId: string,
): Promise<Set<string>> {
    const targets = await confirmedRecordsInTx(tx, run, rows);
    const personIds = targets.flatMap((target) =>
        "personId" in target ? [target.personId] : [],
    );
    const entityIds = targets.flatMap((target) =>
        "entityId" in target ? [target.entityId] : [],
    );
    const privatePeople =
        personIds.length > 0
            ? await tx
                  .select({ id: people.id })
                  .from(people)
                  .where(
                      and(
                          eq(people.userId, run.userId),
                          inArray(people.id, personIds),
                      ),
                  )
            : [];
    const privateEntities =
        entityIds.length > 0
            ? await tx
                  .select({ id: knowledgeEntities.id })
                  .from(knowledgeEntities)
                  .where(
                      and(
                          eq(knowledgeEntities.userId, run.userId),
                          inArray(knowledgeEntities.id, entityIds),
                      ),
                  )
            : [];
    const scopes = await scopesNamingInTx(tx, {
        personIds: privatePeople.map((person) => person.id),
        entityIds: privateEntities.map((entity) => entity.id),
    });
    const adopted = await adoptTypesForShareInTx(tx, {
        ownerUserId: run.userId,
        orgUserId,
        entityIds: privateEntities.map((entity) => entity.id),
        relationKeys: [],
    });
    for (const person of privatePeople) {
        await promotePersonInTx(tx, person.id, orgUserId);
    }
    for (const entity of privateEntities) {
        const plan = await planEntityPromotionInTx(tx, entity.id, orgUserId);
        if (plan && plan.kind !== "private") {
            await promoteEntityInTx(tx, entity.id, orgUserId);
        }
    }
    await dropUnusedAdoptionsInTx(tx, adopted);
    scopes.add(run.userId);
    scopes.add(orgUserId);
    return scopes;
}

/** Settle a shared item's current Learn generation after its existing knowledge publication. */
export async function publishFinishedPrivateLearnInTx(
    tx: Tx,
    input: { itemId: string; ownerUserId: string; orgUserId: string },
): Promise<Set<string>> {
    const [open] = await tx
        .select({ id: learnRuns.id })
        .from(learnRuns)
        .where(
            and(
                eq(learnRuns.itemId, input.itemId),
                eq(learnRuns.userId, input.ownerUserId),
                eq(learnRuns.view, "private"),
                inArray(learnRuns.status, ["queued", "running", "ready"]),
            ),
        )
        .limit(1);
    if (open) return new Set();
    const runs = await tx
        .select()
        .from(learnRuns)
        .where(
            and(
                eq(learnRuns.itemId, input.itemId),
                eq(learnRuns.userId, input.ownerUserId),
                eq(learnRuns.scopeUserId, input.ownerUserId),
                eq(learnRuns.view, "private"),
                eq(learnRuns.status, "finished"),
            ),
        )
        .orderBy(desc(learnRuns.createdAt), desc(learnRuns.id));
    if (runs.length === 0) return new Set();
    const [processing] = await tx
        .select()
        .from(itemProcessing)
        .where(
            and(
                eq(itemProcessing.itemId, input.itemId),
                eq(itemProcessing.userId, input.ownerUserId),
                eq(itemProcessing.view, "private"),
            ),
        )
        .for("update")
        .limit(1);
    const [item] = await tx
        .select({ kind: chatterItems.kind })
        .from(chatterItems)
        .where(
            and(
                eq(chatterItems.id, input.itemId),
                eq(chatterItems.userId, input.ownerUserId),
            ),
        )
        .limit(1);
    if (!item) return new Set();
    let content: { id: string; revision: number; source: string } | undefined;
    if (item.kind === "mail") {
        const [mail] = await tx
            .select()
            .from(mailContents)
            .where(
                and(
                    eq(mailContents.itemId, input.itemId),
                    eq(mailContents.userId, input.ownerUserId),
                ),
            )
            .limit(1);
        if (mail)
            content = { id: mail.id, revision: mail.revision, source: "mail" };
    } else {
        const transcripts = await tx
            .select({
                id: transcriptions.id,
                revision: transcriptions.revision,
                source: transcriptions.source,
            })
            .from(transcriptions)
            .where(
                and(
                    eq(transcriptions.recordingId, input.itemId),
                    eq(transcriptions.userId, input.ownerUserId),
                ),
            );
        content = transcripts.find(
            (transcript) => transcript.source === "riffado",
        );
        if (!content) {
            const revisionId =
                processing?.phases.categorize?.placementProfile
                    ?.profileRevisionId ?? processing?.profileRevisionId;
            const [revision] = revisionId
                ? await tx
                      .select({ settings: processingProfileRevisions.settings })
                      .from(processingProfileRevisions)
                      .innerJoin(
                          processingProfiles,
                          eq(
                              processingProfiles.id,
                              processingProfileRevisions.profileId,
                          ),
                      )
                      .where(
                          and(
                              eq(processingProfileRevisions.id, revisionId),
                              inArray(processingProfiles.ownerUserId, [
                                  input.ownerUserId,
                                  input.orgUserId,
                              ]),
                              eq(processingProfiles.channel, "audio"),
                          ),
                      )
                      .limit(1)
                : [];
            const fallback =
                !revisionId &&
                processing?.phases.categorize?.reason === "legacy"
                    ? await resolveChannelDefaultProfile({
                          ownerUserId: input.ownerUserId,
                          channel: "audio",
                          view: "private",
                          executor: tx,
                          organizationUserId: input.orgUserId,
                          seedProfiles: false,
                          throwOnUnavailable: false,
                      })
                    : null;
            const settings = revision
                ? parseProfileSettings(
                      "audio",
                      JSON.parse(decryptText(revision.settings)),
                  )
                : fallback
                  ? parseProfileSettings("audio", fallback.settings)
                  : null;
            if (settings?.steps.transcribe.plaudTranscript === "use") {
                content = transcripts.find(
                    (transcript) => transcript.source === "plaud",
                );
            }
        }
    }
    if (!content) return new Set();
    for (const run of runs) {
        if (
            run.transcriptionId !==
                (item.kind === "audio" ? content.id : null) ||
            run.transcriptRevision !== content.revision ||
            run.inputs?.contentId !== content.id ||
            run.inputs.contentRevision !== content.revision
        )
            continue;
        const receiptId = domainLookupHash(
            "learn-share-receipt",
            `${input.orgUserId}:${run.id}`,
        );
        const rows = await tx
            .select()
            .from(learnReviewItems)
            .where(
                and(
                    eq(learnReviewItems.runId, run.id),
                    eq(learnReviewItems.userId, input.ownerUserId),
                ),
            );
        const stats: Record<string, number> = {};
        for (const key of ["applied", "skipped", "dismissed"] as const) {
            const value = run.stats?.[key];
            if (value !== undefined) stats[key] = value;
        }
        if (rows.every((row) => row.outcome !== null)) {
            stats.applied ??= rows.filter(
                (row) => row.outcome === "applied",
            ).length;
            stats.skipped ??= rows.filter(
                (row) =>
                    row.outcome &&
                    row.outcome !== "applied" &&
                    row.outcome !== "rejected",
            ).length;
            stats.dismissed ??= rows.filter(
                (row) => row.outcome === "rejected",
            ).length;
        }
        const now = new Date();
        const inputs = {
            contentId: content.id,
            contentRevision: content.revision,
            contentSourceId: content.source,
        };
        const [receipt] = await tx
            .insert(learnRuns)
            .values({
                id: receiptId,
                userId: input.ownerUserId,
                scopeUserId: input.orgUserId,
                itemId: input.itemId,
                transcriptionId: run.transcriptionId,
                view: "org",
                actorUserId: run.actorUserId,
                trigger: run.trigger,
                status: "finished",
                transcriptRevision: content.revision,
                vocabularyVersion: run.vocabularyVersion,
                inputs: { ...inputs, promotedFromRunId: run.id },
                stats,
                finishedAt: now,
                createdAt: now,
                updatedAt: now,
            })
            .onConflictDoNothing()
            .returning({ id: learnRuns.id });
        if (!receipt) return new Set();
        const unfinishedJobs = await tx
            .select({ id: asyncJobs.id })
            .from(asyncJobs)
            .where(
                and(
                    eq(asyncJobs.userId, input.ownerUserId),
                    eq(asyncJobs.subjectId, input.itemId),
                    eq(asyncJobs.kind, "learn.run"),
                    inArray(asyncJobs.status, ["pending", "processing"]),
                    inArray(
                        sql<string>`${asyncJobs.payload} ->> 'runId'`,
                        runs.map((finished) => finished.id),
                    ),
                ),
            );
        for (const job of unfinishedJobs) {
            await settleTerminalJobInTx(tx, {
                jobId: job.id,
                cancelForUserId: input.ownerUserId,
                status: "failed",
                code: "scope_changed",
                message:
                    "Finished private Learn shared before its worker settled",
                result: {
                    outcome: { kind: "skipped", reason: "scope_changed" },
                },
            });
        }
        const scopes = await publishUnreferencedRecordsInTx(
            tx,
            run,
            rows,
            input.orgUserId,
        );
        await cancelPrivateCorrectionsAtShareInTx(
            tx,
            input.itemId,
            input.ownerUserId,
        );
        await tx
            .update(chatterItems)
            .set({ summaryDueAt: null })
            .where(
                and(
                    eq(chatterItems.id, input.itemId),
                    eq(chatterItems.userId, input.ownerUserId),
                ),
            );
        const learn = processing?.phases.learn;
        if (
            learn?.state === "done" &&
            learn.inputs?.contentId === inputs.contentId &&
            learn.inputs.contentRevision === inputs.contentRevision &&
            learn.inputs.contentSourceId === inputs.contentSourceId &&
            unfinishedJobs.length === 0
        )
            return scopes;
        const advance = await requestAdvanceInTx(tx, {
            itemId: input.itemId,
            userId: input.ownerUserId,
            view: "private",
            reason: "review-finished",
        });
        if (advance)
            await updatePhaseInTx(
                tx,
                input.itemId,
                "private",
                input.ownerUserId,
                "learn",
                {
                    state: "done",
                    reason: "released",
                    generation: advance.requestedGeneration,
                    inputs,
                    at: now.toISOString(),
                },
            );
        return scopes;
    }
    return new Set();
}
