import type { IdentityProviderErrorKind } from "@/lib/identity/ports";

/** Why a stored session was removed. */
export type SessionEndCause =
    | "provider-refused"
    | "token-refused"
    | "no-refresh-token"
    | "no-credential"
    | "access-withdrawn"
    | "org-account"
    | "sign-in-superseded"
    | "access-revoked"
    | "sso-enabled"
    | "expired-cleanup"
    | "sign-out"
    | "expired"
    | "password-reset"
    | "session-revoked"
    | "all-sessions-revoked"
    | "other-sessions-revoked"
    | "auth-deleted";

/** Credential timings and provider diagnostics for an ending session. */
export interface SessionEndDetails {
    cause: SessionEndCause;
    verifiedAt?: Date | null;
    authTime?: Date | null;
    refreshTokenExpiresAt?: Date | null;
    providerError?: string;
    providerDetail?: string;
}

type SessionLogFields = {
    user?: string;
    session?: string;
    createdAt?: Date;
    expiresAt?: Date;
    authTime?: Date | null;
    verifiedAt?: Date | null;
    refreshTokenExpiresAt?: Date | null;
    cause?: SessionEndCause;
    kind?: IdentityProviderErrorKind | "superseded";
    providerError?: string;
    providerDetail?: string;
    count?: number;
};

/** Allow only bounded provider error codes in diagnostics. */
export function providerErrorCode(value: unknown): string | undefined {
    return typeof value === "string" && /^[a-z_]{1,40}$/.test(value)
        ? value
        : undefined;
}

/** Allow only bounded provider descriptions without credential-shaped content. */
export function providerErrorDescription(value: unknown): string | undefined {
    return typeof value === "string" &&
        value.length <= 120 &&
        /^[A-Za-z][A-Za-z .,:;'"()-]*$/.test(value) &&
        value.split(" ").every((word) => word.length <= 32)
        ? value
        : undefined;
}

function printable(value: string, quoted = false): string {
    let result = "";
    for (const character of value) {
        const ascii = character >= " " && character <= "~" ? character : " ";
        const escaped = quoted
            ? ascii.replace(/["\\]/g, "\\$&")
            : ascii.replace(/[^a-zA-Z0-9_.:/-]/g, "_");
        if (result.length + escaped.length > 120) break;
        result += escaped;
    }
    return result;
}

/** Write one bounded session event; diagnostics must never affect authentication. */
export function logSession(
    event: "started" | "ended" | "renew-failed",
    fields: SessionLogFields,
): void {
    try {
        const now = Date.now();
        const parts = [`[session] ${event}`];
        const field = (key: string, value: string | number | undefined) => {
            if (value !== undefined) parts.push(`${key}=${value}`);
        };
        const minutes = (date: Date | null | undefined, until = false) => {
            if (!date) return undefined;
            const value = (now - date.getTime()) / 60_000;
            if (!Number.isFinite(value)) return undefined;
            const signed = until ? -value : value;
            return Math.round(signed);
        };
        field(
            "user",
            fields.user === undefined ? undefined : printable(fields.user),
        );
        field(
            "session",
            fields.session === undefined
                ? undefined
                : printable(fields.session),
        );
        if (event === "started") {
            field("expiresAt", fields.expiresAt?.toISOString());
            field("authAgeMin", minutes(fields.authTime));
        } else {
            field("cause", fields.cause);
            field("kind", fields.kind);
            field("count", fields.count);
            field("ageMin", minutes(fields.createdAt));
            field("expiresInMin", minutes(fields.expiresAt, true));
            field("sinceVerifiedMin", minutes(fields.verifiedAt));
            field("sinceAuthMin", minutes(fields.authTime));
            field(
                "refreshExpiresInMin",
                minutes(fields.refreshTokenExpiresAt, true),
            );
            field(
                "providerError",
                fields.providerError === undefined
                    ? undefined
                    : printable(fields.providerError),
            );
            field(
                "providerDetail",
                fields.providerDetail === undefined
                    ? undefined
                    : `"${printable(fields.providerDetail, true)}"`,
            );
        }
        const line = parts.join(" ");
        if (
            event === "renew-failed" ||
            fields.cause === "token-refused" ||
            fields.cause === "no-credential" ||
            fields.cause === "org-account"
        ) {
            console.warn(line);
        } else {
            console.info(line);
        }
    } catch {}
}

/** Log a deleted auth session without affecting the request. */
export function logSessionDeleted(
    session: { id: string; userId: string; createdAt: Date; expiresAt: Date },
    path: string | undefined,
): void {
    try {
        const causes: Record<string, SessionEndCause> = {
            "/sign-out": "sign-out",
            "/reset-password": "password-reset",
            "/revoke-session": "session-revoked",
            "/revoke-sessions": "all-sessions-revoked",
            "/revoke-other-sessions": "other-sessions-revoked",
        };
        const cause =
            session.expiresAt.getTime() <= Date.now()
                ? "expired"
                : (causes[path ?? ""] ?? "auth-deleted");
        logSession("ended", {
            user: session.userId,
            session: session.id,
            cause,
            createdAt: session.createdAt,
            expiresAt: session.expiresAt,
        });
    } catch {}
}
