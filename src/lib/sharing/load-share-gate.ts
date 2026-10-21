import { and, asc, eq, inArray } from "drizzle-orm";
import type { db } from "@/db";
import { transcriptions, transcriptSpeakers } from "@/db/schema";
import { transcriptSpeakerLabels } from "@/lib/knowledge/speaker-labels";
import {
    evaluateShareGate,
    type ShareGateProblem,
} from "@/lib/sharing/share-gate";
import { waitingTaskDecisions } from "@/lib/tasks/waiting-review";

type Executor = Pick<typeof db, "select">;

/**
 * The share gate over a recording's transcripts, which its owner holds,
 * and their speaker rows: a shared recording is one recording, so these
 * are exactly what the Organization will read.
 * Proposal-state filtering follows specification section 7.8; Stage 4
 * narrows both share gates to `awaiting_source_review`.
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
    const taskDecisions = await waitingTaskDecisions(
        executor,
        recordingId,
        ownerUserId,
    );
    return evaluateShareGate({
        transcripts: transcripts.map((transcript) => ({
            id: transcript.id,
            source: transcript.source,
            labels: transcriptSpeakerLabels(transcript),
        })),
        attributions,
        waitingTaskProposals: taskDecisions.total,
    });
}
