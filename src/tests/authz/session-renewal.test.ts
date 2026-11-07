/**
 * Renewing a stale session snapshot: parallel requests of one session in
 * a process renew it once, and the renewal reads everything through its
 * own transaction, never a second pooled connection while it holds the
 * credential row.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    rows: new Map<unknown, unknown[]>(),
    transactions: 0,
    refreshes: 0,
    releaseRefresh: null as (() => void) | null,
    tx: null as unknown,
    deleted: false,
    noDeletedRow: false,
    renewRowMissing: false,
    capabilities: ["use"] as string[],
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
        select: () =>
            state.renewRowMissing
                ? {
                      from: () => ({
                          where: () => ({
                              for: () => ({ limit: async () => [] }),
                          }),
                      }),
                  }
                : query(),
        update: () => ({ set: () => ({ where: async () => undefined }) }),
    };
    state.tx = tx;
    return {
        db: {
            select: () => query(),
            delete: () => ({
                where: () => ({
                    returning: async () => {
                        if (state.deleted || state.noDeletedRow) return [];
                        state.deleted = true;
                        return [
                            {
                                id: "s1",
                                userId: "u1",
                                createdAt: new Date(Date.now() - 60 * 60_000),
                                expiresAt: new Date(Date.now() + 120 * 60_000),
                                token: "example-session-credential",
                                email: "example@example.com",
                                cookie: "example-cookie",
                            },
                        ];
                    },
                }),
            }),
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
        capabilitiesFromAccessToken: () => new Set(state.capabilities),
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
import {
    accessStateVersion,
    recordAccessState,
} from "@/lib/authz/access-state";
import { sessionAccess } from "@/lib/authz/session-access";
import { IdentityProviderError } from "@/lib/identity/ports";
import {
    refreshProviderTokens,
    SsoTokenError,
    verifyWebAccessToken,
} from "@/lib/sso/tokens";

const STALE = {
    sessionId: "s1",
    userId: "u1",
    issuer: "https://id.example.com/realms/acme",
    subject: "alice-sub",
    capabilities: ["use"],
    authTime: null as Date | null,
    verifiedAt: new Date(0),
    accessToken: "old-access",
    accessTokenExpiresAt: new Date(0),
    refreshToken: "old-refresh" as string | null,
    refreshTokenExpiresAt: null as Date | null,
};

beforeEach(() => {
    state.rows = new Map<unknown, unknown[]>([
        [users, [{ role: "user" }]],
        [sessionIdpCredentials, [STALE]],
    ]);
    state.deleted = false;
    state.noDeletedRow = false;
    state.renewRowMissing = false;
    state.capabilities = ["use"];
    state.transactions = 0;
    state.refreshes = 0;
    state.releaseRefresh = null;
    vi.clearAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(Date, "now").mockReturnValue(
        new Date("2026-11-01T12:00:00Z").getTime(),
    );
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

afterEach(() => {
    const output = [
        ...vi.mocked(console.info).mock.calls,
        ...vi.mocked(console.warn).mock.calls,
    ]
        .flat()
        .join("\n");
    for (const privateValue of [
        "old-access",
        "old-refresh",
        "new-access",
        "new-refresh",
        "example-session-credential",
        "example@example.com",
        "example-cookie",
    ]) {
        expect(output).not.toContain(privateValue);
    }
    vi.restoreAllMocks();
});

function credential(overrides: Partial<typeof STALE> = {}) {
    state.rows.set(sessionIdpCredentials, [
        {
            ...STALE,
            verifiedAt: new Date(Date.now() - 40 * 60_000),
            authTime: new Date(Date.now() - 180 * 60_000),
            refreshTokenExpiresAt: new Date(Date.now() - 5 * 60_000),
            ...overrides,
        },
    ]);
}

function lines() {
    return [
        ...vi.mocked(console.info).mock.calls,
        ...vi.mocked(console.warn).mock.calls,
    ].map((call) => String(call[0]));
}

function expectEnding(cause: string, timings = true) {
    expect(lines()).toHaveLength(1);
    const line = lines()[0];
    expect(line).toContain(
        `[session] ended user=u1 session=s1 cause=${cause} ageMin=60 expiresInMin=120`,
    );
    if (timings)
        expect(line).toContain(
            "sinceVerifiedMin=40 sinceAuthMin=180 refreshExpiresInMin=-5",
        );
}

describe("session ending diagnostics", () => {
    it("logs provider refusal once when parallel requests share a renewal", async () => {
        credential();
        vi.mocked(refreshProviderTokens).mockRejectedValueOnce(
            new IdentityProviderError(
                "reauthentication_required",
                "unchanged",
                400,
                { error: "invalid_grant", detail: "Session not active" },
            ),
        );
        const result = await Promise.all([
            sessionAccess({ id: "s1", userId: "u1" }),
            sessionAccess({ id: "s1", userId: "u1" }),
        ]);
        expect(result).toEqual([
            { ok: false, reason: "ended" },
            { ok: false, reason: "ended" },
        ]);
        expectEnding("provider-refused");
        expect(state.transactions).toBe(1);
        expect(refreshProviderTokens).toHaveBeenCalledTimes(1);
        expect(lines()[0]).toContain(
            'providerError=invalid_grant providerDetail="Session not active"',
        );
    });

    it("logs no ending when another process already deleted the row", async () => {
        credential({ refreshToken: null });
        state.noDeletedRow = true;
        expect(await sessionAccess({ id: "s1", userId: "u1" })).toEqual({
            ok: false,
            reason: "ended",
        });
        expect(lines()).toEqual([]);
    });

    it.each([
        ["The token does not verify", true],
        ['The token "does not verify"\nž', false],
        ["refresh_token=example-refresh email=example@example.com", false],
    ])("allowlists a refused renewed token's message %j", async (message, allowed) => {
        credential();
        const result = sessionAccess({ id: "s1", userId: "u1" });
        vi.mocked(verifyWebAccessToken).mockRejectedValueOnce(
            new SsoTokenError(message),
        );
        await vi.waitFor(() => expect(state.releaseRefresh).not.toBeNull());
        state.releaseRefresh?.();
        expect(await result).toEqual({ ok: false, reason: "ended" });
        expectEnding("token-refused");
        if (allowed) {
            expect(lines()[0]).toContain(`providerDetail="${message}"`);
        } else {
            expect(lines()[0]).not.toContain("providerDetail=");
        }
    });

    it("logs a missing refresh token", async () => {
        credential({ refreshToken: null });
        await sessionAccess({ id: "s1", userId: "u1" });
        expectEnding("no-refresh-token");
    });

    it.each([
        false,
        true,
    ])("logs missing credentials (during renewal: %s)", async (duringRenewal) => {
        credential();
        if (duringRenewal) state.renewRowMissing = true;
        else state.rows.set(sessionIdpCredentials, []);
        await sessionAccess({ id: "s1", userId: "u1" });
        expectEnding("no-credential", false);
    });

    it("refuses a missing user without deleting or logging a session", async () => {
        state.rows.set(users, []);
        expect(await sessionAccess({ id: "s1", userId: "u1" })).toEqual({
            ok: false,
            reason: "ended",
        });
        expect(state.deleted).toBe(false);
        expect(lines()).toEqual([]);
    });

    it("logs the organization account", async () => {
        state.rows.set(users, [{ role: "org" }]);
        expect(await sessionAccess({ id: "s1", userId: "u1" })).toEqual({
            ok: false,
            reason: "org-account",
        });
        expectEnding("org-account", false);
    });

    it("logs withdrawn stored access", async () => {
        credential({
            capabilities: [],
            verifiedAt: new Date(Date.now() - 10 * 60_000),
        });
        expect(await sessionAccess({ id: "s1", userId: "u1" })).toEqual({
            ok: false,
            reason: "not-granted",
        });
        expectEnding("access-withdrawn", false);
        expect(lines()[0]).toContain(
            "sinceVerifiedMin=10 sinceAuthMin=180 refreshExpiresInMin=-5",
        );
    });

    it("logs withdrawn renewed access with the credential timings", async () => {
        credential();
        state.capabilities = [];
        const result = sessionAccess({ id: "s1", userId: "u1" });
        await vi.waitFor(() => expect(state.releaseRefresh).not.toBeNull());
        state.releaseRefresh?.();
        expect(await result).toEqual({ ok: false, reason: "not-granted" });
        expectEnding("access-withdrawn");
    });

    it("logs an unavailable provider and keeps the session", async () => {
        credential();
        vi.mocked(refreshProviderTokens).mockRejectedValueOnce(
            new IdentityProviderError("unavailable", "old-refresh"),
        );
        expect(await sessionAccess({ id: "s1", userId: "u1" })).toEqual({
            ok: false,
            reason: "unavailable",
        });
        expect(state.deleted).toBe(false);
        expect(lines()).toEqual([
            "[session] renew-failed user=u1 session=s1 kind=unavailable sinceVerifiedMin=40 sinceAuthMin=180 refreshExpiresInMin=-5",
        ]);
    });

    it("logs a superseded renewal and keeps the session", async () => {
        credential();
        vi.mocked(recordAccessState).mockResolvedValueOnce(false);
        const result = sessionAccess({ id: "s1", userId: "u1" });
        await vi.waitFor(() => expect(state.releaseRefresh).not.toBeNull());
        state.releaseRefresh?.();
        expect(await result).toEqual({ ok: false, reason: "unavailable" });
        expect(state.deleted).toBe(false);
        expect(lines()[0]).toContain(
            "[session] renew-failed user=u1 session=s1 kind=superseded sinceVerifiedMin=40",
        );
    });

    it("preserves refusal when the logging sink throws", async () => {
        credential({ refreshToken: null });
        vi.mocked(console.info).mockImplementation(() => {
            throw new Error("sink failed");
        });
        expect(await sessionAccess({ id: "s1", userId: "u1" })).toEqual({
            ok: false,
            reason: "ended",
        });
        expect(state.deleted).toBe(true);
    });
});
