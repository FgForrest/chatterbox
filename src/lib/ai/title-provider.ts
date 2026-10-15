/** Read the title provider selection from the existing provider preferences. */
export function titleProviderId(value: unknown): string | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    const id = (value as Record<string, unknown>).title;
    return typeof id === "string" && id.length > 0 ? id : null;
}
