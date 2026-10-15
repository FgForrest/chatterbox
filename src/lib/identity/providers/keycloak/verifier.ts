import { expandGrants } from "@/lib/authz/policy";
import {
    type AccessVerification,
    type AccessVerifierPort,
    IdentityProviderError,
} from "@/lib/identity/ports";
import { KeycloakAccessReader } from "@/lib/identity/providers/keycloak/admin";
import type { KeycloakConfig } from "@/lib/identity/providers/keycloak/config";
import { createKeycloakHttp } from "@/lib/identity/providers/keycloak/http";

const TOKEN_TIMEOUT_MS = 10_000;
const EXPIRY_MARGIN_MS = 30_000;

/**
 * A client-credentials token source for the verifier's service client.
 * The token is kept in memory only, until shortly before it expires.
 */
export function clientCredentialsToken(
    config: KeycloakConfig,
    credentials: { clientId: string; clientSecret: string },
): () => Promise<string> {
    let cached: { token: string; expiresAt: number } | null = null;
    let pending: Promise<string> | null = null;
    const tokenUrl = `${config.baseUrl}/realms/${encodeURIComponent(config.realm)}/protocol/openid-connect/token`;

    async function fetchToken(): Promise<string> {
        let response: Response;
        try {
            response = await fetch(tokenUrl, {
                method: "POST",
                headers: {
                    "content-type": "application/x-www-form-urlencoded",
                    authorization: `Basic ${Buffer.from(
                        `${encodeURIComponent(credentials.clientId)}:${encodeURIComponent(credentials.clientSecret)}`,
                    ).toString("base64")}`,
                },
                body: new URLSearchParams({ grant_type: "client_credentials" }),
                signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
            });
        } catch {
            throw new IdentityProviderError(
                "unavailable",
                "The identity provider could not be reached",
            );
        }
        if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            throw new IdentityProviderError(
                response.status >= 500 ? "unavailable" : "unauthorized",
                "The access verifier could not obtain a token",
                response.status,
            );
        }
        const body = (await response.json().catch(() => null)) as {
            access_token?: unknown;
            expires_in?: unknown;
        } | null;
        if (typeof body?.access_token !== "string") {
            throw new IdentityProviderError(
                "invalid_response",
                "The identity provider sent no access token",
            );
        }
        const lifetime =
            typeof body.expires_in === "number"
                ? body.expires_in * 1000
                : 60_000;
        cached = {
            token: body.access_token,
            expiresAt: Date.now() + lifetime - EXPIRY_MARGIN_MS,
        };
        return body.access_token;
    }

    return async () => {
        if (cached && cached.expiresAt > Date.now()) return cached.token;
        pending ??= fetchToken().finally(() => {
            pending = null;
        });
        return pending;
    };
}

/**
 * Re-verifies a subject's access with the realm's read-only verifier client
 * (`realm-management/view-users` and `view-clients`): whether the user still exists, is
 * enabled, and which capabilities their tokens carry now.
 */
export function keycloakVerifier(config: KeycloakConfig): AccessVerifierPort {
    const credentials = config.verifier;
    if (!credentials) {
        throw new Error("The Keycloak access verifier is not configured");
    }
    const reader = new KeycloakAccessReader(
        createKeycloakHttp({
            baseUrl: config.baseUrl,
            realm: config.realm,
            token: clientCredentialsToken(config, credentials),
        }),
        config,
    );
    return {
        async verify(subjectId: string): Promise<AccessVerification> {
            const user = await reader.user(subjectId);
            if (!user) return { status: "missing" };
            if (user.enabled === false) return { status: "disabled" };
            return {
                status: "active",
                capabilities: expandGrants(
                    await reader.effectiveCapabilities(subjectId),
                ),
            };
        },
    };
}
