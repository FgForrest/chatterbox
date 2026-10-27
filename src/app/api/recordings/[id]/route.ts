import { and, eq, inArray, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import {
    audioItemColumns,
    markItemDeleted,
    recordingItemJoin,
    setItemTitle,
    toRecordingResponseRow,
} from "@/db/items";
import {
    recordingAgendaCandidateCount,
    recordingHasAgenda,
} from "@/db/queries/agenda-presence";
import { deleteRecordingAgendaInTx } from "@/db/queries/meeting-lifecycle";
import {
    aiEnhancements,
    asyncJobs,
    chatterItems,
    learnDismissals,
    recordingFolderAssignments,
    recordingFolders,
    recordings,
    transcriptions,
    webhookDeliveries,
} from "@/db/schema";
import { requireApiSession, requireApiSessionActor } from "@/lib/auth-server";
import { actsForOrganization } from "@/lib/authz/curator";
import { retryOnDeadlock } from "@/lib/deadlock-retry";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { refreshExistingRecordingSidecars } from "@/lib/export/document-sidecars";
import { lockOrgTree } from "@/lib/folders/folders";
import { localeFromAcceptLanguage } from "@/lib/i18n/config";
import {
    knowledgeOnRecordingInTx,
    pruneUnsupportedFactsInTx,
} from "@/lib/knowledge/fact-evidence";
import { bumpScopeInTx } from "@/lib/knowledge/scope-generation";
import { getOrgUserId } from "@/lib/org/config";
import { notifyOrgChange } from "@/lib/org/events";
import { loadPrivateItemProcessing } from "@/lib/pipeline/presentation";
import { deleteRecordingStorageArtifacts } from "@/lib/recordings/erase";
import {
    MAX_RECORDING_TITLE_LENGTH,
    normalizeRecordingTitle,
} from "@/lib/recordings/filename";
import { reconcileRecordingStorage } from "@/lib/recordings/reconcile-storage";
import { enqueueStorageReconciliationJob } from "@/lib/recordings/storage-reconciliation-job";
import {
    requestedRecordingView,
    requireRecordingView,
} from "@/lib/sharing/access";
import { notifyIfShared } from "@/lib/sharing/notify";
import { recordingJobSubject } from "@/lib/sharing/view";
import {
    assertMayChange,
    contentWriterRefusal,
    sharingOrgUserId,
    writerRefusalError,
} from "@/lib/sharing/writer";
import { createUserStorageProvider } from "@/lib/storage/factory";
import {
    deleteItemTaskDataInTx,
    lockItemTaskGraphInTx,
} from "@/lib/tasks/mentions";
import { emitEvent } from "@/lib/webhooks/emit";
import { createRedactedWebhookPayload } from "@/lib/webhooks/payload";

type IdContext = { params: Promise<{ id: string }> };

export const GET = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);

    const { id } = await (context as IdContext).params;

    const view = requestedRecordingView(request);
    if (view === "received") {
        const access = await requireRecordingView(
            session.user.id,
            id,
            "received",
        );
        if (new URL(request.url).searchParams.get("processing") === "1")
            return NextResponse.json({ processing: null });
        const [item] = await db
            .select({
                id: recordings.id,
                hasAgenda: recordingHasAgenda(),
                title: chatterItems.title,
                duration: recordings.duration,
                occurredAt: chatterItems.occurredAt,
                filesize: recordings.filesize,
            })
            .from(recordings)
            .innerJoin(chatterItems, recordingItemJoin)
            .where(
                and(
                    eq(recordings.id, id),
                    eq(recordings.userId, access.ownerUserId),
                    isNull(recordings.deletedAt),
                ),
            )
            .limit(1);
        if (!item)
            throw new AppError(
                ErrorCode.RECORDING_NOT_FOUND,
                "Recording not found",
                404,
            );
        return NextResponse.json({
            recording: {
                id: item.id,
                hasAgenda: item.hasAgenda,
                agendaCandidateCount: 0,
                filename: decryptText(item.title),
                duration: item.duration,
                startTime: item.occurredAt,
                filesize: item.filesize,
                view: "received",
                isOwn: false,
            },
        });
    }

    if (new URL(request.url).searchParams.get("processing") === "1") {
        const access = await requireRecordingView(session.user.id, id, view);
        return NextResponse.json({
            processing: await loadPrivateItemProcessing(
                access.ownerUserId,
                id,
                session.user.id,
                localeFromAcceptLanguage(
                    request.headers.get("accept-language"),
                ),
                access.view,
            ),
        });
    }

    const [row] = await db
        .select({
            ...audioItemColumns,
            hasAgenda: recordingHasAgenda(),
            agendaCandidateCount: recordingAgendaCandidateCount(
                session.user.id,
                await getOrgUserId(),
            ),
        })
        .from(recordings)
        .innerJoin(chatterItems, recordingItemJoin)
        .where(
            and(
                eq(recordings.id, id),
                eq(recordings.userId, session.user.id),
                isNull(recordings.deletedAt),
            ),
        )
        .limit(1);
    const recording = row ? toRecordingResponseRow(row) : undefined;

    if (!recording) {
        throw new AppError(
            ErrorCode.RECORDING_NOT_FOUND,
            "Recording not found",
            404,
        );
    }

    // Get transcription if exists. Defense-in-depth: scope by userId
    // even though the parent recording lookup already filtered. If a row
    // ever ends up with mismatched (recordingId, userId) due to a bug or
    // a partially-failed delete, this prevents cross-tenant reads.
    const [transcription] = await db
        .select()
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.recordingId, id),
                eq(transcriptions.userId, session.user.id),
            ),
        )
        .limit(1);

    // Decrypt content fields before returning to the client. The DB
    // holds ciphertext (or, during the deploy → backfill window, legacy
    // plaintext); the client always sees plaintext.
    return NextResponse.json({
        recording: {
            ...recording,
            filename: decryptText(recording.filename),
        },
        transcription: transcription
            ? { ...transcription, text: decryptText(transcription.text) }
            : null,
    });
});

export const PATCH = apiHandler<IdContext>(async (request, context) => {
    const { session, actor } = await requireApiSessionActor(request);
    const { id } = await (context as IdContext).params;
    const body = (await request.json().catch(() => ({}))) as unknown;
    if (
        body === null ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        typeof (body as { filename?: unknown }).filename !== "string"
    ) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "filename must be a string",
            400,
            { field: "filename" },
        );
    }

    const filename = normalizeRecordingTitle(
        (body as { filename: string }).filename,
    );
    if (!filename) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Name cannot be empty",
            400,
            { field: "filename" },
        );
    }
    if (filename.length > MAX_RECORDING_TITLE_LENGTH) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            `Name must be ${MAX_RECORDING_TITLE_LENGTH} characters or fewer`,
            400,
            { field: "filename", maxLength: MAX_RECORDING_TITLE_LENGTH },
        );
    }

    // The owner renames it on the private view; while it is shared, a
    // curator of the Organization (or the organization account) on the
    // Organization view. Either way the files
    // are the owner's and follow the title in the owner's storage; nothing
    // is pushed to the owner's Plaud account.
    const actorUserId = session.user.id;
    const access = await requireRecordingView(
        actorUserId,
        id,
        requestedRecordingView(request),
        { kinds: ["audio", "mail"] },
    );
    const curates = access.view === "org" && (await actsForOrganization(actor));
    assertMayChange(access, actorUserId, curates);
    const userId = access.ownerUserId;
    const orgUserId = await sharingOrgUserId();

    if (access.kind === "mail") {
        const refusal = await contentWriterRefusal(undefined, {
            recordingId: id,
            ownerUserId: userId,
            actorUserId,
            orgUserId,
            actsForOrganization: curates,
        });
        if (refusal) throw writerRefusalError(refusal);

        let refused: ReturnType<typeof writerRefusalError> | null = null;
        const renamed = await db.transaction(async (tx) => {
            const [locked] = await tx
                .select({ id: chatterItems.id })
                .from(chatterItems)
                .where(
                    and(
                        eq(chatterItems.id, id),
                        eq(chatterItems.userId, userId),
                        eq(chatterItems.kind, "mail"),
                        isNull(chatterItems.deletedAt),
                    ),
                )
                .for("update")
                .limit(1);
            if (!locked) return false;
            const shared = await contentWriterRefusal(tx, {
                recordingId: id,
                ownerUserId: userId,
                actorUserId,
                orgUserId,
                actsForOrganization: curates,
            });
            if (shared) {
                refused = writerRefusalError(shared);
                return false;
            }
            await setItemTitle(tx, {
                id,
                userId,
                title: encryptText(filename),
                editedAt: new Date(),
            });
            return true;
        });
        if (refused) throw refused;
        if (!renamed) {
            throw new AppError(ErrorCode.NOT_FOUND, "Mail not found", 404);
        }
        await emitEvent("recording.updated", userId, id);
        await notifyIfShared(id);
        return NextResponse.json({ filename });
    }

    const [recording] = await db
        .select({
            id: recordings.id,
            storagePath: recordings.storagePath,
            storageFilename: recordings.storageFilename,
        })
        .from(recordings)
        .where(
            and(
                eq(recordings.id, id),
                eq(recordings.userId, userId),
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
    // Refused before any file is renamed, and again under the lock where
    // the title is written.
    const refusal = await contentWriterRefusal(undefined, {
        recordingId: id,
        ownerUserId: userId,
        actorUserId,
        orgUserId,
        actsForOrganization: curates,
    });
    if (refusal) throw writerRefusalError(refusal);

    let reconciled: Awaited<ReturnType<typeof reconcileRecordingStorage>>;
    try {
        reconciled = await reconcileRecordingStorage({
            id: recording.id,
            userId,
            title: filename,
            storagePath: recording.storagePath,
            storageFilename: recording.storageFilename,
        });
    } catch (error) {
        console.error(
            `Failed to rename storage files for recording ${id}:`,
            error,
        );
        throw new AppError(
            ErrorCode.STORAGE_ERROR,
            "Failed to rename recording files. Please retry.",
            500,
        );
    }

    let refused: ReturnType<typeof writerRefusalError> | null = null;
    const updated = await db.transaction(async (tx) => {
        // The lock sharing takes, so a share that committed meanwhile is
        // seen below.
        await tx
            .select({ id: recordings.id })
            .from(recordings)
            .where(and(eq(recordings.id, id), eq(recordings.userId, userId)))
            .for("update");
        const shared = await contentWriterRefusal(tx, {
            recordingId: id,
            ownerUserId: userId,
            actorUserId,
            orgUserId,
            actsForOrganization: curates,
        });
        if (shared) {
            refused = writerRefusalError(shared);
            return undefined;
        }
        const now = new Date();
        const [row] = await tx
            .update(recordings)
            .set({ updatedAt: now })
            .where(
                and(
                    eq(recordings.id, id),
                    eq(recordings.userId, userId),
                    eq(recordings.storagePath, reconciled.storagePath),
                    eq(recordings.storageFilename, reconciled.storageFilename),
                    isNull(recordings.deletedAt),
                ),
            )
            .returning({ id: recordings.id });
        if (!row) return undefined;
        const title = encryptText(filename);
        // A person chose this title; nothing generated replaces it.
        await setItemTitle(tx, {
            id,
            userId,
            title,
            editedAt: now,
            at: now,
            touch: false,
        });
        return { id: row.id, filename: title };
    });

    if (refused) {
        // Shared while the files were being renamed for the refused title:
        // they follow the title the recording kept instead.
        if (reconciled.changed) {
            await enqueueStorageReconciliationJob({ userId, recordingId: id });
        }
        throw refused;
    }
    if (!updated) {
        throw new AppError(
            ErrorCode.RECORDING_NOT_FOUND,
            "Recording not found",
            404,
        );
    }

    await refreshExistingRecordingSidecars(userId, id);

    await emitEvent("recording.updated", userId, updated.id);
    await notifyIfShared(updated.id);

    return NextResponse.json({
        filename: decryptText(updated.filename),
    });
});

/**
 * Soft-delete a recording.
 *
 * Order of operations is important:
 *
 * 1. Hard-delete the audio file from storage. If the storage provider fails
 *    for any reason other than "already gone", abort with 500 — we do NOT
 *    tombstone, so the user can retry instead of being left with an orphan
 *    blob that storage-usage stats can't see.
 * 2. Run all DB writes (transcription rows, AI-enhancement rows, tombstone
 *    update on `recordings.deletedAt`) inside a single transaction. Either
 *    they all commit or none do, so a partial failure can't leave the user
 *    with a half-deleted recording (e.g. transcript gone but row still
 *    visible).
 *
 * The tombstone (instead of a hard delete) exists because sync is keyed on
 * `recordings.plaudFileId`. Without it, the next pull from Plaud would
 * resurrect the recording. This endpoint does NOT delete the file on
 * Plaud's servers — Plaud remains the upstream source of truth.
 */
export const DELETE = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);

    const { id } = await (context as IdContext).params;
    const userId = session.user.id;

    const [recording] = await db
        .select()
        .from(recordings)
        .where(
            and(
                eq(recordings.id, id),
                eq(recordings.userId, userId),
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

    // 1. Storage delete first. Treat "already gone" as success; surface
    //    every other error so the user can retry.
    try {
        const storage = await createUserStorageProvider(userId);
        await deleteRecordingStorageArtifacts(
            storage,
            recording.storagePath,
            "all",
        );
    } catch (storageError) {
        console.error(
            `Failed to delete storage files for recording ${id}:`,
            storageError,
        );
        throw new AppError(
            ErrorCode.STORAGE_ERROR,
            "Failed to delete all recording files. Please retry.",
            500,
        );
    }

    // 2. Atomic DB writes: child rows, webhook delivery payload redaction,
    //    and tombstone in one transaction.
    let wasShared = false;
    // Before the transaction, which must not take a second pooled
    // connection while it holds the recording lock.
    const orgUserId = await getOrgUserId();
    const didTombstone = await retryOnDeadlock(() =>
        db.transaction(async (tx) => {
            const now = new Date();
            // Withdrawing takes the Organization tree lock before the
            // recording's, as every change to the tree does, so no folder move
            // can file the recording again beside this delete.
            if (orgUserId) await lockOrgTree(tx);
            await lockItemTaskGraphInTx(tx, {
                itemId: id,
                ownerUserId: userId,
            });

            // Lock the parent recording row up front. Without this, a
            // concurrent transcribe/summary writer (which also re-checks
            // tombstone under FOR UPDATE) could slip a new transcript or
            // ai_enhancement row in between our child-row deletes and the
            // final tombstone, leaving orphan rows pointing at a tombstoned
            // recording. With the lock, concurrent writers either run before
            // us (their rows get deleted by the child-row deletes below) or
            // after us (they observe `deletedAt != null` and bail).
            const [locked] = await tx
                .select({ deletedAt: recordings.deletedAt })
                .from(recordings)
                .where(
                    and(eq(recordings.id, id), eq(recordings.userId, userId)),
                )
                .for("update")
                .limit(1);

            // A concurrent DELETE already tombstoned and committed; nothing
            // for us to do. Return false so we don't emit a duplicate event.
            if (!locked || locked.deletedAt) return false;

            // Nothing queued for either view may run against a deleted
            // recording; it would only fail after spending a provider call.
            await tx
                .update(asyncJobs)
                .set({
                    status: "failed",
                    completedAt: now,
                    updatedAt: now,
                    heartbeatAt: null,
                    claimToken: null,
                    errorCode: ErrorCode.RECORDING_NOT_FOUND,
                    lastError: "Cancelled because the recording was deleted",
                })
                .where(
                    and(
                        inArray(asyncJobs.subjectId, [
                            recordingJobSubject(id, "private"),
                            recordingJobSubject(id, "org"),
                        ]),
                        inArray(asyncJobs.kind, [
                            "transcription",
                            "summary",
                            "topics",
                            "learn.run",
                            "title.generate",
                            "learn.release",
                            "learn.correct",
                            "pipeline.advance",
                        ]),
                        inArray(asyncJobs.status, ["pending", "processing"]),
                    ),
                );

            // Every content row of the recording, whichever account holds it:
            // it goes for everyone at once, the Organization included, and the
            // facts said only here with it.
            const knowledge = await knowledgeOnRecordingInTx(tx, id);
            await tx
                .delete(transcriptions)
                .where(eq(transcriptions.recordingId, id));
            await pruneUnsupportedFactsInTx(tx, knowledge.factIds);

            await tx
                .delete(aiEnhancements)
                .where(eq(aiEnhancements.itemId, id));
            await deleteItemTaskDataInTx(tx, {
                itemId: id,
                ownerUserId: userId,
                actorUserId: userId,
                orgUserId,
                reason: "deleted",
            });
            // Learn runs and their items went with the transcripts; what was
            // dismissed has nothing left to answer for.
            await tx
                .delete(learnDismissals)
                .where(eq(learnDismissals.itemId, id));

            if (orgUserId) {
                const orgFolderIds = tx
                    .select({ id: recordingFolders.id })
                    .from(recordingFolders)
                    .where(eq(recordingFolders.userId, orgUserId));
                const unshared = await tx
                    .delete(recordingFolderAssignments)
                    .where(
                        and(
                            eq(recordingFolderAssignments.itemId, id),
                            inArray(
                                recordingFolderAssignments.folderId,
                                orgFolderIds,
                            ),
                        ),
                    )
                    .returning({
                        folderId: recordingFolderAssignments.folderId,
                    });
                wasShared = unshared.length > 0;
            }

            await tx
                .update(webhookDeliveries)
                .set({
                    payload: createRedactedWebhookPayload(id, now),
                    updatedAt: now,
                })
                .where(
                    and(
                        eq(webhookDeliveries.recordingId, id),
                        eq(webhookDeliveries.userId, userId),
                    ),
                );

            // Returning lets us tell whether THIS request flipped the
            // tombstone vs. a concurrent DELETE having already done it. We
            // only want to emit `recording.deleted` for the winning request.
            const tombstoned = await tx
                .update(recordings)
                .set({ deletedAt: now, updatedAt: now })
                .where(
                    and(
                        eq(recordings.id, id),
                        eq(recordings.userId, userId),
                        isNull(recordings.deletedAt),
                    ),
                )
                .returning({ id: recordings.id });
            if (tombstoned.length > 0) {
                // Nothing waits for Learn on a deleted recording.
                await deleteRecordingAgendaInTx(tx, { id, userId, at: now });
                await markItemDeleted(tx, { id, userId, at: now });
            }

            await bumpScopeInTx(tx, knowledge.scopes);
            return tombstoned.length > 0;
        }),
    );

    if (didTombstone) {
        await emitEvent("recording.deleted", userId, id);
    }
    if (wasShared) {
        await notifyOrgChange({ type: "tree" });
    }

    return NextResponse.json({ success: true });
});
