import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { enqueueJobInTx } from "@/db/queries/async-jobs";
import { trimSnapshotMatches } from "@/db/queries/trim-proposal";
import {
    asyncJobs,
    itemProcessing,
    recordings,
    transcriptions,
} from "@/db/schema";
import { decryptJsonField, encryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { nudge } from "@/lib/jobs/nudge";
import { RECORDING_CUT_KIND } from "@/lib/recordings/cut-kind";
import {
    type CutRange,
    cutTranscript,
    validCutRange,
} from "@/lib/recordings/cut-range";
import type { StoredTrimProposal } from "@/lib/recordings/trim-proposal";
import { recordingJobSubject } from "@/lib/sharing/view";
import { sharingOrgUserId } from "@/lib/sharing/writer";
import { readTranscriptTurns } from "@/lib/transcription/read-turns";

export { RECORDING_CUT_KIND } from "@/lib/recordings/cut-kind";
export const cutRequestSchema = z.object({
    trimProposalId: z.string().min(1).optional(),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    revisions: z
        .array(z.object({ id: z.string(), revision: z.number().int() }))
        .optional(),
});
export const cutPayloadSchema = cutRequestSchema.extend({
    recordingId: z.string().min(1),
    encryptedStoragePath: z.string().min(1),
    fileMd5: z.string(),
    audioReaped: z.boolean(),
    duration: z.number().int().positive(),
    revisions: z.array(
        z.object({ id: z.string(), revision: z.number().int() }),
    ),
    preparedStoragePath: z.string().optional(),
    committed: z.boolean().optional(),
    cleanup: z.unknown().optional(),
});
export type CutPayload = z.infer<typeof cutPayloadSchema>;
export type CutTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Check the recording and all transcripts under the same lock as their writers. */
export async function loadCutInTx(
    tx: CutTx,
    userId: string,
    recordingId: string,
    range: CutRange,
    jobId?: string,
) {
    const [recording] = await tx
        .select()
        .from(recordings)
        .where(
            and(
                eq(recordings.id, recordingId),
                eq(recordings.userId, userId),
                isNull(recordings.deletedAt),
            ),
        )
        .for("update")
        .limit(1);
    if (!recording)
        throw new AppError(
            ErrorCode.RECORDING_NOT_FOUND,
            "Recording not found",
            404,
        );
    if (!validCutRange(range, recording.duration))
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Choose a smaller range that keeps part of the recording",
            400,
        );
    const [busy] = await tx
        .select({ id: asyncJobs.id })
        .from(asyncJobs)
        .where(
            and(
                inArray(asyncJobs.subjectId, [
                    recordingId,
                    recordingJobSubject(recordingId, "org"),
                ]),
                inArray(asyncJobs.kind, ["transcription", RECORDING_CUT_KIND]),
                inArray(asyncJobs.status, ["pending", "processing"]),
                jobId ? ne(asyncJobs.id, jobId) : undefined,
            ),
        )
        .limit(1);
    if (busy)
        throw new AppError(
            ErrorCode.CONFLICT,
            "Transcription or cutting is already running for this recording",
            409,
        );
    const transcripts = await tx
        .select()
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.recordingId, recordingId),
                eq(transcriptions.userId, userId),
            ),
        )
        .orderBy(transcriptions.id)
        .for("update");
    for (const transcript of transcripts) {
        const turns = readTranscriptTurns(transcript);
        if (
            !turns?.length ||
            turns.some((turn) => !(turn.endMs > turn.startMs))
        )
            throw new AppError(
                ErrorCode.CONFLICT,
                "This transcript has no turn times",
                409,
            );
        if (!cutTranscript(turns, range).turns.length)
            throw new AppError(
                ErrorCode.INVALID_INPUT,
                "The range must keep at least one turn of every transcript",
                400,
            );
    }
    if (recording.audioReapedAt && !transcripts.length)
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "There is no audio or transcript to cut",
            400,
        );
    return { recording, transcripts };
}

/** Queue one owner-authorized destructive cut, binding it to the displayed revisions. */
export async function requestRecordingCut(
    userId: string,
    recordingId: string,
    range: z.infer<typeof cutRequestSchema>,
) {
    const orgUserId = await sharingOrgUserId();
    if (userId === orgUserId)
        throw new AppError(
            ErrorCode.FORBIDDEN,
            "Only the recording owner may cut it",
            403,
        );
    const job = await db.transaction(async (tx) => {
        const { recording, transcripts } = await loadCutInTx(
            tx,
            userId,
            recordingId,
            range,
        );
        if (range.trimProposalId) {
            const [processing] = await tx
                .select({ phases: itemProcessing.phases })
                .from(itemProcessing)
                .where(
                    and(
                        eq(itemProcessing.itemId, recordingId),
                        eq(itemProcessing.userId, userId),
                        eq(itemProcessing.view, "private"),
                    ),
                )
                .for("update")
                .limit(1);
            const phase = processing?.phases.trim;
            const proposal = decryptJsonField<StoredTrimProposal>(
                recording.trimProposal,
            );
            if (
                !proposal ||
                phase?.state !== "waiting" ||
                phase.waitingFor?.kind !== "trimReview" ||
                phase.proposalId !== range.trimProposalId ||
                proposal.id !== range.trimProposalId ||
                Date.parse(proposal.deadline) <= Date.now() ||
                !range.revisions ||
                !(await trimSnapshotMatches(
                    { recording, transcripts },
                    proposal,
                ))
            )
                throw new AppError(
                    ErrorCode.CONFLICT,
                    "The trim proposal changed or expired. Reload the recording.",
                    409,
                );
        }
        if (
            range.revisions &&
            (range.revisions.length !== transcripts.length ||
                transcripts.some(
                    (row) =>
                        !range.revisions?.some(
                            (shown) =>
                                shown.id === row.id &&
                                shown.revision === row.revision,
                        ),
                ))
        ) {
            throw new AppError(
                ErrorCode.CONFLICT,
                "The recording or transcript changed. Reload it and choose the cut again.",
                409,
            );
        }
        const payload: CutPayload = {
            ...range,
            recordingId,
            encryptedStoragePath: encryptText(recording.storagePath),
            fileMd5: recording.fileMd5,
            duration: recording.duration,
            audioReaped: recording.audioReapedAt !== null,
            revisions: transcripts.map(({ id, revision }) => ({
                id,
                revision,
            })),
        };
        const created = await enqueueJobInTx(tx, {
            userId,
            kind: RECORDING_CUT_KIND,
            subjectId: recordingId,
            payload,
            maxAttempts: 3,
        });
        if (!created)
            throw new AppError(
                ErrorCode.CONFLICT,
                "Cutting is already running for this recording",
                409,
            );
        const [queued] = await tx
            .select({ id: asyncJobs.id })
            .from(asyncJobs)
            .where(
                and(
                    eq(asyncJobs.userId, userId),
                    eq(asyncJobs.kind, RECORDING_CUT_KIND),
                    eq(asyncJobs.subjectId, recordingId),
                    inArray(asyncJobs.status, ["pending", "processing"]),
                ),
            );
        return queued;
    });
    nudge();
    return job;
}

/** Owner-only status lets the detail pane resume following a cut after a reload. */
export async function latestRecordingCut(userId: string, recordingId: string) {
    const [recording] = await db
        .select({ id: recordings.id })
        .from(recordings)
        .where(
            and(
                eq(recordings.id, recordingId),
                eq(recordings.userId, userId),
                isNull(recordings.deletedAt),
            ),
        );
    if (!recording)
        throw new AppError(
            ErrorCode.RECORDING_NOT_FOUND,
            "Recording not found",
            404,
        );
    const [job] = await db
        .select({
            id: asyncJobs.id,
            status: asyncJobs.status,
            error: asyncJobs.lastError,
            payload: asyncJobs.payload,
        })
        .from(asyncJobs)
        .where(
            and(
                eq(asyncJobs.userId, userId),
                eq(asyncJobs.kind, RECORDING_CUT_KIND),
                eq(asyncJobs.subjectId, recordingId),
            ),
        )
        .orderBy(desc(asyncJobs.createdAt))
        .limit(1);
    if (!job) return null;
    const parsed = cutPayloadSchema.safeParse(job.payload);
    return {
        id: job.id,
        status: job.status,
        error: job.error,
        range: parsed.success
            ? { startMs: parsed.data.startMs, endMs: parsed.data.endMs }
            : null,
    };
}
