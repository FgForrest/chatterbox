import { and, eq } from "drizzle-orm";
import type { MeetingExecutor } from "@/db/queries/meetings";
import { activeShareRecipientExistsCondition } from "@/db/queries/share-recipients";
import { folderShares, receivedFolderAttachments } from "@/db/schema";
import { isOrgScopeVisible } from "@/lib/org/config";

/** The caller's private navigation for source folders shared with them. */
export async function receivedMeetingFolderNodes(
    executor: MeetingExecutor,
    userId: string,
) {
    if (!isOrgScopeVisible()) return [];
    return executor
        .select({
            sourceId: folderShares.folderId,
            id: receivedFolderAttachments.id,
            name: receivedFolderAttachments.name,
            parentId: receivedFolderAttachments.parentId,
        })
        .from(receivedFolderAttachments)
        .innerJoin(
            folderShares,
            and(
                eq(folderShares.id, receivedFolderAttachments.shareId),
                eq(folderShares.receiverUserId, userId),
            ),
        )
        .where(
            and(
                eq(receivedFolderAttachments.userId, userId),
                eq(folderShares.state, "accepted"),
                activeShareRecipientExistsCondition(userId),
            ),
        );
}
