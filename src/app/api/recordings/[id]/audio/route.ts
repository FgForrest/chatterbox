import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { audioItemColumns, recordingItemJoin } from "@/db/items";
import { chatterItems, recordings } from "@/db/schema";
import { requireApiSession } from "@/lib/auth-server";
import { decryptText } from "@/lib/encryption/fields";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import {
    buildDownloadFilename,
    contentDispositionAttachment,
    isAudioDownloadRequest,
} from "@/lib/recordings/filename";
import { requireRecordingAccess } from "@/lib/sharing/access";
import {
    isRequestAbort,
    StorageObjectMissingError,
    StorageRangeNotSatisfiableError,
} from "@/lib/storage/errors";
import { createUserStorageProvider } from "@/lib/storage/factory";
import type { RequestedByteRange } from "@/lib/storage/types";
import { getAudioMimeType } from "@/lib/utils";

type IdContext = { params: Promise<{ id: string }> };

const SINGLE_BYTE_RANGE = /^bytes=(\d*)-(\d*)$/i;

function parseRange(header: string | null): RequestedByteRange | null {
    const match = header?.match(SINGLE_BYTE_RANGE);
    if (!match) return null;

    const [, startText, endText] = match;
    if (startText === "") {
        return endText === "" ? null : { suffixLength: BigInt(endText) };
    }

    const start = BigInt(startText);
    const end = endText === "" ? null : BigInt(endText);
    return end !== null && end < start ? null : { start, end };
}

export const GET = apiHandler<IdContext>(async (request, context) => {
    try {
        const session = await requireApiSession(request);

        const { id } = await (context as IdContext).params;
        const { ownerUserId } = await requireRecordingAccess(
            session.user.id,
            id,
        );

        const [recording] = await db
            .select(audioItemColumns)
            .from(recordings)
            .innerJoin(chatterItems, recordingItemJoin)
            .where(
                and(
                    eq(recordings.id, id),
                    eq(recordings.userId, ownerUserId),
                    isNull(recordings.deletedAt),
                ),
            )
            .limit(1);

        if (!recording) {
            throw new AppError(
                ErrorCode.RECORDING_NOT_FOUND,
                "Recording not found",
                404,
            );
        }

        if (recording.audioReapedAt) {
            throw new AppError(
                ErrorCode.RECORDING_DATA_REAPED,
                "Audio was removed by your retention policy",
                410,
            );
        }

        const storage = await createUserStorageProvider(ownerUserId);
        const { storagePath } = recording;
        const wantsDownload = isAudioDownloadRequest(request);

        const headers = new Headers({
            "Content-Type": getAudioMimeType(storagePath),
            "Accept-Ranges": "bytes",
            "X-Audio-Md5": recording.fileMd5,
            "X-Recording-Cut-At": recording.cutAt?.toISOString() ?? "",
            "Cache-Control": wantsDownload
                ? "private, no-store"
                : "private, max-age=31536000, immutable",
        });
        if (wantsDownload) {
            const filename =
                recording.storageFilename ??
                buildDownloadFilename(
                    decryptText(recording.title),
                    storagePath,
                );
            headers.set(
                "Content-Disposition",
                contentDispositionAttachment(filename),
            );
        }
        if (request.method === "HEAD") {
            const size = await storage.getObjectSize(
                storagePath,
                request.signal,
            );
            headers.set("Content-Length", String(size));
            return new NextResponse(null, { headers });
        }

        // The route has no HTTP validator to match against If-Range.
        const requestedRange =
            wantsDownload || request.headers.has("if-range")
                ? null
                : parseRange(request.headers.get("range"));
        const { body, totalSize, range } = await storage.openRead(
            storagePath,
            requestedRange,
            request.signal,
        );
        if (range) {
            headers.set("Content-Length", String(range.end - range.start + 1));
            headers.set(
                "Content-Range",
                `bytes ${range.start}-${range.end}/${totalSize}`,
            );
            return new NextResponse(body, { status: 206, headers });
        }

        if (totalSize !== null)
            headers.set("Content-Length", String(totalSize));
        return new NextResponse(body, { headers });
    } catch (error) {
        if (isRequestAbort(error, request.signal)) {
            return new NextResponse(null, { status: 499 });
        }
        if (error instanceof StorageRangeNotSatisfiableError) {
            return new NextResponse(null, {
                status: 416,
                headers: {
                    "Content-Range": `bytes */${error.totalSize}`,
                    "Cache-Control": "private, no-store",
                },
            });
        }
        if (error instanceof StorageObjectMissingError) {
            throw new AppError(
                ErrorCode.RECORDING_NOT_FOUND,
                "Recording audio not found",
                404,
            );
        }
        throw error;
    }
});

export const HEAD = GET;
