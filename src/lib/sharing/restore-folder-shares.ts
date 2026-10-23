import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { activeShareRecipientCondition } from "@/db/queries/item-shares";
import type { ItemShareState } from "@/db/schema";
import { folderShares, recordingFolders, users } from "@/db/schema";
import { announceFolderInvitations } from "@/lib/sharing/folder-shares";
import { requirePersonSharing } from "@/lib/sharing/person-shares";

/** Restore active owner folder invitations with fresh receiver consent and explicit skips. */
export async function restoreArchivedFolderShares(
    userId: string,
    shares: readonly {
        folderId: string;
        receiverEmail: string;
        state: ItemShareState;
    }[],
    folderIds: ReadonlyMap<string, string>,
) {
    await requirePersonSharing(userId);
    const skipped: {
        folderId: string;
        receiverEmail: string;
        reason:
            | "organization_shared"
            | "inactive"
            | "folder_missing"
            | "receiver_missing"
            | "already_shared";
    }[] = [];
    const notified = new Set<string>();
    let restored = 0;
    for (const share of shares) {
        const skip = (reason: (typeof skipped)[number]["reason"]) =>
            skipped.push({
                folderId: share.folderId,
                receiverEmail: share.receiverEmail,
                reason,
            });
        if (share.state !== "pending" && share.state !== "accepted") {
            skip("inactive");
            continue;
        }
        const folderId = folderIds.get(share.folderId);
        if (!folderId) {
            skip("folder_missing");
            continue;
        }
        const outcome = await db.transaction(async (tx) => {
            const [folder] = await tx
                .select({
                    id: recordingFolders.id,
                    kind: recordingFolders.kind,
                })
                .from(recordingFolders)
                .where(
                    and(
                        eq(recordingFolders.id, folderId),
                        eq(recordingFolders.userId, userId),
                    ),
                )
                .for("update");
            if (!folder) return "folder_missing" as const;
            if (folder.kind === "public") return "organization_shared" as const;
            if (folder.kind !== "custom") return "folder_missing" as const;
            const [receiver] = await tx
                .select({ id: users.id })
                .from(users)
                .where(
                    and(
                        sql`lower(${users.email}) = ${share.receiverEmail.trim().toLowerCase()}`,
                        ne(users.id, userId),
                        activeShareRecipientCondition(),
                    ),
                )
                .limit(1);
            if (!receiver) return "receiver_missing" as const;
            const [existing] = await tx
                .select({ id: folderShares.id })
                .from(folderShares)
                .where(
                    and(
                        eq(folderShares.userId, userId),
                        eq(folderShares.folderId, folderId),
                        eq(folderShares.receiverUserId, receiver.id),
                    ),
                );
            if (existing) return "already_shared" as const;
            await tx.insert(folderShares).values({
                userId,
                folderId,
                receiverUserId: receiver.id,
                invitedByUserId: userId,
            });
            return { receiverId: receiver.id };
        });
        if (typeof outcome === "string") skip(outcome);
        else {
            restored++;
            notified.add(outcome.receiverId);
        }
    }
    await announceFolderInvitations(notified);
    return { restored, skipped };
}
