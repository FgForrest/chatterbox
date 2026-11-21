import { createHash } from "node:crypto";
import { and, eq, isNull, ne, notInArray, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/db";
import { insertAudioItem, recordingItemJoin } from "@/db/items";
import {
    aiEnhancements,
    chatterItems,
    plaudConnections,
    recordings,
    transcriptions,
    userSettings,
    users,
} from "@/db/schema";
import { generateIngestWaveform } from "@/lib/audio/ingest-waveform";
import { sniffAudio } from "@/lib/audio/sniff";
import { userCuratesOrganizationNow } from "@/lib/authz/curator";
import { encryptText } from "@/lib/encryption/fields";
import { isHostedLockedOut } from "@/lib/entitlements";
import { env } from "@/lib/env";
import { AppError, ErrorCode } from "@/lib/errors";
import { exportRecordingSidecarsIfEnabled } from "@/lib/export/document-sidecars";
import { enforceStorageCap } from "@/lib/hosted/billing/storage-cap";
import { type AppLocale, normalizeLocale } from "@/lib/i18n/config";
import { audioReplacedInTx } from "@/lib/knowledge/transcript-rewrite";
import { sendNewRecordingBarkNotification } from "@/lib/notifications/bark";
import { sendNewRecordingEmail } from "@/lib/notifications/email";
import { requestArrivalInTx } from "@/lib/pipeline/arrival";
import { PlaudTokenRejection } from "@/lib/plaud/client";
import { createPlaudClient } from "@/lib/plaud/client-factory";
import {
    findInlineContent,
    isReady,
    parseSummary,
    parseTranscript,
    segmentsToTurns,
    selectContentItems,
} from "@/lib/plaud/content";
import { markPlaudConnectionInvalidated } from "@/lib/plaud/persist-connection";
import {
    captureServerEvent,
    captureServerException,
} from "@/lib/posthog-server";
import { buildRecordingStagingPath } from "@/lib/recordings/filename";
import { enqueueStorageReconciliationJob } from "@/lib/recordings/storage-reconciliation-job";
import { createUserStorageProvider } from "@/lib/storage/factory";
import {
    upsertEnhancement,
    upsertTranscription,
} from "@/lib/transcription/persist";
import { emitEvent } from "@/lib/webhooks/emit";
import type { PlaudRecording } from "@/types/plaud";

const SYNC_CONFIG = {
    PAGE_SIZE: 50,
    BATCH_CONCURRENCY: 5,
    MAX_PAGES: 20,
} as const;

interface SyncResult {
    newRecordings: number;
    updatedRecordings: number;
    errors: string[];
    /**
     * Set when sync ended at one of the expected-state early returns
     * (no connection yet, suspended, hosted lockout) rather than an
     * operational failure. `errors` still carries the user-facing
     * message for the client, but these aren't bugs -- the caller uses
     * this to skip exception capture for them.
     */
    skipped?: "no_connection" | "suspended" | "locked_out";
    /** True when this call coalesced into an already-running in-process sync. */
    inProgress?: boolean;
    /**
     * True when Plaud rejected the stored token (HTTP 401) during this sync,
     * so the user must reconnect. Surfaced to the client so the dashboard can
     * show a reconnect banner.
     */
    needsReconnect?: boolean;
    errorCode?: ErrorCode;
}

// Per-user in-flight dedup within one process. Cross-process correctness
// is enforced by `enforcePlaudSyncRateLimit` at the route boundary.
const inFlightSyncs = new Map<string, Promise<SyncResult>>();

interface SyncContext {
    userId: string;
    /** Master opt-in: import Plaud's native transcript/summary on sync (#204). */
    importPlaudContent: boolean;
    emailNotifications: boolean;
    barkNotifications: boolean;
    notificationEmail: string | null;
    locale: AppLocale | null;
    barkPushUrl: string | null;
}

/** A freshly-synced recording that Plaud may hold transcript/summary content
 * for. Collected during the sync loop and drained by the import pass. */
interface ImportCandidate {
    recordingId: string;
    plaudFileId: string;
    isTrans: boolean;
    isSummary: boolean;
    /** Recording length in milliseconds, per `PlaudRecording.duration`. */
    durationMs: number;
    transcriptSuppressed: boolean;
    summarySuppressed: boolean;
    /** The audio Plaud listed with it, which its transcript is made from. */
    audioMd5: string | null;
}

async function storagePathHeldByOtherRecording(
    userId: string,
    storagePath: string,
    exceptRecordingId: string,
): Promise<boolean> {
    const [other] = await db
        .select({ id: recordings.id })
        .from(recordings)
        .where(
            and(
                eq(recordings.userId, userId),
                eq(recordings.storagePath, storagePath),
                ne(recordings.id, exceptRecordingId),
            ),
        )
        .limit(1);
    return Boolean(other);
}

async function resolveStorageKey(
    userId: string,
    existingRecording: { id: string; storagePath: string | null } | undefined,
    fileExtension: string,
    recordingId: string,
): Promise<string> {
    if (existingRecording?.storagePath) {
        const shared = await storagePathHeldByOtherRecording(
            userId,
            existingRecording.storagePath,
            existingRecording.id,
        );
        if (!shared) return existingRecording.storagePath;
    }
    return buildRecordingStagingPath(userId, recordingId, fileExtension);
}

async function queueStorageReconciliation(
    userId: string,
    recordingId: string,
): Promise<void> {
    try {
        await enqueueStorageReconciliationJob({ userId, recordingId });
    } catch (error) {
        console.error(
            `Could not queue storage filename reconciliation for recording ${recordingId}:`,
            error,
        );
    }
}

/**
 * Build an import candidate for a freshly-synced recording, or `undefined`
 * when there's nothing to import — the recording is trashed, or Plaud reports
 * neither a transcript (`is_trans`) nor a summary (`is_summary`).
 */
function buildImportCandidate(
    recordingId: string,
    plaudRecording: PlaudRecording,
    suppression?: {
        contentReapedAt: Date | null;
        summaryReapedAt: Date | null;
    },
): ImportCandidate | undefined {
    if (plaudRecording.is_trash) return undefined;
    if (!plaudRecording.is_trans && !plaudRecording.is_summary) {
        return undefined;
    }
    return {
        recordingId,
        plaudFileId: plaudRecording.id,
        isTrans: plaudRecording.is_trans,
        isSummary: plaudRecording.is_summary,
        durationMs: plaudRecording.duration,
        transcriptSuppressed: suppression?.contentReapedAt != null,
        summarySuppressed: suppression?.summaryReapedAt != null,
        audioMd5: plaudRecording.file_md5 ?? null,
    };
}

async function loadPlaudContentGaps(
    { userId }: Pick<SyncContext, "userId">,
    recordingId: string,
    flags: {
        isTrans: boolean;
        isSummary: boolean;
        transcriptSuppressed?: boolean;
        summarySuppressed?: boolean;
    },
): Promise<{
    needsTranscript: boolean;
    needsSummary: boolean;
    hasPlaudTranscript: boolean;
}> {
    let needsTranscript = false;
    let hasPlaudTranscript = false;
    if (flags.isTrans && !flags.transcriptSuppressed) {
        const [existing] = await db
            .select({ id: transcriptions.id })
            .from(transcriptions)
            .where(
                and(
                    eq(transcriptions.recordingId, recordingId),
                    eq(transcriptions.userId, userId),
                    eq(transcriptions.source, "plaud"),
                ),
            )
            .limit(1);
        if (existing) hasPlaudTranscript = true;
        else needsTranscript = true;
    }

    let needsSummary = false;
    if (flags.isSummary && !flags.summarySuppressed) {
        const [existing] = await db
            .select({ id: aiEnhancements.id })
            .from(aiEnhancements)
            .where(
                and(
                    eq(aiEnhancements.itemId, recordingId),
                    eq(aiEnhancements.userId, userId),
                    eq(aiEnhancements.source, "plaud"),
                ),
            )
            .limit(1);
        if (!existing) needsSummary = true;
    }

    return { needsTranscript, needsSummary, hasPlaudTranscript };
}

async function hasUnseenPlaudContentGaps(
    userId: string,
    seenRecordingIds: Set<string>,
): Promise<boolean> {
    const conditions = [
        eq(recordings.userId, userId),
        isNull(recordings.deletedAt),
        isNull(recordings.cutAt),
        ne(recordings.deviceSn, "local"),
        or(
            and(
                isNull(transcriptions.id),
                isNull(chatterItems.contentReapedAt),
            ),
            and(
                isNull(aiEnhancements.id),
                isNull(chatterItems.summaryReapedAt),
            ),
        ),
    ];
    if (seenRecordingIds.size > 0) {
        conditions.push(notInArray(recordings.id, [...seenRecordingIds]));
    }

    const [row] = await db
        .select({ id: recordings.id })
        .from(recordings)
        .innerJoin(chatterItems, recordingItemJoin)
        .leftJoin(
            transcriptions,
            and(
                eq(transcriptions.recordingId, recordings.id),
                eq(transcriptions.userId, userId),
                eq(transcriptions.source, "plaud"),
            ),
        )
        .leftJoin(
            aiEnhancements,
            and(
                eq(aiEnhancements.itemId, recordings.id),
                eq(aiEnhancements.userId, userId),
                eq(aiEnhancements.source, "plaud"),
            ),
        )
        .where(and(...conditions))
        .limit(1);

    return Boolean(row);
}

interface CapState {
    blocked: boolean;
    pendingBytes: number;
    lastCheck: Promise<unknown>;
}

function reserveStorageBytes(
    capState: CapState,
    userId: string,
    bytes: number,
): Promise<boolean> {
    const check = capState.lastCheck.then(async () => {
        if (capState.blocked) return false;
        capState.pendingBytes += bytes;
        let allowed = false;
        try {
            const cap = await enforceStorageCap({
                userId,
                additionalBytes: capState.pendingBytes,
            });
            allowed = cap.allowed;
            capState.blocked = !allowed;
            return allowed;
        } finally {
            if (!allowed) capState.pendingBytes -= bytes;
        }
    });
    capState.lastCheck = check.catch(() => undefined);
    return check;
}

async function processRecording(
    listedRecording: PlaudRecording,
    context: SyncContext,
    plaudClient: Awaited<ReturnType<typeof createPlaudClient>>,
    storage: Awaited<ReturnType<typeof createUserStorageProvider>>,
    capState: CapState,
    seenRecordingIds: Set<string>,
): Promise<{
    status: "new" | "updated" | "skipped" | "error";
    recordingId?: string;
    filename?: string;
    error?: string;
    importCandidate?: ImportCandidate;
    capExceeded?: boolean;
}> {
    let plaudRecording = listedRecording;
    let reservedBytes = 0;
    try {
        const [existing] = await db
            .select({
                recording: recordings,
                contentReapedAt: chatterItems.contentReapedAt,
                summaryReapedAt: chatterItems.summaryReapedAt,
            })
            .from(recordings)
            .innerJoin(chatterItems, recordingItemJoin)
            .where(
                and(
                    eq(recordings.plaudFileId, plaudRecording.id),
                    eq(recordings.userId, context.userId),
                ),
            )
            .limit(1);
        const existingRecording = existing?.recording;

        if (existingRecording) seenRecordingIds.add(existingRecording.id);
        const recordingId = existingRecording?.id ?? nanoid();

        const listedVersion = plaudRecording.version_ms;
        const versionKey = listedVersion.toString();
        const storedVersion = Number(existingRecording?.plaudVersion);
        if (storedVersion > listedVersion) return { status: "skipped" };

        if (existingRecording?.cutAt) return { status: "skipped" };

        // An explicitly erased audio blob stays erased even when Plaud's
        // metadata version changes. The user can restore it from the erase
        // menu; background sync must never silently recreate deleted data.
        if (existingRecording?.audioReapedAt) {
            if (context.importPlaudContent && !existingRecording.deletedAt) {
                const importCandidate = buildImportCandidate(
                    existingRecording.id,
                    plaudRecording,
                    existing,
                );
                if (importCandidate) {
                    const gaps = await loadPlaudContentGaps(
                        context,
                        existingRecording.id,
                        {
                            isTrans: importCandidate.isTrans,
                            isSummary: importCandidate.isSummary,
                            transcriptSuppressed:
                                importCandidate.transcriptSuppressed,
                            summarySuppressed:
                                importCandidate.summarySuppressed,
                        },
                    );
                    if (gaps.needsTranscript || gaps.needsSummary) {
                        return {
                            status: "skipped",
                            recordingId: existingRecording.id,
                            importCandidate,
                        };
                    }
                }
            }
            return { status: "skipped" };
        }

        if (
            existingRecording &&
            (existingRecording.plaudVersion === versionKey ||
                storedVersion === listedVersion)
        ) {
            if (context.importPlaudContent && !existingRecording.deletedAt) {
                const importCandidate = buildImportCandidate(
                    existingRecording.id,
                    plaudRecording,
                    existing,
                );
                if (importCandidate) {
                    const gaps = await loadPlaudContentGaps(
                        context,
                        existingRecording.id,
                        {
                            isTrans: importCandidate.isTrans,
                            isSummary: importCandidate.isSummary,
                            transcriptSuppressed:
                                importCandidate.transcriptSuppressed,
                            summarySuppressed:
                                importCandidate.summarySuppressed,
                        },
                    );
                    if (gaps.needsTranscript || gaps.needsSummary) {
                        return {
                            status: "skipped",
                            recordingId: existingRecording.id,
                            importCandidate,
                        };
                    }
                }
            }
            return { status: "skipped" };
        }

        // Tombstone: suppress resurrection of user-deleted recordings (#56).
        if (existingRecording?.deletedAt) {
            return { status: "skipped" };
        }

        if (!existingRecording && capState.blocked) {
            return { status: "skipped", capExceeded: true };
        }

        const isV4 = plaudRecording.source === "v4";
        if (isV4) {
            plaudRecording = await plaudClient.hydrateRecording(plaudRecording);
        }

        if (!existingRecording && plaudRecording.filesize > 0) {
            const bytes = plaudRecording.filesize;
            if (!(await reserveStorageBytes(capState, context.userId, bytes))) {
                return { status: "skipped", capExceeded: true };
            }
            reservedBytes = bytes;
        }

        const audioBuffer = await plaudClient.downloadRecording(
            plaudRecording.id,
            false,
        );

        if (isV4 || !plaudRecording.filesize) {
            const extraBytes = audioBuffer.length - reservedBytes;
            if (!existingRecording && extraBytes > 0) {
                if (
                    !(await reserveStorageBytes(
                        capState,
                        context.userId,
                        extraBytes,
                    ))
                ) {
                    return { status: "skipped", capExceeded: true };
                }
                reservedBytes += extraBytes;
            }
            plaudRecording = {
                ...plaudRecording,
                filesize: audioBuffer.length,
                file_md5: isV4
                    ? createHash("md5").update(audioBuffer).digest("hex")
                    : plaudRecording.file_md5,
            };
        }

        const sniffed = sniffAudio(audioBuffer);
        const fileExtension = sniffed.extension;
        const storageKey = await resolveStorageKey(
            context.userId,
            existingRecording,
            fileExtension,
            recordingId,
        );
        const contentType = sniffed.contentType;
        // A new version written over the audio a recording already serves
        // is written only under its lock, once the recording is known to be
        // still its owner's to change: a share landing during the download
        // must not have its audio replaced. A fresh key serves nobody yet.
        const overwrites =
            existingRecording !== undefined &&
            storageKey === existingRecording.storagePath;
        const [waveformPeaks] = await Promise.all([
            generateIngestWaveform(audioBuffer),
            overwrites
                ? Promise.resolve()
                : storage.uploadFile(storageKey, audioBuffer, contentType),
        ]);

        const recordingData = {
            userId: context.userId,
            deviceSn: plaudRecording.serial_number,
            plaudFileId: plaudRecording.id,
            duration: plaudRecording.duration,
            endTime: new Date(plaudRecording.end_time),
            filesize: plaudRecording.filesize,
            fileMd5: plaudRecording.file_md5,
            storageType: env.DEFAULT_STORAGE_TYPE,
            storagePath: storageKey,
            waveformPeaks,
            downloadedAt: new Date(),
            plaudVersion: versionKey,
            timezone: plaudRecording.timezone,
            zonemins: plaudRecording.zonemins,
            scene: plaudRecording.scene,
            isTrash: plaudRecording.is_trash,
            // The blob was just (re-)uploaded, so any retention marker on
            // this recording is stale. Reached only when Plaud reports a
            // new version -- the skip above returns early otherwise, which
            // is what stops sync from quietly re-downloading everything a
            // retention sweep has reaped.
            audioReapedAt: null,
        };
        const title = encryptText(plaudRecording.filename);
        const occurredAt = new Date(plaudRecording.start_time);

        if (existingRecording) {
            // Re-check under FOR UPDATE: a concurrent DELETE may have
            // tombstoned the row during the download/upload above.
            const update = await db.transaction(async (tx) => {
                const [locked] = await tx
                    .select({
                        deletedAt: recordings.deletedAt,
                        cutAt: recordings.cutAt,
                        audioReapedAt: recordings.audioReapedAt,
                        storagePath: recordings.storagePath,
                        titleEditedAt: chatterItems.titleEditedAt,
                        fileMd5: recordings.fileMd5,
                        plaudVersion: recordings.plaudVersion,
                        occurredAt: chatterItems.occurredAt,
                        endTime: recordings.endTime,
                        duration: recordings.duration,
                        deviceSn: recordings.deviceSn,
                        timezone: recordings.timezone,
                        zonemins: recordings.zonemins,
                        scene: recordings.scene,
                    })
                    .from(recordings)
                    .innerJoin(chatterItems, recordingItemJoin)
                    .where(
                        and(
                            eq(recordings.id, existingRecording.id),
                            eq(recordings.userId, context.userId),
                        ),
                    )
                    .for("update")
                    .limit(1);

                if (
                    !locked ||
                    locked.deletedAt ||
                    locked.cutAt ||
                    locked.audioReapedAt ||
                    Number(locked.plaudVersion) >= listedVersion
                ) {
                    return {
                        updated: false,
                        discardStagedAudio:
                            !overwrites && locked?.storagePath !== storageKey,
                    };
                }
                if (overwrites) {
                    await storage.uploadFile(
                        storageKey,
                        audioBuffer,
                        contentType,
                    );
                }

                // A title a person set is kept over Plaud's filename. Read
                // under the lock, so a rename committed during the download
                // above still wins.
                const now = new Date();
                const start =
                    isV4 && !plaudRecording.v4HasStartTime
                        ? locked.occurredAt
                        : occurredAt;
                const duration =
                    isV4 && !plaudRecording.v4HasDuration
                        ? locked.duration
                        : recordingData.duration;
                await tx
                    .update(recordings)
                    .set({
                        ...recordingData,
                        ...(isV4 && {
                            duration,
                            endTime:
                                plaudRecording.v4HasStartTime ||
                                plaudRecording.v4HasDuration
                                    ? new Date(start.getTime() + duration)
                                    : locked.endTime,
                            deviceSn:
                                plaudRecording.serial_number || locked.deviceSn,
                            timezone: plaudRecording.timezone_iana
                                ? plaudRecording.timezone
                                : locked.timezone,
                            zonemins: plaudRecording.timezone_iana
                                ? plaudRecording.zonemins
                                : locked.zonemins,
                            scene: locked.scene,
                        }),
                        updatedAt: now,
                    })
                    .where(
                        and(
                            eq(recordings.id, existingRecording.id),
                            eq(recordings.userId, context.userId),
                        ),
                    );
                await tx
                    .update(chatterItems)
                    .set({
                        ...(locked.titleEditedAt ||
                        (isV4 && !plaudRecording.filename.trim())
                            ? {}
                            : { title }),
                        occurredAt: start,
                        updatedAt: now,
                    })
                    .where(
                        and(
                            eq(chatterItems.id, existingRecording.id),
                            eq(chatterItems.userId, context.userId),
                        ),
                    );
                // The transcripts it keeps were made from the old audio.
                await audioReplacedInTx(tx, existingRecording.id, {
                    from: locked.fileMd5,
                    to: plaudRecording.file_md5,
                });
                return { updated: true, discardStagedAudio: false };
            });

            if (!update.updated) {
                // Best-effort cleanup of the orphaned blob, when one was
                // written beside the recording's audio.
                try {
                    if (update.discardStagedAudio)
                        await storage.deleteFile(storageKey);
                } catch (cleanupError) {
                    console.error(
                        `Failed to clean up orphaned storage object ${storageKey} after concurrent delete:`,
                        cleanupError,
                    );
                }
                return { status: "skipped" };
            }

            await queueStorageReconciliation(
                context.userId,
                existingRecording.id,
            );

            await emitEvent(
                "recording.updated",
                context.userId,
                existingRecording.id,
            );
            return {
                status: "updated",
                recordingId: existingRecording.id,
                filename: plaudRecording.filename,
                importCandidate: buildImportCandidate(
                    existingRecording.id,
                    plaudRecording,
                    existing,
                ),
            };
        }

        const canCurate = await userCuratesOrganizationNow(context.userId);
        const newRecording = await insertAudioItem(
            db,
            {
                id: recordingId,
                ...recordingData,
                title,
                occurredAt,
            },
            {
                pipeline: "arrival",
                lockOrganizationTree: false,
                initializeInTx: (tx, input) =>
                    requestArrivalInTx(tx, { ...input, canCurate }),
            },
        );
        capState.pendingBytes -= reservedBytes;
        reservedBytes = 0;

        seenRecordingIds.add(newRecording.id);

        await queueStorageReconciliation(context.userId, newRecording.id);

        await emitEvent("recording.synced", context.userId, newRecording.id);

        return {
            status: "new",
            recordingId: newRecording.id,
            filename: plaudRecording.filename,
            importCandidate: buildImportCandidate(
                newRecording.id,
                plaudRecording,
            ),
        };
    } catch (error) {
        if (
            listedRecording.source === "v4" &&
            error instanceof AppError &&
            error.code === ErrorCode.PLAUD_INVALID_TOKEN
        ) {
            throw error;
        }
        return {
            status: "error",
            error: `Failed to sync ${plaudRecording.filename}: ${error}`,
        };
    } finally {
        capState.pendingBytes -= reservedBytes;
    }
}

async function processBatch(
    batch: PlaudRecording[],
    context: SyncContext,
    plaudClient: Awaited<ReturnType<typeof createPlaudClient>>,
    storage: Awaited<ReturnType<typeof createUserStorageProvider>>,
    capState: CapState,
    seenRecordingIds: Set<string>,
): Promise<{
    newCount: number;
    updatedCount: number;
    errors: string[];
    newRecordingIds: string[];
    newRecordingNames: string[];
    importCandidates: ImportCandidate[];
    capExceeded: boolean;
    connectionError?: AppError;
}> {
    const results = await Promise.allSettled(
        batch.map((rec) =>
            processRecording(
                rec,
                context,
                plaudClient,
                storage,
                capState,
                seenRecordingIds,
            ),
        ),
    );

    let newCount = 0;
    let updatedCount = 0;
    let capExceeded = false;
    let connectionError: AppError | undefined;
    const errors: string[] = [];
    const newRecordingIds: string[] = [];
    const newRecordingNames: string[] = [];
    const importCandidates: ImportCandidate[] = [];

    for (const result of results) {
        if (result.status === "fulfilled") {
            const {
                status,
                recordingId,
                filename,
                error,
                importCandidate,
                capExceeded: ce,
            } = result.value;
            if (ce) capExceeded = true;
            if (status === "new" && recordingId) {
                newCount++;
                newRecordingIds.push(recordingId);
                if (filename) newRecordingNames.push(filename);
            } else if (status === "updated") {
                updatedCount++;
            } else if (status === "error" && error) {
                errors.push(error);
            }
            if (importCandidate) importCandidates.push(importCandidate);
        } else if (
            result.reason instanceof AppError &&
            result.reason.code === ErrorCode.PLAUD_INVALID_TOKEN
        ) {
            connectionError = result.reason;
        } else {
            errors.push(`Batch processing error: ${result.reason}`);
        }
    }

    return {
        newCount,
        updatedCount,
        errors,
        newRecordingIds,
        newRecordingNames,
        importCandidates,
        capExceeded,
        connectionError,
    };
}

/** Paginated, batched sync. Coalesces concurrent same-user calls in-process. */
export async function syncRecordingsForUser(
    userId: string,
    trigger: "manual" | "background" = "manual",
): Promise<SyncResult> {
    const inFlight = inFlightSyncs.get(userId);
    if (inFlight) {
        const shared = await inFlight;
        return { ...shared, inProgress: true };
    }

    const run = runSyncRecordingsForUser(userId);
    inFlightSyncs.set(userId, run);
    try {
        const result = await run;
        // Bloat guard: only fire on syncs that actually changed something --
        // a background cron tick with zero new/updated recordings is pure
        // noise, not a usage signal.
        if (result.newRecordings > 0 || result.updatedRecordings > 0) {
            await captureServerEvent({
                distinctId: userId,
                event: "plaud_synced",
                properties: {
                    trigger,
                    new_recordings: result.newRecordings,
                    updated_recordings: result.updatedRecordings,
                },
            });
        }
        // `skipped` covers the expected-state early returns (no
        // connection yet, suspended, hosted lockout) -- not bugs, so
        // they don't get captured as exceptions even though `errors`
        // carries a message for the client.
        //
        // Deliberately do NOT join `result.errors` into the exception
        // message: per-recording failures embed the Plaud filename
        // ("Failed to sync <filename>: ...", see processRecording's catch
        // block) so callers can show a legible error in their own
        // dashboard -- but that's client-matter-sensitive content (Slice
        // 2 users are lawyers/journalists) that must never leave this
        // process into third-party telemetry. Only a count crosses that
        // boundary.
        if (result.errors.length > 0 && !result.skipped) {
            captureServerException(
                new Error(
                    `Sync completed with ${result.errors.length} error(s)`,
                ),
                {
                    source: "sync",
                    distinctId: userId,
                    trigger,
                    errorCount: result.errors.length,
                },
            );
        }
        return result;
    } finally {
        inFlightSyncs.delete(userId);
    }
}

async function runSyncRecordingsForUser(userId: string): Promise<SyncResult> {
    const result: SyncResult = {
        newRecordings: 0,
        updatedRecordings: 0,
        errors: [],
    };
    let connectionId: string | undefined;

    try {
        const [connection] = await db
            .select()
            .from(plaudConnections)
            .where(eq(plaudConnections.userId, userId))
            .limit(1);

        if (!connection) {
            result.errors.push("No Plaud connection found");
            result.skipped = "no_connection";
            return result;
        }

        const [settings] = await db
            .select()
            .from(userSettings)
            .where(eq(userSettings.userId, userId))
            .limit(1);
        const [user] = await db
            .select({
                email: users.email,
                suspendedAt: users.suspendedAt,
                uiLocale: users.uiLocale,
            })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1);

        if (user?.suspendedAt) {
            result.errors.push("User is suspended");
            result.skipped = "suspended";
            return result;
        }

        // Hosted lockout: a lapsed account is read-only. Existing data
        // stays reachable; no new recordings are pulled until the user
        // subscribes again. No-op on self-host.
        if (await isHostedLockedOut(userId)) {
            result.errors.push(
                "Your hosted plan has lapsed. Subscribe to resume sync, or export your data.",
            );
            result.skipped = "locked_out";
            return result;
        }

        const context: SyncContext = {
            userId,
            importPlaudContent: settings?.importPlaudContent ?? false,
            emailNotifications: settings?.emailNotifications ?? false,
            barkNotifications: settings?.barkNotifications ?? false,
            notificationEmail:
                settings?.notificationEmail || user?.email || null,
            locale: normalizeLocale(user?.uiLocale),
            barkPushUrl: settings?.barkPushUrl || null,
        };

        connectionId = connection.id;
        let refreshRejection: PlaudTokenRejection | undefined;
        const plaudClient = await createPlaudClient(connection, {
            onRefreshRejected: (error) => {
                refreshRejection = error;
            },
        });
        const storage = await createUserStorageProvider(userId);
        const allNewRecordingNames: string[] = [];
        const importCandidates: ImportCandidate[] = [];
        const capState: CapState = {
            blocked: false,
            pendingBytes: 0,
            lastCheck: Promise.resolve(),
        };
        const seenRecordingIds = new Set<string>();

        let page = 0;
        let hasMore = true;
        let consecutiveEmptyPages = 0;

        while (hasMore && page < SYNC_CONFIG.MAX_PAGES) {
            const skip = page * SYNC_CONFIG.PAGE_SIZE;
            const recordingsResponse = await plaudClient.getRecordings(
                skip,
                SYNC_CONFIG.PAGE_SIZE,
                0,
                "edit_time",
                true,
            );

            const plaudRecordings = recordingsResponse.data_file_list;

            if (plaudRecordings.length === 0) {
                break;
            }

            let pageNew = 0;
            let pageUpdated = 0;
            let pageCandidateCount = 0;

            for (
                let i = 0;
                i < plaudRecordings.length;
                i += SYNC_CONFIG.BATCH_CONCURRENCY
            ) {
                const batch = plaudRecordings.slice(
                    i,
                    i + SYNC_CONFIG.BATCH_CONCURRENCY,
                );
                const batchResult = await processBatch(
                    batch,
                    context,
                    plaudClient,
                    storage,
                    capState,
                    seenRecordingIds,
                );

                pageNew += batchResult.newCount;
                pageUpdated += batchResult.updatedCount;
                pageCandidateCount += batchResult.importCandidates.length;
                result.newRecordings += batchResult.newCount;
                result.updatedRecordings += batchResult.updatedCount;
                result.errors.push(...batchResult.errors);
                allNewRecordingNames.push(...batchResult.newRecordingNames);
                importCandidates.push(...batchResult.importCandidates);
                if (batchResult.connectionError)
                    throw batchResult.connectionError;
                if (refreshRejection) throw refreshRejection;
            }

            // Once over the storage cap, every further new recording is a
            // no-op; stop paginating to save Plaud API calls.
            if (capState.blocked) {
                hasMore = false;
            } else if (plaudRecordings.length < SYNC_CONFIG.PAGE_SIZE) {
                hasMore = false;
            } else if (
                pageNew === 0 &&
                pageUpdated === 0 &&
                pageCandidateCount === 0
            ) {
                consecutiveEmptyPages++;
                if (consecutiveEmptyPages >= 2) {
                    if (context.importPlaudContent) {
                        if (
                            !(await hasUnseenPlaudContentGaps(
                                userId,
                                seenRecordingIds,
                            ))
                        ) {
                            hasMore = false;
                        }
                    } else if (
                        result.newRecordings === 0 &&
                        result.updatedRecordings === 0
                    ) {
                        hasMore = false;
                    }
                }
            } else {
                consecutiveEmptyPages = 0;
            }

            page++;
        }

        if (capState.blocked) {
            result.errors.push(
                "Storage limit reached: some recordings were not synced. Upgrade or free up space to continue.",
            );
        }

        const resolvedWorkspaceId = plaudClient.workspaceId;
        const workspaceIdChanged =
            !!resolvedWorkspaceId &&
            resolvedWorkspaceId !== connection.workspaceId;
        await db
            .update(plaudConnections)
            .set({
                lastSync: new Date(),
                ...(workspaceIdChanged
                    ? { workspaceId: resolvedWorkspaceId }
                    : {}),
            })
            .where(
                and(
                    eq(plaudConnections.id, connection.id),
                    eq(plaudConnections.userId, userId),
                ),
            );

        if (
            context.emailNotifications &&
            context.notificationEmail &&
            result.newRecordings > 0
        ) {
            try {
                await sendNewRecordingEmail(
                    context.notificationEmail,
                    result.newRecordings,
                    allNewRecordingNames,
                    context.locale,
                );
            } catch (error) {
                console.error("Failed to send email notification:", error);
                result.errors.push("Email notification failed");
            }
        }

        if (
            context.barkNotifications &&
            context.barkPushUrl &&
            result.newRecordings > 0
        ) {
            try {
                const success = await sendNewRecordingBarkNotification(
                    context.barkPushUrl,
                    result.newRecordings,
                    allNewRecordingNames,
                );
                if (!success) {
                    result.errors.push("Bark notification failed or timed out");
                }
            } catch (error) {
                console.error("Failed to send Bark notification:", error);
                result.errors.push("Bark notification failed");
            }
        }

        // Import Plaud-native transcript/summary content (#204). Runs after
        // all recording rows are committed; never throws out of sync.
        if (context.importPlaudContent && importCandidates.length > 0) {
            await importPlaudContent(
                importCandidates,
                context,
                plaudClient,
                result,
            );
            if (refreshRejection) throw refreshRejection;
        }

        const successfulBearerCiphertext =
            plaudClient.lastSuccessfulBearerCiphertext;
        if (successfulBearerCiphertext) {
            await db
                .update(plaudConnections)
                .set({ invalidatedAt: null })
                .where(
                    and(
                        eq(plaudConnections.id, connection.id),
                        eq(plaudConnections.userId, userId),
                        eq(
                            plaudConnections.bearerToken,
                            successfulBearerCiphertext,
                        ),
                    ),
                );
        }

        return result;
    } catch (error) {
        result.errorCode =
            error instanceof AppError ? error.code : ErrorCode.INTERNAL_ERROR;
        const errorMessage =
            error instanceof Error ? error.message : String(error);

        if (
            error instanceof AppError &&
            error.code === ErrorCode.PLAUD_INVALID_TOKEN &&
            connectionId
        ) {
            result.needsReconnect = false;
            if (
                !(
                    error instanceof PlaudTokenRejection &&
                    error.bearerCiphertext
                )
            ) {
                result.errorCode = ErrorCode.PLAUD_UPSTREAM_ERROR;
                result.errors.push(`Sync failed: ${errorMessage}`);
                return result;
            }
            try {
                result.needsReconnect = await markPlaudConnectionInvalidated({
                    userId,
                    connectionId,
                    bearerToken: error.bearerCiphertext,
                });
            } catch {
                console.error("Failed to mark Plaud connection as invalidated");
                result.errorCode = ErrorCode.INTERNAL_ERROR;
                result.errors.push(
                    "Sync failed: Failed to mark Plaud connection as invalidated.",
                );
                return result;
            }
            if (!result.needsReconnect) {
                result.errorCode = ErrorCode.PLAUD_UPSTREAM_ERROR;
            }
            result.errors.push(
                result.needsReconnect === false
                    ? "The Plaud connection changed during this sync. Please try again."
                    : "Plaud rejected the stored token. Reconnect your Plaud account.",
            );
            return result;
        }

        result.errors.push(`Sync failed: ${errorMessage}`);
        return result;
    }
}

/**
 * Import Plaud-native transcript/summary content for recordings Plaud has
 * already processed. Runs after recording rows are committed, sequentially
 * and gently on the short-lived workspace token
 * (#203). Non-destructive: only fills gaps, never overwrites an existing
 * transcript/summary. Never throws out of sync; a dead token (401) stops the
 * pass, any other failure skips that one item.
 */
async function importPlaudContent(
    candidates: ImportCandidate[],
    context: SyncContext,
    plaudClient: Awaited<ReturnType<typeof createPlaudClient>>,
    result: SyncResult,
): Promise<void> {
    let tokenDead = false;

    for (const candidate of candidates) {
        if (tokenDead) break;
        try {
            const gaps = await loadPlaudContentGaps(
                context,
                candidate.recordingId,
                {
                    isTrans: candidate.isTrans,
                    isSummary: candidate.isSummary,
                    transcriptSuppressed: candidate.transcriptSuppressed,
                    summarySuppressed: candidate.summarySuppressed,
                },
            );
            if (!gaps.needsTranscript && !gaps.needsSummary) continue;

            const detail = await plaudClient.getFileDetail(
                candidate.plaudFileId,
            );
            const { transcript, summary } = selectContentItems(detail);

            // --- Transcript (coexists with the user's own; gap-fill only) ---
            const transcriptLink = transcript?.data_link;
            if (gaps.needsTranscript && isReady(transcript) && transcriptLink) {
                const parsed = parseTranscript(
                    await plaudClient.fetchContentLink(transcriptLink),
                );
                if (parsed.text.trim()) {
                    // `PlaudFileDetail.duration` carries no documented
                    // unit; the list payload's does, so use that.
                    const turns =
                        segmentsToTurns(
                            parsed.segments,
                            candidate.durationMs,
                        ) ?? undefined;
                    const { committed } = await upsertTranscription({
                        userId: context.userId,
                        recordingId: candidate.recordingId,
                        text: parsed.text,
                        detectedLanguage: parsed.language,
                        source: "plaud",
                        provider: "plaud",
                        model: "plaud-native",
                        turns,
                        audioMd5: candidate.audioMd5,
                    });
                    if (committed) {
                        await exportRecordingSidecarsIfEnabled(
                            context.userId,
                            candidate.recordingId,
                            "transcript",
                            "plaud",
                        );
                        await emitEvent(
                            "transcription.completed",
                            context.userId,
                            candidate.recordingId,
                        );
                    }
                }
            }

            const summaryLink = summary?.data_link;
            const inline = findInlineContent(detail, summary?.data_id);
            if (
                gaps.needsSummary &&
                isReady(summary) &&
                (inline || summaryLink)
            ) {
                const parsed = parseSummary(
                    inline ??
                        (await plaudClient.fetchContentLink(
                            summaryLink as string,
                        )),
                );
                if (parsed.summary.trim()) {
                    const [plaudTranscript] = await db
                        .select({ id: transcriptions.id })
                        .from(transcriptions)
                        .where(
                            and(
                                eq(
                                    transcriptions.recordingId,
                                    candidate.recordingId,
                                ),
                                eq(transcriptions.userId, context.userId),
                                eq(transcriptions.source, "plaud"),
                            ),
                        )
                        .limit(1);
                    if (plaudTranscript) {
                        const { committed } = await upsertEnhancement({
                            userId: context.userId,
                            recordingId: candidate.recordingId,
                            transcriptionId: plaudTranscript.id,
                            summary: parsed.summary,
                            keyPoints: parsed.keyPoints,
                            actionItems: parsed.actionItems,
                            source: "plaud",
                            provider: "plaud",
                            model: "plaud-native",
                        });
                        if (committed) {
                            await exportRecordingSidecarsIfEnabled(
                                context.userId,
                                candidate.recordingId,
                                "summary",
                                "plaud",
                            );
                        }
                    }
                }
            }
        } catch (error) {
            if (
                error instanceof AppError &&
                error.code === ErrorCode.PLAUD_INVALID_TOKEN
            ) {
                // Workspace token died mid-pass (#203). Stop; audio already
                // synced and the processing pipeline can use its configured
                // transcription path.
                tokenDead = true;
                result.errors.push(
                    "Plaud content import stopped: access token expired",
                );
            } else {
                result.errors.push(
                    `Plaud content import failed for ${candidate.plaudFileId}: ${error}`,
                );
            }
        }
    }
}
