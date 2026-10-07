import { and, eq, or, type SQL, sql } from "drizzle-orm";
import { db } from "@/db";
import { people, recordings, recordingTasks, users } from "@/db/schema";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { getOrgUserId } from "@/lib/org/config";
import { sharedRecordingCondition } from "@/lib/sharing/shared";

/**
 * Who may do what with a task (Johnny, 2026-10-07):
 *
 * | action                   | private recording | shared recording                          |
 * |--------------------------|-------------------|-------------------------------------------|
 * | edit, add, drop, review  | owner             | organization account                      |
 * | done, reopen             | owner             | organization account, owner, assignee     |
 * | see                      | owner             | everyone; in a list: owner, assignee, org |
 *
 * A task on a private recording reaches nobody but its owner, even when it
 * names someone else: tasks travel only through the Organization. The
 * assignee is a user when their person's email is that user's login email.
 */
export interface TaskViewer {
    userId: string;
    /** `lookupHash` of the viewer's login email. */
    emailHash: string;
    isOrg: boolean;
    /** The organization account this instance shows, or null. */
    orgUserId: string | null;
}

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

/** SQL: the task's recording (`recordings` joined) is shared. */
export function taskRecordingShared(viewer: TaskViewer): SQL {
    return viewer.orgUserId
        ? sharedRecordingCondition(viewer.orgUserId)
        : sql`false`;
}

/** SQL: the task is assigned to the viewer (needs nothing joined). */
export function assignedToViewer(viewer: TaskViewer): SQL {
    return sql`exists (
        select 1 from ${people}
        where ${people.id} = ${recordingTasks.assigneePersonId}
            and ${people.primaryEmailHash} = ${viewer.emailHash}
    )`;
}

/** SQL: the viewer may see the task (`recordings` joined). */
export function taskVisible(viewer: TaskViewer): SQL {
    const shared = taskRecordingShared(viewer);
    if (viewer.isOrg) return shared;
    return or(eq(recordings.userId, viewer.userId), shared) as SQL;
}

/**
 * SQL: the task is in one of the viewer's lists, as the Tasks page shows
 * them (`recordings` joined): the organization account's are the shared
 * recordings' tasks; a user's are their own recordings' tasks and the
 * shared ones assigned to them.
 */
export function taskListed(viewer: TaskViewer): SQL {
    if (viewer.isOrg) return taskRecordingShared(viewer);
    return or(
        eq(recordings.userId, viewer.userId),
        and(taskVisible(viewer), assignedToViewer(viewer)),
    ) as SQL;
}

/** SQL: the viewer may mark the task done or open again (`recordings` joined). */
export function taskClosable(viewer: TaskViewer): SQL {
    const shared = taskRecordingShared(viewer);
    if (viewer.isOrg) return shared;
    return or(
        eq(recordings.userId, viewer.userId),
        and(shared, assignedToViewer(viewer)),
    ) as SQL;
}

/** SQL: the viewer may change the task (`recordings` joined). */
export function taskEditable(viewer: TaskViewer): SQL {
    const shared = taskRecordingShared(viewer);
    if (viewer.isOrg) return shared;
    return and(
        eq(recordings.userId, viewer.userId),
        sql`not (${shared})`,
    ) as SQL;
}
