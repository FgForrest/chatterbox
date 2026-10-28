/** Format lifecycle dates in UTC, or clock deadlines in the recipient's resolved zone. */
export function formatEmailDate(
    d: Date,
    options?: { month?: "long" | "short"; includeTime?: boolean },
    locale = "en",
    timeZone = "UTC",
): string {
    const datePart = d.toLocaleDateString(locale, {
        year: "numeric",
        month: options?.month ?? "long",
        day: "numeric",
        timeZone: options?.includeTime ? timeZone : "UTC",
    });
    if (!options?.includeTime) return datePart;
    const timePart = d.toLocaleTimeString(locale, {
        hour: "numeric",
        minute: "2-digit",
        timeZone,
        timeZoneName: "short",
    });
    return `${datePart}, ${timePart}`;
}
