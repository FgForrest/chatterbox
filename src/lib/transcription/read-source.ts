import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { transcriptions } from "@/db/schema";
import {
    preferredTranscript,
    TRANSCRIPT_SOURCE_ORDER,
} from "@/lib/transcription/preferred-source";

/** Read the owner's preferred transcript for summary and title generation. */
export async function readPreferredTranscript(
    recordingId: string,
    userId: string,
    database: Pick<typeof db, "select"> = db,
): Promise<typeof transcriptions.$inferSelect | undefined> {
    const rows = await database
        .select()
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.recordingId, recordingId),
                eq(transcriptions.userId, userId),
                inArray(transcriptions.source, [...TRANSCRIPT_SOURCE_ORDER]),
            ),
        )
        .limit(TRANSCRIPT_SOURCE_ORDER.length);
    return preferredTranscript(rows);
}
