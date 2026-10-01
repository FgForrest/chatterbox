/** Read the Topics selection from the existing provider preferences. */
export function topicsProviderId(value: unknown): string | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    const id = (value as Record<string, unknown>).topics;
    return typeof id === "string" && id.length > 0 ? id : null;
}
