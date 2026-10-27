import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
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

/** Read event data without interpreting participation metadata as a Calendar event. */
export function cachedMeetingCalendarSnapshot(
    agenda: Pick<typeof meetingAgendas.$inferSelect, "calendarSnapshot">,
): MeetingCalendarSnapshot | null {
    const snapshot = decryptJsonField<MeetingCalendarSnapshot>(
        agenda.calendarSnapshot,
    );
    return snapshot &&
        typeof snapshot.id === "string" &&
        Array.isArray(snapshot.attendees)
        ? snapshot
        : null;
}

/** Preserve editor participation when replacing the rebuildable event snapshot. */
export function calendarSnapshotWithEditors(
    snapshot: ReturnType<typeof encryptCalendarSnapshot> | null,
) {
    return sql`coalesce(${JSON.stringify(snapshot ?? {})}::jsonb, '{}'::jsonb) || jsonb_build_object('editorUserIds', coalesce(${meetingAgendas.calendarSnapshot}->'editorUserIds', '[]'::jsonb))`;
}

/** A conditional database claim permits one refresh per agenda and TTL across app processes. */
export async function readMeetingCalendarSnapshot(
    agenda: typeof meetingAgendas.$inferSelect,
): Promise<MeetingCalendarSnapshot | null> {
    if (!agenda.calendarEventId) return null;
    const cached = cachedMeetingCalendarSnapshot(agenda);
    const now = new Date();
    const staleBefore = new Date(now.getTime() - TTL_MS);
    if (
        agenda.recordingItemId ||
        (agenda.calendarRefreshedAt && agenda.calendarRefreshedAt > staleBefore)
    )
        return cached;
    const [claimed] = await db
        .update(meetingAgendas)
        .set({ calendarRefreshedAt: now })
        .where(
            and(
                eq(meetingAgendas.id, agenda.id),
                eq(meetingAgendas.userId, agenda.userId),
                isNull(meetingAgendas.recordingItemId),
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
            ? cachedMeetingCalendarSnapshot({
                  calendarSnapshot: latest.snapshot,
              })
            : null;
    }
    try {
        const event = await getCalendarEvent(
            agenda.userId,
            agenda.calendarEventId,
        );
        const { description: _description, ...snapshot } = event;
        const changed = JSON.stringify(cached) !== JSON.stringify(snapshot);
        await db
            .update(meetingAgendas)
            .set({
                ...(changed
                    ? {
                          version: sql`${meetingAgendas.version} + 1`,
                          updatedAt: new Date(),
                      }
                    : {}),
                calendarSnapshot: calendarSnapshotWithEditors(
                    encryptCalendarSnapshot(event),
                ),
            })
            .where(
                and(
                    eq(meetingAgendas.id, agenda.id),
                    eq(meetingAgendas.userId, agenda.userId),
                    eq(meetingAgendas.calendarEventId, agenda.calendarEventId),
                    eq(meetingAgendas.calendarRefreshedAt, now),
                    isNull(meetingAgendas.recordingItemId),
                ),
            );
        return snapshot;
    } catch {
        return cached;
    }
}
