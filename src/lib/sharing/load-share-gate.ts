import { and, asc, eq, inArray } from "drizzle-orm";
import type { db } from "@/db";
import { transcriptions, transcriptSpeakers } from "@/db/schema";
import { transcriptSpeakerLabels } from "@/lib/knowledge/speaker-labels";
import {
    evaluateShareGate,
    type ShareGateProblem,
} from "@/lib/sharing/share-gate";

type Executor = Pick<typeof db, "select">;

/**
 * The share gate over the transcripts `contentUserId` holds for a
 * recording, and their speaker rows. Sharing passes the organization
 * account, so it judges the copies it is about to publish.
 */
export async function loadShareGate(
    executor: Executor,
    recordingId: string,
    contentUserId: string,
): Promise<ShareGateProblem[]> {
    const transcripts = await executor
        .select({
            id: transcriptions.id,
            source: transcriptions.source,
            model: transcriptions.model,
            text: transcriptions.text,
            turns: transcriptions.turns,
        })
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.recordingId, recordingId),
                eq(transcriptions.userId, contentUserId),
            ),
        )
        .orderBy(asc(transcriptions.source));
    const attributions =
        transcripts.length > 0
            ? await executor
                  .select({
                      transcriptionId: transcriptSpeakers.transcriptionId,
                      label: transcriptSpeakers.label,
                      status: transcriptSpeakers.status,
                      personId: transcriptSpeakers.personId,
                      markedUnknown: transcriptSpeakers.markedUnknown,
                  })
                  .from(transcriptSpeakers)
                  .where(
                      inArray(
                          transcriptSpeakers.transcriptionId,
                          transcripts.map((transcript) => transcript.id),
                      ),
                  )
            : [];
    return evaluateShareGate({
        transcripts: transcripts.map((transcript) => ({
            id: transcript.id,
            source: transcript.source,
            labels: transcriptSpeakerLabels(transcript),
        })),
        attributions,
        // Learn runs arrive with Phase 3.
        unfinishedLearnRuns: 0,
    });
}
