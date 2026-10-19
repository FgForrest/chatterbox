import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import {
    recordingCaptureKeys,
    recordingSessionChunks,
    recordingSessions,
    recordings,
} from "@/db/schema";
import { decrypt, encrypt } from "@/lib/encryption";
import { AppError, ErrorCode } from "@/lib/errors";
import { assertNotOrgAccount } from "@/lib/org/config";
import type { StorageProvider } from "@/lib/storage/types";
import { MAX_SESSION_BYTES } from "./constants";
import type { RecordingSessionMetadata } from "./metadata";

export type RecordingSessionRow = typeof recordingSessions.$inferSelect;
export type RecordingSessionChunkRow =
    typeof recordingSessionChunks.$inferSelect;
export type RecordingSessionStatus = RecordingSessionRow["status"];
const CAPTURE_KEY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export async function createRecordingSession(input: {
    userId: string;
    apiKeyId: string;
    clientRecordingId: string;
    mimeType: string;
    metadata: RecordingSessionMetadata;
    startedAt: Date;
    noticeAcknowledgedAt: Date | null;
    folderId: string | null;
}): Promise<{ session: RecordingSessionRow; key: string; expiresAt: Date }> {
    await assertNotOrgAccount(input.userId);
    const key = randomBytes(32).toString("base64");
    const expiresAt = new Date(Date.now() + CAPTURE_KEY_RETENTION_MS);
    const session = await db.transaction(async (tx) => {
        const [capture] = await tx
            .insert(recordingCaptureKeys)
            .values({
                userId: input.userId,
                apiKeyId: input.apiKeyId,
                clientRecordingId: input.clientRecordingId,
                encryptedKey: encrypt(key),
                expiresAt,
            })
            .onConflictDoNothing()
            .returning();
        if (!capture) {
            throw new AppError(
                ErrorCode.CONFLICT,
                "This client recording ID has already been used",
                409,
            );
        }
        const [row] = await tx
            .insert(recordingSessions)
            .values({
                userId: input.userId,
                apiKeyId: input.apiKeyId,
                clientRecordingId: input.clientRecordingId,
                captureKeyId: capture.id,
                mimeType: input.mimeType,
                metadata: { ...input.metadata },
                startedAt: input.startedAt,
                noticeAcknowledgedAt: input.noticeAcknowledgedAt,
                folderId: input.folderId,
            })
            .returning();
        if (!row) throw new Error("Recording session insert returned no row");
        await tx
            .update(recordingCaptureKeys)
            .set({ activeSessionId: row.id })
            .where(
                and(
                    eq(recordingCaptureKeys.id, capture.id),
                    eq(recordingCaptureKeys.userId, input.userId),
                ),
            );
        return row;
    });
    return { session, key, expiresAt };
}

/** Resolve only the active capture's key for its original recorder credential. */
export async function getRecordingCaptureKey(input: {
    userId: string;
    apiKeyId: string;
    session: RecordingSessionRow;
}): Promise<Buffer | null> {
    const [capture] = await db
        .select()
        .from(recordingCaptureKeys)
        .where(
            and(
                eq(recordingCaptureKeys.id, input.session.captureKeyId),
                eq(recordingCaptureKeys.userId, input.userId),
                eq(recordingCaptureKeys.apiKeyId, input.apiKeyId),
                eq(recordingCaptureKeys.status, "active"),
                eq(recordingCaptureKeys.activeSessionId, input.session.id),
            ),
        )
        .limit(1);
    if (!capture?.encryptedKey || capture.expiresAt <= new Date()) return null;
    return Buffer.from(decrypt(capture.encryptedKey), "base64");
}

/** Replace a swept or failed server session while keeping its capture key. */
export async function replaceRecordingSession(input: {
    userId: string;
    apiKeyId: string;
    sessionId: string;
}): Promise<RecordingSessionRow> {
    await assertNotOrgAccount(input.userId);
    return db.transaction(async (tx) => {
        const [old] = await tx
            .select()
            .from(recordingSessions)
            .where(
                and(
                    eq(recordingSessions.id, input.sessionId),
                    eq(recordingSessions.userId, input.userId),
                    eq(recordingSessions.apiKeyId, input.apiKeyId),
                ),
            )
            .limit(1);
        if (!old)
            throw new AppError(
                ErrorCode.NOT_FOUND,
                "Recording session not found",
                404,
            );
        const [capture] = await tx
            .select()
            .from(recordingCaptureKeys)
            .where(
                and(
                    eq(recordingCaptureKeys.id, old.captureKeyId),
                    eq(recordingCaptureKeys.userId, input.userId),
                    eq(recordingCaptureKeys.apiKeyId, input.apiKeyId),
                ),
            )
            .for("update")
            .limit(1);
        if (
            !capture ||
            capture.status !== "active" ||
            !capture.encryptedKey ||
            capture.expiresAt <= new Date()
        ) {
            throw new AppError(
                ErrorCode.CONFLICT,
                "Capture key has expired or been retired",
                410,
            );
        }
        if (
            capture.activeSessionId !== old.id ||
            (old.status !== "failed" &&
                !(
                    old.status === "aborted" &&
                    (old.terminalCode === "stale_open" ||
                        old.terminalCode === "failed_expired")
                ))
        ) {
            throw new AppError(
                ErrorCode.CONFLICT,
                "This capture cannot be resumed",
                409,
            );
        }
        const [replacement] = await tx
            .insert(recordingSessions)
            .values({
                userId: old.userId,
                apiKeyId: old.apiKeyId,
                clientRecordingId: old.clientRecordingId,
                captureKeyId: old.captureKeyId,
                mimeType: old.mimeType,
                metadata: old.metadata,
                startedAt: old.startedAt,
                noticeAcknowledgedAt: old.noticeAcknowledgedAt,
                folderId: old.folderId,
            })
            .returning();
        if (!replacement)
            throw new Error("Replacement session insert returned no row");
        await tx
            .update(recordingCaptureKeys)
            .set({ activeSessionId: replacement.id, updatedAt: new Date() })
            .where(
                and(
                    eq(recordingCaptureKeys.id, capture.id),
                    eq(recordingCaptureKeys.userId, input.userId),
                ),
            );
        return replacement;
    });
}

/** Irreversibly retire a capture when its owner discards it. */
export async function retireRecordingCaptureKey(input: {
    userId: string;
    captureKeyId: string;
}): Promise<void> {
    await db
        .update(recordingCaptureKeys)
        .set({
            status: "discarded",
            encryptedKey: null,
            activeSessionId: null,
            updatedAt: new Date(),
        })
        .where(
            and(
                eq(recordingCaptureKeys.id, input.captureKeyId),
                eq(recordingCaptureKeys.userId, input.userId),
            ),
        );
}

/** Remove expired key material while keeping a replay tombstone. */
export async function expireRecordingCaptureKeys(
    limit: number,
): Promise<number> {
    const expired = await db
        .select({
            id: recordingCaptureKeys.id,
            userId: recordingCaptureKeys.userId,
        })
        .from(recordingCaptureKeys)
        .where(
            and(
                eq(recordingCaptureKeys.status, "active"),
                lt(recordingCaptureKeys.expiresAt, new Date()),
            ),
        )
        .limit(limit);
    for (const capture of expired) {
        await db
            .update(recordingCaptureKeys)
            .set({
                status: "expired",
                encryptedKey: null,
                activeSessionId: null,
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(recordingCaptureKeys.id, capture.id),
                    eq(recordingCaptureKeys.userId, capture.userId),
                    eq(recordingCaptureKeys.status, "active"),
                    lt(recordingCaptureKeys.expiresAt, new Date()),
                ),
            );
    }
    return expired.length;
}

/** One session by id, scoped to its owner so an id alone grants nothing. */
export async function getRecordingSessionForUser(
    sessionId: string,
    userId: string,
): Promise<RecordingSessionRow | null> {
    const [row] = await db
        .select()
        .from(recordingSessions)
        .where(
            and(
                eq(recordingSessions.id, sessionId),
                eq(recordingSessions.userId, userId),
            ),
        )
        .limit(1);
    return row ?? null;
}

/** Find the one recording produced by a capture, including a replacement session. */
export async function getRecordingForCapture(
    userId: string,
    clientRecordingId: string,
): Promise<{
    recordingId: string;
    durationMs: number;
    filesize: number;
} | null> {
    const [row] = await db
        .select({
            recordingId: recordings.id,
            durationMs: recordings.duration,
            filesize: recordings.filesize,
        })
        .from(recordings)
        .where(
            and(
                eq(recordings.userId, userId),
                eq(recordings.plaudFileId, `meeting-${clientRecordingId}`),
            ),
        )
        .limit(1);
    return row ?? null;
}

export async function listRecordingSessionsForUser(
    userId: string,
    apiKeyId: string,
    opts: { limit: number; status?: RecordingSessionStatus },
): Promise<RecordingSessionRow[]> {
    const conditions = [
        eq(recordingSessions.userId, userId),
        eq(recordingSessions.apiKeyId, apiKeyId),
    ];
    if (opts.status) conditions.push(eq(recordingSessions.status, opts.status));
    return db
        .select()
        .from(recordingSessions)
        .where(and(...conditions))
        .orderBy(desc(recordingSessions.createdAt))
        .limit(opts.limit);
}

export async function listRecordingSessionChunks(
    sessionId: string,
): Promise<RecordingSessionChunkRow[]> {
    return db
        .select()
        .from(recordingSessionChunks)
        .where(eq(recordingSessionChunks.sessionId, sessionId))
        .orderBy(asc(recordingSessionChunks.index));
}

export async function getRecordingSessionChunk(
    sessionId: string,
    index: number,
): Promise<RecordingSessionChunkRow | null> {
    const [row] = await db
        .select()
        .from(recordingSessionChunks)
        .where(
            and(
                eq(recordingSessionChunks.sessionId, sessionId),
                eq(recordingSessionChunks.index, index),
            ),
        )
        .limit(1);
    return row ?? null;
}

/**
 * Record a chunk. Returns the committed row for this index, which is the
 * new one when the insert won and the pre-existing one when it did not --
 * the caller compares hashes to tell a benign duplicate from a conflict.
 */
export async function insertRecordingSessionChunk(input: {
    sessionId: string;
    userId: string;
    index: number;
    size: number;
    sha256: string;
    storageKey: string;
}): Promise<{ inserted: boolean; row: RecordingSessionChunkRow }> {
    return db.transaction(async (tx) => {
        const [session] = await tx
            .select({ status: recordingSessions.status })
            .from(recordingSessions)
            .where(
                and(
                    eq(recordingSessions.id, input.sessionId),
                    eq(recordingSessions.userId, input.userId),
                ),
            )
            .for("update")
            .limit(1);
        if (!session || session.status !== "open") {
            throw new AppError(
                ErrorCode.CONFLICT,
                "Recording session is no longer open",
                409,
            );
        }
        const [existing] = await tx
            .select()
            .from(recordingSessionChunks)
            .where(
                and(
                    eq(recordingSessionChunks.sessionId, input.sessionId),
                    eq(recordingSessionChunks.index, input.index),
                ),
            )
            .limit(1);
        if (existing) return { inserted: false, row: existing };
        const [total] = await tx
            .select({
                value: sql<number>`coalesce(sum(${recordingSessionChunks.size}), 0)::bigint`,
            })
            .from(recordingSessionChunks)
            .where(eq(recordingSessionChunks.sessionId, input.sessionId));
        if (Number(total?.value ?? 0) + input.size > MAX_SESSION_BYTES) {
            throw new AppError(
                ErrorCode.FILE_TOO_LARGE,
                "Recording exceeds the session limit",
                413,
            );
        }
        const [inserted] = await tx
            .insert(recordingSessionChunks)
            .values({
                sessionId: input.sessionId,
                index: input.index,
                size: input.size,
                sha256: input.sha256,
                storageKey: input.storageKey,
            })
            .returning();
        if (!inserted) throw new Error("Chunk insert returned no row");
        return { inserted: true, row: inserted };
    });
}

/** Touch `updated_at` so the sweeper knows the session is alive. */
export async function touchRecordingSession(
    sessionId: string,
    userId: string,
    captureKeyId: string,
): Promise<void> {
    const now = new Date();
    await db
        .update(recordingSessions)
        .set({ updatedAt: now })
        .where(
            and(
                eq(recordingSessions.id, sessionId),
                eq(recordingSessions.userId, userId),
            ),
        );
    await db
        .update(recordingCaptureKeys)
        .set({
            expiresAt: new Date(now.getTime() + CAPTURE_KEY_RETENTION_MS),
            updatedAt: now,
        })
        .where(
            and(
                eq(recordingCaptureKeys.id, captureKeyId),
                eq(recordingCaptureKeys.activeSessionId, sessionId),
                eq(recordingCaptureKeys.userId, userId),
                eq(recordingCaptureKeys.status, "active"),
            ),
        );
}

/**
 * Move an `open` session to `completing`. Returns null when the session was
 * not open, which the route reports as a conflict rather than racing a
 * second finalize.
 */
export async function markRecordingSessionCompleting(input: {
    sessionId: string;
    userId: string;
    endedAt: Date;
    stopReason: string;
    expectedChunkCount: number;
    truncatedAtChunk: number | null;
}): Promise<RecordingSessionRow | null> {
    return db.transaction(async (tx) => {
        const [session] = await tx
            .select({ status: recordingSessions.status })
            .from(recordingSessions)
            .where(
                and(
                    eq(recordingSessions.id, input.sessionId),
                    eq(recordingSessions.userId, input.userId),
                ),
            )
            .for("update")
            .limit(1);
        if (!session || session.status !== "open") return null;
        const chunks = await tx
            .select({ index: recordingSessionChunks.index })
            .from(recordingSessionChunks)
            .where(eq(recordingSessionChunks.sessionId, input.sessionId))
            .orderBy(asc(recordingSessionChunks.index));
        const prefix = chunks.filter(
            (chunk) => chunk.index < input.expectedChunkCount,
        );
        if (
            prefix.length !== input.expectedChunkCount ||
            prefix.some((chunk, index) => chunk.index !== index) ||
            (!input.truncatedAtChunk &&
                chunks.length !== input.expectedChunkCount)
        ) {
            throw new AppError(
                ErrorCode.INVALID_INPUT,
                "Recording chunks changed while completing; retry with current server state",
                422,
            );
        }
        const [row] = await tx
            .update(recordingSessions)
            .set({
                status: "completing",
                endedAt: input.endedAt,
                stopReason: input.stopReason,
                expectedChunkCount: input.expectedChunkCount,
                truncatedAtChunk: input.truncatedAtChunk,
                lastError: null,
                terminalCode: null,
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(recordingSessions.id, input.sessionId),
                    eq(recordingSessions.userId, input.userId),
                    eq(recordingSessions.status, "open"),
                ),
            )
            .returning();
        return row ?? null;
    });
}

export async function setRecordingSessionJob(
    sessionId: string,
    jobId: string,
): Promise<void> {
    await db
        .update(recordingSessions)
        .set({ jobId, updatedAt: new Date() })
        .where(eq(recordingSessions.id, sessionId));
}

export async function markRecordingSessionCompleted(
    sessionId: string,
    userId: string,
    recordingId: string,
): Promise<boolean> {
    return db.transaction(async (tx) => {
        const [session] = await tx
            .update(recordingSessions)
            .set({
                status: "completed",
                recordingId,
                lastError: null,
                terminalCode: null,
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(recordingSessions.id, sessionId),
                    eq(recordingSessions.userId, userId),
                    eq(recordingSessions.status, "completing"),
                ),
            )
            .returning({ captureKeyId: recordingSessions.captureKeyId });
        if (!session) return false;
        await tx
            .update(recordingCaptureKeys)
            .set({
                status: "completed",
                encryptedKey: null,
                activeSessionId: null,
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(recordingCaptureKeys.id, session.captureKeyId),
                    eq(recordingCaptureKeys.userId, userId),
                ),
            );
        return true;
    });
}

export async function markRecordingSessionFailed(
    sessionId: string,
    userId: string,
    message: string,
): Promise<void> {
    await db
        .update(recordingSessions)
        .set({
            status: "failed",
            lastError: message,
            terminalCode: "finalize_failed",
            updatedAt: new Date(),
        })
        .where(
            and(
                eq(recordingSessions.id, sessionId),
                eq(recordingSessions.userId, userId),
                eq(recordingSessions.status, "completing"),
            ),
        );
}

/**
 * Abort a session from `open` or `failed`. Returns false if the session was
 * already finalizing or finished, which must not be undone from the client.
 */
export async function markRecordingSessionAborted(
    sessionId: string,
    userId: string,
    code: "user_discard" | "stale_open",
    reason: string | null,
): Promise<boolean> {
    const rows = await db
        .update(recordingSessions)
        .set({
            status: "aborted",
            terminalCode: code,
            ...(reason ? { lastError: reason } : {}),
            updatedAt: new Date(),
        })
        .where(
            and(
                eq(recordingSessions.id, sessionId),
                eq(recordingSessions.userId, userId),
                inArray(recordingSessions.status, ["open", "failed"]),
            ),
        )
        .returning({ id: recordingSessions.id });
    return rows.length > 0;
}

/** Retire a failed session after its recovery chunks have been purged. */
export async function markFailedRecordingSessionPurged(
    sessionId: string,
    userId: string,
): Promise<void> {
    await db
        .update(recordingSessions)
        .set({
            status: "aborted",
            terminalCode: "failed_expired",
            updatedAt: new Date(),
        })
        .where(
            and(
                eq(recordingSessions.id, sessionId),
                eq(recordingSessions.userId, userId),
                eq(recordingSessions.status, "failed"),
            ),
        );
}

export async function deleteRecordingSessionChunkRows(
    sessionId: string,
): Promise<void> {
    await db
        .delete(recordingSessionChunks)
        .where(eq(recordingSessionChunks.sessionId, sessionId));
}

export async function listStaleRecordingSessions(
    status: RecordingSessionStatus,
    olderThan: Date,
    limit: number,
): Promise<RecordingSessionRow[]> {
    return db
        .select()
        .from(recordingSessions)
        .where(
            and(
                eq(recordingSessions.status, status),
                lt(recordingSessions.updatedAt, olderThan),
            ),
        )
        .orderBy(asc(recordingSessions.updatedAt))
        .limit(limit);
}

/**
 * Best-effort removal of a session's chunk files. A file that will not
 * delete is logged, not thrown: the rows are the source of truth for what
 * exists, and an orphaned object costs storage, not correctness.
 */
export async function deleteRecordingSessionChunkFiles(
    storage: StorageProvider,
    chunks: Pick<RecordingSessionChunkRow, "storageKey">[],
): Promise<void> {
    for (const chunk of chunks) {
        try {
            if (await storage.exists(chunk.storageKey)) {
                await storage.deleteFile(chunk.storageKey);
            }
        } catch (error) {
            console.error(
                `[recording-sessions] could not delete chunk ${chunk.storageKey}:`,
                error,
            );
        }
    }
}

/** Delete every chunk file and row of a session. */
export async function purgeRecordingSessionChunks(
    storage: StorageProvider,
    sessionId: string,
): Promise<number> {
    const chunks = await listRecordingSessionChunks(sessionId);
    await deleteRecordingSessionChunkFiles(storage, chunks);
    await deleteRecordingSessionChunkRows(sessionId);
    return chunks.length;
}
