import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { nanoid } from "nanoid";
import { db } from "@/db";
import { insertAudioItem } from "@/db/items";
import { generateFileWaveform } from "@/lib/audio/server-waveform";
import { DEFAULT_BUCKETS } from "@/lib/audio/waveform";
import { encryptText } from "@/lib/encryption/fields";
import { env } from "@/lib/env";
import { AppError, ErrorCode } from "@/lib/errors";
import { assertNotOrgAccount } from "@/lib/org/config";
import { requestArrivalInTx } from "@/lib/pipeline/arrival";
import { captureServerEvent } from "@/lib/posthog-server";
import { buildRecordingStagingPath } from "@/lib/recordings/filename";
import { enqueueStorageReconciliationJob } from "@/lib/recordings/storage-reconciliation-job";
import type { StorageProvider } from "@/lib/storage/types";
import { readAudioFileDurationMs } from "@/lib/uploads/audio-duration";
import {
    type DeferredFolderFallback,
    resolveUploadedAudioPlacement,
    type SavedUploadedAudio,
} from "@/lib/uploads/save-uploaded-audio";
import { getAudioMimeType } from "@/lib/utils";

/** Save a recorder file using bounded streams for metadata and storage. */
export async function saveUploadedAudioFile(input: {
    userId: string;
    fileId: string;
    basename: string;
    extension: string;
    filePath: string;
    storage: StorageProvider;
    recordedAt: Date;
    signal?: AbortSignal;
    folderId?: string | null;
    deferredFolderFallback?: DeferredFolderFallback;
}): Promise<SavedUploadedAudio> {
    await assertNotOrgAccount(input.userId);
    const info = await stat(input.filePath);
    const durationMs = await readAudioFileDurationMs(input.filePath);
    if (durationMs <= 0) {
        throw new AppError(
            ErrorCode.INVALID_FILE_FORMAT,
            "File does not contain a valid audio stream",
            422,
        );
    }
    const md5Hash = createHash("md5");
    for await (const part of createReadStream(input.filePath))
        md5Hash.update(part);
    const md5 = md5Hash.digest("hex");
    let waveformPeaks: number[] | null = null;
    try {
        waveformPeaks = await generateFileWaveform(
            input.filePath,
            durationMs,
            DEFAULT_BUCKETS,
            input.signal,
        );
    } catch (error) {
        if (input.signal?.aborted) throw error;
        console.warn("Recorder waveform generation failed:", error);
    }
    input.signal?.throwIfAborted();
    const recordingId = nanoid();
    const { folder, profileResolution } = await resolveUploadedAudioPlacement({
        userId: input.userId,
        itemId: recordingId,
        folderId: input.folderId,
        deferredFolderFallback: input.deferredFolderFallback,
    });
    const storageKey = buildRecordingStagingPath(
        input.userId,
        recordingId,
        input.extension,
    );
    await input.storage.uploadStream(
        storageKey,
        createReadStream(input.filePath),
        getAudioMimeType(storageKey),
    );
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
                occurredAt: input.recordedAt,
                endTime: new Date(input.recordedAt.getTime() + durationMs),
                filesize: info.size,
                fileMd5: md5,
                storageType: env.DEFAULT_STORAGE_TYPE,
                storagePath: storageKey,
                waveformPeaks,
                downloadedAt: new Date(),
                plaudVersion: "1",
                isTrash: false,
            },
            {
                pipeline: "arrival",
                initializeInTx: (tx, arrival) =>
                    requestArrivalInTx(tx, {
                        ...arrival,
                        folder,
                        profile: profileResolution?.profile ?? null,
                        manualOnly: profileResolution?.manualOnly ?? false,
                    }),
            },
        );
    } catch (error) {
        await input.storage
            .deleteFile(storageKey)
            .catch((cleanupError) =>
                console.error(
                    "Failed to remove orphaned recorder audio:",
                    cleanupError,
                ),
            );
        throw error;
    }
    await captureServerEvent({
        distinctId: input.userId,
        event: "recording_uploaded",
        properties: {
            duration_ms: durationMs,
            filesize_bytes: info.size,
            extension: input.extension,
            source_extension: ".webm",
            converted_from_video: false,
        },
    });
    await enqueueStorageReconciliationJob({
        userId: input.userId,
        recordingId,
    }).catch((error) =>
        console.error("Could not queue filename reconciliation:", error),
    );
    return {
        recordingId,
        filename: input.basename,
        storageKey,
        durationMs,
        filesize: info.size,
    };
}
