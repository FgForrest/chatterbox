import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { recordingItemJoin } from "@/db/items";
import { chatterItems, recordings } from "@/db/schema";
import type { LearnSpeakerCandidate } from "@/lib/learn/run-fallback";
import {
    type CalendarEventCandidate,
    listCalendarEventsForRecording,
} from "./calendar-events";
import { getMeetSpeakerCandidates } from "./meet-speaker-candidates";
import { attendeeNameKey } from "./meeting-roster-names";

/** A named invitee or participant, without contact or biometric data. */
export type MeetingAttendee = LearnSpeakerCandidate;

/** The selected event and its deduplicated Calendar and Meet names. */
export interface MeetingRoster {
    eventId: string;
    attendees: MeetingAttendee[];
}

/** Selects an explicit event or a sufficiently overlapping, unambiguous event. */
export function selectMeetingEvent(
    events: readonly CalendarEventCandidate[],
    start: Date,
    end: Date,
    eventId?: string,
): CalendarEventCandidate | null {
    if (eventId !== undefined)
        return events.find((event) => event.id === eventId) ?? null;
    const duration = end.getTime() - start.getTime();
    if (!Number.isFinite(duration) || duration <= 0) return null;
    const ranked = events
        .filter((event) => event.attendees.length > 0)
        .flatMap((event) => {
            const from = Date.parse(event.start);
            const to = Date.parse(event.end);
            const overlap =
                Math.min(end.getTime(), to) - Math.max(start.getTime(), from);
            return to > from && overlap > 0
                ? [
                      {
                          event,
                          overlap,
                          lengthDifference: Math.abs(to - from - duration),
                          eligible:
                              overlap >= duration / 2 ||
                              overlap >= (to - from) / 2,
                      },
                  ]
                : [];
        })
        .sort(
            (a, b) =>
                b.overlap - a.overlap ||
                a.lengthDifference - b.lengthDifference,
        );
    const best = ranked[0];
    if (!best?.eligible) return null;
    if (
        ranked[1] &&
        ranked[1].overlap >= best.overlap * 0.9 &&
        (ranked[1].overlap !== best.overlap ||
            ranked[1].lengthDifference === best.lengthDifference)
    )
        return null;
    return best.event;
}

/** Best-effort meeting names from the audio owner's Calendar and Meet, in either view. */
export async function resolveMeetingRoster(input: {
    ownerUserId: string;
    itemId: string;
    calendarEventId?: string;
    fetchImpl?: typeof fetch;
}): Promise<MeetingRoster | null> {
    try {
        if (input.calendarEventId === "") return null;
        const [recording] = await db
            .select({ start: chatterItems.occurredAt, end: recordings.endTime })
            .from(recordings)
            .innerJoin(chatterItems, recordingItemJoin)
            .where(
                and(
                    eq(recordings.id, input.itemId),
                    eq(recordings.userId, input.ownerUserId),
                    eq(chatterItems.userId, input.ownerUserId),
                    eq(chatterItems.kind, "audio"),
                    isNull(chatterItems.deletedAt),
                ),
            )
            .limit(1);
        if (!recording) return null;
        const event = selectMeetingEvent(
            await listCalendarEventsForRecording({
                userId: input.ownerUserId,
                ...recording,
                fetchImpl: input.fetchImpl,
            }),
            recording.start,
            recording.end,
            input.calendarEventId,
        );
        if (!event) return null;
        const joined = await getMeetSpeakerCandidates({
            userId: input.ownerUserId,
            event,
            recordingStartedAt: recording.start,
            recordingEndedAt: recording.end,
            onGoogleError: () => {
                console.error(
                    "Meeting roster: Meet attendees could not be loaded",
                );
            },
            fetchImpl: input.fetchImpl,
        });
        const names = new Map<string, MeetingAttendee>();
        for (const attendee of [
            ...event.attendees.map(({ name }) => ({
                name,
                source: "calendar" as const,
            })),
            ...joined,
        ]) {
            const key = attendeeNameKey(attendee.name);
            const previous = names.get(key);
            if (key)
                names.set(
                    key,
                    attendee.source === "meet" &&
                        (previous?.source === "calendar" || previous?.invited)
                        ? { ...attendee, invited: true }
                        : attendee,
                );
        }
        return { eventId: event.id, attendees: [...names.values()] };
    } catch {
        return null;
    }
}
