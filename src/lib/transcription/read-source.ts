import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { transcriptions } from "@/db/schema";
import type { ContentRevisionInput } from "@/lib/pipeline/types";
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

/** Read the preferred content fence without loading transcript text or timings. */
export async function readPreferredTranscriptInput(
    recordingId: string,
    userId: string,
    database: Pick<typeof db, "select"> = db,
): Promise<ContentRevisionInput | null> {
    const rows = await database
        .select({
            id: transcriptions.id,
            revision: transcriptions.revision,
            source: transcriptions.source,
        })
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.recordingId, recordingId),
                eq(transcriptions.userId, userId),
                inArray(transcriptions.source, [...TRANSCRIPT_SOURCE_ORDER]),
            ),
        )
        .limit(TRANSCRIPT_SOURCE_ORDER.length);
    const transcript = preferredTranscript(rows);
    return transcript
        ? {
              contentId: transcript.id,
              contentSourceId: transcript.source,
              contentRevision: transcript.revision,
          }
        : null;
}
