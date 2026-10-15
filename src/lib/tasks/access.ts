import { and, eq, or, type SQL, sql } from "drizzle-orm";
import { db } from "@/db";
import {
    ANY_TASK_ITEM,
    RECORDING_TASK_ITEM,
    type TaskItemColumns,
    type TaskViewer,
    taskRecordingShared,
    taskVisible,
} from "@/db/queries/task-visibility";
import { people, recordingTasks, users } from "@/db/schema";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { getOrgUserId } from "@/lib/org/config";

export { ANY_TASK_ITEM, RECORDING_TASK_ITEM, taskRecordingShared, taskVisible };
export type { TaskItemColumns, TaskViewer };

/** The viewer for a signed-in user. */
export async function taskViewer(user: {
    id: string;
    email: string;
}): Promise<TaskViewer> {
    const orgUserId = await getOrgUserId();
    return {
        userId: user.id,
        emailHash: lookupHash(user.email),
        isOrg: orgUserId !== null && orgUserId === user.id,
        orgUserId,
    };
}

/** The viewer for a user known by id, as a background run sees its owner. */
export async function taskViewerById(userId: string): Promise<TaskViewer> {
    const [user] = await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
    return taskViewer(user ?? { id: userId, email: "" });
}

/** SQL: the task is assigned to the viewer (needs nothing joined). */
export function assignedToViewer(viewer: TaskViewer): SQL {
    return sql`exists (
        select 1 from ${people}
        where ${people.id} = ${recordingTasks.assigneePersonId}
            and ${people.primaryEmailHash} = ${viewer.emailHash}
    )`;
}

/**
 * SQL: the task is in one of the viewer's lists, as the Tasks page shows
 * them (`recordings` joined): the organization account's are the shared
 * recordings' tasks; a user's are their own recordings' tasks and the
 * shared ones assigned to them.
 */
export function taskListed(
    viewer: TaskViewer,
    item: TaskItemColumns = RECORDING_TASK_ITEM,
): SQL {
    if (viewer.isOrg) return taskRecordingShared(viewer, item);
    return or(
        eq(item.userId, viewer.userId),
        and(taskVisible(viewer, item), assignedToViewer(viewer)),
    ) as SQL;
}

/** SQL: the viewer may mark the task done or open again (`recordings` joined, or `item`). */
export function taskClosable(
    viewer: TaskViewer,
    item: TaskItemColumns = RECORDING_TASK_ITEM,
): SQL {
    const shared = taskRecordingShared(viewer, item);
    if (viewer.isOrg) return shared;
    return or(
        eq(item.userId, viewer.userId),
        and(shared, assignedToViewer(viewer)),
    ) as SQL;
}

/** SQL: the viewer may change the task (`recordings` joined, or `item`). */
export function taskEditable(
    viewer: TaskViewer,
    item: TaskItemColumns = RECORDING_TASK_ITEM,
): SQL {
    const shared = taskRecordingShared(viewer, item);
    if (viewer.isOrg) return shared;
    return and(eq(item.userId, viewer.userId), sql`not (${shared})`) as SQL;
}
