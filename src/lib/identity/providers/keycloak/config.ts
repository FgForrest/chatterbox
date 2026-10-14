import type { Capability } from "@/lib/authz/catalog";
import type { Env } from "@/lib/env";
import { KEYCLOAK_ISSUER_PATH } from "@/lib/identity/providers/keycloak/issuer";

/** Everything the Keycloak adapter needs, from validated configuration only. */
export interface KeycloakConfig {
    /** Server base URL (before `/realms/...`), as the server reaches it. */
    baseUrl: string;
    realm: string;
    /** Client whose client roles carry the capabilities. */
    rolesClient: string;
    /** Client whose client roles carry the MCP permissions; null when MCP is off. */
    mcpAudience: string | null;
    /** The managed group of each capability; null when access management is off. */
    groups: Readonly<Record<Capability, string>> | null;
    /** The read-only access verifier client; null when not configured. */
    verifier: { clientId: string; clientSecret: string } | null;
}

/** Base URL and realm of a Keycloak issuer (`<base>/realms/<realm>`), or null. */
export function keycloakRealmFromIssuer(
    issuer: string,
): { baseUrl: string; realm: string } | null {
    let url: URL;
    try {
        url = new URL(issuer);
    } catch {
        return null;
    }
    const match = KEYCLOAK_ISSUER_PATH.exec(url.pathname.replace(/\/+$/, ""));
    if (!match?.[2]) return null;
    return {
        baseUrl: `${url.origin}${match[1] ?? ""}`,
        realm: decodeURIComponent(match[2]),
    };
}

/** The Keycloak adapter's configuration, or null when Keycloak is not in use. */
export function keycloakConfigFromEnv(
    env: Pick<
        Env,
        | "OIDC_ISSUER_URL"
        | "OIDC_CLIENT_ID"
        | "MCP_AUDIENCE"
        | "KEYCLOAK_ROLES_CLIENT"
        | "KEYCLOAK_GROUP_USE_ID"
        | "KEYCLOAK_GROUP_CURATE_ID"
        | "KEYCLOAK_GROUP_ACCESS_MANAGE_ID"
        | "KEYCLOAK_VERIFIER_CLIENT_ID"
        | "KEYCLOAK_VERIFIER_CLIENT_SECRET"
    >,
): KeycloakConfig | null {
    const issuer = env.OIDC_ISSUER_URL;
    const rolesClient = env.KEYCLOAK_ROLES_CLIENT ?? env.OIDC_CLIENT_ID;
    if (!issuer || !rolesClient) return null;
    const realm = keycloakRealmFromIssuer(issuer);
    if (!realm) return null;
    const groups =
        env.KEYCLOAK_GROUP_USE_ID &&
        env.KEYCLOAK_GROUP_CURATE_ID &&
        env.KEYCLOAK_GROUP_ACCESS_MANAGE_ID
            ? {
                  use: env.KEYCLOAK_GROUP_USE_ID,
                  "org.curate": env.KEYCLOAK_GROUP_CURATE_ID,
                  "access.manage": env.KEYCLOAK_GROUP_ACCESS_MANAGE_ID,
              }
            : null;
    const verifier =
        env.KEYCLOAK_VERIFIER_CLIENT_ID && env.KEYCLOAK_VERIFIER_CLIENT_SECRET
            ? {
                  clientId: env.KEYCLOAK_VERIFIER_CLIENT_ID,
                  clientSecret: env.KEYCLOAK_VERIFIER_CLIENT_SECRET,
              }
            : null;
    return {
        ...realm,
        rolesClient,
        mcpAudience: env.MCP_AUDIENCE ?? null,
        groups,
        verifier,
    };
}
