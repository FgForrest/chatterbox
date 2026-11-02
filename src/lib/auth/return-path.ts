/** Validate a login destination as a local path, falling back to the dashboard. */
export function loginReturnPath(value: unknown): string {
    if (typeof value !== "string" || !value.startsWith("/")) {
        return "/dashboard";
    }
    try {
        const decoded = decodeURIComponent(value);
        if (
            decoded.startsWith("//") ||
            decoded.includes("\\") ||
            Array.from(decoded).some((char) => char.charCodeAt(0) < 32)
        ) {
            return "/dashboard";
        }
        const url = new URL(value, "https://example.com");
        if (
            url.origin !== "https://example.com" ||
            url.pathname.startsWith("//")
        ) {
            return "/dashboard";
        }
        return `${url.pathname}${url.search}${url.hash}`;
    } catch {
        return "/dashboard";
    }
}

const SSO_RETURN_PATH_KEY = "auth.ssoReturnPath";

/** Retain the destination across provider redirects that omit the OAuth state. */
export function rememberSsoReturnPath(value: string): void {
    try {
        window.sessionStorage.setItem(
            SSO_RETURN_PATH_KEY,
            loginReturnPath(value),
        );
    } catch {}
}

/** Recover and validate the destination for a failed provider sign-in. */
export function recalledSsoReturnPath(): string {
    try {
        return loginReturnPath(
            window.sessionStorage.getItem(SSO_RETURN_PATH_KEY),
        );
    } catch {
        return "/dashboard";
    }
}

/** Discard the retry destination once an authenticated page starts. */
export function clearSsoReturnPath(): void {
    try {
        window.sessionStorage.removeItem(SSO_RETURN_PATH_KEY);
    } catch {}
}
