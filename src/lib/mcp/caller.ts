import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { accounts, users } from "@/db/schema";
import { env } from "@/lib/env";
import { type McpRole, rolesFromPayload } from "@/lib/mcp/roles";
import { type McpTokenClaims, tokenClient } from "@/lib/mcp/token";
import { getOrgUserId, isOrgScopeEnabled } from "@/lib/org/config";
import { SSO_PROVIDER_ID } from "@/lib/sso/constants";

interface CallerBase {
    /** The token's `sub`. */
    subject: string;
    /** `azp`, else `client_id`: the client the token was issued to. */
    clientId: string | null;
    /** The MCP roles the token grants, never empty. */
    roles: Set<McpRole>;
    /** The Organization account, when the instance shows the Organization. */
    orgUserId: string | null;
}

/**
 * Who an MCP request speaks for: a Riffado user (SSO-linked `sub`), or a
 * service account acting as the Organization account.
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
    | "suspended";

/** The outcome of {@link resolveCaller}. */
export type CallerResult =
    | { ok: true; caller: McpCaller }
    | { ok: false; reason: CallerRefusal };

function stringClaim(claims: McpTokenClaims, name: string): string | null {
    const value = claims[name];
    return typeof value === "string" && value ? value : null;
}

/**
 * Who a verified token speaks for. A `sub` linked to a Riffado account
 * through single sign-on is that user; otherwise a token carrying
 * `client_id` is a service account, admitted only while the Organization
 * scope is enabled. Nobody else is provisioned.
 */
export async function resolveCaller(
    claims: McpTokenClaims,
): Promise<CallerResult> {
    const clientId = tokenClient(claims);
    const allowed = env.MCP_ALLOWED_CLIENTS;
    if (allowed.length > 0 && (!clientId || !allowed.includes(clientId))) {
        return { ok: false, reason: "client-not-allowed" };
    }
    const roles = rolesFromPayload(claims, env.MCP_AUDIENCE ?? "");
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
            ),
        )
        .limit(1);
    const orgUserId = await getOrgUserId();
    const base = { subject: claims.sub, clientId, roles };

    if (linked) {
        if (linked.role === "org") return { ok: false, reason: "no-account" };
        if (linked.suspendedAt) return { ok: false, reason: "suspended" };
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
    if (stringClaim(claims, "client_id")) {
        if (!isOrgScopeEnabled() || !orgUserId) {
            return { ok: false, reason: "no-organization" };
        }
        return { ok: true, caller: { ...base, kind: "service", orgUserId } };
    }
    return { ok: false, reason: "no-account" };
}
