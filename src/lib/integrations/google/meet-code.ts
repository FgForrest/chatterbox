interface MeetEventData {
    hangoutLink?: unknown;
    conferenceData?: {
        entryPoints?: Array<{ entryPointType?: unknown; uri?: unknown }>;
    };
}

function codeFromUrl(value: unknown): string | null {
    if (typeof value !== "string") return null;
    try {
        const url = new URL(value);
        if (
            url.protocol !== "https:" ||
            url.hostname.toLowerCase() !== "meet.google.com" ||
            url.port ||
            url.username ||
            url.password
        ) {
            return null;
        }
        const match = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})\/?$/i.exec(url.pathname);
        return match?.[1]?.toLowerCase() ?? null;
    } catch {
        return null;
    }
}

/** A Meet code only when Calendar's event supplies an unambiguous Meet URL. */
export function extractMeetCode(event: MeetEventData): string | null {
    const codes = new Set<string>();
    const hangoutCode = codeFromUrl(event.hangoutLink);
    if (hangoutCode) codes.add(hangoutCode);
    for (const entry of event.conferenceData?.entryPoints ?? []) {
        if (entry.entryPointType !== "video") continue;
        const code = codeFromUrl(entry.uri);
        if (code) codes.add(code);
    }
    return codes.size === 1 ? [...codes][0] : null;
}
