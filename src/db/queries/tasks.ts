import { type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { db } from "@/db";
import { chatterItems, recordingTasks, taskUpdateProposals } from "@/db/schema";
import { recordingSharedCondition } from "@/lib/knowledge/org-people";

/** SQL: an open task target that the named reviewer can currently see. */
export function reviewableTaskTargetCondition(
    taskId: SQLWrapper | string,
    reviewerUserId: SQLWrapper | string,
    organizationOnly = false,
): SQL {
    return sql`exists (
        select 1 from ${recordingTasks} target
        inner join ${chatterItems} target_item
            on target_item.id = target.recording_id
        where target.id = ${taskId}
            and target.status = 'open'
            and target_item.deleted_at is null
            and (
                ${organizationOnly ? sql`false` : sql`target_item.user_id = ${reviewerUserId}`}
                or ${recordingSharedCondition(sql`target_item.id`)}
            )
    )`;
}

/** SQL: a follow-up whose open target item is still visible to its owner. */
export function liveFollowUpCondition(): SQL {
    return reviewableTaskTargetCondition(
        taskUpdateProposals.taskId,
        taskUpdateProposals.userId,
    );
}

/** PostgreSQL's plan for the folder-first candidate join used by task matching. */
export async function explainScopedTaskCandidatePlan(
    itemIds: readonly string[],
): Promise<string[]> {
    if (itemIds.length === 0) return [];
    const values = sql.join(
        itemIds.map((itemId) => sql`${itemId}`),
        sql`, `,
    );
    const rows = await db.execute<{ "QUERY PLAN": string }>(sql`
        explain (format text)
        select task.id
        from task_mentions mention
        inner join recording_tasks task on task.id = mention.task_id
        where mention.item_id in (${values})
          and mention.match_decision in ('home', 'accepted')
          and task.status = 'open'
    `);
    return rows.map((row) => row["QUERY PLAN"]);
}
