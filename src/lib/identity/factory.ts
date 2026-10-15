import { env } from "@/lib/env";
import type {
    AccessManagementPort,
    AccessVerifierPort,
    IdentityClaimsProvider,
} from "@/lib/identity/ports";
import { keycloakAdmin } from "@/lib/identity/providers/keycloak/admin";
import { keycloakClaims } from "@/lib/identity/providers/keycloak/claims";
import {
    type KeycloakConfig,
    keycloakConfigFromEnv,
} from "@/lib/identity/providers/keycloak/config";
import { keycloakVerifier } from "@/lib/identity/providers/keycloak/verifier";

/** Whether the identity provider grants the capabilities (AUTHZ_MODE=idp). */
export function isIdpAuthorization(): boolean {
    return env.AUTHZ_MODE === "idp";
}

function keycloakConfig(): KeycloakConfig {
    const config = keycloakConfigFromEnv(env);
    if (!config) {
        throw new Error(
            "IDENTITY_PROVIDER=keycloak needs OIDC_ISSUER_URL of a Keycloak realm and OIDC_CLIENT_ID",
        );
    }
    return config;
}

/**
 * The claims contract of the configured provider. MCP tokens follow the
 * Keycloak contract in either authorization mode, so that is the default.
 */
export function getClaimsProvider(): IdentityClaimsProvider {
    const provider = env.IDENTITY_PROVIDER ?? "keycloak";
    if (provider !== "keycloak") {
        throw new Error(`Unknown IDENTITY_PROVIDER ${String(provider)}`);
    }
    return keycloakClaims({
        rolesClient: env.KEYCLOAK_ROLES_CLIENT ?? env.OIDC_CLIENT_ID ?? "",
        mcpAudience: env.MCP_AUDIENCE ?? null,
        permissionsSource: isIdpAuthorization() ? "scope" : "roles",
    });
}

/** Supplies the signed-in administrator's provider access token, server-side. */
export type AdminTokenSource = () => Promise<string>;

/**
 * Access management on behalf of the administrator whose token `token`
 * supplies, or null when this installation does not manage access at the
 * provider (local mode, or no managed groups configured).
 */
export function accessManagementFor(
    token: AdminTokenSource,
): AccessManagementPort | null {
    if (!isIdpAuthorization()) return null;
    const config = keycloakConfig();
    if (!config.groups) return null;
    return keycloakAdmin(config, token);
}

let verifier: { key: string; port: AccessVerifierPort } | null = null;

/**
 * The read-only access verifier, or null when none is configured. One per
 * configuration, so its client-credentials token is reused until it
 * expires.
 */
export function getAccessVerifier(): AccessVerifierPort | null {
    if (!isIdpAuthorization()) return null;
    const config = keycloakConfig();
    if (!config.verifier) return null;
    const key = JSON.stringify(config);
    if (verifier?.key !== key) {
        verifier = { key, port: keycloakVerifier(config) };
    }
    return verifier.port;
}
