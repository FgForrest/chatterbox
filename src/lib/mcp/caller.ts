import { and, eq, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { accounts, users } from "@/db/schema";
import { holderAccess } from "@/lib/authz/access-state";
import { env } from "@/lib/env";
import { getClaimsProvider, isIdpAuthorization } from "@/lib/identity/factory";
import type { McpRole } from "@/lib/mcp/roles";
import type { McpTokenClaims } from "@/lib/mcp/token";
import { getOrgUserId, isOrgScopeEnabled } from "@/lib/org/config";
import { SSO_PROVIDER_ID } from "@/lib/sso/constants";

interface CallerBase {
    /** The token's `sub`. */
    subject: string;
    /** `azp`, else `client_id`: the client the token was issued to. */
    clientId: string | null;
    /** The MCP permissions the token grants, never empty. */
    roles: Set<McpRole>;
    /** The Organization account, when the instance shows the Organization. */
    orgUserId: string | null;
}

/**
 * Who an MCP request speaks for: a Chatterbox user (the `sub` linked
 * through single sign-on with the token's issuer), or a configured service
 * acting in the Organization's data context.
 */
export type McpCaller =
    | (CallerBase & { kind: "user"; userId: string; email: string })
    | (CallerBase & { kind: "service"; orgUserId: string });

/** Why a verified token gets no caller. */
export type CallerRefusal =
    | "no-roles"
    | "client-not-allowed"
    | "no-account"
    | "no-organization"
    | "suspended"
    | "no-access"
    | "access-unverifiable";

/** The outcome of {@link resolveCaller}. */
export type CallerResult =
    | { ok: true; caller: McpCaller }
    | { ok: false; reason: CallerRefusal };

let warnedLegacyServices = false;

/**
 * Whether an unlinked token may still be a service the way earlier
 * releases decided it (any token carrying `client_id`): only in
 * `AUTHZ_MODE=local` with no MCP_SERVICE_CLIENTS configured. Logged once.
 */
function legacyServiceToken(claims: McpTokenClaims): boolean {
    if (isIdpAuthorization() || env.MCP_SERVICE_CLIENTS.length > 0) {
        return false;
    }
    if (typeof claims.client_id !== "string" || !claims.client_id) {
        return false;
    }
    if (!warnedLegacyServices) {
        warnedLegacyServices = true;
        console.warn(
            "[mcp] a token was taken as a service by its client_id alone; list the service clients in MCP_SERVICE_CLIENTS and mark them (see the MCP docs). This fallback is deprecated.",
        );
    }
    return true;
}

/**
 * Who a verified token speaks for.
 *
 * A person is only ever the account its issuer and `sub` are linked to;
 * an unlinked person is refused, never taken for a service. A service is
 * a token the provider marks as a service token of a client listed in
 * MCP_SERVICE_CLIENTS, admitted only while the Organization scope is
 * enabled. With identity-provider authorization a person also needs a
 * verified `use`. The web sign-in client's tokens are never admitted.
 */
export async function resolveCaller(
    claims: McpTokenClaims,
): Promise<CallerResult> {
    const profile = getClaimsProvider().mcpTokenProfile(claims, {
        serviceClients: env.MCP_SERVICE_CLIENTS,
    });
    const clientId = profile.clientId;
    const allowed = env.MCP_ALLOWED_CLIENTS;
    if (
        (allowed.length > 0 && (!clientId || !allowed.includes(clientId))) ||
        (clientId !== null && clientId === env.OIDC_CLIENT_ID)
    ) {
        return { ok: false, reason: "client-not-allowed" };
    }
    const roles = profile.permissions;
    if (roles.size === 0) return { ok: false, reason: "no-roles" };

    const [linked] = await db
        .select({
            id: users.id,
            email: users.email,
            role: users.role,
            suspendedAt: users.suspendedAt,
        })
        .from(accounts)
        .innerJoin(users, eq(users.id, accounts.userId))
        .where(
            and(
                eq(accounts.providerId, SSO_PROVIDER_ID),
                eq(accounts.accountId, claims.sub),
                typeof claims.iss === "string"
                    ? or(
                          eq(accounts.issuer, claims.iss),
                          isNull(accounts.issuer),
                      )
                    : undefined,
            ),
        )
        .limit(1);
    const orgUserId = await getOrgUserId();
    const base = { subject: claims.sub, clientId, roles };

    if (linked) {
        if (linked.role === "org") return { ok: false, reason: "no-account" };
        if (linked.suspendedAt) return { ok: false, reason: "suspended" };
        if (isIdpAuthorization()) {
            const access = await holderAccess(linked.id);
            if (!access.ok) {
                return {
                    ok: false,
                    reason:
                        access.reason === "unavailable" ||
                        access.reason === "unverifiable"
                            ? "access-unverifiable"
                            : "no-access",
                };
            }
        }
        return {
            ok: true,
            caller: {
                ...base,
                kind: "user",
                userId: linked.id,
                email: linked.email,
                orgUserId,
            },
        };
    }
    if (profile.kind === "service" || legacyServiceToken(claims)) {
        if (!isOrgScopeEnabled() || !orgUserId) {
            return { ok: false, reason: "no-organization" };
        }
        return { ok: true, caller: { ...base, kind: "service", orgUserId } };
    }
    return { ok: false, reason: "no-account" };
}
