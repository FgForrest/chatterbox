export const TIME_ZONE_COOKIE = "viewer-time-zone";

/** Validate and canonicalize an IANA time zone. */
export function validTimeZone(value: unknown): string | null {
    if (typeof value !== "string" || !value || value.length > 100) return null;
    try {
        if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(value)) return null;
        return new Intl.DateTimeFormat("en", {
            timeZone: value,
        }).resolvedOptions().timeZone;
    } catch {
        return null;
    }
}

/** Decode an optional browser cookie, retaining absence for default resolution. */
export function browserTimeZone(
    value: string | null | undefined,
): string | null {
    try {
        return validTimeZone(decodeURIComponent(value ?? ""));
    } catch {
        return null;
    }
}

/** Validate a browser IANA time zone; missing or malformed cookies use UTC. */
export function timeZoneFromCookie(value: string | null | undefined): string {
    return browserTimeZone(value) ?? "UTC";
}

/** Resolve preferences for a page (with cookie) or background work (without one). */
export function resolveTimeZone(input: {
    user?: string | null;
    cookie?: string | null;
    organization?: string | null;
}): string {
    return (
        validTimeZone(input.user) ??
        browserTimeZone(input.cookie) ??
        validTimeZone(input.organization) ??
        "UTC"
    );
}

/** Format an instant for a datetime-local field in the resolved viewer zone. */
export function dateTimeInput(value: string | null, timeZone: string): string {
    if (!value) return "";
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
    }).formatToParts(new Date(value));
    const part = (type: Intl.DateTimeFormatPartTypes) =>
        parts.find((part) => part.type === type)?.value;
    return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

/** Interpret a datetime-local value in a zone; reject nonexistent daylight-saving times. */
export function dateTimeInputIso(
    value: string,
    timeZone: string,
): string | null {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
    const wall = Date.parse(`${value}:00Z`);
    if (!Number.isFinite(wall)) return null;
    let instant = wall;
    for (let attempt = 0; attempt < 3; attempt++) {
        const local = dateTimeInput(new Date(instant).toISOString(), timeZone);
        if (local === value) return new Date(instant).toISOString();
        instant += wall - Date.parse(`${local}:00Z`);
    }
    return null;
}
