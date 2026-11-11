import { and, eq, inArray, or, sql } from "drizzle-orm";
import { folderParticipantCondition } from "@/db/queries/folder-participants";
import { meetingItemAudienceInTx } from "@/db/queries/meeting-audience";
import type { MeetingTx } from "@/db/queries/meetings";
import { restrictedFolderVisibleCondition } from "@/db/queries/restricted-folders";
import {
    activeShareRecipientCondition,
    activeShareRecipientExistsCondition,
} from "@/db/queries/share-recipients";
import {
    folderShares,
    recordingFolders,
    restrictedFolderMembers,
    users,
} from "@/db/schema";

/** Keep the agenda safety audience separate from the audience reached through fileable folders. */
export async function meetingAttachmentAudienceInTx(
    tx: MeetingTx,
    input: {
        itemId: string;
        ownerUserId: string;
        actorUserId: string;
        isCurator?: boolean;
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
                  restrictedAt: recordingFolders.restrictedAt,
                  readable: sql<boolean>`${restrictedFolderVisibleCondition({ userId: input.actorUserId, isCurator: input.isCurator === true })}`,
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
              .select({
                  userId: folderShares.receiverUserId,
                  folderId: folderShares.folderId,
              })
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
    const restrictedIds = folders
        .filter((folder) => folder.restrictedAt)
        .map((folder) => folder.id);
    const audience = restrictedIds.length
        ? await tx
              .select({
                  userId: restrictedFolderMembers.userId,
                  folderId: restrictedFolderMembers.folderId,
              })
              .from(restrictedFolderMembers)
              .where(
                  and(
                      inArray(restrictedFolderMembers.folderId, restrictedIds),
                      activeShareRecipientExistsCondition(
                          restrictedFolderMembers.userId,
                      ),
                  ),
              )
        : [];
    const intended = {
        organization: folders.some(
            (folder) =>
                folder.userId === input.orgUserId && !folder.restrictedAt,
        ),
        userIds: new Set([
            input.actorUserId,
            ...folders.map((folder) => folder.userId),
            ...audience.map((member) => member.userId),
            ...shares.map((share) => share.userId),
        ]),
    };
    const readableIds = new Set(
        folders.filter((folder) => folder.readable).map((folder) => folder.id),
    );
    const disclosedUserIds = new Set([
        input.actorUserId,
        ...folders
            .filter((folder) => folder.readable)
            .map((folder) => folder.userId),
        ...audience
            .filter((member) => readableIds.has(member.folderId))
            .map((member) => member.userId),
        ...shares
            .filter((share) => readableIds.has(share.folderId))
            .map((share) => share.userId),
    ]);
    const audienceUsers = intended.organization
        ? []
        : await tx
              .select({ id: users.id, name: users.name })
              .from(users)
              .where(inArray(users.id, [...disclosedUserIds]))
              .orderBy(users.id);
    return {
        current,
        intended,
        sharedFolders: shares.length > 0,
        disclosure: {
            organization: intended.organization,
            userIds: intended.organization
                ? []
                : [...disclosedUserIds]
                      .filter((id) => id !== input.actorUserId)
                      .sort(),
            users: audienceUsers.filter(
                (person) => person.id !== input.actorUserId,
            ),
        },
    };
}
