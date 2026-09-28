import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { recordings } from "@/db/schema";
import { encryptText } from "@/lib/encryption/fields";

/**
 * Store a generated title as the recording's name, unless a person has set
 * one (`titleEditedAt`). Checked in the update itself, so a rename that
 * commits while the title was being generated wins. Returns whether the
 * title was stored; nothing that follows from a new title may run if not.
 */
export async function storeGeneratedTitle(
    userId: string,
    recordingId: string,
    title: string,
): Promise<boolean> {
    const stored = await db
        .update(recordings)
        .set({ filename: encryptText(title), updatedAt: new Date() })
        .where(
            and(
                eq(recordings.id, recordingId),
                eq(recordings.userId, userId),
                isNull(recordings.deletedAt),
                isNull(recordings.titleEditedAt),
            ),
        )
        .returning({ id: recordings.id });
    return stored.length > 0;
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
        .select({ titleEditedAt: recordings.titleEditedAt })
        .from(recordings)
        .where(
            and(eq(recordings.id, recordingId), eq(recordings.userId, userId)),
        )
        .limit(1);
    return row !== undefined && row.titleEditedAt === null;
}
