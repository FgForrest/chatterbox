import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { db } from "@/db";
import {
    notifyRestrictedAudienceInTx,
    restrictedMemberCondition,
} from "@/db/queries/restricted-folders";
import {
    chatterItems,
    recordingFolderAssignments,
    recordingFolders,
    restrictedFolderMembers,
} from "@/db/schema";
import { AppError, ErrorCode } from "@/lib/errors";

/** File without publication after the caller takes the tree and item locks. */
export async function recordWithheldPlacementInTx(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    ownerUserId: string,
    itemId: string,
    folderId: string,
    isCurator = false,
) {
    const [folder] = await tx
        .select({
            id: recordingFolders.id,
            readable: sql<boolean>`${isCurator ? sql`true` : restrictedMemberCondition(ownerUserId)}`,
        })
        .from(recordingFolders)
        .where(
            and(
                eq(recordingFolders.id, folderId),
                or(
                    isNotNull(recordingFolders.restrictedAt),
                    isNotNull(recordingFolders.restrictingAt),
                ),
            ),
        );
    const [item] = await tx
        .select({ id: chatterItems.id })
        .from(chatterItems)
        .where(
            and(
                eq(chatterItems.id, itemId),
                eq(chatterItems.userId, ownerUserId),
                isNull(chatterItems.deletedAt),
            ),
        );
    if (!folder || !item)
        throw new AppError(ErrorCode.NOT_FOUND, ErrorCode.NOT_FOUND, 404);
    if (!folder.readable)
        throw new AppError(
            ErrorCode.RESTRICTED_FOLDER_NO_ACCESS,
            ErrorCode.RESTRICTED_FOLDER_NO_ACCESS,
            403,
        );
    await tx
        .insert(restrictedFolderMembers)
        .values({
            folderId,
            userId: ownerUserId,
            role: "member",
            addedByUserId: ownerUserId,
        })
        .onConflictDoNothing();
    await tx
        .insert(recordingFolderAssignments)
        .values({ userId: ownerUserId, itemId, folderId, withheld: true })
        .onConflictDoNothing();
    await notifyRestrictedAudienceInTx(tx, folderId);
}
