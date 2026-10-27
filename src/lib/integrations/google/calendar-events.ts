import { deploymentProductName } from "@/lib/deployment-brand";
import { AppError, ErrorCode } from "@/lib/errors";
import {
    GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE,
    GOOGLE_CALENDAR_EVENTS_WRITE_SCOPE,
    getGoogleOAuthConfig,
} from "./config";
import {
    getGoogleAccessToken,
    getGoogleConnectionStatus,
    invalidateGoogleAccessToken,
} from "./connection";
import { extractMeetCode } from "./meet-code";

const API_URL =
    "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const MARGIN_MS = 30 * 60_000;
const MAX_WINDOW_MS = 12 * 60 * 60_000;

export interface CalendarEventCandidate {
    id: string;
    title: string;
    start: string;
    end: string;
    attendees: { name: string; email?: string }[];
    recurringEventId?: string | null;
    organizer?: { self: boolean; name?: string };
    description?: string;
    htmlLink?: string;
    /** Meet code read from the event list; never returned to the browser. */
    meetingCode?: string | null;
}

interface CalendarEventResponse {
    items?: {
        id?: string;
        summary?: string;
        recurringEventId?: string;
        recurrence?: string[];
        organizer?: { self?: boolean; displayName?: string };
        description?: string;
        htmlLink?: string;
        status?: string;
        start?: { dateTime?: string };
        end?: { dateTime?: string };
        hangoutLink?: string;
        conferenceData?: {
            entryPoints?: { entryPointType?: string; uri?: string }[];
        };
        attendeesOmitted?: boolean;
        attendees?: {
            displayName?: string;
            email?: string;
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
        "nextPageToken,items(id,summary,recurringEventId,status,hangoutLink,conferenceData,start/dateTime,end/dateTime,attendeesOmitted,attendees(displayName,email,responseStatus,resource,self))",
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
                recurringEventId: event.recurringEventId ?? null,
                meetingCode: extractMeetCode(event),
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
                                      (typeof attendee.displayName ===
                                          "string" ||
                                          typeof attendee.email === "string") &&
                                      !attendee.resource &&
                                      !attendee.self &&
                                      attendee.responseStatus !== "declined",
                              )
                              .slice(0, 100)
                              .map((attendee) => ({
                                  name: (typeof attendee.displayName ===
                                  "string"
                                      ? attendee.displayName
                                      : ""
                                  )
                                      .trim()
                                      .slice(0, 120),
                                  ...(typeof attendee.email === "string"
                                      ? { email: attendee.email.trim() }
                                      : {}),
                              }))
                              .filter(
                                  (attendee) =>
                                      attendee.name.length > 0 ||
                                      Boolean(attendee.email),
                              ),
            },
        ];
    });
}

const EVENT_FIELDS =
    "id,summary,recurringEventId,recurrence,status,description,htmlLink,organizer(self,displayName),hangoutLink,conferenceData,start/dateTime,end/dateTime,attendeesOmitted,attendees(displayName,email,responseStatus,resource,self)";

type GoogleEvent = NonNullable<CalendarEventResponse["items"]>[number];

function upcomingCandidate(event: GoogleEvent): CalendarEventCandidate | null {
    const start = Date.parse(event.start?.dateTime ?? "");
    const end = Date.parse(event.end?.dateTime ?? "");
    if (
        !event.id ||
        event.status === "cancelled" ||
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        end <= start ||
        event.attendees?.some(
            (attendee) =>
                attendee.self && attendee.responseStatus === "declined",
        )
    )
        return null;
    return {
        id: event.id,
        title: (event.summary ?? "Meeting").slice(0, 500),
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        recurringEventId: event.recurringEventId ?? null,
        organizer: {
            self: event.organizer?.self === true,
            name: event.organizer?.displayName,
        },
        description: event.description ?? "",
        htmlLink: event.htmlLink,
        meetingCode: extractMeetCode(event),
        attendees: event.attendeesOmitted
            ? []
            : (event.attendees ?? [])
                  .filter(
                      (attendee) =>
                          !attendee.resource &&
                          !attendee.self &&
                          attendee.responseStatus !== "declined",
                  )
                  .slice(0, 100)
                  .map((attendee) => ({
                      name: (attendee.displayName ?? "").trim().slice(0, 120),
                      ...(attendee.email
                          ? { email: attendee.email.trim() }
                          : {}),
                  }))
                  .filter((attendee) => attendee.name || attendee.email),
    };
}

async function calendarRequest(
    userId: string,
    url: URL,
    options: {
        fetchImpl?: typeof fetch;
        write?: boolean;
        init?: RequestInit;
    } = {},
) {
    if (!getGoogleOAuthConfig())
        throw new AppError(
            ErrorCode.SERVICE_UNAVAILABLE,
            "Google Calendar is unavailable",
            503,
        );
    const connection = await getGoogleConnectionStatus(userId);
    const scope = options.write
        ? GOOGLE_CALENDAR_EVENTS_WRITE_SCOPE
        : connection?.scopes.includes(GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE)
          ? GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE
          : GOOGLE_CALENDAR_EVENTS_WRITE_SCOPE;
    if (connection?.status !== "active" || !connection.scopes.includes(scope))
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Connect Google Calendar with the required permission",
            409,
        );
    const token = await getGoogleAccessToken(userId, {
        expectedSubject: connection.subject,
        requiredScope: scope,
        fetchImpl: options.fetchImpl,
    });
    const response = await (options.fetchImpl ?? fetch)(url, {
        ...options.init,
        headers: { ...options.init?.headers, Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
    });
    if (response.status === 401) invalidateGoogleAccessToken(userId);
    if (!response.ok)
        throw new AppError(
            response.status === 404
                ? ErrorCode.NOT_FOUND
                : ErrorCode.SERVICE_UNAVAILABLE,
            `Calendar returned ${response.status}`,
            response.status === 404 ? 404 : 502,
        );
    return response;
}

/** Upcoming timed events from the primary calendar, with bounded complete pagination. */
export async function listUpcomingCalendarEvents(
    userId: string,
    from: Date,
    to: Date,
    options: { fetchImpl?: typeof fetch; seriesId?: string } = {},
): Promise<CalendarEventCandidate[]> {
    if (
        !Number.isFinite(from.getTime()) ||
        !Number.isFinite(to.getTime()) ||
        to <= from ||
        to.getTime() - from.getTime() > 366 * 86400000
    )
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Invalid Calendar window",
            400,
        );
    const url = new URL(
        options.seriesId
            ? `${API_URL}/${encodeURIComponent(options.seriesId)}/instances`
            : API_URL,
    );
    url.searchParams.set("timeMin", from.toISOString());
    url.searchParams.set("timeMax", to.toISOString());
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("showDeleted", "false");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("maxResults", "250");
    url.searchParams.set("fields", `nextPageToken,items(${EVENT_FIELDS})`);
    const events: CalendarEventCandidate[] = [];
    for (let page = 0; page < 10; page++) {
        const response = await calendarRequest(userId, url, options);
        const data = (await response.json()) as CalendarEventResponse;
        for (const event of data.items ?? []) {
            const candidate = upcomingCandidate(event);
            if (candidate) events.push(candidate);
        }
        if (!data.nextPageToken) return events;
        url.searchParams.set("pageToken", data.nextPageToken);
    }
    throw new AppError(
        ErrorCode.SERVICE_UNAVAILABLE,
        "Calendar pagination limit reached; choose a shorter window",
        502,
    );
}

/** Fresh instance read used for event linking and the organizer-only export check. */
export async function getCalendarEvent(
    userId: string,
    eventId: string,
    fetchImpl?: typeof fetch,
): Promise<CalendarEventCandidate> {
    const url = new URL(`${API_URL}/${encodeURIComponent(eventId)}`);
    url.searchParams.set("fields", EVENT_FIELDS);
    const response = await calendarRequest(userId, url, { fetchImpl });
    const rawEvent = (await response.json()) as GoogleEvent;
    const event = rawEvent.recurrence?.length
        ? null
        : upcomingCandidate(rawEvent);
    if (!event)
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Choose a timed Calendar event you have not declined",
            400,
        );
    return event;
}

/** Replace only our marked block, recognizing both English and Czech exports. */
export function replaceAgendaDescription(
    description: string,
    markdown: string,
    locale: "en" | "cs-CZ" = "en",
): string {
    const block =
        locale === "cs-CZ"
            ? `--- Agenda z ${deploymentProductName(locale, "genitive")} ---\n${markdown}\n--- konec agendy ---`
            : `--- Agenda from ${deploymentProductName(locale)} ---\n${markdown}\n--- end of agenda ---`;
    const marked =
        /--- (?:Agenda from Chatterbox|Agenda z Klepny) ---[\s\S]*?--- (?:end of agenda|konec agendy) ---/gu;
    let replaced = false;
    const updated = description.replace(marked, () => {
        if (replaced) return "";
        replaced = true;
        return block;
    });
    return replaced
        ? updated
        : `${description}${description ? "\n\n" : ""}${block}`;
}

/** Explicit export to one occurrence, with optimistic HTTP concurrency and no invitation emails. */
export async function writeCalendarAgenda(
    userId: string,
    eventId: string,
    markdown: string,
    locale: "en" | "cs-CZ" = "en",
    fetchImpl?: typeof fetch,
) {
    const url = new URL(`${API_URL}/${encodeURIComponent(eventId)}`);
    const read = await calendarRequest(userId, url, { fetchImpl });
    const event = (await read.json()) as GoogleEvent & { etag?: string };
    if (!event.organizer?.self)
        throw new AppError(
            ErrorCode.FORBIDDEN,
            "Only the event organizer may export the agenda",
            403,
        );
    if (event.recurrence?.length || !upcomingCandidate(event))
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Choose a timed event occurrence",
            400,
        );
    url.searchParams.set("sendUpdates", "none");
    const response = await calendarRequest(userId, url, {
        fetchImpl,
        write: true,
        init: {
            method: "PATCH",
            headers: {
                "Content-Type": "application/json",
                ...(event.etag ? { "If-Match": event.etag } : {}),
            },
            body: JSON.stringify({
                description: replaceAgendaDescription(
                    event.description ?? "",
                    markdown,
                    locale,
                ),
            }),
        },
    });
    return {
        eventId,
        htmlLink: ((await response.json()) as GoogleEvent).htmlLink ?? null,
    };
}
