import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { enforceStorageCap } from "@/lib/hosted/billing/storage-cap";
import {
    MAX_CHUNK_BYTES,
    MAX_SESSION_BYTES,
} from "@/lib/recording-sessions/constants";
import {
    parseChunkIndex,
    parseSha256,
} from "@/lib/recording-sessions/metadata";
import { gateRecordingSessionRequest } from "@/lib/recording-sessions/route-gate";
import { recordingSessionChunkKey } from "@/lib/recording-sessions/storage-keys";
import {
    getRecordingSessionForUser,
    insertRecordingSessionChunk,
    sumRecordingSessionBytes,
    touchRecordingSession,
} from "@/lib/recording-sessions/store";
import { createUserStorageProvider } from "@/lib/storage/factory";

type ChunkContext = { params: Promise<{ id: string; index: string }> };

/**
 * `PUT /api/v1/recording-sessions/{id}/chunks/{index}` — upload one chunk.
 *
 * The body is the raw chunk bytes. `X-Chunk-SHA256` must match, and the
 * write is idempotent: re-sending an index that already holds the same
 * bytes succeeds without storing twice, while a different-hash collision
 * on a committed index is a conflict.
 */
export const PUT = apiHandler<ChunkContext>(async (request, context) => {
    const gate = await gateRecordingSessionRequest(request);
    if (gate.response) return gate.response;
    const { authn } = gate;
    const { id, index: indexRaw } = await (context as ChunkContext).params;

    const index = parseChunkIndex(indexRaw);
    const expectedSha = parseSha256(request.headers.get("x-chunk-sha256"));

    const session = await getRecordingSessionForUser(id, authn.user.id);
    if (!session) {
        throw new AppError(
            ErrorCode.NOT_FOUND,
            "Recording session not found",
            404,
        );
    }
    if (session.status !== "open") {
        throw new AppError(
            ErrorCode.CONFLICT,
            `Cannot upload chunks to a session that is ${session.status}`,
            409,
        );
    }

    const body = await request.arrayBuffer();
    const buffer = Buffer.from(body);
    if (buffer.length === 0) {
        throw new AppError(ErrorCode.INVALID_INPUT, "Chunk body is empty", 400);
    }
    if (buffer.length > MAX_CHUNK_BYTES) {
        throw new AppError(
            ErrorCode.FILE_TOO_LARGE,
            `Chunk exceeds the ${MAX_CHUNK_BYTES} byte limit`,
            413,
        );
    }

    const actualSha = createHash("sha256").update(buffer).digest("hex");
    if (actualSha !== expectedSha) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Chunk body does not match the X-Chunk-SHA256 header",
            400,
            { field: "X-Chunk-SHA256" },
        );
    }

    // Running total guard, before writing this chunk's bytes.
    const alreadyStored = await sumRecordingSessionBytes(session.id);
    if (alreadyStored + buffer.length > MAX_SESSION_BYTES) {
        throw new AppError(
            ErrorCode.FILE_TOO_LARGE,
            `Recording exceeds the ${MAX_SESSION_BYTES} byte session limit`,
            413,
        );
    }

    // Hosted storage cap, same gate as the whole-file upload route.
    const cap = await enforceStorageCap({
        userId: authn.user.id,
        additionalBytes: buffer.length,
    });
    if (!cap.allowed) {
        throw new AppError(
            ErrorCode.STORAGE_QUOTA_EXCEEDED,
            "This recording would exceed your plan's storage limit. Upgrade or free up space to continue.",
            413,
        );
    }

    const storageKey = recordingSessionChunkKey(
        authn.user.id,
        session.id,
        index,
        actualSha,
    );
    const storage = await createUserStorageProvider(authn.user.id);
    await storage.uploadFile(storageKey, buffer, session.mimeType);

    const { inserted, row } = await insertRecordingSessionChunk({
        sessionId: session.id,
        index,
        size: buffer.length,
        sha256: actualSha,
        storageKey,
    });

    if (!inserted) {
        if (row.sha256 !== actualSha) {
            // A different body already occupies this index. Drop the file we
            // just wrote (its key differs, so it did not overwrite) and tell
            // the client its numbering conflicts.
            try {
                await storage.deleteFile(storageKey);
            } catch (error) {
                console.error(
                    `[recording-sessions] could not clean up conflicting chunk ${storageKey}:`,
                    error,
                );
            }
            throw new AppError(
                ErrorCode.CONFLICT,
                `Chunk ${index} already exists with different content`,
                409,
            );
        }
        // Benign duplicate: same bytes re-sent after a retry. The file we
        // just wrote has the same key as the committed one, so nothing to
        // clean up.
    }

    await touchRecordingSession(session.id);

    return NextResponse.json(
        { index, size: buffer.length, sha256: actualSha, duplicate: !inserted },
        { status: inserted ? 201 : 200 },
    );
});
