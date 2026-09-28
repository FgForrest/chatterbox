import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { db } from "@/db";
import { learnRuns, transcriptions, transcriptSpeakers } from "@/db/schema";
import { transcriptSpeakerLabels } from "@/lib/knowledge/speaker-labels";
import { UNFINISHED_LEARN_STATUSES } from "@/lib/learn/learn-statuses";
import {
    evaluateShareGate,
    type ShareGateProblem,
} from "@/lib/sharing/share-gate";

type Executor = Pick<typeof db, "select">;

/**
 * The share gate over a recording's transcripts, which its owner holds,
 * and their speaker rows: a shared recording is one recording, so these
 * are exactly what the Organization will read.
 */
export async function loadShareGate(
    executor: Executor,
    recordingId: string,
    ownerUserId: string,
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
                eq(transcriptions.userId, ownerUserId),
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
    // The owner's Learn runs not yet finished (queued, running, or ready
    // for review): what they propose is private until reviewed.
    const [unfinished] = await executor
        .select({ count: sql<number>`count(*)::int` })
        .from(learnRuns)
        .where(
            and(
                eq(learnRuns.recordingId, recordingId),
                eq(learnRuns.view, "private"),
                inArray(learnRuns.status, [...UNFINISHED_LEARN_STATUSES]),
            ),
        );
    return evaluateShareGate({
        transcripts: transcripts.map((transcript) => ({
            id: transcript.id,
            source: transcript.source,
            labels: transcriptSpeakerLabels(transcript),
        })),
        attributions,
        unfinishedLearnRuns: unfinished?.count ?? 0,
    });
}
