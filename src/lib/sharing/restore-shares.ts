import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { activeShareRecipientCondition } from "@/db/queries/item-shares";
import { chatterItems, itemShares, users } from "@/db/schema";
import { notifyPersonShareChanged } from "@/lib/events/personal";
import type { ArchivedItemShare } from "@/lib/export/item-shares";
import { sendPersonShareInvitation } from "@/lib/notifications/person-share";
import { getOrgUserId } from "@/lib/org/config";
import { requirePersonSharing } from "@/lib/sharing/person-shares";
import { isRecordingShared } from "@/lib/sharing/shared";

/** Restore active direct shares after content import, requiring consent again on the target instance. */
export async function restoreArchivedItemShares(
    userId: string,
    shares: readonly Pick<
        ArchivedItemShare,
        "itemId" | "receiverEmail" | "state"
    >[],
    itemIds: ReadonlyMap<string, string>,
) {
    await requirePersonSharing(userId);
    const orgUserId = await getOrgUserId();
    const skipped: {
        itemId: string;
        receiverEmail: string;
        reason:
            | "organization_shared"
            | "inactive"
            | "item_missing"
            | "receiver_missing"
            | "already_shared";
    }[] = [];
    const notified = new Set<string>();
    let restored = 0;
    for (const share of shares) {
        const skip = (reason: (typeof skipped)[number]["reason"]) =>
            skipped.push({
                itemId: share.itemId,
                receiverEmail: share.receiverEmail,
                reason,
            });
        if (share.state !== "pending" && share.state !== "accepted") {
            skip("inactive");
            continue;
        }
        const itemId = itemIds.get(share.itemId);
        if (!itemId) {
            skip("item_missing");
            continue;
        }
        const outcome = await db.transaction(async (tx) => {
            const [item] = await tx
                .select({ id: chatterItems.id })
                .from(chatterItems)
                .where(
                    and(
                        eq(chatterItems.id, itemId),
                        eq(chatterItems.userId, userId),
                        isNull(chatterItems.deletedAt),
                        inArray(chatterItems.kind, ["audio", "mail"]),
                    ),
                )
                .for("update");
            if (!item) return "item_missing" as const;
            if (orgUserId && (await isRecordingShared(itemId, orgUserId, tx)))
                return "organization_shared" as const;
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
                .select({ id: itemShares.id })
                .from(itemShares)
                .where(
                    and(
                        eq(itemShares.userId, userId),
                        eq(itemShares.itemId, itemId),
                        eq(itemShares.receiverUserId, receiver.id),
                        isNull(itemShares.folderShareId),
                    ),
                );
            if (existing) return "already_shared" as const;
            await tx.insert(itemShares).values({
                itemId,
                userId,
                receiverUserId: receiver.id,
                invitedByUserId: userId,
                state: "pending",
            });
            return { receiverId: receiver.id };
        });
        if (typeof outcome === "string") skip(outcome);
        else {
            restored++;
            notified.add(outcome.receiverId);
        }
    }
    await Promise.all([...notified].map(notifyPersonShareChanged));
    for (const receiverId of notified)
        void sendPersonShareInvitation(receiverId).catch(() => {
            console.error("[person-shares] restore invitation email failed");
        });
    return { restored, skipped };
}
