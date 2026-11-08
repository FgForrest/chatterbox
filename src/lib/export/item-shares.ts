import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { archivedMeetingShareCondition } from "@/db/queries/archived-meeting-shares";
import { type ItemShareState, itemShares, users } from "@/db/schema";
import type { ArchiveScope } from "@/lib/export/archive-scope";

export interface ArchivedItemShare {
    itemId: string;
    receiverEmail: string;
    state: ItemShareState;
    invitedAt: string;
    respondedAt: string | null;
    removedAt: string | null;
}

/** Direct shares of the owner's archived items, without the receiver's filing. */
export async function collectArchivedItemShares(
    scope: ArchiveScope,
    itemIds: ReadonlySet<string>,
): Promise<ArchivedItemShare[]> {
    if (scope.kind !== "personal") return [];
    const rows = await db
        .select({
            itemId: itemShares.itemId,
            receiverEmail: users.email,
            state: itemShares.state,
            invitedAt: itemShares.invitedAt,
            respondedAt: itemShares.respondedAt,
            removedAt: itemShares.removedAt,
        })
        .from(itemShares)
        .innerJoin(users, eq(users.id, itemShares.receiverUserId))
        .where(
            and(
                eq(itemShares.userId, scope.userId),
                or(
                    inArray(itemShares.itemId, [...itemIds]),
                    archivedMeetingShareCondition(scope.userId),
                ),
                isNull(itemShares.folderShareId),
            ),
        );
    return rows.map((row) => ({
        ...row,
        invitedAt: row.invitedAt.toISOString(),
        respondedAt: row.respondedAt?.toISOString() ?? null,
        removedAt: row.removedAt?.toISOString() ?? null,
    }));
}
