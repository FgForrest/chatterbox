import { extractMeetCode } from "@/lib/integrations/google/meet-code";

/** Accept a bare Meet code, ignoring malformed optional room declarations. */
export function normalizeRecorderMeetCode(value: unknown): string | null {
    if (
        typeof value !== "string" ||
        !/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(value)
    )
        return null;
    return extractMeetCode({ hangoutLink: `https://meet.google.com/${value}` });
}
