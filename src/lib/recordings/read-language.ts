import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { recordings } from "@/db/schema";

/** The owner's confirmed language, shared by all views and transcript sources. */
export async function readConfirmedLanguage(
    userId: string,
    recordingId: string,
): Promise<string | null> {
    const [recording] = await db
        .select({ confirmedLanguage: recordings.confirmedLanguage })
        .from(recordings)
        .where(
            and(
                eq(recordings.id, recordingId),
                eq(recordings.userId, userId),
                isNull(recordings.deletedAt),
            ),
        )
        .limit(1);
    return recording?.confirmedLanguage ?? null;
}
