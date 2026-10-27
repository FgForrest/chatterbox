import {
    and,
    asc,
    desc,
    eq,
    gt,
    inArray,
    isNotNull,
    isNull,
    ne,
    or,
    sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { meetingVisibility } from "@/db/queries/meetings";
import {
    ANY_TASK_ITEM,
    type TaskViewer,
    taskVisible,
} from "@/db/queries/task-visibility";
import {
    agendaPoints,
    agendaSuggestions,
    aiEnhancements,
    chatterItems,
    meetingAgendas,
    recordingFolderAssignments,
    recordings,
    recordingTasks,
    taskMentions,
} from "@/db/schema";
import { taskMentionVisible } from "@/lib/tasks/mentions";

const mentionItem = alias(chatterItems, "agenda_mention_item");
const preferredSummary = alias(aiEnhancements, "agenda_preferred_summary");

/** Visible summaries of folder arrivals since the previous held or recorded meeting. */
export async function agendaSuggestionInputs(input: {
    agenda: typeof meetingAgendas.$inferSelect;
    folderId: string;
    userId: string;
    orgUserId: string | null;
    viewer: TaskViewer;
}) {
    const { agenda } = input;
    const [previous] = await db
        .select({
            at: sql<Date>`coalesce(${meetingAgendas.plannedStart}, ${meetingAgendas.createdAt})`,
        })
        .from(meetingAgendas)
        .innerJoin(
            chatterItems,
            eq(
                chatterItems.id,
                sql`coalesce(${meetingAgendas.recordingItemId}, ${meetingAgendas.meetingItemId})`,
            ),
        )
        .where(
            and(
                meetingVisibility(input.userId, input.orgUserId),
                ne(meetingAgendas.id, agenda.id),
                or(
                    eq(meetingAgendas.state, "held"),
                    sql`${meetingAgendas.recordingItemId} is not null`,
                ),
                sql`coalesce(${meetingAgendas.plannedStart}, ${meetingAgendas.createdAt}) < ${(agenda.plannedStart ?? agenda.createdAt).toISOString()}::timestamp`,
                agenda.calendarSeriesId
                    ? eq(
                          meetingAgendas.calendarSeriesId,
                          agenda.calendarSeriesId,
                      )
                    : sql`exists (select 1 from ${recordingFolderAssignments} where ${recordingFolderAssignments.itemId} = ${chatterItems.id} and ${recordingFolderAssignments.folderId} = ${input.folderId})`,
            ),
        )
        .orderBy(
            desc(
                sql`coalesce(${meetingAgendas.plannedStart}, ${meetingAgendas.createdAt})`,
            ),
            desc(meetingAgendas.id),
        )
        .limit(1);
    const since = previous?.at ? new Date(previous.at) : new Date(0);
    const [previousRecording] = await db
        .select({ at: chatterItems.occurredAt })
        .from(recordings)
        .innerJoin(chatterItems, eq(chatterItems.id, recordings.id))
        .where(
            and(
                meetingVisibility(input.userId, input.orgUserId),
                sql`${chatterItems.occurredAt} < ${(agenda.plannedStart ?? agenda.createdAt).toISOString()}::timestamp`,
                agenda.calendarSeriesId
                    ? eq(recordings.calendarSeriesId, agenda.calendarSeriesId)
                    : sql`exists (select 1 from ${recordingFolderAssignments} where ${recordingFolderAssignments.itemId} = ${chatterItems.id} and ${recordingFolderAssignments.folderId} = ${input.folderId})`,
            ),
        )
        .orderBy(desc(chatterItems.occurredAt), desc(chatterItems.id))
        .limit(1);
    if (previousRecording && previousRecording.at > since)
        since.setTime(previousRecording.at.getTime());
    const [summaries, tasks, points, suggestions] = await Promise.all([
        db
            .select({
                itemId: chatterItems.id,
                source: aiEnhancements.source,
                summary: aiEnhancements.summary,
            })
            .from(recordingFolderAssignments)
            .innerJoin(
                chatterItems,
                eq(chatterItems.id, recordingFolderAssignments.itemId),
            )
            .innerJoin(
                aiEnhancements,
                and(
                    eq(aiEnhancements.itemId, chatterItems.id),
                    eq(aiEnhancements.userId, chatterItems.userId),
                ),
            )
            .where(
                and(
                    eq(recordingFolderAssignments.folderId, input.folderId),
                    gt(recordingFolderAssignments.createdAt, since),
                    meetingVisibility(input.userId, input.orgUserId),
                    inArray(chatterItems.kind, ["audio", "mail"]),
                    isNull(chatterItems.summaryReapedAt),
                    isNotNull(aiEnhancements.summary),
                    or(
                        eq(aiEnhancements.source, "riffado"),
                        sql`not exists (select 1 from ${aiEnhancements} as agenda_preferred_summary where ${preferredSummary.itemId} = ${aiEnhancements.itemId} and ${preferredSummary.userId} = ${aiEnhancements.userId} and ${preferredSummary.source} = 'riffado' and ${preferredSummary.summary} is not null)`,
                    ),
                ),
            )
            .orderBy(
                desc(recordingFolderAssignments.createdAt),
                asc(chatterItems.id),
                desc(aiEnhancements.source),
            )
            .limit(101),
        db
            .select({ id: recordingTasks.id, text: recordingTasks.text })
            .from(recordingTasks)
            .leftJoin(chatterItems, eq(chatterItems.id, recordingTasks.itemId))
            .where(
                and(
                    eq(recordingTasks.status, "open"),
                    taskVisible(input.viewer, ANY_TASK_ITEM, true),
                    sql`exists (select 1 from ${recordingFolderAssignments} where ${recordingFolderAssignments.folderId} = ${input.folderId} and (${recordingFolderAssignments.itemId} = ${recordingTasks.itemId} or exists (select 1 from ${taskMentions} inner join ${chatterItems} as agenda_mention_item on ${mentionItem.id} = ${taskMentions.itemId} where ${taskMentions.taskId} = ${recordingTasks.id} and ${taskMentions.itemId} = ${recordingFolderAssignments.itemId} and ${taskMentions.matchDecision} in ('home', 'accepted', 'kept_new') and ${taskMentionVisible(input.viewer, { itemId: taskMentions.itemId, userId: taskMentions.userId, view: taskMentions.view }, { id: mentionItem.id, userId: mentionItem.userId, deletedAt: mentionItem.deletedAt })})))`,
                ),
            )
            .orderBy(desc(recordingTasks.updatedAt), asc(recordingTasks.id))
            .limit(201),
        db
            .select({
                id: agendaPoints.id,
                parentId: agendaPoints.parentId,
                text: agendaPoints.text,
            })
            .from(agendaPoints)
            .where(
                and(
                    eq(agendaPoints.agendaId, agenda.id),
                    eq(agendaPoints.userId, agenda.userId),
                ),
            )
            .orderBy(asc(agendaPoints.position), asc(agendaPoints.id)),
        db
            .select({
                text: agendaSuggestions.text,
                state: agendaSuggestions.state,
            })
            .from(agendaSuggestions)
            .where(
                and(
                    eq(agendaSuggestions.agendaId, agenda.id),
                    eq(agendaSuggestions.userId, agenda.userId),
                ),
            ),
    ]);
    return { summaries, tasks, points, suggestions };
}
