import { and, eq, isNull, ne, or, type SQL } from "drizzle-orm";
import { db } from "@/db";
import {
    ANY_TASK_ITEM,
    assignedToViewer,
    personalTask,
    RECORDING_TASK_ITEM,
    type TaskItemColumns,
    type TaskViewer,
    taskFollowed,
    taskRecordingShared,
    taskVisible,
} from "@/db/queries/task-visibility";
import { chatterItems, recordingTasks, users } from "@/db/schema";
import {
    actsForOrganization,
    userCuratesOrganizationNow,
} from "@/lib/authz/curator";
import type { ActorContext } from "@/lib/authz/model";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { getOrgUserId } from "@/lib/org/config";

export {
    ANY_TASK_ITEM,
    RECORDING_TASK_ITEM,
    personalTask,
    taskRecordingShared,
    taskVisible,
    assignedToViewer,
    taskFollowed,
};
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

/**
 * SQL: the task is in one of the viewer's lists, as the Tasks page shows
 * them (`recordings` joined): their home tasks, shared tasks assigned to
 * them, and every shared task when they are a curator.
 */
export function taskListed(
    viewer: TaskViewer,
    item: TaskItemColumns = RECORDING_TASK_ITEM,
): SQL {
    return or(
        taskClosable(viewer, item, true),
        taskFollowed(viewer, item),
    ) as SQL;
}

/** SQL: the viewer may mark the task done or open again (`recordings` joined, or `item`). */
export function taskClosable(
    viewer: TaskViewer,
    item: TaskItemColumns = RECORDING_TASK_ITEM,
    includePersonal = false,
): SQL {
    const own = ownedByViewer(viewer, item, includePersonal);
    const shared = taskRecordingShared(viewer, item);
    if (viewer.isCurator) return or(own, shared) as SQL;
    return or(own, and(shared, assignedToViewer(viewer))) as SQL;
}

/** SQL: the viewer may change the task (`recordings` joined, or `item`). */
export function taskEditable(
    viewer: TaskViewer,
    item: TaskItemColumns = RECORDING_TASK_ITEM,
    includePersonal = false,
): SQL {
    const own = ownedByViewer(viewer, item, includePersonal);
    const shared = taskRecordingShared(viewer, item);
    return viewer.isCurator ? (or(own, shared) as SQL) : own;
}

function ownedByViewer(
    viewer: TaskViewer,
    item: TaskItemColumns,
    includePersonal: boolean,
): SQL {
    return or(
        eq(item.userId, viewer.userId),
        includePersonal ? personalTask(viewer) : undefined,
    ) as SQL;
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

/** SQL: a task may be merged by its editor or assignee. */
export function taskMergeable(
    viewer: TaskViewer,
    item: TaskItemColumns = ANY_TASK_ITEM,
): SQL {
    return and(
        taskVisible(viewer, item, true),
        or(taskEditable(viewer, item, true), assignedToViewer(viewer)),
    ) as SQL;
}

/** Lock only the visible accepted task to serialize personal follow changes. */
export async function lockFollowableTask(
    executor: Pick<typeof db, "select">,
    viewer: TaskViewer,
    taskId: string,
): Promise<boolean> {
    const [task] = await executor
        .select({ id: recordingTasks.id })
        .from(recordingTasks)
        .leftJoin(chatterItems, eq(chatterItems.id, recordingTasks.itemId))
        .where(
            and(
                eq(recordingTasks.id, taskId),
                ne(recordingTasks.status, "proposed"),
                isNull(chatterItems.deletedAt),
                taskVisible(viewer, ANY_TASK_ITEM, true),
            ),
        )
        .for("no key update", { of: recordingTasks })
        .limit(1);
    return Boolean(task);
}
