import {
    and,
    asc,
    eq,
    inArray,
    isNotNull,
    isNull,
    or,
    type SQL,
    sql,
} from "drizzle-orm";
import { db } from "@/db";
import {
    receivedItemCondition,
    receivedThroughFolderCondition,
} from "@/db/queries/item-shares";
import {
    agendaPoints,
    agendaTasks,
    chatterItems,
    meetingAgendas,
    recordingFolderAssignments,
    users,
} from "@/db/schema";
import { sharedItemCondition } from "@/lib/sharing/shared";

export { meetingFolders } from "@/db/queries/meeting-folders";

export type MeetingTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type MeetingExecutor = Pick<
    typeof db,
    "select" | "update" | "insert" | "delete"
>;

/** Item visibility for both standalone meetings and agendas absorbed by recordings. */
export function meetingVisibility(
    userId: string,
    orgUserId: string | null,
): SQL {
    return and(
        isNull(chatterItems.deletedAt),
        or(
            eq(chatterItems.userId, userId),
            or(
                and(
                    eq(chatterItems.kind, "meeting"),
                    receivedThroughFolderCondition(userId),
                ),
                and(
                    inArray(chatterItems.kind, ["audio", "mail"]),
                    receivedItemCondition(userId),
                ),
            ),
            orgUserId ? sharedItemCondition(orgUserId) : undefined,
        ),
    ) as SQL;
}

/** Read an agenda only through the caller's currently visible item. */
export async function findMeeting(
    userId: string,
    orgUserId: string | null,
    id: string,
    executor: MeetingExecutor = db,
    lock = false,
) {
    const query = executor
        .select({ agenda: meetingAgendas, item: chatterItems })
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
                or(
                    eq(meetingAgendas.id, id),
                    eq(meetingAgendas.meetingItemId, id),
                    eq(meetingAgendas.recordingItemId, id),
                ),
                meetingVisibility(userId, orgUserId),
            ),
        )
        .limit(1);
    const [row] = await (lock
        ? query.for("update", { of: meetingAgendas })
        : query);
    if (row) return { ...row, recordingVisible: !!row.agenda.recordingItemId };
    const fallback = executor
        .select({ agenda: meetingAgendas, item: chatterItems })
        .from(meetingAgendas)
        .innerJoin(
            chatterItems,
            eq(chatterItems.id, meetingAgendas.meetingItemId),
        )
        .where(
            and(
                or(
                    eq(meetingAgendas.id, id),
                    eq(meetingAgendas.meetingItemId, id),
                ),
                isNotNull(meetingAgendas.recordingItemId),
                eq(chatterItems.kind, "meeting"),
                or(
                    eq(chatterItems.userId, userId),
                    receivedThroughFolderCondition(userId),
                    orgUserId ? sharedItemCondition(orgUserId) : undefined,
                ),
            ),
        )
        .limit(1);
    const [original] = await (lock
        ? fallback.for("update", { of: meetingAgendas })
        : fallback);
    return original ? { ...original, recordingVisible: false } : null;
}

/** Visible standalone agendas, bounded for polling, calendar annotation and recorder reminders. */
export async function listMeetingRows(
    userId: string,
    orgUserId: string | null,
    input: {
        folderId?: string;
        overlapWith?: { start: Date; end: Date };
        from?: Date;
        to?: Date;
        calendarEventId?: string;
        includePast?: boolean;
        includeAbsorbed?: boolean;
        limit?: number;
    } = {},
    executor: MeetingExecutor = db,
) {
    return executor
        .select({
            agenda: meetingAgendas,
            item: chatterItems,
            authorName: users.name,
            counts: {
                points: sql<number>`(select count(*)::int from ${agendaPoints} where ${agendaPoints.agendaId} = ${meetingAgendas.id} and ${agendaPoints.userId} = ${meetingAgendas.userId})`,
                tasks: sql<number>`(select count(*)::int from ${agendaTasks} where ${agendaTasks.agendaId} = ${meetingAgendas.id} and ${agendaTasks.userId} = ${meetingAgendas.userId} and ${agendaTasks.removedAt} is null)`,
            },
        })
        .from(meetingAgendas)
        .innerJoin(users, eq(users.id, meetingAgendas.userId))
        .innerJoin(
            chatterItems,
            eq(
                chatterItems.id,
                input.includeAbsorbed
                    ? sql`coalesce(${meetingAgendas.recordingItemId}, ${meetingAgendas.meetingItemId})`
                    : meetingAgendas.meetingItemId,
            ),
        )
        .where(
            and(
                meetingVisibility(userId, orgUserId),
                input.includeAbsorbed
                    ? undefined
                    : isNull(meetingAgendas.recordingItemId),
                input.folderId
                    ? sql`exists (select 1 from ${recordingFolderAssignments} where ${recordingFolderAssignments.itemId} = ${chatterItems.id} and ${recordingFolderAssignments.folderId} = ${input.folderId})`
                    : undefined,
                input.overlapWith
                    ? sql`${meetingAgendas.plannedStart} < ${input.overlapWith.end.toISOString()}::timestamp and coalesce(${meetingAgendas.plannedEnd}, ${meetingAgendas.plannedStart} + interval '2 hours') > ${input.overlapWith.start.toISOString()}::timestamp`
                    : undefined,
                input.from
                    ? sql`${meetingAgendas.plannedStart} >= ${input.from.toISOString()}::timestamp`
                    : undefined,
                input.to
                    ? sql`${meetingAgendas.plannedStart} < ${input.to.toISOString()}::timestamp`
                    : undefined,
                input.calendarEventId
                    ? eq(meetingAgendas.calendarEventId, input.calendarEventId)
                    : undefined,
                input.includePast
                    ? undefined
                    : or(
                          eq(meetingAgendas.state, "held"),
                          sql`${meetingAgendas.plannedStart} >= now()`,
                          eq(meetingAgendas.timeSet, false),
                      ),
            ),
        )
        .orderBy(asc(meetingAgendas.plannedStart), asc(meetingAgendas.id))
        .limit(input.limit ?? 500);
}

/** Serialize event creation across processes before checking visible duplicates. */
export async function lockMeetingEvent(tx: MeetingTx, eventId: string) {
    await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`meeting-event:${eventId}`}, 0))`,
    );
}

/** Atomically mark overdue meetings held, claiming bounded batches across processes. */
export async function holdOverdueMeetings(
    limit: number,
    at = new Date(),
): Promise<number> {
    const rows = await db.execute(sql`
        with due as (
            select a.id from meeting_agendas a
            inner join chatter_items i on i.id = a.meeting_item_id and i.user_id = a.user_id
            where a.recording_item_id is null and a.state <> 'held' and a.time_set
              and i.deleted_at is null
              and coalesce(a.planned_end, a.planned_start + interval '2 hours') < ${at.toISOString()}::timestamp - interval '12 hours'
            order by a.planned_start, a.id limit ${limit} for update of a skip locked
        )
        update meeting_agendas a set state = 'held', live_ended_at = coalesce(a.live_ended_at, ${at.toISOString()}::timestamp),
            version = a.version + 1, updated_at = ${at.toISOString()}::timestamp
        from due where a.id = due.id returning a.id
    `);
    return rows.length;
}
