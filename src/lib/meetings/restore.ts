import { and, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "@/db";
import {
    agendaPoints,
    agendaTasks,
    aiEnhancements,
    chatterItems,
    meetingAgendas,
    recordingFolderAssignments,
    recordings,
    recordingTasks,
} from "@/db/schema";
import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { archivedItemCondition } from "@/lib/export/archive-scope";
import { archivedMeetingSchema } from "@/lib/export/meetings";
import { resolveArchiveScope } from "@/lib/export/resolve-archive-scope";
import { assertCategorizableFolder } from "@/lib/folders/folders";
import { validatePointTree } from "@/lib/meetings/model";

const id = z.string().min(1).max(255);
export const restoreMeetingsInput = z.object({
    meetings: z.array(archivedMeetingSchema).max(500),
    itemIdMap: z.record(id, id).default({}),
    folderIdMap: z.record(id, id).default({}),
    taskIdMap: z.record(id, id).default({}),
    summaryIdMap: z.record(id, id).default({}),
});

/** Restore meeting content onto authorized imported items and folders; never create users or shares. */
export async function restoreMeetings(
    userId: string,
    raw: z.input<typeof restoreMeetingsInput>,
) {
    const input = restoreMeetingsInput.parse(raw);
    const scope = await resolveArchiveScope(userId);
    const restored: { oldId: string; id: string; meetingItemId: string }[] = [];
    const skipped: { id: string; reason: string }[] = [];
    const folderIds = [
        ...new Set(
            input.meetings.flatMap((meeting) =>
                meeting.folderIds
                    .map((folderId) => input.folderIdMap[folderId])
                    .filter(Boolean),
            ),
        ),
    ];
    for (const folderId of folderIds) {
        const folder = await assertCategorizableFolder(userId, folderId);
        if (
            folder.ownerId !==
            (scope.kind === "personal" ? userId : scope.orgUserId)
        )
            throw new AppError(
                ErrorCode.FORBIDDEN,
                "Mapped folder is outside your archive scope",
                403,
            );
    }
    const restoredPointIds = new Map<string, string>();
    const originLinks: { id: string; agendaId: string; sourceId: string }[] =
        [];
    for (const meeting of input.meetings) {
        const folders = meeting.folderIds
            .map((folderId) => input.folderIdMap[folderId])
            .filter(Boolean);
        if (!folders.length && !meeting.recordingItemId) {
            skipped.push({
                id: meeting.id,
                reason: "No mapped writable folder",
            });
            continue;
        }
        const recordingId = meeting.recordingItemId
            ? input.itemIdMap[meeting.recordingItemId]
            : null;
        if (meeting.recordingItemId && !recordingId) {
            skipped.push({
                id: meeting.id,
                reason: "Recording was not restored",
            });
            continue;
        }
        validatePointTree(meeting.points);
        await db.transaction(async (tx) => {
            let recordingOwnerId = userId;
            if (recordingId) {
                const [recording] = await tx
                    .select({ id: recordings.id, userId: recordings.userId })
                    .from(recordings)
                    .innerJoin(chatterItems, eq(chatterItems.id, recordings.id))
                    .where(
                        and(
                            eq(recordings.id, recordingId),
                            archivedItemCondition(scope),
                            scope.kind === "personal"
                                ? eq(recordings.userId, userId)
                                : undefined,
                        ),
                    )
                    .for("update", { of: recordings });
                if (!recording)
                    throw new AppError(
                        ErrorCode.FORBIDDEN,
                        "Mapped recording is outside your archive scope",
                        403,
                    );
                recordingOwnerId = recording.userId;
            }
            const id = nanoid();
            const meetingItemId = nanoid();
            const at = (value: string | null) =>
                value ? new Date(value) : null;
            await tx.insert(chatterItems).values({
                id: meetingItemId,
                userId,
                kind: "meeting",
                title: encryptText(meeting.title),
                occurredAt:
                    at(meeting.plannedStart) ?? new Date(meeting.createdAt),
                deletedAt: recordingId
                    ? (at(meeting.absorbedAt) ?? new Date())
                    : null,
                createdAt: new Date(meeting.createdAt),
                updatedAt: new Date(meeting.updatedAt),
            });
            const sourceId = meeting.taskSourceItemId
                ? input.itemIdMap[meeting.taskSourceItemId]
                : null;
            const [source] = sourceId
                ? await tx
                      .select({ id: chatterItems.id })
                      .from(chatterItems)
                      .where(
                          and(
                              eq(chatterItems.id, sourceId),
                              eq(chatterItems.kind, "audio"),
                              archivedItemCondition(scope),
                          ),
                      )
                : [];
            const snapshotId = meeting.snapshotSourceItemId
                ? input.itemIdMap[meeting.snapshotSourceItemId]
                : null;
            const [snapshot] = snapshotId
                ? await tx
                      .select({ id: chatterItems.id })
                      .from(chatterItems)
                      .where(
                          and(
                              eq(chatterItems.id, snapshotId),
                              eq(chatterItems.kind, "audio"),
                              archivedItemCondition(scope),
                          ),
                      )
                : [];
            const summaryId = meeting.outcomeSummaryId
                ? input.summaryIdMap[meeting.outcomeSummaryId]
                : null;
            const [summary] =
                summaryId && recordingId
                    ? await tx
                          .select({ id: aiEnhancements.id })
                          .from(aiEnhancements)
                          .where(
                              and(
                                  eq(aiEnhancements.id, summaryId),
                                  eq(aiEnhancements.itemId, recordingId),
                                  eq(aiEnhancements.userId, recordingOwnerId),
                              ),
                          )
                    : [];
            await tx.insert(meetingAgendas).values({
                id,
                userId,
                meetingItemId,
                recordingItemId: recordingId,
                calendarEventId: meeting.calendarEventId,
                calendarSeriesId: meeting.calendarSeriesId,
                plannedStart: at(meeting.plannedStart),
                plannedEnd: at(meeting.plannedEnd),
                timeSet: meeting.timeSet,
                state: meeting.state,
                liveStartedAt: at(meeting.liveStartedAt),
                liveEndedAt: at(meeting.liveEndedAt),
                absorbedAt: recordingId
                    ? (at(meeting.absorbedAt) ?? new Date())
                    : null,
                taskSourceItemId: source?.id,
                snapshotSourceItemId: snapshot?.id,
                outcomeUnplanned: encryptJsonField(meeting.outcomeUnplanned),
                outcomeSummaryId: summary?.id,
                version: meeting.version,
                createdAt: new Date(meeting.createdAt),
                updatedAt: new Date(meeting.updatedAt),
            });
            if (folders.length)
                await tx.insert(recordingFolderAssignments).values(
                    folders.map((folderId) => ({
                        itemId: meetingItemId,
                        userId,
                        folderId,
                    })),
                );
            const pointIds = new Map(
                meeting.points.map((point) => [point.id, nanoid()]),
            );
            const pending = [...meeting.points];
            const inserted = new Set<string>();
            while (pending.length) {
                const ready = pending.filter(
                    (point) => !point.parentId || inserted.has(point.parentId),
                );
                for (const point of ready) {
                    await tx.insert(agendaPoints).values({
                        ...point,
                        id: pointIds.get(point.id),
                        agendaId: id,
                        userId,
                        parentId: point.parentId
                            ? pointIds.get(point.parentId)
                            : null,
                        text: encryptText(point.text),
                        note: point.note ? encryptText(point.note) : null,
                        authorUserId: userId,
                        discussedByUserId: point.discussedAt ? userId : null,
                        discussedAt: at(point.discussedAt),
                        noteAt: at(point.noteAt),
                        originPointId: null,
                        createdAt: new Date(point.createdAt),
                        updatedAt: new Date(point.updatedAt),
                    });
                    restoredPointIds.set(
                        point.id,
                        pointIds.get(point.id) as string,
                    );
                    if (point.originPointId)
                        originLinks.push({
                            id: pointIds.get(point.id) as string,
                            agendaId: id,
                            sourceId: point.originPointId,
                        });
                    inserted.add(point.id);
                    pending.splice(pending.indexOf(point), 1);
                }
            }
            const taskIds = meeting.tasks
                .map((task) => input.taskIdMap[task.taskId])
                .filter(Boolean);
            const allowedTasks = taskIds.length
                ? await tx
                      .select({ id: recordingTasks.id })
                      .from(recordingTasks)
                      .innerJoin(
                          chatterItems,
                          eq(chatterItems.id, recordingTasks.itemId),
                      )
                      .where(
                          and(
                              inArray(recordingTasks.id, taskIds),
                              archivedItemCondition(scope),
                          ),
                      )
                : [];
            const allowed = new Set(allowedTasks.map((task) => task.id));
            for (const task of meeting.tasks) {
                const taskId = input.taskIdMap[task.taskId];
                if (!taskId || !allowed.has(taskId)) {
                    skipped.push({
                        id: task.taskId,
                        reason: "Agenda task was not restored in this scope",
                    });
                    continue;
                }
                await tx.insert(agendaTasks).values({
                    userId,
                    agendaId: id,
                    taskId,
                    origin: task.origin,
                    position: task.position,
                    note: task.note ? encryptText(task.note) : null,
                    removedAt: at(task.removedAt),
                });
            }
            if (recordingId)
                await tx
                    .update(recordings)
                    .set({
                        calendarEventId: meeting.calendarEventId,
                        calendarSeriesId: meeting.calendarSeriesId,
                    })
                    .where(
                        and(
                            eq(recordings.id, recordingId),
                            eq(recordings.userId, recordingOwnerId),
                        ),
                    );
            restored.push({ oldId: meeting.id, id, meetingItemId });
        });
    }
    for (const link of originLinks) {
        const originPointId = restoredPointIds.get(link.sourceId);
        if (originPointId)
            await db
                .update(agendaPoints)
                .set({ originPointId })
                .where(
                    and(
                        eq(agendaPoints.id, link.id),
                        eq(agendaPoints.agendaId, link.agendaId),
                        eq(agendaPoints.userId, userId),
                    ),
                );
    }
    return { restored, skipped };
}
