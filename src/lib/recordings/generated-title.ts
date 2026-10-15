import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { recordingItemJoin, touchRecording } from "@/db/items";
import { chatterItems, recordings } from "@/db/schema";
import { encryptText } from "@/lib/encryption/fields";
import { contentWriterRefusal, sharingOrgUserId } from "@/lib/sharing/writer";

/**
 * Store a generated title as the recording's name. Automatic runs preserve
 * a person's edit; an explicit regeneration may replace the edit observed
 * before generation. A newer edit always wins. Returns whether stored.
 *
 * The owner's run generates it, and a recording shared while the title was
 * being generated is the organization account's to change: checked under
 * the recording lock sharing takes, so that share wins too.
 */
export async function storeGeneratedTitle(
    userId: string,
    recordingId: string,
    title: string,
    expectedTitleEditedAt?: Date | null,
    actorUserId = userId,
): Promise<boolean> {
    // Before the transaction; see `sharingOrgUserId`.
    const orgUserId = await sharingOrgUserId();
    return db.transaction(async (tx) => {
        await tx
            .select({ id: recordings.id })
            .from(recordings)
            .where(
                and(
                    eq(recordings.id, recordingId),
                    eq(recordings.userId, userId),
                ),
            )
            .for("update");
        if (
            await contentWriterRefusal(tx, {
                recordingId,
                ownerUserId: userId,
                actorUserId,
                orgUserId,
            })
        ) {
            return false;
        }
        const now = new Date();
        const titleCondition = expectedTitleEditedAt
            ? eq(chatterItems.titleEditedAt, expectedTitleEditedAt)
            : isNull(chatterItems.titleEditedAt);
        const stored = await tx
            .update(chatterItems)
            .set({
                title: encryptText(title),
                ...(expectedTitleEditedAt ? { titleEditedAt: null } : {}),
                updatedAt: now,
            })
            .where(
                and(
                    eq(chatterItems.id, recordingId),
                    eq(chatterItems.userId, userId),
                    isNull(chatterItems.deletedAt),
                    titleCondition,
                ),
            )
            .returning({ id: chatterItems.id });
        if (stored.length === 0) return false;
        await touchRecording(tx, recordingId, userId, now);
        return true;
    });
}

/**
 * Whether no person has set the recording's title since a generated one was
 * stored. Read right before the title leaves Riffado, e.g. for Plaud: a
 * rename made meanwhile is kept here, and must not be replaced there.
 */
export async function titleStillGenerated(
    userId: string,
    recordingId: string,
): Promise<boolean> {
    const [row] = await db
        .select({ titleEditedAt: chatterItems.titleEditedAt })
        .from(recordings)
        .innerJoin(chatterItems, recordingItemJoin)
        .where(
            and(eq(recordings.id, recordingId), eq(recordings.userId, userId)),
        )
        .limit(1);
    return row !== undefined && row.titleEditedAt === null;
}
