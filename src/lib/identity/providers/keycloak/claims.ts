import type { JWTPayload } from "jose";
import {
    type Capability,
    isCapability,
    isMcpPermission,
    type McpPermission,
} from "@/lib/authz/catalog";
import { expandGrants } from "@/lib/authz/policy";
import type {
    IdentityClaimsProvider,
    McpTokenProfile,
    VerifiedIdentity,
} from "@/lib/identity/ports";

/**
 * Claim configured through a hardcoded claim mapper on the
 * access tokens of a service-only client. A person's token never has it:
 * the client allows no interactive flow.
 */
export const SERVICE_MARKER_CLAIM = "chatterbox_subject_kind";
export const SERVICE_MARKER_VALUE = "service";

function ownProperty(value: unknown, key: string): unknown {
    return typeof value === "object" &&
        value !== null &&
        Object.hasOwn(value, key)
        ? (value as Record<string, unknown>)[key]
        : undefined;
}

/**
 * The client roles of `client` in `resource_access`. The client id is a
 * literal key (it may contain dots or slashes), never a path.
 */
export function clientRoles(claims: JWTPayload, client: string): string[] {
    const roles = ownProperty(
        ownProperty(claims.resource_access, client),
        "roles",
    );
    return Array.isArray(roles)
        ? roles.filter((role): role is string => typeof role === "string")
        : [];
}

function stringClaim(claims: JWTPayload, name: string): string | null {
    const value = claims[name];
    return typeof value === "string" && value ? value : null;
}

/** The client a token was issued to: `azp`, else `client_id`. */
export function tokenClient(claims: JWTPayload): string | null {
    return stringClaim(claims, "azp") ?? stringClaim(claims, "client_id");
}

/** The Keycloak claims contract. */
export function keycloakClaims(options: {
    rolesClient: string;
    mcpAudience: string | null;
    permissionsSource?: "scope" | "roles";
}): IdentityClaimsProvider {
    return {
        id: "keycloak",
        acceptsIdToken: (claims, clientId) =>
            (claims.typ === undefined || claims.typ === "ID") &&
            (claims.azp === undefined || claims.azp === clientId),
        acceptsAccessToken: (claims, clientId) =>
            claims.typ === "Bearer" &&
            (clientId === undefined || claims.azp === clientId),
        tokenClient,

        identityFromIdToken(
            issuer: string,
            claims: JWTPayload,
        ): VerifiedIdentity | null {
            const subject = stringClaim(claims, "sub");
            if (!subject) return null;
            const email = stringClaim(claims, "email")?.toLowerCase() ?? null;
            const joined = [
                stringClaim(claims, "given_name"),
                stringClaim(claims, "family_name"),
            ]
                .filter(Boolean)
                .join(" ");
            const authTime =
                typeof claims.auth_time === "number" &&
                Number.isFinite(claims.auth_time)
                    ? new Date(claims.auth_time * 1000)
                    : null;
            return {
                issuer,
                subject,
                email,
                emailVerified: claims.email_verified === true,
                name:
                    stringClaim(claims, "name") ??
                    (joined || stringClaim(claims, "preferred_username")),
                authTime,
            };
        },

        capabilitiesFromAccessToken(claims: JWTPayload): Set<Capability> {
            return expandGrants<Capability>(
                clientRoles(claims, options.rolesClient).filter(isCapability),
            );
        },

        mcpTokenProfile(
            claims: JWTPayload,
            { serviceClients }: { serviceClients: readonly string[] },
        ): McpTokenProfile {
            const clientId = tokenClient(claims);
            const permissions = new Set<McpPermission>(
                [
                    ...expandGrants(
                        options.permissionsSource === "roles"
                            ? options.mcpAudience
                                ? clientRoles(
                                      claims,
                                      options.mcpAudience,
                                  ).filter(isMcpPermission)
                                : []
                            : typeof claims.scope === "string"
                              ? claims.scope
                                    .split(/\s+/)
                                    .filter(isMcpPermission)
                              : [],
                    ),
                ].filter(isMcpPermission),
            );
            const service =
                clientId !== null &&
                serviceClients.includes(clientId) &&
                stringClaim(claims, "client_id") === clientId &&
                claims[SERVICE_MARKER_CLAIM] === SERVICE_MARKER_VALUE;
            return {
                kind: service ? "service" : "user",
                clientId,
                permissions,
            };
        },
    };
}
