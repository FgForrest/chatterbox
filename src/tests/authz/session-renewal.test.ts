/**
 * Renewing a stale session snapshot: parallel requests of one session in
 * a process renew it once, and the renewal reads everything through its
 * own transaction, never a second pooled connection while it holds the
 * credential row.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    rows: new Map<unknown, unknown[]>(),
    transactions: 0,
    refreshes: 0,
    releaseRefresh: null as (() => void) | null,
    tx: null as unknown,
}));

vi.mock("@/lib/env", () => ({
    env: {
        AUTHZ_MODE: "idp",
        AUTHZ_VERIFICATION_MAX_AGE: 1800,
        OIDC_CLIENT_ID: "chatterbox",
    },
}));
vi.mock("@/db", () => {
    const query = () => {
        let table: unknown;
        const chain: Record<string, unknown> = {
            from: (from: unknown) => {
                table = from;
                return chain;
            },
            where: () => chain,
            for: () => chain,
            limit: async () => state.rows.get(table) ?? [],
            set: () => chain,
        };
        return chain;
    };
    const tx = {
        select: () => query(),
        update: () => ({ set: () => ({ where: async () => undefined }) }),
    };
    state.tx = tx;
    return {
        db: {
            select: () => query(),
            delete: () => ({ where: async () => undefined }),
            update: () => ({ set: () => ({ where: async () => undefined }) }),
            transaction: async (run: (t: unknown) => Promise<unknown>) => {
                state.transactions++;
                return run(tx);
            },
        },
    };
});
vi.mock("@/lib/authz/access-state", () => ({
    accessStateVersion: vi.fn(async () => new Date(0)),
    recordAccessState: vi.fn(async () => true),
}));
vi.mock("@/lib/encryption/fields", () => ({
    decryptText: (value: string | null) => value,
    encryptText: (value: string | null) => value,
}));
vi.mock("@/lib/identity/factory", () => ({
    isIdpAuthorization: () => true,
    getClaimsProvider: () => ({
        capabilitiesFromAccessToken: () => new Set(["use"]),
    }),
}));
vi.mock("@/lib/sso/config", () => ({ isSsoEnabled: () => true }));
vi.mock("@/lib/sso/tokens", () => ({
    SsoTokenError: class SsoTokenError extends Error {},
    refreshProviderTokens: vi.fn(async () => {
        state.refreshes++;
        await new Promise<void>((resolve) => {
            state.releaseRefresh = resolve;
        });
        return {
            accessToken: "new-access",
            accessTokenExpiresAt: new Date(Date.now() + 300_000),
            refreshToken: "new-refresh",
            refreshTokenExpiresAt: null,
            idToken: null,
        };
    }),
    verifyWebAccessToken: vi.fn(async () => ({
        payload: { sub: "alice-sub" },
        issuer: "https://id.example.com/realms/acme",
    })),
}));

import { sessionIdpCredentials, users } from "@/db/schema";
import { accessStateVersion } from "@/lib/authz/access-state";
import { sessionAccess } from "@/lib/authz/session-access";

const STALE = {
    sessionId: "s1",
    userId: "u1",
    issuer: "https://id.example.com/realms/acme",
    subject: "alice-sub",
    capabilities: ["use"],
    authTime: null,
    verifiedAt: new Date(0),
    accessToken: "old-access",
    accessTokenExpiresAt: new Date(0),
    refreshToken: "old-refresh",
    refreshTokenExpiresAt: null,
};

beforeEach(() => {
    state.rows = new Map<unknown, unknown[]>([
        [users, [{ role: "user" }]],
        [sessionIdpCredentials, [STALE]],
    ]);
    state.transactions = 0;
    state.refreshes = 0;
    state.releaseRefresh = null;
    vi.mocked(accessStateVersion).mockClear();
});

describe("sessionAccess on a stale snapshot", () => {
    it("renews once for parallel requests of the session", async () => {
        const requests = Array.from({ length: 6 }, () =>
            sessionAccess({ id: "s1", userId: "u1" }),
        );
        await vi.waitFor(() => expect(state.releaseRefresh).not.toBeNull());
        state.releaseRefresh?.();
        const results = await Promise.all(requests);

        expect(results.every((result) => result.ok)).toBe(true);
        expect(state.transactions).toBe(1);
        expect(state.refreshes).toBe(1);
    });

    it("reads the access-state version through the renewal's transaction", async () => {
        const renewal = sessionAccess({ id: "s1", userId: "u1" });
        await vi.waitFor(() => expect(state.releaseRefresh).not.toBeNull());
        state.releaseRefresh?.();
        await renewal;

        expect(accessStateVersion).toHaveBeenCalledWith("u1", state.tx);
    });

    it("renews again for a later request", async () => {
        for (let round = 1; round <= 2; round++) {
            const renewal = sessionAccess({ id: "s1", userId: "u1" });
            await vi.waitFor(() => expect(state.releaseRefresh).not.toBeNull());
            state.releaseRefresh?.();
            state.releaseRefresh = null;
            await renewal;
        }
        expect(state.refreshes).toBe(2);
    });
});
