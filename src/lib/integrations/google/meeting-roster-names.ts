/** Compares attendee names without case, spacing or diacritics. */
export function attendeeNameKey(name: string): string {
    return name
        .normalize("NFD")
        .replace(/\p{M}/gu, "")
        .toLowerCase()
        .trim()
        .replace(/\s+/g, " ");
}
