import { and, desc, eq, exists, isNotNull, or, sql } from "drizzle-orm";
import type { db } from "@/db";
import {
    aiEnhancements,
    asyncJobs,
    learnReviewItems,
    learnRuns,
    transcriptions,
} from "@/db/schema";
import { decryptJsonField } from "@/lib/encryption/fields";
import { isPlaceholderSpeakerLabel } from "@/lib/knowledge/speaker-label-rules";
import { isOrgScopeEnabled, isOrgScopeVisible } from "@/lib/org/config";
import type { PipelineView, PlaudTranscriptInput } from "@/lib/pipeline/types";
import { recordingJobSubject } from "@/lib/sharing/view";
import { TRANSCRIPTION_JOB_KIND } from "@/lib/transcription/transcription-job";

/** Project only Plaud's encrypted turns when reading both transcript sources. */
export const plaudTranscriptTurns = sql<unknown>`case when ${transcriptions.source} = 'plaud' then ${transcriptions.turns} end`;

/** Build a Plaud input with deferred inspection of its stored speaker labels. */
export function plaudTranscriptInput(row: {
    id: string;
    revision: number;
    turns: unknown;
}): PlaudTranscriptInput {
    return {
        contentId: row.id,
        contentSourceId: "plaud",
        contentRevision: row.revision,
        timed: row.turns != null,
        lacksConfirmableSpeakers: () => {
            const turns = decryptJsonField<{ speaker?: unknown }[]>(row.turns);
            return (
                Array.isArray(turns) &&
                turns.length > 0 &&
                !turns.some(
                    (turn) =>
                        typeof turn?.speaker === "string" &&
                        !isPlaceholderSpeakerLabel(turn.speaker),
                )
            );
        },
    };
}

/** Whether a private driver would be refused by the worker's Organization guard. */
export function sharedTranscriptionReadOnly(shared: boolean): boolean {
    return shared && isOrgScopeVisible() && !isOrgScopeEnabled();
}

/** Evidence of processing by Chatterbox, scoped to the recording owner. */
export function audioHasPriorOutput(
    executor: Pick<typeof db, "select">,
    userId: string,
    itemId: string,
) {
    return sql<boolean>`${or(
        exists(
            executor
                .select({ id: aiEnhancements.id })
                .from(aiEnhancements)
                .where(
                    and(
                        eq(aiEnhancements.itemId, itemId),
                        eq(aiEnhancements.userId, userId),
                        eq(aiEnhancements.source, "riffado"),
                        isNotNull(aiEnhancements.summary),
                    ),
                ),
        ),
        exists(
            executor
                .select({ id: transcriptions.id })
                .from(transcriptions)
                .where(
                    and(
                        eq(transcriptions.recordingId, itemId),
                        eq(transcriptions.userId, userId),
                        isNotNull(transcriptions.topics),
                    ),
                ),
        ),
        exists(
            executor
                .select({ id: learnRuns.id })
                .from(learnRuns)
                .where(
                    and(
                        eq(learnRuns.itemId, itemId),
                        eq(learnRuns.userId, userId),
                        or(
                            eq(learnRuns.status, "finished"),
                            exists(
                                executor
                                    .select({ id: learnReviewItems.id })
                                    .from(learnReviewItems)
                                    .where(
                                        and(
                                            eq(
                                                learnReviewItems.runId,
                                                learnRuns.id,
                                            ),
                                            eq(
                                                learnReviewItems.userId,
                                                learnRuns.scopeUserId,
                                            ),
                                        ),
                                    ),
                            ),
                        ),
                    ),
                ),
        ),
    )}`;
}

/** Latest terminal failure of an automatic transcription in this owner's view. */
export async function readFailedAutomaticTranscription(
    executor: Pick<typeof db, "select">,
    itemId: string,
    view: PipelineView,
    userId: string,
) {
    const [job] = await executor
        .select({
            errorCode: asyncJobs.errorCode,
            completedAt: asyncJobs.completedAt,
        })
        .from(asyncJobs)
        .where(
            and(
                eq(asyncJobs.userId, userId),
                eq(asyncJobs.kind, TRANSCRIPTION_JOB_KIND),
                eq(asyncJobs.subjectId, recordingJobSubject(itemId, view)),
                eq(asyncJobs.status, "failed"),
                isNotNull(asyncJobs.completedAt),
                sql`${asyncJobs.payload} ->> 'trigger' <> 'manual'`,
            ),
        )
        .orderBy(desc(asyncJobs.completedAt), desc(asyncJobs.createdAt))
        .limit(1);
    if (!job?.completedAt) return undefined;
    return {
        errorCode: job.errorCode ?? "TRANSCRIPTION_FAILED",
        completedAt: job.completedAt.toISOString(),
    };
}
