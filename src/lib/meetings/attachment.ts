import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { notifyFolderReceiversInTx } from "@/db/queries/item-shares";
import { restoreStandaloneAgendaInTx } from "@/db/queries/meeting-lifecycle";
import {
    findMeeting,
    listMeetingRows,
    type MeetingTx,
    meetingFolders,
} from "@/db/queries/meetings";
import {
    chatterItems,
    folderShares,
    itemShares,
    mailPendingShares,
    meetingAgendas,
    recordingFolderAssignments,
    recordingFolders,
    recordingSessions,
    recordings,
    users,
} from "@/db/schema";
import { retryOnDeadlock } from "@/lib/deadlock-retry";
import { decryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import {
    lockOrgTree,
    orgTreeChanged,
    withdrawRecordingInTx,
} from "@/lib/folders/folders";
import { nudge } from "@/lib/jobs/nudge";
import { bumpScopeInTx } from "@/lib/knowledge/scope-generation";
import { meetingViewer, requireMeetingAccess } from "@/lib/meetings/access";
import { meetingOverlap } from "@/lib/meetings/model";
import { assertOrgScopeWritable, getOrgUserId } from "@/lib/org/config";
import { recordIntendedPlacementInTx } from "@/lib/pipeline/share-intent";
import { requestAdvanceInTx } from "@/lib/pipeline/trigger";
import { isRecordingShared } from "@/lib/sharing/shared";

async function ownedRecording(tx: MeetingTx, userId: string, itemId: string) {
    const [row] = await tx
        .select({ recording: recordings, item: chatterItems })
        .from(recordings)
        .innerJoin(chatterItems, eq(chatterItems.id, recordings.id))
        .where(
            and(
                eq(recordings.id, itemId),
                eq(recordings.userId, userId),
                eq(chatterItems.userId, userId),
                isNull(chatterItems.deletedAt),
                isNull(recordings.deletedAt),
            ),
        )
        .for("update", { of: recordings })
        .limit(1);
    if (!row)
        throw new AppError(ErrorCode.NOT_FOUND, "Recording not found", 404);
    return row;
}

async function candidatesInTx(
    tx: MeetingTx,
    userId: string,
    itemId: string,
    orgUserId: string | null,
) {
    const recording = await ownedRecording(tx, userId, itemId);
    const rows = await listMeetingRows(
        userId,
        orgUserId,
        {
            includePast: true,
            limit: 1000,
            overlapWith: {
                start: recording.item.occurredAt,
                end: recording.recording.endTime,
            },
        },
        tx,
    );
    const assignments = await tx
        .select({
            folderId: recordingFolderAssignments.folderId,
            folderOwnerId: recordingFolders.userId,
        })
        .from(recordingFolderAssignments)
        .innerJoin(
            recordingFolders,
            eq(recordingFolders.id, recordingFolderAssignments.folderId),
        )
        .where(
            and(
                eq(recordingFolderAssignments.itemId, itemId),
                eq(recordingFolderAssignments.userId, userId),
            ),
        );
    const [intent] = await tx
        .select({ id: mailPendingShares.itemId })
        .from(mailPendingShares)
        .where(
            and(
                eq(mailPendingShares.itemId, itemId),
                eq(mailPendingShares.userId, userId),
            ),
        )
        .limit(1);
    const [personShare] = await tx
        .select({ id: itemShares.id })
        .from(itemShares)
        .where(
            and(
                eq(itemShares.itemId, itemId),
                eq(itemShares.userId, userId),
                inArray(itemShares.state, ["pending", "accepted"]),
            ),
        )
        .limit(1);
    const otherSharedFolders = await tx
        .select({ id: folderShares.folderId })
        .from(folderShares)
        .where(
            and(
                eq(folderShares.userId, userId),
                inArray(
                    folderShares.folderId,
                    assignments.map((row) => row.folderId).concat([""]),
                ),
                inArray(folderShares.state, ["pending", "accepted"]),
            ),
        );
    const result = [];
    let overlappingCount = 0;
    for (const row of rows) {
        if (
            !row.agenda.timeSet ||
            !row.agenda.plannedStart ||
            !row.agenda.meetingItemId
        )
            continue;
        const overlap = meetingOverlap(
            recording.item.occurredAt,
            recording.recording.endTime,
            row.agenda.plannedStart,
            row.agenda.plannedEnd ??
                new Date(row.agenda.plannedStart.getTime() + 2 * 3600000),
        );
        if (!overlap) continue;
        overlappingCount++;
        const [folder] = await meetingFolders(
            tx,
            row.agenda.meetingItemId,
            row.agenda.userId,
        );
        if (!folder) continue;
        const shares = await tx
            .select({
                receiverUserId: folderShares.receiverUserId,
                name: users.name,
            })
            .from(folderShares)
            .innerJoin(users, eq(users.id, folderShares.receiverUserId))
            .where(
                and(
                    eq(folderShares.folderId, folder.id),
                    eq(folderShares.userId, folder.userId),
                    inArray(folderShares.state, ["accepted", "pending"]),
                ),
            );
        const inFolder = assignments.some(
            (assignment) => assignment.folderId === folder.id,
        );
        const privateFolder = folder.userId === userId && shares.length === 0;
        result.push({
            ...row,
            folder,
            overlapMs: overlap,
            safe:
                row.agenda.userId === userId &&
                (inFolder ||
                    (privateFolder &&
                        !intent &&
                        !personShare &&
                        !assignments.some(
                            (assignment) => assignment.folderOwnerId !== userId,
                        ) &&
                        otherSharedFolders.length === 0)),
            widensSharing:
                !inFolder && (folder.userId !== userId || shares.length > 0),
            audience:
                folder.userId === orgUserId
                    ? {
                          organization: true,
                          userIds: [] as string[],
                          users: [] as { id: string; name: string }[],
                      }
                    : {
                          organization: false,
                          userIds: [
                              ...new Set([
                                  folder.userId,
                                  ...shares.map(
                                      (share) => share.receiverUserId,
                                  ),
                              ]),
                          ].filter((id) => id !== userId),
                          users: [
                              { id: row.agenda.userId, name: row.authorName },
                              ...shares.map((share) => ({
                                  id: share.receiverUserId,
                                  name: share.name,
                              })),
                          ].filter(
                              (entry, index, all) =>
                                  entry.id !== userId &&
                                  all.findIndex(
                                      (other) => other.id === entry.id,
                                  ) === index,
                          ),
                      },
        });
    }
    return { candidates: result, overlappingCount };
}

async function absorbInTx(
    tx: MeetingTx,
    userId: string,
    agendaId: string,
    recordingItemId: string,
    orgUserId: string | null,
    explicit: boolean,
    arriving = false,
) {
    await ownedRecording(tx, userId, recordingItemId);
    const row = await findMeeting(userId, orgUserId, agendaId, tx, true);
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, "Meeting not found", 404);
    const { agenda } = row;
    if (agenda.recordingItemId === recordingItemId) return;
    if (agenda.recordingItemId)
        throw new AppError(ErrorCode.CONFLICT, "Agenda already attached", 409);
    const existing = await findMeeting(userId, orgUserId, recordingItemId, tx);
    if (existing)
        throw new AppError(
            ErrorCode.CONFLICT,
            "Recording already has an agenda",
            409,
        );
    if (!agenda.meetingItemId)
        throw new AppError(
            ErrorCode.CONFLICT,
            "Meeting item no longer exists",
            409,
        );
    const [folder] = await meetingFolders(
        tx,
        agenda.meetingItemId,
        agenda.userId,
    );
    if (explicit && folder) {
        if (folder.userId === orgUserId) {
            assertOrgScopeWritable();
            await recordIntendedPlacementInTx(tx, {
                ownerUserId: userId,
                itemId: recordingItemId,
                folderId: folder.id,
                requestPipeline: !arriving,
            });
        } else
            await tx
                .insert(recordingFolderAssignments)
                .values({
                    userId,
                    itemId: recordingItemId,
                    folderId: folder.id,
                })
                .onConflictDoNothing();
    }
    const at = new Date();
    await tx
        .update(meetingAgendas)
        .set({
            recordingItemId,
            absorbedAt: at,
            version: agenda.version + 1,
            updatedAt: at,
        })
        .where(
            and(
                eq(meetingAgendas.id, agenda.id),
                eq(meetingAgendas.userId, agenda.userId),
                isNull(meetingAgendas.recordingItemId),
            ),
        );
    if (explicit && folder)
        await notifyFolderReceiversInTx(tx, userId, recordingItemId, folder.id);
    await tx
        .update(recordings)
        .set({
            calendarEventId: sql`coalesce(${recordings.calendarEventId}, ${agenda.calendarEventId})`,
            calendarSeriesId: sql`coalesce(${recordings.calendarSeriesId}, ${agenda.calendarSeriesId})`,
            updatedAt: at,
        })
        .where(
            and(
                eq(recordings.id, recordingItemId),
                eq(recordings.userId, userId),
            ),
        );
    if (explicit && folder && folder.userId !== orgUserId && !arriving) {
        await requestAdvanceInTx(tx, {
            itemId: recordingItemId,
            userId,
            view: "private",
            reason: "placement",
        });
    }
    await tx
        .update(chatterItems)
        .set({ deletedAt: at, updatedAt: at })
        .where(
            and(
                eq(chatterItems.id, agenda.meetingItemId),
                eq(chatterItems.userId, agenda.userId),
            ),
        );
}

/** Explicit attachment requires meeting edit access and ownership of the recording. */
export async function attachAgenda(
    userId: string,
    id: string,
    recordingItemId: string,
) {
    const viewer = await meetingViewer(userId);
    await requireMeetingAccess(userId, id, "edit", { viewer });
    await db.transaction(async (tx) => {
        await requireMeetingAccess(userId, id, "edit", {
            viewer,
            executor: tx,
        });
        await absorbInTx(
            tx,
            userId,
            id,
            recordingItemId,
            viewer.orgUserId,
            true,
        );
    });
    nudge();
}

/** Automatic matching never moves or shares a recording; ambiguity is left for the card. */
export async function attachArrivingRecordingInTx(
    tx: MeetingTx,
    userId: string,
    itemId: string,
    fileId: string,
) {
    const orgUserId = await getOrgUserId();
    const [session] = fileId.startsWith("meeting-")
        ? await tx
              .select({ metadata: recordingSessions.metadata })
              .from(recordingSessions)
              .where(
                  and(
                      eq(recordingSessions.userId, userId),
                      eq(
                          recordingSessions.clientRecordingId,
                          fileId.slice("meeting-".length),
                      ),
                      inArray(recordingSessions.status, [
                          "completing",
                          "completed",
                      ]),
                  ),
              )
        : [];
    if (session?.metadata.agendaId === null) return;
    const agendaOutcome = session?.metadata.agendaOutcome;
    if (
        agendaOutcome &&
        typeof agendaOutcome === "object" &&
        "attached" in agendaOutcome &&
        agendaOutcome.attached === false
    )
        return;
    const explicitId =
        typeof session?.metadata.agendaId === "string"
            ? session.metadata.agendaId
            : null;
    if (explicitId) {
        const attached = await findMeeting(userId, orgUserId, explicitId, tx);
        if (attached?.agenda.recordingItemId === itemId) return;
        try {
            await requireMeetingAccess(userId, explicitId, "edit", {
                viewer: { userId, orgUserId, curator: false },
                executor: tx,
            });
            await absorbInTx(
                tx,
                userId,
                explicitId,
                itemId,
                orgUserId,
                true,
                true,
            );
        } catch (error) {
            if (
                !(error instanceof AppError) ||
                ![403, 404, 409].includes(error.statusCode)
            )
                throw error;
        }
        return;
    }
    const { candidates, overlappingCount } = await candidatesInTx(
        tx,
        userId,
        itemId,
        orgUserId,
    );
    if (
        overlappingCount === 1 &&
        candidates.length === 1 &&
        candidates[0].safe
    ) {
        try {
            await absorbInTx(
                tx,
                userId,
                candidates[0].agenda.id,
                itemId,
                orgUserId,
                false,
            );
        } catch (error) {
            if (
                !(error instanceof AppError) ||
                ![404, 409].includes(error.statusCode)
            )
                throw error;
        }
    }
}

/** Matching agendas and the audience an explicit shared-folder attachment would reach. */
export async function agendaCandidates(userId: string, itemId: string) {
    const viewer = await meetingViewer(userId);
    return db.transaction(async (tx) =>
        (
            await candidatesInTx(tx, userId, itemId, viewer.orgUserId)
        ).candidates.map((candidate) => ({
            id: candidate.agenda.id,
            title: decryptText(candidate.item.title),
            start: candidate.agenda.plannedStart,
            end: candidate.agenda.plannedEnd,
            folder: {
                id: candidate.folder.id,
                name: decryptText(candidate.folder.name),
            },
            overlapMs: candidate.overlapMs,
            widensSharing: candidate.widensSharing,
            audience: candidate.audience,
        })),
    );
}

/** Restore the standalone item; summaries and actual task changes remain untouched. */
export async function detachAgenda(userId: string, recordingItemId: string) {
    const viewer = await meetingViewer(userId);
    let withdrew = false;
    await retryOnDeadlock(() =>
        db.transaction(async (tx) => {
            if (viewer.orgUserId) await lockOrgTree(tx);
            await ownedRecording(tx, userId, recordingItemId);
            const row = await findMeeting(
                userId,
                viewer.orgUserId,
                recordingItemId,
                tx,
                true,
            );
            if (
                !row ||
                row.agenda.recordingItemId !== recordingItemId ||
                !row.agenda.meetingItemId
            )
                throw new AppError(
                    ErrorCode.NOT_FOUND,
                    "Attached agenda not found",
                    404,
                );
            const wasShared = viewer.orgUserId
                ? await isRecordingShared(recordingItemId, viewer.orgUserId, tx)
                : false;
            await notifyFolderReceiversInTx(tx, userId, recordingItemId);
            await restoreStandaloneAgendaInTx(tx, row.agenda, userId);
            if (
                viewer.orgUserId &&
                wasShared &&
                !(await isRecordingShared(
                    recordingItemId,
                    viewer.orgUserId,
                    tx,
                ))
            ) {
                await bumpScopeInTx(
                    tx,
                    await withdrawRecordingInTx(
                        tx,
                        viewer.orgUserId,
                        recordingItemId,
                        userId,
                    ),
                );
                withdrew = true;
            }
            if (row.agenda.meetingItemId)
                await notifyFolderReceiversInTx(
                    tx,
                    row.agenda.userId,
                    row.agenda.meetingItemId,
                );
        }),
    );
    if (withdrew) await orgTreeChanged();
}
