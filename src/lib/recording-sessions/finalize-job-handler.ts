import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { AppError, ErrorCode } from "@/lib/errors";
import { isRetryableError } from "@/lib/jobs/retryable";
import {
    InvalidJobPayloadError,
    type JobHandler,
    type JobResult,
} from "@/lib/jobs/types";
import { createUserStorageProvider } from "@/lib/storage/factory";
import type { StorageProvider } from "@/lib/storage/types";
import { saveUploadedAudioFile } from "@/lib/uploads/save-uploaded-audio-file";
import {
    parseRecordingSessionFinalizePayload,
    RECORDING_SESSION_FINALIZE_JOB_KIND,
    RECORDING_SESSION_FINALIZE_MAX_ATTEMPTS,
    RECORDING_SESSION_FINALIZE_TIMEOUT_MS,
    type RecordingSessionFinalizePayload,
} from "./finalize-job";
import { buildMeetingTitle, readRecordingSessionMetadata } from "./metadata";
import {
    getRecordingForCapture,
    getRecordingSessionForUser,
    listRecordingSessionChunks,
    markRecordingSessionCompleted,
    markRecordingSessionFailed,
    purgeRecordingSessionChunks,
    type RecordingSessionChunkRow,
} from "./store";

/**
 * Remux the concatenated WebM/Ogg capture into a clean Ogg/Opus file.
 *
 * `-c:a copy` keeps the original Opus packets, so this is fast and lossless.
 * The point is the container: Chrome's MediaRecorder writes WebM with no
 * duration, and the audio ingest path rejects a file whose duration it
 * cannot read. Muxing into Ogg gives it proper timing.
 */
function remuxToOgg(
    inputPath: string,
    outputPath: string,
    signal: AbortSignal,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(
            "ffmpeg",
            [
                "-nostdin",
                "-y",
                "-i",
                inputPath,
                "-map",
                "0:a:0",
                "-vn",
                "-c:a",
                "copy",
                "-f",
                "ogg",
                outputPath,
            ],
            { signal },
        );
        let stderr = "";
        let settled = false;
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
            stderr += chunk;
            if (stderr.length > 4_000) stderr = stderr.slice(-4_000);
        });
        child.once("error", (error) => {
            if (settled) return;
            settled = true;
            if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
                reject(
                    new AppError(
                        ErrorCode.SERVICE_UNAVAILABLE,
                        "Recording finalization is unavailable because ffmpeg is not installed",
                        503,
                    ),
                );
                return;
            }
            if (signal.aborted && signal.reason instanceof Error) {
                reject(signal.reason);
                return;
            }
            reject(error instanceof Error ? error : new Error(String(error)));
        });
        child.once("close", (code) => {
            if (settled) return;
            settled = true;
            if (code === 0) {
                resolve();
                return;
            }
            reject(
                new AppError(
                    ErrorCode.INVALID_FILE_FORMAT,
                    "The recording could not be assembled into a valid audio file.",
                    422,
                    { ffmpeg: stderr.slice(-500) },
                ),
            );
        });
    });
}

/**
 * Stream every chunk, in order, into one file on disk.
 *
 * Concatenation of the raw MediaRecorder slices reproduces the original
 * bytestream: only chunk 0 carries the container header, so the chunks are
 * meaningful only joined from index 0 up, which the contiguity check below
 * guarantees before this runs.
 */
async function assembleChunks(
    storage: StorageProvider,
    chunks: RecordingSessionChunkRow[],
    destinationPath: string,
    signal: AbortSignal,
): Promise<void> {
    const output = createWriteStream(destinationPath);
    try {
        for (const chunk of chunks) {
            signal.throwIfAborted();
            const stream = await storage.downloadStream(chunk.storageKey);
            await pipeline(stream, output, { end: false, signal });
        }
        await new Promise<void>((resolve, reject) => {
            output.end((error?: Error | null) =>
                error ? reject(error) : resolve(),
            );
        });
    } catch (error) {
        output.destroy();
        throw error;
    }
}

function assertContiguous(
    chunks: RecordingSessionChunkRow[],
    expected: number | null,
): void {
    const count = expected ?? chunks.length;
    if (chunks.length !== count) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            `Recording is incomplete: expected ${count} chunks but ${chunks.length} were uploaded`,
            422,
        );
    }
    for (let i = 0; i < chunks.length; i++) {
        if (chunks[i].index !== i) {
            throw new AppError(
                ErrorCode.INVALID_INPUT,
                `Recording is missing chunk ${i}`,
                422,
            );
        }
    }
}

export const recordingSessionFinalizeJobHandler: JobHandler<RecordingSessionFinalizePayload> =
    {
        kind: RECORDING_SESSION_FINALIZE_JOB_KIND,
        concurrency: 1,
        maxAttempts: RECORDING_SESSION_FINALIZE_MAX_ATTEMPTS,
        timeoutMs: RECORDING_SESSION_FINALIZE_TIMEOUT_MS,
        parsePayload: parseRecordingSessionFinalizePayload,

        async run({
            payload,
            userId,
            attempt,
            maxAttempts,
            signal,
        }): Promise<JobResult> {
            const session = await getRecordingSessionForUser(
                payload.sessionId,
                userId,
            );
            if (!session) {
                throw new InvalidJobPayloadError(
                    RECORDING_SESSION_FINALIZE_JOB_KIND,
                    "session does not exist or is not owned by this user",
                );
            }

            // Already assembled on a previous attempt that succeeded past the
            // point of marking completion? Nothing to redo.
            if (session.status === "completed" && session.recordingId) {
                return { recordingId: session.recordingId, alreadyDone: true };
            }
            if (session.status !== "completing") {
                throw new InvalidJobPayloadError(
                    RECORDING_SESSION_FINALIZE_JOB_KIND,
                    `session is ${session.status}, not completing`,
                );
            }

            const storage = await createUserStorageProvider(userId);
            const existing = await getRecordingForCapture(
                userId,
                session.clientRecordingId,
            );
            if (existing) {
                if (
                    await markRecordingSessionCompleted(
                        session.id,
                        userId,
                        existing.recordingId,
                    )
                ) {
                    await purgeRecordingSessionChunks(storage, session.id);
                } else {
                    const latest = await getRecordingSessionForUser(
                        session.id,
                        userId,
                    );
                    if (
                        latest?.status !== "completed" ||
                        latest.recordingId !== existing.recordingId
                    ) {
                        throw new AppError(
                            ErrorCode.CONFLICT,
                            "Recording session changed during finalization",
                            409,
                        );
                    }
                }
                return { ...existing, alreadyDone: true };
            }
            const chunks = (
                await listRecordingSessionChunks(session.id)
            ).filter(
                (chunk) => chunk.index < (session.expectedChunkCount ?? 0),
            );
            assertContiguous(chunks, session.expectedChunkCount);

            let temporaryDirectory: string | null = null;
            try {
                temporaryDirectory = await mkdtemp(
                    path.join(tmpdir(), "riffado-recsession-"),
                );
                const rawPath = path.join(temporaryDirectory, "input");
                const oggPath = path.join(temporaryDirectory, "audio.ogg");

                await assembleChunks(storage, chunks, rawPath, signal);
                const rawStat = await stat(rawPath);
                if (rawStat.size === 0) {
                    throw new AppError(
                        ErrorCode.INVALID_FILE_FORMAT,
                        "The uploaded recording is empty.",
                        422,
                    );
                }

                await remuxToOgg(rawPath, oggPath, signal);

                const metadata = readRecordingSessionMetadata(
                    session.metadata as Record<string, unknown>,
                );
                const title = buildMeetingTitle(metadata, session.startedAt);

                signal.throwIfAborted();
                let saved: {
                    recordingId: string;
                    durationMs: number;
                    filesize: number;
                };
                try {
                    saved = await saveUploadedAudioFile({
                        userId,
                        fileId: `meeting-${session.clientRecordingId}`,
                        basename: title,
                        extension: ".ogg",
                        filePath: oggPath,
                        storage,
                        recordedAt: session.startedAt,
                        signal,
                    });
                } catch (error) {
                    const alreadySaved = await getRecordingForCapture(
                        userId,
                        session.clientRecordingId,
                    );
                    if (!alreadySaved) throw error;
                    saved = alreadySaved;
                }

                const completed = await markRecordingSessionCompleted(
                    session.id,
                    userId,
                    saved.recordingId,
                );
                if (completed) {
                    await purgeRecordingSessionChunks(storage, session.id);
                } else {
                    const latest = await getRecordingSessionForUser(
                        session.id,
                        userId,
                    );
                    if (
                        latest?.status !== "completed" ||
                        latest.recordingId !== saved.recordingId
                    ) {
                        throw new AppError(
                            ErrorCode.CONFLICT,
                            "Recording session changed during finalization",
                            409,
                        );
                    }
                }

                return {
                    recordingId: saved.recordingId,
                    durationMs: saved.durationMs,
                    filesize: saved.filesize,
                    chunkCount: chunks.length,
                };
            } catch (error) {
                const willRetry =
                    attempt < maxAttempts && isRetryableError(error);
                if (!willRetry && !signal.aborted) {
                    // Terminal: record why and keep the chunks for recovery.
                    // The sweeper deletes them after the retention window.
                    const message =
                        error instanceof AppError
                            ? error.message
                            : "The recording could not be finalized.";
                    await markRecordingSessionFailed(
                        session.id,
                        userId,
                        message,
                    );
                }
                throw error;
            } finally {
                if (temporaryDirectory) {
                    await rm(temporaryDirectory, {
                        recursive: true,
                        force: true,
                    });
                }
            }
        },
    };
