import { createHash } from "node:crypto";
import {
    and,
    count,
    eq,
    inArray,
    isNotNull,
    isNull,
    or,
    type SQL,
    sql,
} from "drizzle-orm";
import { db } from "@/db";
import {
    aiEnhancements,
    chatterItems,
    people,
    recordingTaskRejections,
    recordingTasks,
    summaryRemarks,
    taskMentions,
    taskUpdateProposals,
    transcriptCorrections,
    transcriptions,
    transcriptSpeakers,
} from "@/db/schema";
import { orgOwnedCondition } from "@/lib/knowledge/org-people";

/** Read the same title marker for the dashboard and the processing projection. */
export function itemTitleVersion() {
    return sql<string>`md5(${chatterItems.title}::text)`;
}

/** Read the stored topics marker without decrypting the topics. */
export function transcriptTopicsVersion() {
    return sql<string | null>`md5(${transcriptions.topics}::text)`;
}

/** Identify the text revision and persisted topics rendered by the dashboard. */
export function transcriptPartVersion(
    id: string,
    revision: number,
    topics: string | null,
) {
    return createHash("sha256")
        .update(JSON.stringify([id, revision, topics]))
        .digest("hex");
}

/** Version of the remarks on the current owner-scoped summary. */
export function summaryRemarksVersion() {
    return sql<string>`(
        select md5(coalesce(string_agg(concat_ws(':', ${summaryRemarks.id}, ${summaryRemarks.createdAt}), ',' order by ${summaryRemarks.id}), ''))
        from ${summaryRemarks}
        where ${summaryRemarks.itemId} = ${aiEnhancements.itemId}
          and ${summaryRemarks.userId} = ${aiEnhancements.userId}
    )`;
}

/** Fingerprint the item's own task rows without reading their text or other items' tasks. */
export function itemTaskRowsVersion(isOwner: boolean, view: SQL) {
    return sql<string>`(
        select md5(coalesce(string_agg(v, ',' order by v), ''))
        from (
            select concat_ws(':', 'task', ${recordingTasks.id}, ${recordingTasks.version}, ${recordingTasks.updatedAt}) as v
            from ${recordingTasks}
            where ${recordingTasks.itemId} = ${chatterItems.id}
              and ${recordingTasks.userId} = ${chatterItems.userId}
              and (${isOwner} or ${recordingTasks.status} <> 'proposed')
            union all
            select concat_ws(':', 'mention', ${taskMentions.id}, ${taskMentions.updatedAt})
            from ${taskMentions}
            where ${taskMentions.itemId} = ${chatterItems.id}
              and ${taskMentions.userId} = ${chatterItems.userId}
              and ${taskMentions.view} = ${view}
              and (${taskMentions.matchDecision} = 'accepted' or (${isOwner} and ${taskMentions.matchDecision} = 'suggested'))
            union all
            select concat_ws(':', 'proposal', ${taskUpdateProposals.id}, ${taskUpdateProposals.version}, ${taskUpdateProposals.updatedAt})
            from ${taskUpdateProposals}
            where ${isOwner}
              and ${taskUpdateProposals.itemId} = ${chatterItems.id}
              and ${taskUpdateProposals.userId} = ${chatterItems.userId}
              and (${taskUpdateProposals.state} = 'awaiting_source_review' or
                   (${taskUpdateProposals.state} = 'obsolete' and
                    ${taskUpdateProposals.obsoleteReason} = 'earlier_statement' and
                    ${taskUpdateProposals.decidedByUserId} is null))
            union all
            select concat_ws(':', 'rejection', ${recordingTaskRejections.id})
            from ${recordingTaskRejections}
            where ${recordingTaskRejections.itemId} = ${chatterItems.id}
              and ${recordingTaskRejections.userId} = ${chatterItems.userId}
        ) task_rows
    )`;
}

/** Count and newest change among the item's visible rows, grouped by transcript. */
export async function loadTranscriptOverlayVersions(
    ownerUserId: string,
    transcriptIds: string[],
    shared: boolean,
    canSeeSuggestions: boolean,
) {
    if (transcriptIds.length === 0) return { corrections: [], speakers: [] };
    const [corrections, speakers] = await Promise.all([
        db
            .select({
                id: transcriptCorrections.transcriptionId,
                count: count(),
                updatedAt: sql<
                    string | null
                >`max(${transcriptCorrections.updatedAt})::text`,
            })
            .from(transcriptCorrections)
            .where(
                and(
                    inArray(
                        transcriptCorrections.transcriptionId,
                        transcriptIds,
                    ),
                    shared
                        ? orgOwnedCondition(transcriptCorrections.userId)
                        : eq(transcriptCorrections.userId, ownerUserId),
                ),
            )
            .groupBy(transcriptCorrections.transcriptionId),
        db
            .select({
                id: transcriptSpeakers.transcriptionId,
                count: count(),
                updatedAt: sql<
                    string | null
                >`max(${transcriptSpeakers.updatedAt})::text`,
            })
            .from(transcriptSpeakers)
            .leftJoin(
                people,
                and(
                    eq(people.id, transcriptSpeakers.personId),
                    orgOwnedCondition(people.userId),
                ),
            )
            .where(
                and(
                    eq(transcriptSpeakers.userId, ownerUserId),
                    inArray(transcriptSpeakers.transcriptionId, transcriptIds),
                    shared
                        ? or(
                              isNull(transcriptSpeakers.personId),
                              isNotNull(people.id),
                          )
                        : undefined,
                    shared && !canSeeSuggestions
                        ? eq(transcriptSpeakers.status, "confirmed")
                        : undefined,
                ),
            )
            .groupBy(transcriptSpeakers.transcriptionId),
    ]);
    return { corrections, speakers };
}
