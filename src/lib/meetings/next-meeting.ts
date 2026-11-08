import {
    type CalendarEventCandidate,
    listUpcomingCalendarEvents,
} from "@/lib/integrations/google/calendar-events";
import { getGoogleConnectionStatus } from "@/lib/integrations/google/connection";
import { extractMeetCode } from "@/lib/integrations/google/meet-code";
import { calendarUnavailableReason } from "@/lib/meetings/calendar";
import { listMeetings } from "@/lib/meetings/service";

type NextMeetingResult = Awaited<ReturnType<typeof loadNextRecorderMeeting>>;
const cache = new Map<
    string,
    { identity: string; expires: number; result: Promise<NextMeetingResult> }
>();

/** Build a Meet URL from a validated room code and the connected Google identity. */
export function recorderJoinUrl(
    code: string | null | undefined,
    email: string,
): string | null {
    if (!code || !/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(code) || !email.trim())
        return null;
    const validated = extractMeetCode({
        hangoutLink: `https://meet.google.com/${code}`,
    });
    return validated
        ? `https://meet.google.com/${validated}?authuser=${encodeURIComponent(email)}`
        : null;
}

/** Prefer an ongoing Meet event, otherwise the earliest start in the next twelve hours. */
export function selectNextRecorderMeeting(
    events: CalendarEventCandidate[],
    at: Date,
) {
    const now = at.getTime();
    return (
        events
            .filter(
                (event) =>
                    event.meetingCode &&
                    Date.parse(event.end) > now &&
                    Date.parse(event.start) < now + 12 * 3600000,
            )
            .sort(
                (a, b) =>
                    Number(Date.parse(b.start) <= now) -
                        Number(Date.parse(a.start) <= now) ||
                    a.start.localeCompare(b.start) ||
                    a.id.localeCompare(b.id),
            )[0] ?? null
    );
}

/** Recorder-only disclosure of the caller's own primary-calendar Meet event. */
export async function nextRecorderMeeting(userId: string, at = new Date()) {
    const reason = await calendarUnavailableReason(userId);
    if (reason) {
        cache.delete(userId);
        return { data: null, reason };
    }
    const connection = await getGoogleConnectionStatus(userId);
    if (!connection?.email) {
        cache.delete(userId);
        return { data: null, reason: "not_connected" };
    }
    const identity = JSON.stringify(connection);
    const now = Date.now();
    const cached = cache.get(userId);
    if (cached?.identity === identity && cached.expires > now)
        return cached.result;
    for (const [id, entry] of cache) if (entry.expires <= now) cache.delete(id);
    const result = loadNextRecorderMeeting(userId, at, connection.email);
    cache.set(userId, { identity, expires: now + 60000, result });
    return result;
}

async function loadNextRecorderMeeting(
    userId: string,
    at: Date,
    email: string,
) {
    try {
        const events = await listUpcomingCalendarEvents(
            userId,
            at,
            new Date(at.getTime() + 12 * 3600000),
            {
                participantEmail: email,
            },
        );
        const event = selectNextRecorderMeeting(events, at);
        if (!event) return { data: null };
        const joinUrl = recorderJoinUrl(event.meetingCode, email);
        if (!joinUrl) return { data: null };
        const agendas = await listMeetings(userId, {
            calendarEventId: event.id,
            includePast: true,
            includeAbsorbed: true,
        });
        return {
            data: {
                eventId: event.id,
                title: event.title,
                start: event.start,
                end: event.end,
                ongoing: Date.parse(event.start) <= at.getTime(),
                joinUrl,
                accountEmail: email,
                agendaId: agendas[0]?.id ?? null,
            },
        };
    } catch {
        return { data: null, reason: "calendar_unavailable" };
    }
}
