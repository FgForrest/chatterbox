import { and, eq, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { receivedItemCondition } from "@/db/queries/item-shares";
import { restrictedFolderVisibleCondition } from "@/db/queries/restricted-folders";
import { chatterItems, recordingFolders } from "@/db/schema";
import { userCuratesOrganizationNow } from "@/lib/authz/curator";
import { getOrgUserId } from "@/lib/org/config";
import type { OrgEvent } from "@/lib/org/events";
import { sharedItemCondition } from "@/lib/sharing/shared";

/** Recheck event ids against current visibility before they leave a session's stream. */
export async function mayReceiveOrganizationEvent(
    userId: string,
    event: OrgEvent,
) {
    if (event.type === "tree" && (!event.folderId || event.structural))
        return true;
    const orgUserId = await getOrgUserId();
    const isCurator = await userCuratesOrganizationNow(userId);
    if (event.type === "tree") {
        if (isCurator) return true;
        if (!orgUserId || !event.folderId) return false;
        const [folder] = await db
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(
                and(
                    eq(recordingFolders.id, event.folderId),
                    eq(recordingFolders.userId, orgUserId),
                    restrictedFolderVisibleCondition({ userId, isCurator }),
                ),
            );
        return !!folder;
    }
    const [item] = await db
        .select({ id: chatterItems.id })
        .from(chatterItems)
        .where(
            and(
                eq(chatterItems.id, event.recordingId),
                isNull(chatterItems.deletedAt),
                or(
                    eq(chatterItems.userId, userId),
                    receivedItemCondition(userId, chatterItems.id, isCurator),
                    orgUserId ? sharedItemCondition(orgUserId) : undefined,
                ),
            ),
        )
        .limit(1);
    return !!item;
}
