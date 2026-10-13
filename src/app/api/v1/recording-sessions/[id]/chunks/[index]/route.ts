import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { enforceStorageCap } from "@/lib/hosted/billing/storage-cap";
import {
    CHUNK_ENVELOPE_OVERHEAD,
    decryptRecorderChunk,
} from "@/lib/recording-sessions/chunk-crypto";
import { MAX_CHUNK_BYTES } from "@/lib/recording-sessions/constants";
import {
    parseChunkIndex,
    parseSha256,
} from "@/lib/recording-sessions/metadata";
import { gateRecordingSessionRequest } from "@/lib/recording-sessions/route-gate";
import { recordingSessionChunkKey } from "@/lib/recording-sessions/storage-keys";
import {
    getRecordingCaptureKey,
    getRecordingSessionChunk,
    getRecordingSessionForUser,
    insertRecordingSessionChunk,
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
    if (session.apiKeyId !== authn.apiKeyId) {
        throw new AppError(ErrorCode.FORBIDDEN, "Recorder key mismatch", 403);
    }

    const reader = request.body?.getReader();
    if (!reader) {
        throw new AppError(ErrorCode.INVALID_INPUT, "Chunk body is empty", 400);
    }
    const parts: Buffer[] = [];
    let inputBytes = 0;
    for (;;) {
        const result = await reader.read();
        if (result.done) break;
        inputBytes += result.value.byteLength;
        if (inputBytes > MAX_CHUNK_BYTES + CHUNK_ENVELOPE_OVERHEAD) {
            await reader.cancel();
            throw new AppError(
                ErrorCode.FILE_TOO_LARGE,
                `Chunk exceeds the ${MAX_CHUNK_BYTES} byte limit`,
                413,
            );
        }
        parts.push(Buffer.from(result.value));
    }
    const buffer = Buffer.concat(parts, inputBytes);
    if (buffer.length === 0) {
        throw new AppError(ErrorCode.INVALID_INPUT, "Chunk body is empty", 400);
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

    const key = await getRecordingCaptureKey({
        userId: authn.user.id,
        apiKeyId: authn.apiKeyId,
        session,
    });
    if (!key) {
        throw new AppError(
            ErrorCode.CONFLICT,
            "Recording encryption key has expired or been retired",
            410,
        );
    }
    let plaintext: Buffer;
    try {
        plaintext = decryptRecorderChunk({
            envelope: buffer,
            key,
            clientRecordingId: session.clientRecordingId,
            index,
        });
    } catch {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Encrypted chunk authentication failed",
            422,
        );
    }
    if (plaintext.length > MAX_CHUNK_BYTES) {
        throw new AppError(ErrorCode.FILE_TOO_LARGE, "Chunk too large", 413);
    }
    const plaintextSha = createHash("sha256").update(plaintext).digest("hex");
    const prior = await getRecordingSessionChunk(session.id, index);
    if (prior) {
        if (prior.sha256 !== plaintextSha) {
            throw new AppError(
                ErrorCode.CONFLICT,
                `Chunk ${index} already exists with different content`,
                409,
            );
        }
        await touchRecordingSession(
            session.id,
            authn.user.id,
            session.captureKeyId,
        );
        return NextResponse.json(
            { index, size: prior.size, sha256: prior.sha256, duplicate: true },
            { status: 200 },
        );
    }

    // Hosted storage cap, same gate as the whole-file upload route.
    const cap = await enforceStorageCap({
        userId: authn.user.id,
        additionalBytes: plaintext.length,
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
        plaintextSha,
    );
    const storage = await createUserStorageProvider(authn.user.id);
    await storage.uploadFile(storageKey, plaintext, session.mimeType);

    let committed: Awaited<ReturnType<typeof insertRecordingSessionChunk>>;
    try {
        committed = await insertRecordingSessionChunk({
            sessionId: session.id,
            userId: authn.user.id,
            index,
            size: plaintext.length,
            sha256: plaintextSha,
            storageKey,
        });
    } catch (error) {
        const existing = await getRecordingSessionChunk(session.id, index);
        if (existing?.storageKey !== storageKey) {
            await storage
                .deleteFile(storageKey)
                .catch((cleanupError) =>
                    console.error(
                        "Could not remove uncommitted recorder chunk:",
                        cleanupError,
                    ),
                );
        }
        throw error;
    }
    const { inserted, row } = committed;

    if (!inserted) {
        if (row.sha256 !== plaintextSha) {
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

    await touchRecordingSession(
        session.id,
        authn.user.id,
        session.captureKeyId,
    );

    return NextResponse.json(
        {
            index,
            size: plaintext.length,
            sha256: plaintextSha,
            duplicate: !inserted,
        },
        { status: inserted ? 201 : 200 },
    );
});
