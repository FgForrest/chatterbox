/**
 * Starting a Learn run: the run row and its job (kind `learn.run`, subject
 * `recordingJobSubject(recordingId, view)`, so it is in every cancellation
 * list the recording's other jobs are). Light, like `topics-job.ts`: the
 * route imports this; only the worker imports the handler.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { enqueueJob } from "@/db/queries/async-jobs";
import { learnRuns, transcriptions } from "@/db/schema";
import { AppError, ErrorCode } from "@/lib/errors";
import { nudge } from "@/lib/jobs/nudge";
import { InvalidJobPayloadError } from "@/lib/jobs/types";
import { isLearnAvailableFor } from "@/lib/knowledge/availability";
import { isUntimed } from "@/lib/knowledge/correction-anchors";
import { vocabularyVersion } from "@/lib/knowledge/vocabulary";
import type { RecordingViewContext } from "@/lib/sharing/access";
import { type RecordingView, recordingJobSubject } from "@/lib/sharing/view";
import { readTranscriptTurns } from "@/lib/transcription/read-turns";

export const LEARN_JOB_KIND = "learn.run";
export const LEARN_PRIORITY_MANUAL = 10;
export const LEARN_PRIORITY_AUTO = 0;
export const LEARN_MAX_ATTEMPTS = 2;

export type LearnSource = "plaud" | "riffado";

export interface LearnJobPayload {
    runId: string;
}

export function parseLearnJobPayload(
    raw: Record<string, unknown>,
): LearnJobPayload {
    if (typeof raw.runId !== "string" || raw.runId.length === 0) {
        throw new InvalidJobPayloadError(
            LEARN_JOB_KIND,
            "runId must be a non-empty string",
        );
    }
    return { runId: raw.runId };
}

export interface StartedLearnRun {
    runId: string;
    jobId: string | null;
    /** False when a run of this transcript in this view was already open. */
    created: boolean;
}

/**
 * Start a Learn run on one transcript of a recording in a view, or return
 * the one already queued or running there. The caller authorized the view
 * and the change (`assertMayChange`): the owner on the private view, the
 * organization account on the Organization's. The actor's chat provider
 * pays, as for summaries.
 *
 * Refused: Learn not available to the actor (no chat provider, or a hosted
 * instance), no such transcript, or one without timed turns.
 */
export async function startLearnRun(input: {
    access: RecordingViewContext;
    actorUserId: string;
    source: LearnSource;
    trigger: "manual" | "auto";
}): Promise<StartedLearnRun> {
    const { access, actorUserId, source, trigger } = input;
    if (!(await isLearnAvailableFor(actorUserId))) {
        throw new AppError(
            ErrorCode.AI_PROVIDER_NOT_CONFIGURED,
            "Learn needs a chat provider. Add an OpenAI-compatible provider to run it.",
            400,
        );
    }
    const [transcript] = await db
        .select({
            id: transcriptions.id,
            revision: transcriptions.revision,
            turns: transcriptions.turns,
        })
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.recordingId, access.recordingId),
                eq(transcriptions.userId, access.ownerUserId),
                eq(transcriptions.source, source),
            ),
        )
        .limit(1);
    if (!transcript) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "This recording has no such transcript",
            400,
        );
    }
    const turns = readTranscriptTurns(transcript);
    if (!turns?.length || isUntimed(turns)) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "This transcript has no timings, so Learn cannot read it. Transcribe it with a provider that reports them.",
            400,
        );
    }

    const view: RecordingView = access.view;
    const [open] = await db
        .select({ id: learnRuns.id, jobId: learnRuns.jobId })
        .from(learnRuns)
        .where(
            and(
                eq(learnRuns.transcriptionId, transcript.id),
                eq(learnRuns.view, view),
                inArray(learnRuns.status, ["queued", "running"]),
            ),
        )
        .orderBy(desc(learnRuns.createdAt))
        .limit(1);
    if (open) return { runId: open.id, jobId: open.jobId, created: false };

    const scopeUserId =
        view === "org" && access.orgUserId
            ? access.orgUserId
            : access.ownerUserId;
    const [run] = await db
        .insert(learnRuns)
        .values({
            userId: access.ownerUserId,
            scopeUserId,
            recordingId: access.recordingId,
            transcriptionId: transcript.id,
            view,
            actorUserId,
            trigger,
            transcriptRevision: transcript.revision,
            vocabularyVersion: await vocabularyVersion(),
        })
        .returning({ id: learnRuns.id });
    const runId = (run as { id: string }).id;
    const { job, created } = await enqueueJob({
        userId: actorUserId,
        kind: LEARN_JOB_KIND,
        subjectId: recordingJobSubject(access.recordingId, view),
        priority:
            trigger === "manual" ? LEARN_PRIORITY_MANUAL : LEARN_PRIORITY_AUTO,
        maxAttempts: LEARN_MAX_ATTEMPTS,
        payload: { runId },
    });
    // One Learn job per recording and view. Another start won the slot:
    // for this transcript, its run is this one; for the other transcript,
    // this waits for the next try.
    if (!created && job.payload.runId !== runId) {
        await db.delete(learnRuns).where(eq(learnRuns.id, runId));
        const [holder] = await db
            .select({ transcriptionId: learnRuns.transcriptionId })
            .from(learnRuns)
            .where(eq(learnRuns.id, String(job.payload.runId)))
            .limit(1);
        if (holder?.transcriptionId === transcript.id) {
            return {
                runId: String(job.payload.runId),
                jobId: job.id,
                created: false,
            };
        }
        throw new AppError(
            ErrorCode.CONFLICT,
            "Learn is already running on this recording's other transcript. Try again when it finishes.",
            409,
        );
    }
    await db
        .update(learnRuns)
        .set({ jobId: job.id, updatedAt: new Date() })
        .where(eq(learnRuns.id, runId));
    if (created) nudge();
    return { runId, jobId: job.id, created: true };
}
