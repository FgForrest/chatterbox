import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { and, eq, inArray, isNull, notExists, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { cancelAgendaSuggestionsForRecordingInTx } from "@/db/queries/agenda-suggestions";
import { lockPipelineTargetsInTx } from "@/db/queries/pipeline-jobs";
import {
    agendaPoints,
    agendaSuggestions,
    aiEnhancements,
    asyncJobs,
    chatterItems,
    itemProcessing,
    knowledgeFactEvidence,
    knowledgeFacts,
    learnReviewItems,
    learnRuns,
    meetingAgendas,
    recordings,
    recordingTasks,
    taskContentVectors,
    taskMentions,
    taskUpdateProposals,
    transcriptions,
} from "@/db/schema";
import { generateFileWaveform } from "@/lib/audio/server-waveform";
import {
    decryptJsonField,
    decryptText,
    encryptJsonField,
    encryptText,
} from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { enqueueExportPlansForUser } from "@/lib/folder-exports/jobs";
import { lockOrgTree } from "@/lib/folders/folders";
import { nudge } from "@/lib/jobs/nudge";
import { InvalidJobPayloadError, type JobHandler } from "@/lib/jobs/types";
import { lockOrgPeople } from "@/lib/knowledge/org-people";
import { bumpScopeInTx } from "@/lib/knowledge/scope-generation";
import { speakerVersionOf } from "@/lib/knowledge/speaker-label-rules";
import { storedSpeakerVersion } from "@/lib/knowledge/speaker-labels";
import { transcriptRewrittenInTx } from "@/lib/knowledge/transcript-rewrite";
import { notifyOrgChange } from "@/lib/org/events";
import { requestAdvanceInTx } from "@/lib/pipeline/trigger";
import {
    type CutPayload,
    type CutTx,
    cutPayloadSchema,
    loadCutInTx,
    RECORDING_CUT_KIND,
} from "@/lib/recordings/cut";
import { cutAudioFile } from "@/lib/recordings/cut-audio";
import { cutTranscript } from "@/lib/recordings/cut-range";
import {
    isStorageNotFoundError,
    storageKeysForErase,
} from "@/lib/recordings/erase";
import { buildRecordingStorageFilename } from "@/lib/recordings/filename";
import { enqueueStorageReconciliationJob } from "@/lib/recordings/storage-reconciliation-job";
import { isRecordingShared } from "@/lib/sharing/shared";
import { recordingJobSubject } from "@/lib/sharing/view";
import { sharingOrgUserId } from "@/lib/sharing/writer";
import { createUserStorageProvider } from "@/lib/storage/factory";
import type { StorageProvider } from "@/lib/storage/types";
import { lockItemTaskGraphInTx } from "@/lib/tasks/mentions";
import { readTranscriptTurns } from "@/lib/transcription/read-turns";
import type { TranscriptTurn } from "@/lib/transcription/turns";

interface Cleanup {
    oldPath: string;
    audio: boolean;
}

async function cleanStorage(
    storage: StorageProvider,
    cleanup: Cleanup,
    userId: string,
    recordingId: string,
    jobId: string,
    claimToken: string | null,
    attempt: number,
    prepared = false,
) {
    await db.transaction(async (tx) => {
        await tx
            .select({ id: recordings.id })
            .from(recordings)
            .where(
                and(
                    eq(recordings.id, recordingId),
                    eq(recordings.userId, userId),
                ),
            )
            .for("update");
        const [job] = await tx
            .select({ id: asyncJobs.id })
            .from(asyncJobs)
            .where(
                and(
                    eq(asyncJobs.id, jobId),
                    eq(asyncJobs.userId, userId),
                    eq(asyncJobs.status, "processing"),
                    eq(asyncJobs.attempts, attempt),
                    claimToken === null
                        ? isNull(asyncJobs.claimToken)
                        : eq(asyncJobs.claimToken, claimToken),
                ),
            )
            .for("update");
        if (!job) return;
        const keys = prepared
            ? [cleanup.oldPath]
            : cleanup.audio
              ? storageKeysForErase(cleanup.oldPath, "all")
              : [
                    ...storageKeysForErase(cleanup.oldPath, "transcript"),
                    ...storageKeysForErase(cleanup.oldPath, "summary"),
                ];
        for (const key of keys) {
            // The recording and claim locks prevent reclaim/reconciliation during deletion; references in any scope protect live audio.
            const [reference] = await tx
                .select({ id: recordings.id })
                .from(recordings)
                .where(
                    or(
                        eq(recordings.storagePath, key),
                        cleanup.audio
                            ? eq(recordings.storagePath, cleanup.oldPath)
                            : undefined,
                    ),
                )
                .limit(1);
            if (reference) continue;
            try {
                await storage.deleteFile(key);
            } catch (error) {
                if (!isStorageNotFoundError(error)) throw error;
            }
        }
    });
}

/** Apply the prepared audio and transcript cut atomically; the caller holds the task graph. */
export async function commitRecordingCut(
    tx: CutTx,
    userId: string,
    jobId: string,
    payload: CutPayload,
    audio: {
        storagePath: string;
        storageFilename: string;
        filesize: number;
        md5: string;
        duration: number;
        peaks: number[];
    } | null,
    orgUserId: string | null,
    expectedClaimToken?: string | null,
): Promise<Cleanup> {
    const { recording, transcripts } = await loadCutInTx(
        tx,
        userId,
        payload.recordingId,
        payload,
        jobId,
    );
    if (
        recording.storagePath !== decryptText(payload.encryptedStoragePath) ||
        recording.fileMd5 !== payload.fileMd5 ||
        recording.duration !== payload.duration ||
        Boolean(recording.audioReapedAt) !== payload.audioReaped ||
        transcripts.length !== payload.revisions.length ||
        transcripts.some(
            (row) =>
                !payload.revisions.some(
                    (old) => old.id === row.id && old.revision === row.revision,
                ),
        )
    ) {
        throw new AppError(
            ErrorCode.CONFLICT,
            "The recording or transcript changed. Reload it and choose the cut again.",
            409,
        );
    }
    // Processing locks precede job locks, including queue completion.
    await lockPipelineTargetsInTx(tx, [
        { itemId: payload.recordingId, userId },
    ]);
    const [job] = await tx
        .select({ status: asyncJobs.status, claimToken: asyncJobs.claimToken })
        .from(asyncJobs)
        .where(and(eq(asyncJobs.id, jobId), eq(asyncJobs.userId, userId)))
        .for("update");
    if (
        !job ||
        job.status !== "processing" ||
        (expectedClaimToken !== undefined &&
            expectedClaimToken !== job.claimToken)
    )
        throw new AppError(
            ErrorCode.CONFLICT,
            "The cut job is no longer running",
            409,
        );
    const factEvidenceBefore = await tx
        .select({
            factId: knowledgeFactEvidence.factId,
            userId: knowledgeFactEvidence.userId,
        })
        .from(knowledgeFactEvidence)
        .where(
            and(
                eq(knowledgeFactEvidence.itemId, recording.id),
                inArray(
                    knowledgeFactEvidence.userId,
                    orgUserId ? [userId, orgUserId] : [userId],
                ),
            ),
        );
    await cancelAgendaSuggestionsForRecordingInTx(tx, userId, recording.id);
    const now = new Date();
    const md5 = audio?.md5 ?? recording.fileMd5;
    await tx
        .update(recordings)
        .set({
            ...(audio
                ? {
                      storagePath: audio.storagePath,
                      storageFilename: recording.storageFilename ?? null,
                      filesize: audio.filesize,
                      fileMd5: md5,
                      waveformPeaks: audio.peaks,
                  }
                : { waveformPeaks: null }),
            duration: audio?.duration ?? payload.endMs - payload.startMs,
            cutAt: now,
            updatedAt: now,
        })
        .where(
            and(eq(recordings.id, recording.id), eq(recordings.userId, userId)),
        );
    const rewrittenBySource = new Map<string, TranscriptTurn[]>();
    for (const transcript of transcripts) {
        const previous = storedSpeakerVersion(transcript);
        const rewritten = cutTranscript(
            readTranscriptTurns(transcript) ?? [],
            payload,
        );
        rewrittenBySource.set(transcript.source, rewritten.turns);
        await tx
            .update(transcriptions)
            .set({
                text: encryptText(rewritten.text),
                turns: encryptJsonField(rewritten.turns),
                revision: transcript.revision + 1,
                topics: null,
                topicsInputFingerprint: null,
            })
            .where(
                and(
                    eq(transcriptions.id, transcript.id),
                    eq(transcriptions.userId, userId),
                ),
            );
        const next = speakerVersionOf(rewritten);
        await transcriptRewrittenInTx(tx, {
            userId,
            transcriptionId: transcript.id,
            previous,
            next: { ...next, retainedLabels: next.labels },
            audioMd5: md5,
            cut: { ...payload, turnIndices: rewritten.turnIndices },
        });
    }
    if (factEvidenceBefore.length) {
        await tx
            .update(knowledgeFacts)
            .set({ origin: "manual", updatedAt: now })
            .where(
                and(
                    inArray(knowledgeFacts.id, [
                        ...new Set(factEvidenceBefore.map((row) => row.factId)),
                    ]),
                    inArray(
                        knowledgeFacts.userId,
                        orgUserId ? [userId, orgUserId] : [userId],
                    ),
                    notExists(
                        tx
                            .select({ id: knowledgeFactEvidence.id })
                            .from(knowledgeFactEvidence)
                            .where(
                                and(
                                    eq(
                                        knowledgeFactEvidence.factId,
                                        knowledgeFacts.id,
                                    ),
                                    eq(
                                        knowledgeFactEvidence.status,
                                        "supported",
                                    ),
                                ),
                            ),
                    ),
                ),
            );
    }
    await tx
        .delete(aiEnhancements)
        .where(
            and(
                eq(aiEnhancements.itemId, recording.id),
                eq(aiEnhancements.userId, userId),
            ),
        );
    await tx
        .delete(recordingTasks)
        .where(
            and(
                eq(recordingTasks.itemId, recording.id),
                eq(recordingTasks.userId, userId),
                eq(recordingTasks.status, "proposed"),
            ),
        );
    await tx
        .delete(taskUpdateProposals)
        .where(
            and(
                eq(taskUpdateProposals.itemId, recording.id),
                eq(taskUpdateProposals.userId, userId),
                inArray(taskUpdateProposals.state, [
                    "awaiting_source_review",
                    "awaiting_share",
                    "awaiting_target_review",
                ]),
            ),
        );
    await tx
        .delete(taskMentions)
        .where(
            and(
                eq(taskMentions.itemId, recording.id),
                eq(taskMentions.userId, userId),
                eq(taskMentions.matchDecision, "suggested"),
            ),
        );
    await tx
        .delete(taskContentVectors)
        .where(
            and(
                eq(taskContentVectors.itemId, recording.id),
                eq(taskContentVectors.userId, userId),
            ),
        );
    const retainedTaskEvidence = (
        at: number | null,
        quote: string | null,
        source?: string | null,
    ) => {
        const shifted = at === null ? -1 : at - payload.startMs;
        const candidates =
            source && rewrittenBySource.has(source)
                ? (rewrittenBySource.get(source) ?? [])
                : [...rewrittenBySource.values()].flat();
        const text = decryptText(quote);
        const stays =
            shifted >= 0 &&
            at !== null &&
            at < payload.endMs &&
            candidates.some(
                (turn) =>
                    turn.startMs <= shifted &&
                    shifted < turn.endMs &&
                    (!text || turn.text.includes(text)),
            );
        return {
            evidenceStartMs: stays ? shifted : null,
            quote: stays ? quote : null,
        };
    };
    const acceptedTasks = await tx
        .select()
        .from(recordingTasks)
        .where(
            and(
                eq(recordingTasks.itemId, recording.id),
                eq(recordingTasks.userId, userId),
            ),
        );
    for (const task of acceptedTasks) {
        await tx
            .update(recordingTasks)
            .set({
                ...retainedTaskEvidence(
                    task.evidenceStartMs,
                    task.quote,
                    task.source,
                ),
                version: task.version + 1,
                updatedAt: now,
            })
            .where(
                and(
                    eq(recordingTasks.id, task.id),
                    eq(recordingTasks.userId, userId),
                ),
            );
    }
    const mentions = await tx
        .select()
        .from(taskMentions)
        .where(
            and(
                eq(taskMentions.itemId, recording.id),
                eq(taskMentions.userId, userId),
            ),
        );
    for (const mention of mentions) {
        const transcript = transcripts.find(
            (row) => row.source === mention.contentSourceId,
        );
        await tx
            .update(taskMentions)
            .set({
                ...retainedTaskEvidence(
                    mention.evidenceStartMs,
                    mention.quote,
                    mention.contentSourceId,
                ),
                contentRevision: transcript ? transcript.revision + 1 : null,
                updatedAt: now,
            })
            .where(
                and(
                    eq(taskMentions.id, mention.id),
                    eq(taskMentions.userId, userId),
                ),
            );
    }
    const updates = await tx
        .select()
        .from(taskUpdateProposals)
        .where(
            and(
                eq(taskUpdateProposals.itemId, recording.id),
                eq(taskUpdateProposals.userId, userId),
            ),
        );
    for (const update of updates) {
        await tx
            .update(taskUpdateProposals)
            .set({
                ...retainedTaskEvidence(
                    update.evidenceStartMs,
                    update.quote,
                    null,
                ),
                updatedAt: now,
            })
            .where(
                and(
                    eq(taskUpdateProposals.id, update.id),
                    eq(taskUpdateProposals.userId, userId),
                ),
            );
    }
    const agendas = await tx
        .update(meetingAgendas)
        .set({
            outcomeUnplanned: null,
            outcomeSummaryId: null,
            updatedAt: now,
            version: sql`${meetingAgendas.version} + 1`,
        })
        .where(
            and(
                eq(meetingAgendas.recordingItemId, recording.id),
                eq(meetingAgendas.userId, userId),
            ),
        )
        .returning({ id: meetingAgendas.id });
    if (agendas.length)
        await tx
            .update(agendaPoints)
            .set({ summaryOutcome: null })
            .where(
                and(
                    eq(agendaPoints.userId, userId),
                    inArray(
                        agendaPoints.agendaId,
                        agendas.map((agenda) => agenda.id),
                    ),
                ),
            );
    const cutSuggestionSource = and(
        eq(agendaSuggestions.kind, "ai"),
        sql`${agendaSuggestions.sources} -> 'itemIds' @> ${JSON.stringify([recording.id])}::jsonb`,
    );
    await tx
        .update(meetingAgendas)
        .set({ updatedAt: now, version: sql`${meetingAgendas.version} + 1` })
        .where(
            inArray(
                meetingAgendas.id,
                tx
                    .select({ id: agendaSuggestions.agendaId })
                    .from(agendaSuggestions)
                    .where(cutSuggestionSource),
            ),
        );
    await tx.delete(agendaSuggestions).where(cutSuggestionSource);
    const runs = await tx
        .select({ id: learnRuns.id, scope: learnRuns.scopeUserId })
        .from(learnRuns)
        .where(
            and(
                eq(learnRuns.itemId, recording.id),
                eq(learnRuns.userId, userId),
            ),
        );
    if (runs.length)
        await tx.delete(learnReviewItems).where(
            inArray(
                learnReviewItems.runId,
                runs.map((run) => run.id),
            ),
        );
    await bumpScopeInTx(
        tx,
        runs.map((run) => run.scope),
    );
    await tx
        .update(asyncJobs)
        .set({
            status: "failed",
            completedAt: now,
            updatedAt: now,
            claimToken: null,
            heartbeatAt: null,
            errorCode: ErrorCode.CONFLICT,
            lastError: "Cancelled because the recording was cut",
        })
        .where(
            and(
                inArray(asyncJobs.subjectId, [
                    recording.id,
                    recordingJobSubject(recording.id, "org"),
                    `executeShares:${recording.id}`,
                ]),
                inArray(asyncJobs.kind, [
                    "summary",
                    "topics",
                    "title.generate",
                    "learn.run",
                    "learn.release",
                    "learn.correct",
                    "pipeline.action",
                ]),
                inArray(asyncJobs.status, ["pending", "processing"]),
            ),
        );
    const processingRows = await tx
        .select()
        .from(itemProcessing)
        .where(
            and(
                eq(itemProcessing.itemId, recording.id),
                eq(itemProcessing.userId, userId),
            ),
        )
        .for("update");
    const generatedTitle = processingRows.some(
        (row) => row.phases.summary?.steps?.title?.state === "done",
    );
    await tx
        .update(chatterItems)
        .set({
            updatedAt: now,
            summaryDueAt: null,
            summaryReapedAt: null,
            ...(generatedTitle
                ? {
                      title: sql`case when ${chatterItems.titleEditedAt} is null then ${encryptText("")} else ${chatterItems.title} end`,
                  }
                : {}),
        })
        .where(
            and(
                eq(chatterItems.id, recording.id),
                eq(chatterItems.userId, userId),
            ),
        );
    for (const processing of processingRows) {
        const phases = { ...processing.phases };
        delete phases.learn;
        delete phases.summary;
        delete phases.taskReview;
        delete phases.share;
        await tx
            .update(itemProcessing)
            .set({ phases, updatedAt: now })
            .where(
                and(
                    eq(itemProcessing.itemId, recording.id),
                    eq(itemProcessing.userId, userId),
                    eq(itemProcessing.view, processing.view),
                ),
            );
    }
    if (transcripts.length)
        await requestAdvanceInTx(tx, {
            itemId: recording.id,
            userId,
            view: "private",
            reason: "transcript",
        });
    const cleanup = { oldPath: recording.storagePath, audio: audio !== null };
    await tx
        .update(asyncJobs)
        .set({
            payload: {
                ...payload,
                committed: true,
                cleanup: encryptJsonField(cleanup),
            },
        })
        .where(and(eq(asyncJobs.id, jobId), eq(asyncJobs.userId, userId)));
    return cleanup;
}

async function afterCutCommit(
    userId: string,
    jobId: string,
    payload: CutPayload,
) {
    const orgUserId = await sharingOrgUserId();
    const shared = orgUserId
        ? await isRecordingShared(payload.recordingId, orgUserId)
        : false;
    console.info(
        `[cut] done recording=${payload.recordingId} job=${jobId} keptMs=${payload.endMs - payload.startMs} shared=${shared}`,
    );
    await enqueueExportPlansForUser(userId);
    if (orgUserId && shared) {
        await enqueueExportPlansForUser(orgUserId);
        await notifyOrgChange({
            type: "recording",
            recordingId: payload.recordingId,
        });
    }
    await enqueueStorageReconciliationJob({
        userId,
        recordingId: payload.recordingId,
    });
    nudge();
}

export const recordingCutJobHandler: JobHandler<CutPayload> = {
    kind: RECORDING_CUT_KIND,
    concurrency: 1,
    maxAttempts: 3,
    timeoutMs: 60 * 60 * 1000,
    parsePayload(raw) {
        const parsed = cutPayloadSchema.safeParse(raw);
        if (!parsed.success)
            throw new InvalidJobPayloadError(
                RECORDING_CUT_KIND,
                "Invalid cut range or transcript revisions",
            );
        return parsed.data;
    },
    isRetryable: (error) => !(error instanceof AppError),
    async run({ userId, jobId, payload, signal, reportProgress, attempt }) {
        try {
            signal.throwIfAborted();
            const storage = await createUserStorageProvider(userId);
            const [persisted] = await db
                .select({
                    payload: asyncJobs.payload,
                    claimToken: asyncJobs.claimToken,
                    attempts: asyncJobs.attempts,
                    status: asyncJobs.status,
                })
                .from(asyncJobs)
                .where(
                    and(eq(asyncJobs.id, jobId), eq(asyncJobs.userId, userId)),
                );
            if (
                !persisted ||
                persisted.status !== "processing" ||
                persisted.attempts !== attempt
            )
                throw new AppError(
                    ErrorCode.CONFLICT,
                    "The cut job is no longer running",
                    409,
                );
            const checkpoint = persisted
                ? cutPayloadSchema.parse(persisted.payload)
                : payload;
            if (checkpoint.committed) {
                const cleanup = decryptJsonField<Cleanup>(checkpoint.cleanup);
                if (!cleanup)
                    throw new Error("Cut cleanup checkpoint is missing");
                await afterCutCommit(userId, jobId, payload);
                await cleanStorage(
                    storage,
                    cleanup,
                    userId,
                    payload.recordingId,
                    jobId,
                    persisted.claimToken,
                    attempt,
                );
                return { cut: true };
            }
            if (checkpoint.preparedStoragePath) {
                await cleanStorage(
                    storage,
                    {
                        oldPath: decryptText(checkpoint.preparedStoragePath),
                        audio: true,
                    },
                    userId,
                    payload.recordingId,
                    jobId,
                    persisted.claimToken,
                    attempt,
                    true,
                );
            }
            let prepared: Parameters<typeof commitRecordingCut>[4] = null;
            let committed = false;
            let directory: string | null = null;
            try {
                if (!payload.audioReaped) {
                    reportProgress({ phase: "cutting" });
                    directory = await mkdtemp(
                        path.join(tmpdir(), "chatterbox-cut-job-"),
                    );
                    const source = path.join(directory, "source");
                    await pipeline(
                        await storage.downloadStream(
                            decryptText(payload.encryptedStoragePath),
                        ),
                        createWriteStream(source),
                        { signal },
                    );
                    const result = await cutAudioFile(
                        source,
                        directory,
                        payload,
                        signal,
                    );
                    const hash = createHash("md5");
                    for await (const chunk of createReadStream(result.output, {
                        signal,
                    }))
                        hash.update(chunk);
                    const peaks = await generateFileWaveform(
                        result.output,
                        result.duration,
                        500,
                        signal,
                    );
                    if (!peaks)
                        throw new Error(
                            "The cut audio waveform could not be generated",
                        );
                    const [item] = await db
                        .select({ title: chatterItems.title })
                        .from(chatterItems)
                        .where(
                            and(
                                eq(chatterItems.id, payload.recordingId),
                                eq(chatterItems.userId, userId),
                            ),
                        );
                    const filename = buildRecordingStorageFilename(
                        decryptText(item?.title ?? ""),
                        result.extension,
                    );
                    const key = `${userId}/.cuts/${jobId}-${attempt}/${filename}`;
                    prepared = {
                        storagePath: key,
                        storageFilename: filename,
                        filesize: (await stat(result.output)).size,
                        md5: hash.digest("hex"),
                        duration: result.duration,
                        peaks,
                    };
                    const [saved] = await db
                        .update(asyncJobs)
                        .set({
                            payload: {
                                ...checkpoint,
                                preparedStoragePath: encryptText(key),
                            },
                        })
                        .where(
                            and(
                                eq(asyncJobs.id, jobId),
                                eq(asyncJobs.userId, userId),
                                eq(asyncJobs.status, "processing"),
                                eq(asyncJobs.attempts, attempt),
                                persisted.claimToken === null
                                    ? isNull(asyncJobs.claimToken)
                                    : eq(
                                          asyncJobs.claimToken,
                                          persisted.claimToken,
                                      ),
                            ),
                        )
                        .returning({ id: asyncJobs.id });
                    if (!saved)
                        throw new AppError(
                            ErrorCode.CONFLICT,
                            "The cut job is no longer running",
                            409,
                        );
                    await storage.uploadStream(
                        key,
                        createReadStream(result.output, { signal }),
                        result.contentType,
                    );
                }
                signal.throwIfAborted();
                const orgUserId = await sharingOrgUserId();
                const cleanup = await db.transaction(async (tx) => {
                    // Match intended sharing: Organization tree, people, then item/task graph.
                    if (orgUserId) {
                        await lockOrgTree(tx);
                        await lockOrgPeople(tx);
                    }
                    await lockItemTaskGraphInTx(tx, {
                        itemId: payload.recordingId,
                        ownerUserId: userId,
                    });
                    signal.throwIfAborted();
                    return commitRecordingCut(
                        tx,
                        userId,
                        jobId,
                        payload,
                        prepared,
                        orgUserId,
                        persisted.claimToken,
                    );
                });
                committed = true;
                reportProgress({ phase: "cleanup" });
                await afterCutCommit(userId, jobId, payload);
                await cleanStorage(
                    storage,
                    cleanup,
                    userId,
                    payload.recordingId,
                    jobId,
                    persisted.claimToken,
                    attempt,
                );
                return { cut: true };
            } finally {
                try {
                    if (!committed && prepared) {
                        await cleanStorage(
                            storage,
                            { oldPath: prepared.storagePath, audio: true },
                            userId,
                            payload.recordingId,
                            jobId,
                            persisted.claimToken,
                            attempt,
                            true,
                        );
                    }
                } finally {
                    if (directory)
                        await rm(directory, { recursive: true, force: true });
                }
            }
        } catch (error) {
            if (
                error instanceof AppError &&
                [
                    ErrorCode.CONFLICT,
                    ErrorCode.INVALID_INPUT,
                    ErrorCode.RECORDING_NOT_FOUND,
                ].includes(error.code)
            )
                throw error;
            throw new Error("The recording could not be cut.");
        }
    },
};
