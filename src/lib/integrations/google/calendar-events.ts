import { GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE } from "./config";
import {
    getGoogleAccessToken,
    getGoogleConnectionStatus,
    invalidateGoogleAccessToken,
} from "./connection";

const API_URL =
    "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const MARGIN_MS = 30 * 60_000;
const MAX_WINDOW_MS = 12 * 60 * 60_000;

export interface CalendarEventCandidate {
    id: string;
    title: string;
    start: string;
    end: string;
    attendees: { name: string }[];
}

interface CalendarEventResponse {
    items?: {
        id?: string;
        summary?: string;
        status?: string;
        start?: { dateTime?: string };
        end?: { dateTime?: string };
        attendeesOmitted?: boolean;
        attendees?: {
            displayName?: string;
            responseStatus?: string;
            resource?: boolean;
            self?: boolean;
        }[];
    }[];
    nextPageToken?: string;
}

/** On-demand events on the owner's primary calendar near one recording. */
export async function listCalendarEventsForRecording(input: {
    userId: string;
    start: Date;
    end: Date;
    fetchImpl?: typeof fetch;
}): Promise<CalendarEventCandidate[]> {
    const connection = await getGoogleConnectionStatus(input.userId);
    if (
        connection?.status !== "active" ||
        !connection.scopes.includes(GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE)
    ) {
        return [];
    }
    const startMs = input.start.getTime();
    const endMs = input.end.getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];
    const boundedEnd = Math.min(
        Math.max(startMs, endMs),
        startMs + MAX_WINDOW_MS,
    );
    const url = new URL(API_URL);
    url.searchParams.set(
        "timeMin",
        new Date(startMs - MARGIN_MS).toISOString(),
    );
    url.searchParams.set(
        "timeMax",
        new Date(boundedEnd + MARGIN_MS).toISOString(),
    );
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("showDeleted", "false");
    url.searchParams.set("maxResults", "100");
    url.searchParams.set("maxAttendees", "100");
    url.searchParams.set(
        "fields",
        "nextPageToken,items(id,summary,status,start/dateTime,end/dateTime,attendeesOmitted,attendees(displayName,responseStatus,resource,self))",
    );
    const token = await getGoogleAccessToken(input.userId, {
        expectedSubject: connection.subject,
        requiredScope: GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE,
        fetchImpl: input.fetchImpl,
    });
    const response = await (input.fetchImpl ?? fetch)(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8_000),
    });
    if (response.status === 401) invalidateGoogleAccessToken(input.userId);
    if (!response.ok) throw new Error(`Calendar returned ${response.status}`);
    const data = (await response.json()) as CalendarEventResponse;
    if (!Array.isArray(data.items)) return [];
    if (data.nextPageToken) return [];
    return data.items.flatMap((event) => {
        if (!event || typeof event !== "object") return [];
        const eventStart = Date.parse(event.start?.dateTime ?? "");
        const eventEnd = Date.parse(event.end?.dateTime ?? "");
        if (
            typeof event.id !== "string" ||
            event.status === "cancelled" ||
            !Number.isFinite(eventStart) ||
            !Number.isFinite(eventEnd) ||
            eventStart > boundedEnd + MARGIN_MS ||
            eventEnd < startMs - MARGIN_MS
        )
            return [];
        return [
            {
                id: event.id,
                title: (typeof event.summary === "string"
                    ? event.summary
                    : "Meeting"
                ).slice(0, 200),
                start: new Date(eventStart).toISOString(),
                end: new Date(eventEnd).toISOString(),
                attendees:
                    event.attendeesOmitted || !Array.isArray(event.attendees)
                        ? []
                        : (event.attendees ?? [])
                              .filter(
                                  (attendee) =>
                                      attendee &&
                                      typeof attendee.displayName ===
                                          "string" &&
                                      !attendee.resource &&
                                      !attendee.self &&
                                      attendee.responseStatus !== "declined",
                              )
                              .slice(0, 100)
                              .map((attendee) => ({
                                  name: (attendee.displayName ?? "")
                                      .trim()
                                      .slice(0, 120),
                              }))
                              .filter((attendee) => attendee.name.length > 0),
            },
        ];
    });
}
