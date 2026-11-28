import { randomBytes } from "node:crypto";
import {
    and,
    asc,
    desc,
    eq,
    exists,
    inArray,
    isNotNull,
    isNull,
    lt,
    or,
    sql,
} from "drizzle-orm";
import { db } from "@/db";
import { publishAgendaEventInTx } from "@/db/queries/agenda-events";
import {
    recordingCaptureKeys,
    recordingSessionChunks,
    recordingSessions,
    recordings,
} from "@/db/schema";
import { decrypt, encrypt } from "@/lib/encryption";
import { AppError, ErrorCode } from "@/lib/errors";
import { assertCategorizableFolderInput } from "@/lib/folders/folders";
import { meetingViewer, requireMeetingAccess } from "@/lib/meetings/access";
import { assertNotOrgAccount } from "@/lib/org/config";
import type { StorageProvider } from "@/lib/storage/types";
import { MAX_SESSION_BYTES } from "./constants";
import type { RecordingSessionMetadata } from "./metadata";
import { resolveSealedCaptureKey, type SealedCapture } from "./offline-key";

export type RecordingSessionRow = typeof recordingSessions.$inferSelect;
export type RecordingSessionChunkRow =
    typeof recordingSessionChunks.$inferSelect;
export type RecordingSessionStatus = RecordingSessionRow["status"];
const CAPTURE_KEY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
type CaptureKeyRow = typeof recordingCaptureKeys.$inferSelect;

type NewSession = {
    userId: string;
    apiKeyId: string;
    clientRecordingId: string;
    mimeType: string;
    metadata: RecordingSessionMetadata;
    startedAt: Date;
    noticeAcknowledgedAt: Date | null;
    folderId: string | null;
};

export async function createRecordingSession(input: NewSession) {
    const key = randomBytes(32).toString("base64");
    const expiresAt = new Date(Date.now() + CAPTURE_KEY_RETENTION_MS);
    const { session } = await openRecordingSession(input, expiresAt, key);
    return { session, key, expiresAt };
}

/** Reserve the client ID and open the sealed capture or return its current session. */
export function createSealedRecordingSession(
    input: NewSession,
    sealed: SealedCapture,
) {
    return openRecordingSession(
        input,
        new Date(Date.now() + CAPTURE_KEY_RETENTION_MS),
        null,
        sealed,
    );
}

function readSealedCapture(capture: CaptureKeyRow): SealedCapture | null {
    const { offlineKid, ephemeralPublicKey, offlineSalt } = capture;
    if (
        offlineKid === null ||
        ephemeralPublicKey === null ||
        offlineSalt === null
    )
        return null;
    return {
        protocol: 2,
        kid: offlineKid,
        ephemeralPublicKey,
        salt: offlineSalt,
    };
}

async function currentCaptureSession(
    executor: Pick<typeof db, "select">,
    capture: CaptureKeyRow,
    lock = false,
) {
    const sessionId = capture.activeSessionId;
    const query = executor
        .select()
        .from(recordingSessions)
        .where(
            and(
                capture.status === "completed"
                    ? eq(recordingSessions.status, "completed")
                    : capture.status === "discarded"
                      ? eq(recordingSessions.terminalCode, "user_discard")
                      : sessionId
                        ? eq(recordingSessions.id, sessionId)
                        : undefined,
                eq(recordingSessions.captureKeyId, capture.id),
                eq(recordingSessions.userId, capture.userId),
                eq(recordingSessions.apiKeyId, capture.apiKeyId),
            ),
        );
    const ordered = query.orderBy(
        desc(recordingSessions.createdAt),
        desc(recordingSessions.id),
    );
    const [session] = await (lock ? ordered.for("update") : ordered).limit(1);
    return session ?? null;
}

function usableCaptureKey(capture: CaptureKeyRow, now: Date) {
    return capture.status === "active" &&
        capture.encryptedKey &&
        capture.expiresAt > now
        ? capture.encryptedKey
        : null;
}

async function bindOpenSealedSession(
    executor: Pick<typeof db, "select" | "update">,
    capture: CaptureKeyRow,
    sessionId: string,
    sealed: SealedCapture,
) {
    const now = new Date();
    const key = usableCaptureKey(capture, now);
    if (key && capture.activeSessionId === sessionId) return;
    const encryptedKey =
        key ??
        encrypt(
            (
                await resolveSealedCaptureKey(
                    executor,
                    capture.userId,
                    capture.clientRecordingId,
                    sealed,
                )
            ).toString("base64"),
        );
    await executor
        .update(recordingCaptureKeys)
        .set({
            status: "active",
            activeSessionId: sessionId,
            encryptedKey,
            expiresAt: new Date(now.getTime() + CAPTURE_KEY_RETENTION_MS),
            updatedAt: now,
        })
        .where(
            and(
                eq(recordingCaptureKeys.id, capture.id),
                eq(recordingCaptureKeys.userId, capture.userId),
                eq(recordingCaptureKeys.apiKeyId, capture.apiKeyId),
            ),
        );
}

function sameSealedCapture(
    input: NewSession,
    sealed: SealedCapture,
    stored: SealedCapture,
    session: RecordingSessionRow,
) {
    return (
        stored.kid === sealed.kid &&
        stored.ephemeralPublicKey === sealed.ephemeralPublicKey &&
        stored.salt === sealed.salt &&
        session.startedAt.getTime() === input.startedAt.getTime() &&
        session.noticeAcknowledgedAt?.getTime() ===
            input.noticeAcknowledgedAt?.getTime() &&
        session.mimeType === input.mimeType &&
        JSON.stringify(session.metadata.channelLayout) ===
            JSON.stringify(input.metadata.channelLayout)
    );
}

function unavailableCaptureChoice(error: unknown) {
    return (
        error instanceof AppError &&
        [400, 403, 404, 409].includes(error.statusCode)
    );
}

async function openRecordingSession(
    input: NewSession,
    expiresAt: Date,
    legacyKey: string | null,
    sealed?: SealedCapture,
) {
    await assertNotOrgAccount(input.userId, {
        surface: "createRecordingSession",
    });
    const viewer =
        input.metadata.liveAgendaId || (sealed && input.folderId)
            ? await meetingViewer(input.userId)
            : undefined;
    return db.transaction(async (tx) => {
        const [capture] = await tx
            .insert(recordingCaptureKeys)
            .values({
                userId: input.userId,
                apiKeyId: input.apiKeyId,
                clientRecordingId: input.clientRecordingId,
                ...(legacyKey && { encryptedKey: encrypt(legacyKey) }),
                ...(sealed && {
                    offlineKid: sealed.kid,
                    ephemeralPublicKey: sealed.ephemeralPublicKey,
                    offlineSalt: sealed.salt,
                }),
                expiresAt,
            })
            .onConflictDoNothing()
            .returning();
        if (!capture) {
            if (sealed) {
                const [existing] = await tx
                    .select()
                    .from(recordingCaptureKeys)
                    .where(
                        and(
                            eq(recordingCaptureKeys.userId, input.userId),
                            eq(
                                recordingCaptureKeys.clientRecordingId,
                                input.clientRecordingId,
                            ),
                        ),
                    )
                    .for("update")
                    .limit(1);
                if (existing) {
                    const stored = readSealedCapture(existing);
                    if (stored) {
                        if (existing.apiKeyId !== input.apiKeyId)
                            throw new AppError(
                                ErrorCode.RECORDER_KEY_MISMATCH,
                                "Recorder key mismatch",
                                403,
                            );
                        const current = await currentCaptureSession(
                            tx,
                            existing,
                        );
                        if (
                            current &&
                            sameSealedCapture(input, sealed, stored, current)
                        ) {
                            if (current.status === "open")
                                await bindOpenSealedSession(
                                    tx,
                                    existing,
                                    current.id,
                                    stored,
                                );
                            return { session: current, replayed: true };
                        }
                    }
                }
            }
            throw new AppError(
                ErrorCode.CONFLICT,
                "This client recording ID has already been used",
                409,
            );
        }
        const encryptedSealedKey = sealed
            ? encrypt(
                  (
                      await resolveSealedCaptureKey(
                          tx,
                          input.userId,
                          input.clientRecordingId,
                          sealed,
                      )
                  ).toString("base64"),
              )
            : null;
        const folderId =
            sealed && input.folderId
                ? await assertCategorizableFolderInput(
                      input.userId,
                      input.folderId,
                      tx,
                      viewer?.curator,
                  )
                      .then((folder) => folder.folderId)
                      .catch((error: unknown) => {
                          if (unavailableCaptureChoice(error)) return null;
                          throw error;
                      })
                : input.folderId;
        const liveAgenda = input.metadata.liveAgendaId
            ? await requireMeetingAccess(
                  input.userId,
                  input.metadata.liveAgendaId,
                  "edit",
                  { viewer, executor: tx, lock: true },
              ).catch((error: unknown) => {
                  if (sealed && unavailableCaptureChoice(error)) return null;
                  throw error;
              })
            : null;
        const [row] = await tx
            .insert(recordingSessions)
            .values({
                userId: input.userId,
                apiKeyId: input.apiKeyId,
                clientRecordingId: input.clientRecordingId,
                captureKeyId: capture.id,
                mimeType: input.mimeType,
                metadata: {
                    ...input.metadata,
                    ...(input.metadata.liveAgendaId
                        ? { liveAgendaId: liveAgenda?.agenda.id ?? null }
                        : {}),
                },
                startedAt: input.startedAt,
                noticeAcknowledgedAt: input.noticeAcknowledgedAt,
                folderId,
            })
            .returning();
        if (!row) throw new Error("Recording session insert returned no row");
        await tx
            .update(recordingCaptureKeys)
            .set({
                activeSessionId: row.id,
                ...(encryptedSealedKey && { encryptedKey: encryptedSealedKey }),
            })
            .where(
                and(
                    eq(recordingCaptureKeys.id, capture.id),
                    eq(recordingCaptureKeys.userId, input.userId),
                ),
            );
        if (liveAgenda)
            await publishAgendaEventInTx(
                tx,
                liveAgenda.agenda.id,
                String(liveAgenda.agenda.version),
            );
        return { session: row, replayed: false };
    });
}

/** Change the live agenda only for an open session and its original recorder key. */
export async function setRecordingSessionAgenda(input: {
    userId: string;
    apiKeyId: string;
    sessionId: string;
    agendaId: string | null;
}): Promise<RecordingSessionRow> {
    // Check session ownership first while keeping agenda locks before session locks.
    const existing = await getRecordingSessionForUser(
        input.sessionId,
        input.userId,
    );
    if (!existing)
        throw new AppError(
            ErrorCode.NOT_FOUND,
            "Recording session not found",
            404,
        );
    if (existing.apiKeyId !== input.apiKeyId)
        throw new AppError(ErrorCode.FORBIDDEN, "Recorder key mismatch", 403);
    const viewer = input.agendaId
        ? await meetingViewer(input.userId)
        : undefined;
    return db.transaction(async (tx) => {
        const access = input.agendaId
            ? await requireMeetingAccess(input.userId, input.agendaId, "edit", {
                  viewer,
                  executor: tx,
                  lock: true,
              })
            : null;
        const [session] = await tx
            .select()
            .from(recordingSessions)
            .where(
                and(
                    eq(recordingSessions.id, input.sessionId),
                    eq(recordingSessions.userId, input.userId),
                ),
            )
            .for("update");
        if (!session)
            throw new AppError(
                ErrorCode.NOT_FOUND,
                "Recording session not found",
                404,
            );
        if (session.apiKeyId !== input.apiKeyId)
            throw new AppError(
                ErrorCode.FORBIDDEN,
                "Recorder key mismatch",
                403,
            );
        if (session.status !== "open")
            throw new AppError(
                ErrorCode.CONFLICT,
                "Recording session is no longer open",
                409,
            );
        const [updated] = await tx
            .update(recordingSessions)
            .set({
                metadata: {
                    ...session.metadata,
                    liveAgendaId: access?.agenda.id ?? null,
                },
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(recordingSessions.id, session.id),
                    eq(recordingSessions.userId, input.userId),
                ),
            )
            .returning();
        for (const agendaId of new Set([
            session.metadata.liveAgendaId,
            access?.agenda.id,
        ]))
            if (typeof agendaId === "string")
                await publishAgendaEventInTx(tx, agendaId, "0");
        return updated;
    });
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

/** Check whether an owned session uses the sealed upload protocol. */
export async function isSealedRecordingSession(session: RecordingSessionRow) {
    const [capture] = await db
        .select({ id: recordingCaptureKeys.id })
        .from(recordingCaptureKeys)
        .where(
            and(
                eq(recordingCaptureKeys.id, session.captureKeyId),
                eq(recordingCaptureKeys.userId, session.userId),
                eq(recordingCaptureKeys.apiKeyId, session.apiKeyId),
                isNotNull(recordingCaptureKeys.offlineKid),
            ),
        )
        .limit(1);
    return Boolean(capture);
}

/** Replace a swept or failed server session while keeping its capture key. */
export async function replaceRecordingSession(input: {
    userId: string;
    apiKeyId: string;
    sessionId: string;
}) {
    await assertNotOrgAccount(input.userId, {
        surface: "replaceRecordingSession",
        sessionId: input.sessionId,
    });
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
            .for("update")
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
        const sealed = capture ? readSealedCapture(capture) : null;
        const now = new Date();
        if (!capture || (!sealed && !usableCaptureKey(capture, now))) {
            throw new AppError(
                ErrorCode.CONFLICT,
                "Capture key has expired or been retired",
                410,
            );
        }
        const current = sealed
            ? await currentCaptureSession(tx, capture)
            : null;
        if (sealed && current?.status === "open") {
            await bindOpenSealedSession(tx, capture, current.id, sealed);
            return { session: current, sealed };
        }
        if (
            current &&
            (current.id !== old.id ||
                capture.status === "completed" ||
                capture.status === "discarded" ||
                old.status === "completed" ||
                old.terminalCode === "user_discard")
        ) {
            return { session: current, sealed };
        }
        if (
            (sealed ? current?.id : capture.activeSessionId) !== old.id ||
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
                leaseRevision: old.leaseRevision,
                leaseEndedAt: old.leaseEndedAt,
            })
            .returning();
        if (!replacement)
            throw new Error("Replacement session insert returned no row");
        if (sealed)
            await bindOpenSealedSession(tx, capture, replacement.id, sealed);
        else
            await tx
                .update(recordingCaptureKeys)
                .set({ activeSessionId: replacement.id, updatedAt: now })
                .where(
                    and(
                        eq(recordingCaptureKeys.id, capture.id),
                        eq(recordingCaptureKeys.userId, input.userId),
                        eq(recordingCaptureKeys.apiKeyId, input.apiKeyId),
                    ),
                );
        return { session: replacement, sealed };
    });
}

/** Retire the current sealed session even when the caller knows only a historical session ID. */
export async function discardSealedRecordingCapture(input: {
    userId: string;
    apiKeyId: string;
    sessionId: string;
}) {
    const { userId, apiKeyId, sessionId } = input;
    const requested = await getRecordingSessionForUser(sessionId, userId);
    if (!requested)
        throw new AppError(
            ErrorCode.NOT_FOUND,
            "Recording session not found",
            404,
        );
    if (requested.apiKeyId !== apiKeyId)
        throw new AppError(
            ErrorCode.RECORDER_KEY_MISMATCH,
            "Recorder key mismatch",
            403,
        );

    const captureScope = and(
        eq(recordingCaptureKeys.id, requested.captureKeyId),
        eq(recordingCaptureKeys.userId, userId),
        eq(recordingCaptureKeys.apiKeyId, apiKeyId),
        isNotNull(recordingCaptureKeys.offlineKid),
    );
    for (;;) {
        const result = await db.transaction(async (tx) => {
            const [snapshot] = await tx
                .select()
                .from(recordingCaptureKeys)
                .where(captureScope)
                .limit(1);
            if (!snapshot)
                throw new AppError(
                    ErrorCode.NOT_FOUND,
                    "Sealed recording capture not found",
                    404,
                );
            // Lock the candidate session first to keep the same lock order as recovery and completion.
            const candidate = await currentCaptureSession(tx, snapshot, true);
            const [capture] = await tx
                .select()
                .from(recordingCaptureKeys)
                .where(captureScope)
                .for("update")
                .limit(1);
            if (!capture)
                throw new AppError(
                    ErrorCode.NOT_FOUND,
                    "Sealed recording capture not found",
                    404,
                );
            const current = await currentCaptureSession(tx, capture);
            if (!current)
                throw new AppError(
                    ErrorCode.NOT_FOUND,
                    "Recording session not found",
                    404,
                );
            if (candidate?.id !== current.id) return null;
            if (current.status === "completed")
                return { sessionId: current.id, purge: false };
            if (current.status === "completing")
                throw new AppError(
                    ErrorCode.CONFLICT,
                    "Cannot abort a session that is completing",
                    409,
                );

            if (current.terminalCode !== "user_discard") {
                await tx
                    .update(recordingSessions)
                    .set({
                        status: "aborted",
                        liveRoomKey: null,
                        liveUntil: null,
                        terminalCode: "user_discard",
                        lastError: "Aborted by client",
                        updatedAt: new Date(),
                    })
                    .where(
                        and(
                            eq(recordingSessions.id, current.id),
                            eq(recordingSessions.userId, userId),
                            eq(recordingSessions.apiKeyId, apiKeyId),
                        ),
                    );
                if (typeof current.metadata.liveAgendaId === "string")
                    await publishAgendaEventInTx(
                        tx,
                        current.metadata.liveAgendaId,
                        "0",
                    );
            }
            await tx
                .update(recordingCaptureKeys)
                .set({
                    status: "discarded",
                    encryptedKey: null,
                    activeSessionId: current.id,
                    updatedAt: new Date(),
                })
                .where(captureScope);
            return { sessionId: current.id, purge: true };
        });
        if (result) return result;
    }
}

const sealedSessionPointer = sql`case when ${recordingCaptureKeys.offlineKid} is not null then ${recordingCaptureKeys.activeSessionId} else null end`;

/** Irreversibly retire a capture when its owner discards it. */
export async function retireRecordingCaptureKey(input: {
    userId: string;
    captureKeyId: string;
    sessionId: string;
}): Promise<void> {
    await db
        .update(recordingCaptureKeys)
        .set({
            status: "discarded",
            encryptedKey: null,
            activeSessionId: sealedSessionPointer,
            updatedAt: new Date(),
        })
        .where(
            and(
                eq(recordingCaptureKeys.id, input.captureKeyId),
                eq(recordingCaptureKeys.userId, input.userId),
                or(
                    isNull(recordingCaptureKeys.offlineKid),
                    eq(recordingCaptureKeys.activeSessionId, input.sessionId),
                ),
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
                activeSessionId: sealedSessionPointer,
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
    ownerUserId?: string,
): Promise<RecordingSessionChunkRow[]> {
    return db
        .select()
        .from(recordingSessionChunks)
        .where(
            and(
                eq(recordingSessionChunks.sessionId, sessionId),
                ownedChunkSession(sessionId, ownerUserId),
            ),
        )
        .orderBy(asc(recordingSessionChunks.index));
}

function ownedChunkSession(sessionId: string, ownerUserId?: string) {
    if (ownerUserId === undefined) return undefined;
    return exists(
        db
            .select({ id: recordingSessions.id })
            .from(recordingSessions)
            .where(
                and(
                    eq(recordingSessions.id, sessionId),
                    eq(recordingSessions.userId, ownerUserId),
                ),
            ),
    );
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
    folderId?: string | null;
    truncatedAtChunk: number | null;
    agendaId?: string | null;
}): Promise<RecordingSessionRow | null> {
    const viewer = input.agendaId ? await meetingViewer(input.userId) : null;
    return db.transaction(async (tx) => {
        let agendaAvailable = false;
        if (input.agendaId && viewer) {
            try {
                await requireMeetingAccess(
                    input.userId,
                    input.agendaId,
                    "edit",
                    { viewer, executor: tx, lock: true },
                );
                agendaAvailable = true;
            } catch (error) {
                if (
                    !(error instanceof AppError) ||
                    ![403, 404, 409].includes(error.statusCode)
                )
                    throw error;
            }
        }
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
                ...(input.folderId !== undefined
                    ? { folderId: input.folderId }
                    : {}),
                ...(input.agendaId !== undefined
                    ? {
                          metadata: sql`(${recordingSessions.metadata} - 'agendaId' - 'agendaOutcome') || ${JSON.stringify(
                              input.agendaId === null
                                  ? { agendaId: null }
                                  : {
                                        ...(agendaAvailable
                                            ? { agendaId: input.agendaId }
                                            : {}),
                                        agendaOutcome: agendaAvailable
                                            ? { attached: true }
                                            : {
                                                  attached: false,
                                                  reason: "unavailable",
                                              },
                                    },
                          )}::jsonb`,
                      }
                    : {}),
                status: "completing",
                liveRoomKey: null,
                liveUntil: null,
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
        if (typeof row?.metadata?.liveAgendaId === "string")
            await publishAgendaEventInTx(tx, row.metadata.liveAgendaId, "0");
        return row ?? null;
    });
}

export async function setRecordingSessionJob(
    sessionId: string,
    userId: string,
    jobId: string,
): Promise<void> {
    await db
        .update(recordingSessions)
        .set({ jobId, updatedAt: new Date() })
        .where(
            and(
                eq(recordingSessions.id, sessionId),
                eq(recordingSessions.userId, userId),
            ),
        );
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
            .returning({
                captureKeyId: recordingSessions.captureKeyId,
                metadata: recordingSessions.metadata,
            });
        if (!session) return false;
        if (typeof session.metadata?.liveAgendaId === "string")
            await publishAgendaEventInTx(
                tx,
                session.metadata.liveAgendaId,
                "0",
            );
        await tx
            .update(recordingCaptureKeys)
            .set({
                status: "completed",
                encryptedKey: null,
                activeSessionId: sealedSessionPointer,
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
            liveRoomKey: null,
            liveUntil: null,
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
        .returning({
            id: recordingSessions.id,
            metadata: recordingSessions.metadata,
        });
    for (const row of rows)
        if (typeof row.metadata?.liveAgendaId === "string")
            await publishAgendaEventInTx(db, row.metadata.liveAgendaId, "0");
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
            liveRoomKey: null,
            liveUntil: null,
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
    ownerUserId?: string,
): Promise<void> {
    await db
        .delete(recordingSessionChunks)
        .where(
            and(
                eq(recordingSessionChunks.sessionId, sessionId),
                ownedChunkSession(sessionId, ownerUserId),
            ),
        );
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
    ownerUserId?: string,
): Promise<number> {
    const chunks = await listRecordingSessionChunks(sessionId, ownerUserId);
    await deleteRecordingSessionChunkFiles(storage, chunks);
    await deleteRecordingSessionChunkRows(sessionId, ownerUserId);
    return chunks.length;
}
