import { and, asc, eq, gt, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { db } from "@/db";
import {
    aiEnhancements,
    asyncJobs,
    itemProcessing,
    learnRuns,
    processingProfileRevisions,
    processingProfiles,
    transcriptions,
} from "@/db/schema";
import { decryptJsonField } from "@/lib/encryption/fields";

type Executor = Pick<typeof db, "select">;
const TOPICS_BATCH_SIZE = 100;

/** Check references after establishing profile ownership, returning at the first match. */
export async function profileHistoryReferences(
    executor: Executor,
    ownerUserId: string,
    profileId: string,
): Promise<boolean> {
    const revisions = await executor
        .select({
            id: processingProfileRevisions.id,
            scope: processingProfiles.scope,
        })
        .from(processingProfileRevisions)
        .innerJoin(
            processingProfiles,
            and(
                eq(processingProfiles.id, processingProfileRevisions.profileId),
                eq(processingProfiles.ownerUserId, ownerUserId),
            ),
        )
        .where(eq(processingProfileRevisions.profileId, profileId));
    const revisionIds = revisions.map(({ id }) => id);
    const assigned = await executor
        .select({ id: itemProcessing.itemId })
        .from(itemProcessing)
        .where(eq(itemProcessing.profileId, profileId))
        .limit(1);
    if (assigned.length > 0) return true;
    if (revisionIds.length === 0) return false;
    const revision = await executor
        .select({ id: itemProcessing.itemId })
        .from(itemProcessing)
        .where(inArray(itemProcessing.profileRevisionId, revisionIds))
        .limit(1);
    if (revision.length > 0) return true;
    for (const table of [transcriptions, learnRuns, aiEnhancements]) {
        const output = await executor
            .select({ id: table.id })
            .from(table)
            .where(inArray(table.profileRevisionId, revisionIds))
            .limit(1);
        if (output.length > 0) return true;
    }
    const job = await executor
        .select({ id: asyncJobs.id })
        .from(asyncJobs)
        .where(
            inArray(
                sql<string>`${asyncJobs.payload} ->> 'profileRevisionId'`,
                revisionIds,
            ),
        )
        .limit(1);
    if (job.length > 0) return true;
    for (const table of [transcriptions, learnRuns, aiEnhancements]) {
        const output = await executor
            .select({ id: table.id })
            .from(table)
            .where(
                inArray(
                    sql<string>`${table.inputs} ->> 'itemProfileRevisionId'`,
                    revisionIds,
                ),
            )
            .limit(1);
        if (output.length > 0) return true;
    }
    const revisionPredicate = revisionIds
        .map((id) => `@ == ${JSON.stringify(id)}`)
        .join(" || ");
    const phase = await executor
        .select({ id: itemProcessing.itemId })
        .from(itemProcessing)
        .where(
            or(
                and(
                    eq(itemProcessing.userId, ownerUserId),
                    sql`${itemProcessing.phases} @? ${`$.**.profileRevisionId ? (${revisionPredicate})`}::jsonpath`,
                ),
                revisions[0]?.scope === "organization"
                    ? or(
                          sql`${itemProcessing.phases}->'categorize'->'placementProfile'->>'profileId' = ${profileId}`,
                          sql`${itemProcessing.phases} @? ${`$.categorize.heldProfiles.*.profileRevisionId ? (${revisionPredicate})`}::jsonpath`,
                      )
                    : undefined,
            ),
        )
        .limit(1);
    if (phase.length > 0) return true;
    const wanted = new Set(revisionIds);
    let afterId: string | undefined;
    while (true) {
        const topics = await executor
            .select({ id: transcriptions.id, topics: transcriptions.topics })
            .from(transcriptions)
            .where(
                and(
                    eq(transcriptions.userId, ownerUserId),
                    isNotNull(transcriptions.topics),
                    afterId ? gt(transcriptions.id, afterId) : undefined,
                ),
            )
            .orderBy(asc(transcriptions.id))
            .limit(TOPICS_BATCH_SIZE);
        for (const row of topics) {
            const stored = decryptJsonField<{
                profileRevisionId?: string | null;
            }>(row.topics);
            if (
                stored?.profileRevisionId &&
                wanted.has(stored.profileRevisionId)
            )
                return true;
        }
        if (topics.length < TOPICS_BATCH_SIZE) return false;
        afterId = topics.at(-1)?.id;
    }
}
