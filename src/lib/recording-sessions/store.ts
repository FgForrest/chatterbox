import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { recordingSessionChunks, recordingSessions } from "@/db/schema";
import type { StorageProvider } from "@/lib/storage/types";
import type { RecordingSessionMetadata } from "./metadata";

export type RecordingSessionRow = typeof recordingSessions.$inferSelect;
export type RecordingSessionChunkRow =
    typeof recordingSessionChunks.$inferSelect;
export type RecordingSessionStatus = RecordingSessionRow["status"];

export async function createRecordingSession(input: {
    userId: string;
    mimeType: string;
    metadata: RecordingSessionMetadata;
    startedAt: Date;
    noticeAcknowledgedAt: Date | null;
}): Promise<RecordingSessionRow> {
    const [row] = await db
        .insert(recordingSessions)
        .values({
            userId: input.userId,
            mimeType: input.mimeType,
            metadata: { ...input.metadata },
            startedAt: input.startedAt,
            noticeAcknowledgedAt: input.noticeAcknowledgedAt,
        })
        .returning();
    if (!row) throw new Error("Recording session insert returned no row");
    return row;
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

export async function listRecordingSessionsForUser(
    userId: string,
    opts: { limit: number; status?: RecordingSessionStatus },
): Promise<RecordingSessionRow[]> {
    const conditions = [eq(recordingSessions.userId, userId)];
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

export async function sumRecordingSessionBytes(
    sessionId: string,
): Promise<number> {
    const [row] = await db
        .select({
            total: sql<number>`coalesce(sum(${recordingSessionChunks.size}), 0)::bigint`,
        })
        .from(recordingSessionChunks)
        .where(eq(recordingSessionChunks.sessionId, sessionId));
    return Number(row?.total ?? 0);
}

/**
 * Record a chunk. Returns the committed row for this index, which is the
 * new one when the insert won and the pre-existing one when it did not --
 * the caller compares hashes to tell a benign duplicate from a conflict.
 */
export async function insertRecordingSessionChunk(input: {
    sessionId: string;
    index: number;
    size: number;
    sha256: string;
    storageKey: string;
}): Promise<{ inserted: boolean; row: RecordingSessionChunkRow }> {
    const [inserted] = await db
        .insert(recordingSessionChunks)
        .values(input)
        .onConflictDoNothing()
        .returning();
    if (inserted) return { inserted: true, row: inserted };
    const existing = await getRecordingSessionChunk(
        input.sessionId,
        input.index,
    );
    if (!existing) {
        throw new Error(
            `Chunk ${input.index} of session ${input.sessionId} vanished between insert and read`,
        );
    }
    return { inserted: false, row: existing };
}

/** Touch `updated_at` so the sweeper knows the session is alive. */
export async function touchRecordingSession(sessionId: string): Promise<void> {
    await db
        .update(recordingSessions)
        .set({ updatedAt: new Date() })
        .where(eq(recordingSessions.id, sessionId));
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
}): Promise<RecordingSessionRow | null> {
    const [row] = await db
        .update(recordingSessions)
        .set({
            status: "completing",
            endedAt: input.endedAt,
            stopReason: input.stopReason,
            expectedChunkCount: input.expectedChunkCount,
            lastError: null,
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
    recordingId: string,
): Promise<void> {
    await db
        .update(recordingSessions)
        .set({
            status: "completed",
            recordingId,
            lastError: null,
            updatedAt: new Date(),
        })
        .where(eq(recordingSessions.id, sessionId));
}

export async function markRecordingSessionFailed(
    sessionId: string,
    message: string,
): Promise<void> {
    await db
        .update(recordingSessions)
        .set({ status: "failed", lastError: message, updatedAt: new Date() })
        .where(eq(recordingSessions.id, sessionId));
}

/**
 * Abort a session from `open` or `failed`. Returns false if the session was
 * already finalizing or finished, which must not be undone from the client.
 */
export async function markRecordingSessionAborted(
    sessionId: string,
    reason: string | null,
): Promise<boolean> {
    const rows = await db
        .update(recordingSessions)
        .set({
            status: "aborted",
            ...(reason ? { lastError: reason } : {}),
            updatedAt: new Date(),
        })
        .where(
            and(
                eq(recordingSessions.id, sessionId),
                inArray(recordingSessions.status, ["open", "failed"]),
            ),
        )
        .returning({ id: recordingSessions.id });
    return rows.length > 0;
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
