/** Checks whether a Postgres connection URL contains the bundled default password. */
export function usesDefaultPostgresPassword(databaseUrl?: string): boolean {
    const trimmedUrl = databaseUrl?.trim();
    if (!trimmedUrl) return false;

    try {
        decodeURI(trimmedUrl);
        const firstHostUrl = trimmedUrl.replace(
            /^(postgres(?:ql)?:\/\/[^/?#]*@[^/?#,]+),[^/?#]+/i,
            "$1",
        );
        const { protocol, password } = new URL(firstHostUrl);
        return (
            (protocol === "postgres:" || protocol === "postgresql:") &&
            decodeURIComponent(password) === "postgres"
        );
    } catch {
        return false;
    }
}
