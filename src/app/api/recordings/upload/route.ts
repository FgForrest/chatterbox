import * as path from "node:path";
import { nanoid } from "nanoid";
import { NextResponse } from "next/server";
import { listJobsForUser } from "@/db/queries/async-jobs";
import { requireApiSession } from "@/lib/auth-server";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { isHostedLockedOut } from "@/lib/entitlements";
import { env } from "@/lib/env";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { enforceStorageCap } from "@/lib/hosted/billing/storage-cap";
import { decideHostnameGate } from "@/lib/hosted/hostname-gate";
import { assertNotOrgAccount } from "@/lib/org/config";
import { createUserStorageProvider } from "@/lib/storage/factory";
import type { StorageProvider } from "@/lib/storage/types";
import {
    AUDIO_UPLOAD_MAX_BYTES,
    acceptedUploadExtensions,
    isSupportedUpload,
    shouldExtractVideo,
    uploadExtension,
} from "@/lib/uploads/media-types";
import { saveUploadedAudio } from "@/lib/uploads/save-uploaded-audio";
import {
    fileTooLarge,
    readUploadBody,
    readUploadMetadata,
    streamUploadBody,
} from "@/lib/uploads/upload-body";
import {
    enqueueVideoExtractionJob,
    parseVideoExtractionJobPayload,
    VIDEO_EXTRACTION_JOB_KIND,
} from "@/lib/uploads/video-extraction-job";

/**
 * `src/proxy.ts` skips this route so it cannot buffer the request body in
 * memory, and with it the admin-host gate. Apply that gate here instead.
 */
function assertNotOnAdminHost(request: Request): void {
    const decision = decideHostnameGate({
        requestHostname: (request.headers.get("host") ?? "")
            .split(":")[0]
            .toLowerCase(),
        pathname: new URL(request.url).pathname,
        adminHostname: env.ADMIN_HOSTNAME,
    });
    if (decision.kind !== "next") {
        throw new AppError(ErrorCode.NOT_FOUND, "Not found", 404);
    }
}

function anotherVideoConverting(): AppError {
    return new AppError(
        ErrorCode.RATE_LIMITED,
        "Another video is already being converted. Try this upload again when it finishes.",
        429,
    );
}

async function deleteSource(
    storage: StorageProvider,
    sourceStorageKey: string,
): Promise<void> {
    try {
        if (await storage.exists(sourceStorageKey)) {
            await storage.deleteFile(sourceStorageKey);
        }
    } catch (cleanupError) {
        console.error("Failed to clean up uploaded video:", cleanupError);
    }
}

export const GET = apiHandler(async (request: Request) => {
    assertNotOnAdminHost(request);
    const session = await requireApiSession(request);
    const jobs = await listJobsForUser(session.user.id, {
        kind: VIDEO_EXTRACTION_JOB_KIND,
        activeOnly: true,
        limit: 20,
    });

    const uploads = jobs.flatMap((job) => {
        try {
            const payload = parseVideoExtractionJobPayload(job.payload);
            return [
                {
                    jobId: job.id,
                    filename: decryptText(payload.encryptedFilename),
                    filesize: payload.sourceSize,
                    status: job.status,
                    progress: job.progress,
                },
            ];
        } catch {
            return [];
        }
    });

    return NextResponse.json({
        uploads,
        limits: {
            audioMaxBytes: AUDIO_UPLOAD_MAX_BYTES,
            videoMaxBytes: env.VIDEO_UPLOAD_MAX_BYTES,
        },
    });
});

export const POST = apiHandler(async (request: Request) => {
    assertNotOnAdminHost(request);
    const session = await requireApiSession(request);
    await assertNotOrgAccount(session.user.id);

    if (await isHostedLockedOut(session.user.id)) {
        throw new AppError(
            ErrorCode.ACCOUNT_LOCKED,
            "Your hosted plan has lapsed. Subscribe to resume uploads, or export your data.",
            403,
        );
    }

    const upload = readUploadMetadata(request);
    const ext = uploadExtension(upload.filename);

    if (!isSupportedUpload(upload.filename, upload.mimeType)) {
        throw new AppError(
            ErrorCode.INVALID_FILE_FORMAT,
            `Unsupported format. Upload a browser-recognized video or use one of these extensions: ${acceptedUploadExtensions()}`,
            400,
        );
    }

    const isVideo = shouldExtractVideo(upload.filename, upload.mimeType);
    const maxBytes = isVideo
        ? env.VIDEO_UPLOAD_MAX_BYTES
        : AUDIO_UPLOAD_MAX_BYTES;
    if (upload.size > maxBytes) {
        throw fileTooLarge(maxBytes);
    }

    // Storage cap: block the upload before reading the body when it would
    // push the user over their plan's storage limit. No-op on self-host.
    const cap = await enforceStorageCap({
        userId: session.user.id,
        additionalBytes: upload.size,
    });
    if (!cap.allowed) {
        throw new AppError(
            ErrorCode.STORAGE_QUOTA_EXCEEDED,
            "This upload would exceed your plan's storage limit. Upgrade or free up space to continue.",
            413,
        );
    }

    // readUploadMetadata rejected a request without a body.
    const body = request.body as ReadableStream<Uint8Array>;
    const storage = await createUserStorageProvider(session.user.id);
    const basename = path.basename(upload.filename, ext);

    if (isVideo) {
        // Checked again when the job is queued; this saves sending gigabytes
        // only to be turned away at the end.
        const active = await listJobsForUser(session.user.id, {
            kind: VIDEO_EXTRACTION_JOB_KIND,
            activeOnly: true,
            limit: 1,
        });
        if (active.length > 0) throw anotherVideoConverting();

        const uploadId = nanoid();
        const sourceStorageKey = `${session.user.id}/video-uploads/${uploadId}`;
        // Stream straight to storage: only the extracted audio is kept, and
        // the source can be several gigabytes.
        const source = streamUploadBody(body, upload.size);
        try {
            await storage.uploadStream(
                sourceStorageKey,
                source.stream,
                "application/octet-stream",
            );
        } catch (uploadError) {
            await deleteSource(storage, sourceStorageKey);
            throw source.error ?? uploadError;
        }

        try {
            const enqueued = await enqueueVideoExtractionJob({
                uploadId,
                sourceStorageKey,
                encryptedFilename: encryptText(upload.filename),
                sourceSize: source.bytes,
                userId: session.user.id,
            });
            if (!enqueued.created) throw anotherVideoConverting();
            return NextResponse.json(
                {
                    success: true,
                    filename: basename,
                    conversion: true,
                    jobId: enqueued.job.id,
                },
                { status: 202 },
            );
        } catch (queueError) {
            await deleteSource(storage, sourceStorageKey);
            throw queueError;
        }
    }

    const buffer = await readUploadBody(body, upload.size);

    const fileId = `uploaded-${nanoid()}`;
    await saveUploadedAudio({
        userId: session.user.id,
        fileId,
        basename,
        extension: ext,
        buffer,
        storage,
        sourceExtension: ext,
        convertedFromVideo: false,
    });

    return NextResponse.json({ success: true, filename: basename });
});
