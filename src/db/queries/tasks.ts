import { type SQL, sql } from "drizzle-orm";
import { chatterItems, recordingTasks, taskUpdateProposals } from "@/db/schema";
import { recordingSharedCondition } from "@/lib/knowledge/org-people";

/** SQL: a follow-up whose open target item is still visible to its owner. */
export function liveFollowUpCondition(): SQL {
    return sql`exists (
        select 1 from ${recordingTasks} target
        inner join ${chatterItems} target_item
            on target_item.id = target.recording_id
        where target.id = ${taskUpdateProposals.taskId}
            and target.status = 'open'
            and target_item.deleted_at is null
            and (
                target_item.user_id = ${taskUpdateProposals.userId}
                or ${recordingSharedCondition(sql`target_item.id`)}
            )
    )`;
}
