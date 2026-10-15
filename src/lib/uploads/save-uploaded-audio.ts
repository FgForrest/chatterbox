import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import { db } from "@/db";
import { insertAudioItem } from "@/db/items";
import { generateIngestWaveform } from "@/lib/audio/ingest-waveform";
import { encryptText } from "@/lib/encryption/fields";
import { env } from "@/lib/env";
import { AppError, ErrorCode } from "@/lib/errors";
import { assertCategorizableFolder } from "@/lib/folders/folders";
import {
    requestArrivalInTx,
    resolveArrivalProfile,
} from "@/lib/pipeline/arrival";
import { captureServerEvent } from "@/lib/posthog-server";
import { buildRecordingStagingPath } from "@/lib/recordings/filename";
import { enqueueStorageReconciliationJob } from "@/lib/recordings/storage-reconciliation-job";
import type { StorageProvider } from "@/lib/storage/types";
import { readAudioDurationMs } from "@/lib/uploads/audio-duration";
import { getAudioMimeType } from "@/lib/utils";

export interface SaveUploadedAudioInput {
    userId: string;
    fileId: string;
    basename: string;
    extension: string;
    buffer: Buffer;
    storage: StorageProvider;
    sourceExtension: string;
    convertedFromVideo: boolean;
    folderId?: string | null;
    /**
     * When the audio was actually captured. Defaults to now, which is right
     * for a file picked from disk but wrong for a meeting recording that
     * started an hour ago and is only being assembled now.
     */
    recordedAt?: Date;
    deferredFolderFallback?: DeferredFolderFallback;
}

export interface DeferredFolderFallback {
    kind: "recording session" | "video extraction job";
    id: string;
}

export interface SavedUploadedAudio {
    recordingId: string;
    filename: string;
    storageKey: string;
    durationMs: number;
    filesize: number;
}

function isUnavailableFolderError(error: unknown): boolean {
    return (
        error instanceof AppError &&
        (error.statusCode === 400 ||
            error.statusCode === 403 ||
            error.statusCode === 404)
    );
}

/** Resolve an upload folder, optionally degrading deferred captures to filing later. */
export async function resolveUploadedAudioFolder(
    userId: string,
    folderId: string | null | undefined,
    fallback?: DeferredFolderFallback,
) {
    if (!folderId) return null;
    try {
        return await assertCategorizableFolder(userId, folderId);
    } catch (error) {
        if (!fallback || !isUnavailableFolderError(error)) throw error;
        console.warn(
            `[${fallback.kind} ${fallback.id}] selected folder is unavailable; saved without placement`,
        );
        return null;
    }
}

export async function saveUploadedAudio(
    input: SaveUploadedAudioInput,
): Promise<SavedUploadedAudio> {
    const recordingId = nanoid();
    const folder = await resolveUploadedAudioFolder(
        input.userId,
        input.folderId,
        input.deferredFolderFallback,
    );
    const profile = folder
        ? await resolveArrivalProfile({
              ownerUserId: input.userId,
              itemId: recordingId,
              channel: "audio",
              folderIds: [folder.folderId],
          })
        : null;
    const storageKey = buildRecordingStagingPath(
        input.userId,
        recordingId,
        input.extension,
    );
    const contentType = getAudioMimeType(storageKey);
    const durationMs = await readAudioDurationMs(input.buffer, contentType);

    if (durationMs === 0) {
        throw new AppError(
            ErrorCode.INVALID_FILE_FORMAT,
            "File does not contain a valid audio stream",
            422,
        );
    }

    const md5 = createHash("md5").update(input.buffer).digest("hex");
    const now = new Date();
    const startTime = input.recordedAt ?? now;

    const [waveformPeaks] = await Promise.all([
        generateIngestWaveform(input.buffer),
        input.storage.uploadFile(storageKey, input.buffer, contentType),
    ]);

    try {
        await insertAudioItem(
            db,
            {
                id: recordingId,
                userId: input.userId,
                deviceSn: "local",
                plaudFileId: input.fileId,
                title: encryptText(input.basename),
                duration: durationMs,
                occurredAt: startTime,
                endTime: new Date(startTime.getTime() + durationMs),
                filesize: input.buffer.length,
                fileMd5: md5,
                storageType: env.DEFAULT_STORAGE_TYPE,
                storagePath: storageKey,
                waveformPeaks,
                downloadedAt: now,
                plaudVersion: "1",
                isTrash: false,
            },
            {
                pipeline: "arrival",
                initializeInTx: (tx, arrival) =>
                    requestArrivalInTx(tx, { ...arrival, folder, profile }),
            },
        );
    } catch (dbError) {
        try {
            await input.storage.deleteFile(storageKey);
        } catch (cleanupError) {
            console.error(
                "Failed to clean up orphaned audio after database insert error:",
                cleanupError,
            );
        }
        throw dbError;
    }

    await captureServerEvent({
        distinctId: input.userId,
        event: "recording_uploaded",
        properties: {
            duration_ms: durationMs,
            filesize_bytes: input.buffer.length,
            extension: input.extension,
            source_extension: input.sourceExtension,
            converted_from_video: input.convertedFromVideo,
        },
    });

    try {
        await enqueueStorageReconciliationJob({
            userId: input.userId,
            recordingId,
        });
    } catch (error) {
        console.error(
            `Could not queue storage filename reconciliation for recording ${recordingId}:`,
            error,
        );
    }

    return {
        recordingId,
        filename: input.basename,
        storageKey,
        durationMs,
        filesize: input.buffer.length,
    };
}
