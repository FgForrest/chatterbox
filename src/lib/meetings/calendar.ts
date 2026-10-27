import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { listMeetingRows, meetingVisibility } from "@/db/queries/meetings";
import {
    chatterItems,
    meetingAgendas,
    recordingFolderAssignments,
    recordings,
} from "@/db/schema";
import { env } from "@/lib/env";
import { AppError, ErrorCode } from "@/lib/errors";
import { assertCategorizableFolder } from "@/lib/folders/folders";
import { listUpcomingCalendarEvents } from "@/lib/integrations/google/calendar-events";
import {
    GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE,
    GOOGLE_CALENDAR_EVENTS_WRITE_SCOPE,
    getGoogleOAuthConfig,
} from "@/lib/integrations/google/config";
import { getGoogleConnectionStatus } from "@/lib/integrations/google/connection";
import { extractMeetCode } from "@/lib/integrations/google/meet-code";
import { meetingViewer } from "@/lib/meetings/access";
import {
    cachedMeetingCalendarSnapshot,
    readMeetingCalendarSnapshot,
} from "@/lib/meetings/calendar-snapshot";
import { listMeetings } from "@/lib/meetings/service";
import { requireRecordingAccess } from "@/lib/sharing/access";

/** Availability reasons keep manual meetings fully usable without Google. */
export async function calendarUnavailableReason(userId: string) {
    if (env.IS_HOSTED) return "hosted";
    if (!getGoogleOAuthConfig()) return "not_configured";
    const connection = await getGoogleConnectionStatus(userId);
    if (connection?.status !== "active") return "not_connected";
    if (
        !connection.scopes.includes(GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE) &&
        !connection.scopes.includes(GOOGLE_CALENDAR_EVENTS_WRITE_SCOPE)
    )
        return "no_calendar_scope";
    return null;
}

/** Fourteen-day event picker, ranking known recurring series by folder usage. */
export async function meetingCalendarEvents(userId: string, folderId: string) {
    await assertCategorizableFolder(userId, folderId);
    const reason = await calendarUnavailableReason(userId);
    if (reason) return { reason, recurring: [], other: [] };
    const viewer = await meetingViewer(userId);
    const now = new Date();
    const [events, meetings, used] = await Promise.all([
        listUpcomingCalendarEvents(
            userId,
            now,
            new Date(now.getTime() + 14 * 86400000),
        ),
        listMeetings(userId, {
            from: now,
            to: new Date(now.getTime() + 14 * 86400000),
            includePast: true,
            includeAbsorbed: true,
        }),
        db
            .select({
                series: recordings.calendarSeriesId,
                count: sql<number>`count(*)::int`,
            })
            .from(recordings)
            .innerJoin(chatterItems, eq(chatterItems.id, recordings.id))
            .innerJoin(
                recordingFolderAssignments,
                eq(recordingFolderAssignments.itemId, recordings.id),
            )
            .where(
                and(
                    eq(recordingFolderAssignments.folderId, folderId),
                    meetingVisibility(userId, viewer.orgUserId),
                ),
            )
            .groupBy(recordings.calendarSeriesId),
    ]);
    const counts = new Map(
        used.filter((row) => row.series).map((row) => [row.series, row.count]),
    );
    const data = events.map(
        ({
            meetingCode: _meetingCode,
            attendees,
            description: _description,
            ...event
        }) => {
            const agenda = meetings.find(
                (meeting) => meeting.calendarEventId === event.id,
            );
            return {
                ...event,
                attendees: attendees.map(({ name }) => ({ name })),
                visibleAgenda: agenda
                    ? { id: agenda.id, author: agenda.author }
                    : null,
                recordingCount: counts.get(event.recurringEventId ?? "") ?? 0,
            };
        },
    );
    return {
        reason: null,
        recurring: data
            .filter((event) => event.recordingCount > 0)
            .sort(
                (a, b) =>
                    b.recordingCount - a.recordingCount ||
                    a.start.localeCompare(b.start),
            ),
        other: data
            .filter((event) => event.recordingCount === 0)
            .sort((a, b) => a.start.localeCompare(b.start)),
    };
}

/** Next instance is offered only for a recurring recording visible to this caller. */
export async function nextMeeting(userId: string, itemId: string) {
    const access = await requireRecordingAccess(userId, itemId);
    const [attached] = await db
        .select({ id: meetingAgendas.id })
        .from(meetingAgendas)
        .where(eq(meetingAgendas.recordingItemId, itemId))
        .limit(1);
    if (!attached)
        throw new AppError(
            ErrorCode.NOT_FOUND,
            "Attached agenda not found",
            404,
        );
    const [recording] = await db
        .select({ seriesId: recordings.calendarSeriesId })
        .from(recordings)
        .where(
            and(
                eq(recordings.id, itemId),
                eq(recordings.userId, access.ownerUserId),
            ),
        );
    if (!recording?.seriesId || (await calendarUnavailableReason(userId)))
        return { event: null };
    const now = new Date();
    const [event] = await listUpcomingCalendarEvents(
        userId,
        now,
        new Date(now.getTime() + 366 * 86400000),
        { seriesId: recording.seriesId },
    );
    if (!event) return { event: null };
    const meetings = await listMeetings(userId, {
        calendarEventId: event.id,
        includePast: true,
        includeAbsorbed: true,
    });
    const {
        meetingCode: _meetingCode,
        description: _description,
        attendees,
        ...publicEvent
    } = event;
    return {
        event: {
            ...publicEvent,
            attendees: attendees.map(({ name }) => ({ name })),
            agendaId: meetings[0]?.id ?? null,
        },
    };
}

/** Match Meet by the exact server-side room code; other platforms match by time. */
export async function matchRecorderAgendas(
    userId: string,
    at: Date,
    meetCode?: string,
    scheduleRefresh?: (refresh: () => Promise<void>) => void,
) {
    const rows = await listMeetings(userId, {
        from: new Date(at.getTime() - 24 * 3600000),
        to: new Date(at.getTime() + 15 * 60000),
        includePast: true,
    });
    const code = meetCode
        ? extractMeetCode({
              hangoutLink: `https://meet.google.com/${meetCode}`,
          })
        : null;
    if (meetCode && !code) return [];
    const viewer = await meetingViewer(userId);
    const agendas = await listMeetingRows(userId, viewer.orgUserId, {
        from: new Date(at.getTime() - 24 * 3600000),
        to: new Date(at.getTime() + 15 * 60000),
        includePast: true,
    });
    const byId = new Map(agendas.map((row) => [row.agenda.id, row.agenda]));
    scheduleRefresh?.(async () => {
        await Promise.all(
            agendas.map(({ agenda }) => readMeetingCalendarSnapshot(agenda)),
        );
    });
    const matches = await Promise.all(
        rows.map(async (row) => {
            if (
                !row.start ||
                at.getTime() >
                    (row.end?.getTime() ?? row.start.getTime() + 2 * 3600000)
            )
                return null;
            if (code) {
                if (!row.calendarEventId) return null;
                const agenda = byId.get(row.id);
                const event = agenda
                    ? cachedMeetingCalendarSnapshot(agenda)
                    : null;

                if (event?.meetingCode !== code) return null;
            }
            return row;
        }),
    );
    return matches.filter((row) => row !== null);
}
