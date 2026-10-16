export const GOOGLE_MEET_READ_SCOPE =
    "https://www.googleapis.com/auth/meetings.space.readonly";

/** Scopes for incremental Meet consent, retaining the current Google grant. */
export function meetConsentScopes(existingScopes: string[]): string[] {
    return [
        ...new Set([
            "openid",
            "email",
            ...existingScopes,
            GOOGLE_MEET_READ_SCOPE,
        ]),
    ];
}

/** Calendar and Meet scopes for one consent screen, retaining existing access. */
export function calendarAndMeetConsentScopes(
    existingScopes: string[],
    calendarScope: string,
): string[] {
    return [
        ...new Set([
            "openid",
            "email",
            ...existingScopes,
            calendarScope,
            GOOGLE_MEET_READ_SCOPE,
        ]),
    ];
}
