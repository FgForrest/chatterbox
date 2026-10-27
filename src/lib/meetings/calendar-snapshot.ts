import { and, eq, isNull, lt, or } from "drizzle-orm";
import { db } from "@/db";
import { meetingAgendas } from "@/db/schema";
import { decryptJsonField, encryptJsonField } from "@/lib/encryption/fields";
import {
    type CalendarEventCandidate,
    getCalendarEvent,
} from "@/lib/integrations/google/calendar-events";

export type MeetingCalendarSnapshot = Omit<
    CalendarEventCandidate,
    "description"
>;
const TTL_MS = 10 * 60 * 1000;

/** Store only the event context preparation needs, including server-only room matching data. */
export function encryptCalendarSnapshot(event: CalendarEventCandidate) {
    const { description: _description, ...snapshot } = event;
    return encryptJsonField(snapshot);
}

/** A conditional database claim permits one refresh per agenda and TTL across app processes. */
export async function readMeetingCalendarSnapshot(
    agenda: typeof meetingAgendas.$inferSelect,
): Promise<MeetingCalendarSnapshot | null> {
    if (!agenda.calendarEventId) return null;
    const cached = decryptJsonField<MeetingCalendarSnapshot>(
        agenda.calendarSnapshot,
    );
    const now = new Date();
    const staleBefore = new Date(now.getTime() - TTL_MS);
    if (agenda.calendarRefreshedAt && agenda.calendarRefreshedAt > staleBefore)
        return cached;
    const [claimed] = await db
        .update(meetingAgendas)
        .set({ calendarRefreshedAt: now })
        .where(
            and(
                eq(meetingAgendas.id, agenda.id),
                eq(meetingAgendas.userId, agenda.userId),
                eq(meetingAgendas.calendarEventId, agenda.calendarEventId),
                or(
                    isNull(meetingAgendas.calendarRefreshedAt),
                    lt(meetingAgendas.calendarRefreshedAt, staleBefore),
                ),
            ),
        )
        .returning({ id: meetingAgendas.id });
    if (!claimed) {
        const [latest] = await db
            .select({ snapshot: meetingAgendas.calendarSnapshot })
            .from(meetingAgendas)
            .where(
                and(
                    eq(meetingAgendas.id, agenda.id),
                    eq(meetingAgendas.userId, agenda.userId),
                    eq(meetingAgendas.calendarEventId, agenda.calendarEventId),
                ),
            );
        return latest
            ? decryptJsonField<MeetingCalendarSnapshot>(latest.snapshot)
            : null;
    }
    try {
        const event = await getCalendarEvent(
            agenda.userId,
            agenda.calendarEventId,
        );
        await db
            .update(meetingAgendas)
            .set({ calendarSnapshot: encryptCalendarSnapshot(event) })
            .where(
                and(
                    eq(meetingAgendas.id, agenda.id),
                    eq(meetingAgendas.userId, agenda.userId),
                    eq(meetingAgendas.calendarEventId, agenda.calendarEventId),
                    eq(meetingAgendas.calendarRefreshedAt, now),
                ),
            );
        const { description: _description, ...snapshot } = event;
        return snapshot;
    } catch {
        return cached;
    }
}
