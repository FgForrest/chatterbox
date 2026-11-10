/** Validated Google Meet room identity, independent of redirects and account selection. */
export function meetCode(value) {
    try {
        const url = value instanceof URL ? value : new URL(value);
        if (url.protocol !== "https:" || url.hostname !== "meet.google.com" ||
            url.port || url.username || url.password) return null;
        return /^\/(?:meet\/)?([a-z]{3}-[a-z]{4}-[a-z]{3})\/?$/i
            .exec(url.pathname)?.[1]?.toLowerCase() ?? null;
    } catch {
        return null;
    }
}
