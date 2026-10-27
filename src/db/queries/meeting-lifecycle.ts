import { and, eq, inArray, sql } from "drizzle-orm";
import { meetingFolders } from "@/db/queries/meeting-folders";
import type { MeetingExecutor } from "@/db/queries/meetings";
import {
    agendaPoints,
    chatterItems,
    mailPendingShares,
    meetingAgendas,
    recordingFolderAssignments,
    recordings,
} from "@/db/schema";

type Agenda = typeof meetingAgendas.$inferSelect;

/** Reverse absorption while preserving recording identifiers supplied by another source. */
export async function restoreStandaloneAgendaInTx(
    executor: MeetingExecutor,
    agenda: Agenda,
    recordingOwnerId: string,
    at = new Date(),
) {
    const folders = agenda.meetingItemId
        ? await meetingFolders(executor, agenda.meetingItemId, agenda.userId)
        : [];
    const foreignFolderIds = folders
        .filter((folder) => folder.userId !== recordingOwnerId)
        .map((folder) => folder.id);
    if (agenda.recordingItemId) {
        await executor
            .update(recordings)
            .set({
                calendarEventId: sql`case when ${recordings.calendarEventId} = ${agenda.calendarEventId} then null else ${recordings.calendarEventId} end`,
                calendarSeriesId: sql`case when ${recordings.calendarSeriesId} = ${agenda.calendarSeriesId} then null else ${recordings.calendarSeriesId} end`,
                updatedAt: at,
            })
            .where(
                and(
                    eq(recordings.id, agenda.recordingItemId),
                    eq(recordings.userId, recordingOwnerId),
                ),
            );
        if (foreignFolderIds.length) {
            await executor
                .delete(recordingFolderAssignments)
                .where(
                    and(
                        eq(
                            recordingFolderAssignments.itemId,
                            agenda.recordingItemId,
                        ),
                        eq(recordingFolderAssignments.userId, recordingOwnerId),
                        inArray(
                            recordingFolderAssignments.folderId,
                            foreignFolderIds,
                        ),
                    ),
                );
            await executor
                .delete(mailPendingShares)
                .where(
                    and(
                        eq(mailPendingShares.itemId, agenda.recordingItemId),
                        eq(mailPendingShares.userId, recordingOwnerId),
                        inArray(mailPendingShares.folderId, foreignFolderIds),
                    ),
                );
        }
    }
    const end =
        agenda.plannedEnd ??
        (agenda.plannedStart
            ? new Date(agenda.plannedStart.getTime() + 2 * 3600000)
            : null);
    const held =
        !!agenda.liveEndedAt ||
        agenda.state === "held" ||
        (agenda.timeSet &&
            end !== null &&
            end.getTime() < at.getTime() - 12 * 3600000);
    await executor
        .update(meetingAgendas)
        .set({
            recordingItemId: null,
            absorbedAt: null,
            outcomeUnplanned: null,
            outcomeSummaryId: null,
            state: held ? "held" : "planned",
            version: sql`${meetingAgendas.version} + 1`,
            updatedAt: at,
        })
        .where(
            and(
                eq(meetingAgendas.id, agenda.id),
                eq(meetingAgendas.userId, agenda.userId),
            ),
        );
    await executor
        .update(agendaPoints)
        .set({
            summaryOutcome: null,
            version: sql`${agendaPoints.version} + 1`,
            updatedAt: at,
        })
        .where(
            and(
                eq(agendaPoints.agendaId, agenda.id),
                eq(agendaPoints.userId, agenda.userId),
            ),
        );
    if (agenda.meetingItemId)
        await executor
            .update(chatterItems)
            .set({ deletedAt: null, updatedAt: at })
            .where(
                and(
                    eq(chatterItems.id, agenda.meetingItemId),
                    eq(chatterItems.userId, agenda.userId),
                ),
            );
}

/** Every permanent recording deletion removes its own plan or restores another author's meeting. */
export async function deleteRecordingAgendaInTx(
    executor: MeetingExecutor,
    input: { id: string; userId: string; at: Date },
) {
    const [row] = await executor
        .select({ agenda: meetingAgendas })
        .from(meetingAgendas)
        .innerJoin(
            recordings,
            and(
                eq(recordings.id, meetingAgendas.recordingItemId),
                eq(recordings.userId, input.userId),
            ),
        )
        .where(eq(meetingAgendas.recordingItemId, input.id))
        .for("update", { of: meetingAgendas });
    if (!row) return;
    if (row.agenda.userId !== input.userId) {
        await restoreStandaloneAgendaInTx(
            executor,
            row.agenda,
            input.userId,
            input.at,
        );
        return;
    }
    await executor
        .delete(meetingAgendas)
        .where(
            and(
                eq(meetingAgendas.id, row.agenda.id),
                eq(meetingAgendas.userId, input.userId),
            ),
        );
    if (row.agenda.meetingItemId)
        await executor
            .delete(chatterItems)
            .where(
                and(
                    eq(chatterItems.id, row.agenda.meetingItemId),
                    eq(chatterItems.userId, input.userId),
                ),
            );
}
