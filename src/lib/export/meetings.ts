import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
    agendaPoints,
    agendaTasks,
    chatterItems,
    meetingAgendas,
    recordingFolderAssignments,
    recordingFolders,
    recordingTasks,
} from "@/db/schema";
import { decryptJsonField, decryptText } from "@/lib/encryption/fields";
import {
    type ArchiveScope,
    archivedItemCondition,
} from "@/lib/export/archive-scope";
import { archivedTaskCondition } from "@/lib/tasks/archive";

const id = z.string().min(1).max(255);
const date = z.iso.datetime({ offset: true });
const pointArchive = z.object({
    id,
    parentId: id.nullable(),
    position: z.number().int().nonnegative(),
    text: z.string().max(2000),
    authorUserId: id.nullable(),
    discussedAt: date.nullable(),
    discussedByUserId: id.nullable(),
    note: z.string().max(2000).nullable(),
    noteAt: date.nullable(),
    summaryOutcome: z.enum(["covered", "not_covered"]).nullable(),
    origin: z.enum(["manual", "carry_over", "ai", "live"]),
    originPointId: id.nullable(),
    version: z.number().int().nonnegative(),
    createdAt: date,
    updatedAt: date,
});
export const archivedMeetingSchema = z.object({
    id,
    title: z.string().max(2000),
    meetingItemId: id.nullable(),
    recordingItemId: id.nullable(),
    userId: id,
    calendarEventId: id.nullable(),
    calendarSeriesId: id.nullable(),
    plannedStart: date.nullable(),
    plannedEnd: date.nullable(),
    timeSet: z.boolean(),
    state: z.enum(["planned", "live", "held"]),
    liveStartedAt: date.nullable(),
    liveEndedAt: date.nullable(),
    absorbedAt: date.nullable(),
    taskSourceItemId: id.nullable(),
    snapshotSourceItemId: id.nullable().default(null),
    outcomeUnplanned: z.array(z.string().max(2000)).max(100),
    outcomeSummaryId: id.nullable(),
    version: z.number().int().nonnegative(),
    createdAt: date,
    updatedAt: date,
    folderIds: z.array(id).max(100),
    points: z.array(pointArchive).max(5000),
    tasks: z
        .array(
            z.object({
                taskId: id,
                origin: z.enum(["last_meeting", "older"]),
                removedAt: date.nullable(),
                position: z.number().int(),
                note: z.string().max(2000).nullable(),
            }),
        )
        .max(5000),
});
export type ArchivedMeeting = z.infer<typeof archivedMeetingSchema>;

/** Archive meetings in the item's scope, including read-only absorbed agendas with recordings. */
export async function collectArchivedMeetings(
    scope: ArchiveScope,
): Promise<ArchivedMeeting[]> {
    const rows = await db
        .select({ agenda: meetingAgendas })
        .from(meetingAgendas)
        .innerJoin(
            chatterItems,
            eq(
                chatterItems.id,
                sql`coalesce(${meetingAgendas.recordingItemId}, ${meetingAgendas.meetingItemId})`,
            ),
        )
        .where(archivedItemCondition(scope));
    const result: ArchivedMeeting[] = [];
    for (const { agenda } of rows) {
        const [[item], points, tasks, folders, sources] = await Promise.all([
            agenda.meetingItemId
                ? db
                      .select({ title: chatterItems.title })
                      .from(chatterItems)
                      .where(
                          and(
                              eq(chatterItems.id, agenda.meetingItemId),
                              eq(chatterItems.userId, agenda.userId),
                          ),
                      )
                : [],
            db
                .select()
                .from(agendaPoints)
                .where(
                    and(
                        eq(agendaPoints.agendaId, agenda.id),
                        eq(agendaPoints.userId, agenda.userId),
                    ),
                )
                .orderBy(asc(agendaPoints.position), asc(agendaPoints.id)),
            db
                .select({ task: agendaTasks })
                .from(agendaTasks)
                .innerJoin(
                    recordingTasks,
                    eq(recordingTasks.id, agendaTasks.taskId),
                )
                .innerJoin(
                    chatterItems,
                    and(
                        eq(chatterItems.id, recordingTasks.itemId),
                        eq(chatterItems.userId, recordingTasks.userId),
                    ),
                )
                .where(
                    and(
                        eq(agendaTasks.agendaId, agenda.id),
                        eq(agendaTasks.userId, agenda.userId),
                        archivedItemCondition(scope),
                        archivedTaskCondition(scope),
                    ),
                )
                .orderBy(asc(agendaTasks.position)),
            agenda.meetingItemId
                ? db
                      .select({ id: recordingFolderAssignments.folderId })
                      .from(recordingFolderAssignments)
                      .innerJoin(
                          recordingFolders,
                          eq(
                              recordingFolders.id,
                              recordingFolderAssignments.folderId,
                          ),
                      )
                      .where(
                          and(
                              eq(
                                  recordingFolderAssignments.itemId,
                                  agenda.meetingItemId,
                              ),
                              eq(
                                  recordingFolderAssignments.userId,
                                  agenda.userId,
                              ),
                              eq(
                                  recordingFolders.userId,
                                  scope.kind === "personal"
                                      ? scope.userId
                                      : scope.orgUserId,
                              ),
                          ),
                      )
                : [],
            db
                .select({ id: chatterItems.id })
                .from(chatterItems)
                .where(
                    and(
                        inArray(
                            chatterItems.id,
                            [
                                agenda.taskSourceItemId,
                                agenda.snapshotSourceItemId,
                            ].filter((id): id is string => id !== null),
                        ),
                        archivedItemCondition(scope),
                    ),
                ),
        ]);
        const {
            calendarSnapshot: _snapshot,
            calendarRefreshedAt: _refreshedAt,
            ...archivedAgenda
        } = agenda;
        result.push({
            ...archivedAgenda,
            taskSourceItemId: sources.some(
                (source) => source.id === agenda.taskSourceItemId,
            )
                ? agenda.taskSourceItemId
                : null,
            snapshotSourceItemId: sources.some(
                (source) => source.id === agenda.snapshotSourceItemId,
            )
                ? agenda.snapshotSourceItemId
                : null,
            title: item ? decryptText(item.title) : "Meeting",
            folderIds: folders.map((folder) => folder.id),
            plannedStart: agenda.plannedStart?.toISOString() ?? null,
            plannedEnd: agenda.plannedEnd?.toISOString() ?? null,
            liveStartedAt: agenda.liveStartedAt?.toISOString() ?? null,
            liveEndedAt: agenda.liveEndedAt?.toISOString() ?? null,
            absorbedAt: agenda.absorbedAt?.toISOString() ?? null,
            createdAt: agenda.createdAt.toISOString(),
            updatedAt: agenda.updatedAt.toISOString(),
            outcomeUnplanned:
                decryptJsonField<string[]>(agenda.outcomeUnplanned) ?? [],
            points: points.map((point) => ({
                ...point,
                text: decryptText(point.text),
                note: point.note ? decryptText(point.note) : null,
                discussedAt: point.discussedAt?.toISOString() ?? null,
                noteAt: point.noteAt?.toISOString() ?? null,
                createdAt: point.createdAt.toISOString(),
                updatedAt: point.updatedAt.toISOString(),
            })),
            tasks: tasks.map(({ task }) => ({
                ...task,
                note: task.note ? decryptText(task.note) : null,
                removedAt: task.removedAt?.toISOString() ?? null,
            })),
        });
    }
    return result;
}
