import { decrypt } from "@/lib/encryption";
import { decodeAccessTokenExpiry } from "./auth";

/** Read stored expiries or derive the expiry of a legacy access token. */
export function getPlaudTokenExpiries(connection: {
    bearerToken: string;
    refreshToken: string | null;
    accessExpiresAt: Date | null;
    sessionExpiresAt: Date | null;
}): { accessExpiresAt: Date | null; sessionExpiresAt: Date | null } {
    let accessExpiresAt = connection.accessExpiresAt ?? null;
    if (!accessExpiresAt) {
        try {
            accessExpiresAt = decodeAccessTokenExpiry(
                decrypt(connection.bearerToken),
            );
        } catch {
            // An unreadable legacy token has no expiry to display or backfill.
        }
    }
    return {
        accessExpiresAt,
        sessionExpiresAt:
            connection.sessionExpiresAt ??
            (connection.refreshToken ? null : accessExpiresAt),
    };
}
