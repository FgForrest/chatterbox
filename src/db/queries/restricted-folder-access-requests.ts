import { and, eq, inArray } from "drizzle-orm";
import type { db } from "@/db";
import { restrictedFolderAccessRequests } from "@/db/schema";

type Writer = Pick<typeof db, "update">;

/** Membership additions settle pending requests in the same tree-locked transaction. */
export async function approvePendingFolderRequests(
    executor: Writer,
    folderId: string,
    userIds: string[],
    decidedByUserId: string,
) {
    if (!userIds.length) return [];
    return executor
        .update(restrictedFolderAccessRequests)
        .set({ state: "approved", decidedByUserId, decidedAt: new Date() })
        .where(
            and(
                eq(restrictedFolderAccessRequests.folderId, folderId),
                inArray(restrictedFolderAccessRequests.userId, userIds),
                eq(restrictedFolderAccessRequests.state, "pending"),
            ),
        )
        .returning({ userId: restrictedFolderAccessRequests.userId });
}

/** Loss of Organization membership permanently cancels outstanding requests. */
export async function cancelUserFolderRequests(
    executor: Writer,
    userId: string,
) {
    await executor
        .update(restrictedFolderAccessRequests)
        .set({ state: "cancelled", decidedAt: new Date() })
        .where(
            and(
                eq(restrictedFolderAccessRequests.userId, userId),
                eq(restrictedFolderAccessRequests.state, "pending"),
            ),
        );
}

/** Lifting a restriction cancels requests without granting membership. */
export async function cancelFolderRequests(executor: Writer, folderId: string) {
    await executor
        .update(restrictedFolderAccessRequests)
        .set({ state: "cancelled", decidedAt: new Date() })
        .where(
            and(
                eq(restrictedFolderAccessRequests.folderId, folderId),
                eq(restrictedFolderAccessRequests.state, "pending"),
            ),
        );
}
