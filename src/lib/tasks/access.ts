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
import {
    actsForOrganization,
    userCuratesOrganizationNow,
} from "@/lib/authz/curator";
import type { ActorContext } from "@/lib/authz/model";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { getOrgUserId } from "@/lib/org/config";

export { ANY_TASK_ITEM, RECORDING_TASK_ITEM, taskRecordingShared, taskVisible };
export type { TaskItemColumns, TaskViewer };

/** The viewer for a signed-in user. */
export async function taskViewer(
    user: {
        id: string;
        email: string;
    },
    actor?: ActorContext,
): Promise<TaskViewer> {
    const orgUserId = await getOrgUserId();
    const isCurator = actor
        ? await actsForOrganization(actor)
        : await userCuratesOrganizationNow(user.id);
    return {
        userId: user.id,
        emailHash: lookupHash(user.email),
        isOrg: orgUserId !== null && orgUserId === user.id,
        isCurator,
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
 * them (`recordings` joined): their home tasks, shared tasks assigned to
 * them, and every shared task when they are a curator.
 */
export function taskListed(
    viewer: TaskViewer,
    item: TaskItemColumns = RECORDING_TASK_ITEM,
): SQL {
    const own = eq(item.userId, viewer.userId);
    const shared = taskRecordingShared(viewer, item);
    if (viewer.isCurator) return or(own, shared) as SQL;
    return or(own, and(shared, assignedToViewer(viewer))) as SQL;
}

/** SQL: the viewer may mark the task done or open again (`recordings` joined, or `item`). */
export function taskClosable(
    viewer: TaskViewer,
    item: TaskItemColumns = RECORDING_TASK_ITEM,
): SQL {
    const own = eq(item.userId, viewer.userId);
    const shared = taskRecordingShared(viewer, item);
    if (viewer.isCurator) return or(own, shared) as SQL;
    return or(own, and(shared, assignedToViewer(viewer))) as SQL;
}

/** SQL: the viewer may change the task (`recordings` joined, or `item`). */
export function taskEditable(
    viewer: TaskViewer,
    item: TaskItemColumns = RECORDING_TASK_ITEM,
): SQL {
    const own = eq(item.userId, viewer.userId);
    const shared = taskRecordingShared(viewer, item);
    return viewer.isCurator ? (or(own, shared) as SQL) : own;
}

/** Whether the viewer may remove `sourceOwnerUserId`'s task into the target. */
export function mayMergeTaskOwners(
    viewer: TaskViewer,
    sourceOwnerUserId: string,
    targetOwnerUserId: string,
): boolean {
    if (sourceOwnerUserId === viewer.userId) return true;
    if (!viewer.isCurator) return false;
    return (
        sourceOwnerUserId === targetOwnerUserId ||
        targetOwnerUserId === viewer.userId
    );
}
