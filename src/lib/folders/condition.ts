import {
    type AnyColumn,
    and,
    eq,
    exists,
    inArray,
    or,
    type SQL,
    sql,
} from "drizzle-orm";
import { db } from "@/db";
import {
    receivedItemCondition,
    receivedThroughFolderCondition,
} from "@/db/queries/item-shares";
import {
    itemShares,
    recordingFolderAssignments,
    recordings,
} from "@/db/schema";
import { listFolderOrganization } from "@/lib/folders/folders";
import { descendantFolderIds } from "@/lib/folders/hierarchy";
import type { FolderOrganization } from "@/types/folder";

/**
 * SQL over `recordings` (or the item columns given): those filed in
 * `folderId` or below it, in the tree `userId` sees (`organization`). The
 * Private root holds every recording of its owner. Null when the folder is
 * not in that tree.
 */
export function folderRecordingCondition(
    organization: FolderOrganization,
    userId: string,
    folderId: string,
    item: { id: AnyColumn; userId: AnyColumn } = {
        id: recordings.id,
        userId: recordings.userId,
    },
): SQL | null {
    const folder = organization.folders.find((entry) => entry.id === folderId);
    if (!folder) return null;
    if (folder.receivedFolder)
        return or(
            receivedThroughFolderCondition(userId, item.id, folder.id),
            folder.receivedFolder.sourceFolderId
                ? and(
                      eq(item.userId, userId),
                      exists(
                          db
                              .select({ one: sql`1` })
                              .from(recordingFolderAssignments)
                              .where(
                                  and(
                                      eq(
                                          recordingFolderAssignments.itemId,
                                          item.id,
                                      ),
                                      eq(
                                          recordingFolderAssignments.userId,
                                          userId,
                                      ),
                                      eq(
                                          recordingFolderAssignments.folderId,
                                          folder.receivedFolder.sourceFolderId,
                                      ),
                                  ),
                              ),
                      ),
                  )
                : undefined,
        ) as SQL;
    if (folder.kind === "private")
        return or(
            eq(item.userId, userId),
            receivedItemCondition(userId, item.id),
        ) as SQL;
    const ids = [...descendantFolderIds(organization.folders, folderId)];
    const owned = exists(
        db
            .select({ one: sql`1` })
            .from(recordingFolderAssignments)
            .where(
                and(
                    eq(recordingFolderAssignments.itemId, item.id),
                    inArray(recordingFolderAssignments.folderId, ids),
                ),
            ),
    );
    if (folder.scope !== "personal") return owned;
    const attached = organization.folders.filter(
        (entry) => entry.receivedFolder && ids.includes(entry.id),
    );
    return or(
        owned,
        ...attached.map((entry) =>
            receivedThroughFolderCondition(userId, item.id, entry.id),
        ),
        and(
            receivedItemCondition(userId, item.id),
            exists(
                db
                    .select({ one: sql`1` })
                    .from(itemShares)
                    .where(
                        and(
                            eq(itemShares.itemId, item.id),
                            eq(itemShares.receiverUserId, userId),
                            eq(itemShares.state, "accepted"),
                            inArray(itemShares.filingFolderId, ids),
                        ),
                    ),
            ),
        ),
    ) as SQL;
}

/**
 * A folder filter: the recordings filed in it or below, as `userId` sees
 * the tree; nothing for a folder they do not see.
 */
export async function folderCondition(
    userId: string,
    folderId: string,
    item?: { id: AnyColumn; userId: AnyColumn },
): Promise<SQL> {
    const organization = await listFolderOrganization(userId);
    return (
        folderRecordingCondition(organization, userId, folderId, item) ??
        sql`false`
    );
}
