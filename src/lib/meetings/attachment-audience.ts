import { and, inArray } from "drizzle-orm";
import { meetingItemAudienceInTx } from "@/db/queries/meeting-audience";
import type { MeetingTx } from "@/db/queries/meetings";
import { folderShares, users } from "@/db/schema";

/** Resolve the audience of attaching to an authorized agenda, including pending folder recipients. */
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
    const shares = input.folderIds.length
        ? await tx
              .select({ userId: folderShares.receiverUserId })
              .from(folderShares)
              .where(
                  and(
                      inArray(folderShares.folderId, input.folderIds),
                      inArray(folderShares.state, ["accepted", "pending"]),
                  ),
              )
        : [];
    const intended = {
        organization: current.organization,
        userIds: new Set([
            ...current.userIds,
            ...shares.map((share) => share.userId),
        ]),
    };
    const audienceUsers = intended.organization
        ? []
        : await tx
              .select({ id: users.id, name: users.name })
              .from(users)
              .where(inArray(users.id, [...intended.userIds]));
    return {
        current,
        intended,
        sharedFolders: shares.length > 0,
        disclosure: {
            organization: intended.organization,
            userIds: intended.organization
                ? []
                : [...intended.userIds].filter(
                      (id) => id !== input.actorUserId,
                  ),
            users: audienceUsers.filter(
                (person) => person.id !== input.actorUserId,
            ),
        },
    };
}
