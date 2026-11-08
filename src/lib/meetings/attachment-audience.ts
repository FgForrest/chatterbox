import { and, eq, inArray, or } from "drizzle-orm";
import { folderParticipantCondition } from "@/db/queries/folder-participants";
import { meetingItemAudienceInTx } from "@/db/queries/meeting-audience";
import type { MeetingTx } from "@/db/queries/meetings";
import { activeShareRecipientCondition } from "@/db/queries/share-recipients";
import { folderShares, recordingFolders, users } from "@/db/schema";

/** Keep the agenda safety audience separate from the audience reached through fileable folders. */
export async function meetingAttachmentAudienceInTx(
    tx: MeetingTx,
    input: {
        itemId: string;
        ownerUserId: string;
        actorUserId: string;
        orgUserId: string | null;
        folderIds: string[];
    },
) {
    const current = await meetingItemAudienceInTx(
        tx,
        input.itemId,
        input.ownerUserId,
        input.orgUserId,
    );
    const folders = input.folderIds.length
        ? await tx
              .select({
                  id: recordingFolders.id,
                  userId: recordingFolders.userId,
              })
              .from(recordingFolders)
              .where(
                  and(
                      inArray(recordingFolders.id, input.folderIds),
                      or(
                          input.orgUserId
                              ? eq(recordingFolders.userId, input.orgUserId)
                              : undefined,
                          folderParticipantCondition(
                              recordingFolders.userId,
                              input.actorUserId,
                              recordingFolders.id,
                          ),
                      ),
                  ),
              )
        : [];
    const shares = folders.length
        ? await tx
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
                      inArray(folderShares.state, ["accepted", "pending"]),
                      activeShareRecipientCondition(),
                  ),
              )
        : [];
    const intended = {
        organization: folders.some(
            (folder) => folder.userId === input.orgUserId,
        ),
        userIds: new Set([
            input.actorUserId,
            ...folders.map((folder) => folder.userId),
            ...shares.map((share) => share.userId),
        ]),
    };
    const audienceUsers = intended.organization
        ? []
        : await tx
              .select({ id: users.id, name: users.name })
              .from(users)
              .where(inArray(users.id, [...intended.userIds]))
              .orderBy(users.id);
    return {
        current,
        intended,
        sharedFolders: shares.length > 0,
        disclosure: {
            organization: intended.organization,
            userIds: intended.organization
                ? []
                : [...intended.userIds]
                      .filter((id) => id !== input.actorUserId)
                      .sort(),
            users: audienceUsers.filter(
                (person) => person.id !== input.actorUserId,
            ),
        },
    };
}
