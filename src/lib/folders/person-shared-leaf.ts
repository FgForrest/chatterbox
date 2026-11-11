import { and, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { db } from "@/db";
import {
    folderShares,
    receivedFolderAttachments,
    recordingFolders,
} from "@/db/schema";
import { AppError, ErrorCode } from "@/lib/errors";
import { isOrgScopeVisible } from "@/lib/org/config";
import type { FolderScope } from "@/types/folder";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Refuse new children of a person-shared private folder while holding its owner's private-tree lock. */
export async function assertPersonSharedFolderAllowsChildren(
    tx: Tx,
    container: { scope: FolderScope; ownerId: string; folder: { id: string } },
    existingParentId?: string | null,
): Promise<void> {
    if (
        !isOrgScopeVisible() ||
        container.scope !== "personal" ||
        existingParentId === container.folder.id
    )
        return;
    const [share] = await tx
        .select({ id: folderShares.id })
        .from(folderShares)
        .where(
            and(
                eq(folderShares.userId, container.ownerId),
                eq(folderShares.folderId, container.folder.id),
                inArray(folderShares.state, ["pending", "accepted"]),
            ),
        )
        .limit(1);
    if (share)
        throw new AppError(
            ErrorCode.SHARED_FOLDER_HAS_NO_SUBFOLDERS,
            "A shared folder has no subfolders.",
            409,
        );
}

/** Whether an owned folder has direct folder or received-attachment children, without revealing names. */
export async function folderHasSubfolders(
    executor: Pick<typeof db, "select">,
    userId: string,
    folderId: string,
): Promise<boolean> {
    if (!isOrgScopeVisible()) return false;
    const parent = alias(recordingFolders, "parent");
    const [child] = await executor
        .select({ id: recordingFolders.id })
        .from(recordingFolders)
        .innerJoin(parent, eq(parent.id, recordingFolders.parentId))
        .where(and(eq(parent.userId, userId), eq(parent.id, folderId)))
        .limit(1);
    if (child) return true;
    const [attachment] = await executor
        .select({ id: receivedFolderAttachments.id })
        .from(receivedFolderAttachments)
        .innerJoin(parent, eq(parent.id, receivedFolderAttachments.parentId))
        .where(
            and(
                eq(parent.userId, userId),
                eq(parent.id, folderId),
                eq(receivedFolderAttachments.userId, userId),
            ),
        )
        .limit(1);
    return !!attachment;
}
