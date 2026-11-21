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
    StorageObjectMissingError,
    StorageRangeNotSatisfiableError,
} from "@/lib/storage/errors";
import { createUserStorageProvider } from "@/lib/storage/factory";
import type { ByteRange } from "@/lib/storage/types";
import { getAudioMimeType } from "@/lib/utils";

type IdContext = { params: Promise<{ id: string }> };

const SINGLE_BYTE_RANGE = /^bytes=(\d*)-(\d*)$/i;

type RequestedRange =
    | { start: bigint; end: bigint | null }
    | { suffixLength: number };

function parseRange(header: string | null): RequestedRange | null {
    const match = header?.match(SINGLE_BYTE_RANGE);
    if (!match) return null;

    const [, startText, endText] = match;
    if (startText === "") {
        return endText === "" ? null : { suffixLength: Number(endText) };
    }

    const start = BigInt(startText);
    const end = endText === "" ? null : BigInt(endText);
    return end !== null && end < start ? null : { start, end };
}

function resolveRange(range: RequestedRange, size: number): ByteRange | null {
    if ("suffixLength" in range) {
        if (range.suffixLength === 0)
            throw new StorageRangeNotSatisfiableError(size);
        if (size === 0) return null;
        const length = Math.min(range.suffixLength, size);
        return { start: size - length, end: size - 1 };
    }

    if (range.start >= size) throw new StorageRangeNotSatisfiableError(size);
    const start = Number(range.start);
    const requestedEnd = range.end === null ? size - 1 : Number(range.end);
    return {
        start,
        end: Math.min(requestedEnd, size - 1),
    };
}

export const GET = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);

    const { id } = await (context as IdContext).params;
    const { ownerUserId } = await requireRecordingAccess(session.user.id, id);

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

    try {
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
            const size = await storage.getObjectSize(storagePath);
            headers.set("Content-Length", String(size));
            return new NextResponse(null, { headers });
        }

        // The route has no HTTP validator to match against If-Range.
        const requestedRange =
            wantsDownload || request.headers.has("if-range")
                ? null
                : parseRange(request.headers.get("range"));
        if (requestedRange) {
            const size = await storage.getObjectSize(storagePath);
            const range = resolveRange(requestedRange, size);
            if (range) {
                const { data, totalSize } = await storage.downloadRange(
                    storagePath,
                    range,
                );
                const end = range.start + data.length - 1;
                headers.set("Content-Length", String(data.length));
                headers.set(
                    "Content-Range",
                    `bytes ${range.start}-${end}/${totalSize}`,
                );
                return new NextResponse(data, {
                    status: 206,
                    headers,
                });
            }
        }

        const data = await storage.downloadFile(storagePath);
        headers.set("Content-Length", String(data.length));
        return new NextResponse(new Uint8Array(data), { headers });
    } catch (error) {
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
