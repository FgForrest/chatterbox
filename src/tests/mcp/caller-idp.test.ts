/**
 * Who an MCP token speaks for under identity-provider authorization: the
 * permissions come from the token's scopes, never from client roles, and
 * a person also needs a verified `use`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockEnv, linked, holderAccess } = vi.hoisted(() => ({
    mockEnv: {
        AUTHZ_MODE: "idp" as "idp" | "local",
        IDENTITY_PROVIDER: "keycloak",
        OIDC_ISSUER_URL: "https://id.example.com/realms/acme",
        OIDC_CLIENT_ID: "chatterbox",
        KEYCLOAK_ROLES_CLIENT: undefined as string | undefined,
        MCP_AUDIENCE: "chatterbox-mcp",
        MCP_ALLOWED_CLIENTS: ["claude"] as string[],
        MCP_SERVICE_CLIENTS: [] as string[],
    },
    linked: {
        rows: [] as unknown[],
        queried: 0,
    },
    holderAccess: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/db", () => {
    const chain: Record<string, unknown> = {};
    for (const step of ["select", "from", "innerJoin"]) {
        chain[step] = () => chain;
    }
    chain.where = () =>
        Object.assign(Promise.resolve([]), {
            limit: async () => {
                linked.queried++;
                return linked.rows;
            },
        });
    return { db: chain };
});
vi.mock("@/lib/authz/access-state", () => ({ holderAccess }));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: vi.fn(async () => "org-user"),
    isOrgScopeEnabled: () => true,
    isOrgScopeVisible: () => true,
}));

import { resolveCaller } from "@/lib/mcp/caller";
import type { McpTokenClaims } from "@/lib/mcp/token";

const ALICE = {
    id: "u-alice",
    email: "alice@example.test",
    role: "user",
    suspendedAt: null,
};

function claims(extra: Record<string, unknown>): McpTokenClaims {
    return {
        iss: "https://id.example.com/realms/acme",
        sub: "alice-sub",
        azp: "claude",
        typ: "Bearer",
        ...extra,
    } as McpTokenClaims;
}

const ROLE_ONLY = {
    resource_access: { "chatterbox-mcp": { roles: ["knowledge:read"] } },
};
const SCOPED = { scope: "openid knowledge:read" };

beforeEach(() => {
    mockEnv.AUTHZ_MODE = "idp";
    mockEnv.MCP_ALLOWED_CLIENTS = ["claude"];
    linked.rows = [ALICE];
    linked.queried = 0;
    holderAccess.mockReset();
    holderAccess.mockResolvedValue({
        ok: true,
        capabilities: new Set(["use"]),
        verifiedAt: new Date(),
    });
});

describe("resolveCaller with AUTHZ_MODE=idp", () => {
    it("refuses a token whose permissions are only client roles", async () => {
        expect(await resolveCaller(claims(ROLE_ONLY))).toEqual({
            ok: false,
            reason: "no-roles",
        });
        expect(linked.queried).toBe(0);
        expect(holderAccess).not.toHaveBeenCalled();
    });

    it("admits a scoped token of a person who holds `use`", async () => {
        const result = await resolveCaller(claims(SCOPED));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.caller).toMatchObject({
            kind: "user",
            userId: "u-alice",
            clientId: "claude",
        });
        expect([...result.caller.roles]).toEqual(["knowledge:read"]);
        expect(holderAccess).toHaveBeenCalledWith("u-alice");
    });

    it("refuses a person whose access is withdrawn or cannot be verified", async () => {
        holderAccess.mockResolvedValueOnce({
            ok: false,
            reason: "not-granted",
        });
        expect(await resolveCaller(claims(SCOPED))).toEqual({
            ok: false,
            reason: "no-access",
        });
        holderAccess.mockResolvedValueOnce({
            ok: false,
            reason: "unavailable",
        });
        expect(await resolveCaller(claims(SCOPED))).toEqual({
            ok: false,
            reason: "access-unverifiable",
        });
    });

    it("never admits the web sign-in client, even without an allowlist", async () => {
        mockEnv.MCP_ALLOWED_CLIENTS = [];
        expect(
            await resolveCaller(claims({ ...SCOPED, azp: "chatterbox" })),
        ).toEqual({ ok: false, reason: "client-not-allowed" });
    });

    it("takes client roles in local mode, without asking for `use`", async () => {
        mockEnv.AUTHZ_MODE = "local";
        const result = await resolveCaller(claims(ROLE_ONLY));
        expect(result.ok).toBe(true);
        expect(holderAccess).not.toHaveBeenCalled();
    });
});
