/**
 * The lock every change to knowledge on a transcript takes first.
 */

import { and, eq } from "drizzle-orm";
import type { db } from "@/db";
import { recordings, transcriptions } from "@/db/schema";
import { AppError, ErrorCode } from "@/lib/errors";
import type { TranscriptVersion } from "@/lib/knowledge/attribution";
import { contentWriterRefusal, writerRefusalError } from "@/lib/sharing/writer";
import { readTranscriptTurns } from "@/lib/transcription/read-turns";
import type { TranscriptTurn } from "@/lib/transcription/turns";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface Writer {
    actorUserId: string;
    orgUserId: string | null;
}

/**
 * Lock a transcript for a change to the knowledge on it (corrections,
 * evidence), after its recording (the lock sharing and withdrawal take),
 * and check the writer rule under it. Returns what the change needs to
 * know of the transcript. 404 alike for a missing transcript and another
 * account's.
 */
export async function lockTranscriptForChange(
    tx: Tx,
    { userId, transcriptionId }: Omit<TranscriptVersion, "revision">,
    { actorUserId, orgUserId }: Writer,
): Promise<{
    recordingId: string;
    revision: number;
    turns: TranscriptTurn[] | null;
    language: string | null;
    provider: string | null;
}> {
    const [recording] = await tx
        .select({ id: recordings.id })
        .from(recordings)
        .innerJoin(
            transcriptions,
            eq(transcriptions.recordingId, recordings.id),
        )
        .where(
            and(
                eq(transcriptions.id, transcriptionId),
                eq(transcriptions.userId, userId),
            ),
        )
        .for("share", { of: recordings });
    const [transcript] = recording
        ? await tx
              .select({
                  revision: transcriptions.revision,
                  turns: transcriptions.turns,
                  language: transcriptions.detectedLanguage,
                  provider: transcriptions.provider,
              })
              .from(transcriptions)
              .where(
                  and(
                      eq(transcriptions.id, transcriptionId),
                      eq(transcriptions.userId, userId),
                  ),
              )
              .for("update")
        : [];
    if (!recording || !transcript) {
        throw new AppError(ErrorCode.NOT_FOUND, "Transcript not found", 404);
    }
    const refusal = await contentWriterRefusal(tx, {
        recordingId: recording.id,
        ownerUserId: userId,
        actorUserId,
        orgUserId,
    });
    if (refusal) throw writerRefusalError(refusal);
    return {
        recordingId: recording.id,
        revision: transcript.revision,
        turns: readTranscriptTurns(transcript),
        language: transcript.language,
        provider: transcript.provider,
    };
}
