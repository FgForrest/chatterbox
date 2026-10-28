import { and, eq, inArray, or } from "drizzle-orm";
import { folderParticipantCondition } from "@/db/queries/folder-participants";
import type { MeetingTx } from "@/db/queries/meetings";
import { activeShareRecipientCondition } from "@/db/queries/share-recipients";
import {
    folderShares,
    itemShares,
    recordingFolderAssignments,
    recordingFolders,
    users,
} from "@/db/schema";

interface Audience {
    organization: boolean;
    userIds: Set<string>;
}

/** Current audience of an authorized owner's item, including valid contributed placements. */
export async function meetingItemAudienceInTx(
    tx: MeetingTx,
    itemId: string,
    ownerUserId: string,
    orgUserId: string | null,
): Promise<Audience> {
    const folders = await tx
        .select({ id: recordingFolders.id, userId: recordingFolders.userId })
        .from(recordingFolderAssignments)
        .innerJoin(
            recordingFolders,
            eq(recordingFolders.id, recordingFolderAssignments.folderId),
        )
        .where(
            and(
                eq(recordingFolderAssignments.itemId, itemId),
                eq(recordingFolderAssignments.userId, ownerUserId),
                or(
                    orgUserId
                        ? eq(recordingFolders.userId, orgUserId)
                        : undefined,
                    folderParticipantCondition(
                        recordingFolders.userId,
                        ownerUserId,
                        recordingFolders.id,
                    ),
                ),
            ),
        )
        .for("share", { of: recordingFolders });
    const [receivers, direct] = await Promise.all([
        folders.length
            ? tx
                  .select({ userId: folderShares.receiverUserId })
                  .from(folderShares)
                  .innerJoin(
                      recordingFolders,
                      and(
                          eq(recordingFolders.id, folderShares.folderId),
                          eq(recordingFolders.userId, folderShares.userId),
                      ),
                  )
                  .innerJoin(users, eq(users.id, folderShares.receiverUserId))
                  .where(
                      and(
                          inArray(
                              folderShares.folderId,
                              folders.map((folder) => folder.id),
                          ),
                          eq(folderShares.state, "accepted"),
                          activeShareRecipientCondition(),
                      ),
                  )
            : [],
        tx
            .select({ userId: itemShares.receiverUserId })
            .from(itemShares)
            .innerJoin(users, eq(users.id, itemShares.receiverUserId))
            .where(
                and(
                    eq(itemShares.itemId, itemId),
                    eq(itemShares.userId, ownerUserId),
                    eq(itemShares.state, "accepted"),
                    activeShareRecipientCondition(),
                ),
            ),
    ]);
    return {
        organization: folders.some((folder) => folder.userId === orgUserId),
        userIds: new Set([
            ownerUserId,
            ...folders.map((folder) => folder.userId),
            ...receivers.map((receiver) => receiver.userId),
            ...direct.map((receiver) => receiver.userId),
        ]),
    };
}

/** Whether every current viewer of the source can already read the target. */
export function meetingAudienceWithin(
    source: Audience,
    target: Audience,
): boolean {
    return (
        target.organization ||
        (!source.organization &&
            [...source.userIds].every((id) => target.userIds.has(id)))
    );
}
