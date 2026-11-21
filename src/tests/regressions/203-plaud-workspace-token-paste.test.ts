/**
 * Regression test for issue #203:
 *   "[Bug]: Plaud no longer has long-lived bearer tokens available"
 *
 * The web app stores the user token as the pld_ut cookie. Data endpoints
 * use workspace tokens, which cannot mint replacement workspace tokens.
 * The paste route must reject those tokens with cookie instructions.
 */

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    type Mock,
    vi,
} from "vitest";

vi.mock("next-intl/server", () => ({
    getExtracted: async () => (message: string) => message,
}));

vi.mock("@/lib/org/config", () => ({
    isOrgScopeVisible: () => false,
    isOrgScopeEnabled: () => false,
    getOrgUserId: async () => null,
    assertOrgScopeWritable: () => {},
    isOrgAccount: async () => false,
    assertNotOrgAccount: async () => {},
}));

vi.mock("@/lib/env", () => ({
    env: {
        DEFAULT_STORAGE_TYPE: "local",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
}));

vi.mock("@/db", () => {
    const select = vi.fn();
    const insert = vi.fn();
    const update = vi.fn();
    const execute = vi.fn().mockResolvedValue(undefined);
    const transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({ select, insert, update, execute }),
    );
    return { db: { select, insert, update, transaction } };
});

vi.mock("@/lib/auth", () => ({
    auth: { api: { getSession: vi.fn() } },
}));

vi.mock("@/lib/auth-server", () => {
    return {
        requireApiSession: async (request: Request) => {
            const session = await auth.api.getSession({
                headers: request.headers,
            });
            if (!session?.user) {
                throw new AppError(
                    ErrorCode.AUTH_SESSION_MISSING,
                    "Unauthorized",
                    401,
                );
            }
            return session;
        },
    };
});

import { POST } from "@/app/api/plaud/auth/connect-token/route";
import { auth } from "@/lib/auth";
import { AppError, ErrorCode } from "@/lib/errors";
import { decodeJwtClaims, isPlaudWorkspaceToken } from "@/lib/plaud/auth";

const originalFetch = global.fetch;
let mockFetch: Mock;

beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn() as Mock;
    global.fetch = mockFetch as typeof global.fetch;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    global.fetch = originalFetch;
});

const USER_ID = "user-203";

function authedSession() {
    (auth.api.getSession as unknown as Mock).mockResolvedValue({
        user: { id: USER_ID },
    });
}

/** Build a JWT with arbitrary payload (signature is junk; we never verify). */
function makeJwt(payload: Record<string, unknown>): string {
    const header = Buffer.from(
        JSON.stringify({ alg: "HS256", typ: "JWT" }),
    ).toString("base64url");
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${header}.${body}.signature-not-checked`;
}

const futureSec = () => Math.floor(Date.now() / 1000) + 3600;

/** A user token (UT): no workspace-scoped claims. */
function makeUserToken(): string {
    return makeJwt({
        sub: "8585e7d85836468baea538f05342cb40",
        aud: "",
        client_id: "web",
        region: "aws:us-west-2",
        iat: Math.floor(Date.now() / 1000),
        exp: futureSec(),
    });
}

/** A workspace token (WT): carries ut_ref / wid / wtype. */
function makeWorkspaceToken(): string {
    return makeJwt({
        sub: "8585e7d85836468baea538f05342cb40",
        aud: "",
        client_id: "web",
        region: "aws:us-west-2",
        jti: "63478f97f5f4efe32ad687a7b01e3834",
        mfa_method: "skipped",
        mid: "mem_clFG6UpjIl",
        role: "admin",
        ut_ref: "1404f29eb68dc0b9fe44c5ca6007a134282587497b1a59fbf5a1682134351ced",
        ver: 1,
        wid: "ws_clFG6UpjIk",
        wtype: "0",
        iat: Math.floor(Date.now() / 1000),
        exp: futureSec(),
    });
}

function makeRequest(body: unknown): Request {
    return new Request("http://localhost/api/plaud/auth/connect-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

// ── isPlaudWorkspaceToken (pure unit) ───────────────────────────────────────

describe("isPlaudWorkspaceToken", () => {
    it("returns true for a token carrying ut_ref/wid", () => {
        expect(isPlaudWorkspaceToken(makeWorkspaceToken())).toBe(true);
    });

    it("returns true when only ut_ref is present", () => {
        expect(isPlaudWorkspaceToken(makeJwt({ ut_ref: "abc" }))).toBe(true);
    });

    it("returns true when only wid is present", () => {
        expect(isPlaudWorkspaceToken(makeJwt({ wid: "ws_x" }))).toBe(true);
    });

    it("returns false for a user token", () => {
        expect(isPlaudWorkspaceToken(makeUserToken())).toBe(false);
    });

    it("returns false for non-JWT garbage", () => {
        expect(isPlaudWorkspaceToken("not-a-jwt")).toBe(false);
        expect(isPlaudWorkspaceToken("")).toBe(false);
    });

    it("decodeJwtClaims surfaces the workspace claims", () => {
        const claims = decodeJwtClaims(makeWorkspaceToken());
        expect(claims?.wid).toBe("ws_clFG6UpjIk");
        expect(claims?.ut_ref).toBeTypeOf("string");
        expect(claims?.wtype).toBe("0");
    });
});

// ── /api/plaud/auth/connect-token rejects a pasted WT ────────────────────────

describe("POST /api/plaud/auth/connect-token (workspace-token guard)", () => {
    it("rejects a pasted workspace token before hitting Plaud", async () => {
        authedSession();
        const res = await POST(
            makeRequest({ accessToken: makeWorkspaceToken() }),
        );
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.code).toBe(ErrorCode.PLAUD_WORKSPACE_TOKEN_PASTED);
        expect(body.error).toMatch(/workspace token/i);
        expect(body.error).toMatch(/pld_ut/);
        // No Plaud round-trip — the guard short-circuits.
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("rejects a WT even when wrapped in 'Bearer '", async () => {
        authedSession();
        const res = await POST(
            makeRequest({ accessToken: `Bearer ${makeWorkspaceToken()}` }),
        );
        expect(res.status).toBe(400);
        expect((await res.json()).code).toBe(
            ErrorCode.PLAUD_WORKSPACE_TOKEN_PASTED,
        );
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("lets a user token through the guard to Plaud validation", async () => {
        authedSession();
        // UT passes the WT guard; the route then reaches Plaud. Fail at the
        // first Plaud call so we don't have to mock the full happy path — we
        // only need to prove the guard did NOT short-circuit a UT.
        mockFetch.mockResolvedValue({
            ok: false,
            status: 401,
            statusText: "Unauthorized",
            headers: { get: () => null },
            json: () => Promise.resolve({ status: 401, msg: "bad token" }),
        });
        const res = await POST(makeRequest({ accessToken: makeUserToken() }));
        // Reached Plaud (guard passed); /device/list 401 → reconnect, not the
        // workspace-token rejection.
        expect(mockFetch).toHaveBeenCalled();
        expect(res.status).not.toBe(400);
    });
});
