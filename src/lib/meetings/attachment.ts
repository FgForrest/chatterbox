import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { notifyFolderReceiversInTx } from "@/db/queries/item-shares";
import {
    findMeeting,
    listMeetingRows,
    type MeetingTx,
    meetingFolders,
} from "@/db/queries/meetings";
import {
    chatterItems,
    folderShares,
    meetingAgendas,
    recordingFolderAssignments,
    recordingSessions,
    recordings,
    users,
} from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { shareItemToOrganizationFolderInTx } from "@/lib/folders/folders";
import { meetingViewer, requireMeetingAccess } from "@/lib/meetings/access";
import { meetingOverlap } from "@/lib/meetings/model";
import { assertOrgScopeWritable } from "@/lib/org/config";

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
        .select({ folderId: recordingFolderAssignments.folderId })
        .from(recordingFolderAssignments)
        .where(
            and(
                eq(recordingFolderAssignments.itemId, itemId),
                eq(recordingFolderAssignments.userId, userId),
            ),
        );
    const result = [];
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
            safe: row.agenda.userId === userId && (inFolder || privateFolder),
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
    return result;
}

async function absorbInTx(
    tx: MeetingTx,
    userId: string,
    agendaId: string,
    recordingItemId: string,
    orgUserId: string | null,
    explicit: boolean,
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
            const problems = await shareItemToOrganizationFolderInTx(tx, {
                ownerUserId: userId,
                itemId: recordingItemId,
                folderId: folder.id,
                orgUserId,
                explicitAgendaId: agenda.id,
            });
            if (problems.length)
                throw new AppError(
                    ErrorCode.SHARE_REQUIREMENTS_UNMET,
                    "Finish the recording review before sharing",
                    409,
                    { problems },
                );
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
            calendarEventId: agenda.calendarEventId,
            calendarSeriesId: agenda.calendarSeriesId,
            updatedAt: at,
        })
        .where(
            and(
                eq(recordings.id, recordingItemId),
                eq(recordings.userId, userId),
            ),
        );
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
}

/** Automatic matching never moves or shares a recording; ambiguity is left for the card. */
export async function attachArrivingRecordingInTx(
    tx: MeetingTx,
    userId: string,
    itemId: string,
    fileId: string,
) {
    const [organization] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.role, "org"))
        .limit(1);
    const orgUserId = organization?.id ?? null;
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
                      eq(recordingSessions.status, "completing"),
                  ),
              )
        : [];
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
            await absorbInTx(tx, userId, explicitId, itemId, orgUserId, true);
        } catch (error) {
            if (
                !(error instanceof AppError) ||
                ![403, 404, 409].includes(error.statusCode)
            )
                throw error;
        }
        return;
    }
    const candidates = await candidatesInTx(tx, userId, itemId, orgUserId);
    const owned = candidates.filter(
        (candidate) => candidate.agenda.userId === userId,
    );
    if (owned.length === 1 && owned[0].safe) {
        try {
            await absorbInTx(
                tx,
                userId,
                owned[0].agenda.id,
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
        (await candidatesInTx(tx, userId, itemId, viewer.orgUserId)).map(
            (candidate) => ({
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
            }),
        ),
    );
}

/** Restore the standalone item; summaries and actual task changes remain untouched. */
export async function detachAgenda(userId: string, recordingItemId: string) {
    const viewer = await meetingViewer(userId);
    await db.transaction(async (tx) => {
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
        const agenda = row.agenda;
        await tx
            .update(meetingAgendas)
            .set({
                recordingItemId: null,
                absorbedAt: null,
                version: agenda.version + 1,
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(meetingAgendas.id, agenda.id),
                    eq(meetingAgendas.userId, agenda.userId),
                ),
            );
        await tx
            .update(chatterItems)
            .set({ deletedAt: null, updatedAt: new Date() })
            .where(
                and(
                    eq(chatterItems.id, agenda.meetingItemId as string),
                    eq(chatterItems.userId, agenda.userId),
                ),
            );
    });
}
