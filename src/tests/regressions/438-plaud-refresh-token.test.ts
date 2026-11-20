/**
 * Regression test for Plaud refresh tokens (follow-up to issue #203).
 *
 * Plaud now issues short user tokens (UT): 24 hours from the web app's
 * `pld_ut` cookie, 30 days from the email-code login. Both come with a
 * refresh token (`pld_urt` / `refresh_token`) that mints a fresh UT via
 * `POST /auth/refresh-user-token` until the original sign-in ends. This file
 * pins: token + expiry persistence on connect (OTP and connect-token),
 * refresh-before-expiry and refresh-on-401 in the client factory, the
 * reconnect path when Plaud rejects the refresh token, the compare-and-swap
 * that keeps a stale refresh from overwriting a reconnect, the JWT `exp`
 * helper, and the dashboard banner predicate.
 */

import { DrizzleQueryError, getTableColumns, is, SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    type Mock,
    vi,
} from "vitest";

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

vi.mock("next-intl/server", () => ({
    getExtracted: async () => (message: string, values?: { hours: number }) =>
        values
            ? message.replace(
                  "{hours, plural, one {# hour} other {# hours}}",
                  `${values.hours} ${values.hours === 1 ? "hour" : "hours"}`,
              )
            : message,
}));

vi.mock("@/lib/org/config", () => ({
    assertNotOrgAccount: async () => {},
}));

vi.mock("@/lib/rate-limit", () => ({
    assertRateLimitAllowed: () => {},
    consumeRateLimitBucket: async () => ({}),
}));

vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: vi.fn().mockResolvedValue({
        uploadFile: vi.fn().mockResolvedValue(undefined),
        downloadFile: vi.fn().mockResolvedValue(Buffer.from("audio-data")),
    }),
}));

vi.mock("@/lib/notifications/bark", () => ({
    sendNewRecordingBarkNotification: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/notifications/email", () => ({
    sendNewRecordingEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/transcription/transcribe-recording", () => ({
    transcribeRecording: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("@/lib/webhooks/emit", () => ({
    emitEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));

import { GET as devInfoGET } from "@/app/api/dev/plaud/info/route";
import { POST as connectTokenPOST } from "@/app/api/plaud/auth/connect-token/route";
import { POST as verifyPOST } from "@/app/api/plaud/auth/verify/route";
import { GET as connectionGET } from "@/app/api/plaud/connection/route";
import { db } from "@/db";
import { plaudConnections, recordings, userSettings } from "@/db/schema";
import { auth } from "@/lib/auth";
import { decrypt, encrypt } from "@/lib/encryption";
import { AppError, ErrorCode } from "@/lib/errors";
import {
    buildPlaudTokenSet,
    decodeAccessTokenExpiry,
    plaudRefreshUserToken,
    plaudVerifyOtp,
} from "@/lib/plaud/auth";
import {
    createPlaudClient,
    type PlaudConnectionCredentials,
    shouldRefreshPlaudAccessToken,
} from "@/lib/plaud/client-factory";
import {
    PLAUD_SESSION_WARNING_WINDOW_MS,
    plaudConnectionBannerState,
} from "@/lib/plaud/connection-expiry";
import {
    persistPlaudConnection,
    persistRefreshedPlaudTokens,
} from "@/lib/plaud/persist-connection";
import { PLAUD_USER_AGENT } from "@/lib/plaud/servers";
import { captureServerException } from "@/lib/posthog-server";
import { getPlaudConnection } from "@/lib/settings/plaud-connection";
import { syncRecordingsForUser } from "@/lib/sync/sync-recordings";

const USER_ID = "user-refresh";
const CONNECTION_ID = "conn-refresh";
const API_BASE = "https://api-euc1.plaud.ai";
const HOUR = 60 * 60;
const DAY = 24 * HOUR;

const originalFetch = global.fetch;
let mockFetch: Mock;

beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn() as Mock;
    global.fetch = mockFetch as typeof global.fetch;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    global.fetch = originalFetch;
});

// ── Helpers ─────────────────────────────────────────────────────────────────

const nowSec = () => Math.floor(Date.now() / 1000);

/** Build a JWT with arbitrary payload (signature is junk; we never verify). */
function makeJwt(payload: Record<string, unknown>): string {
    const header = Buffer.from(
        JSON.stringify({ alg: "HS256", typ: "JWT" }),
    ).toString("base64url");
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${header}.${body}.signature-not-checked`;
}

function makeUserToken(expSec: number, tag = "ut"): string {
    return makeJwt({
        sub: "user-sub",
        client_id: "web",
        tag,
        iat: nowSec(),
        exp: expSec,
    });
}

function makeRefreshToken(expSec: number, tag = "rt"): string {
    return makeJwt({ sub: "user-sub", typ: "refresh", tag, exp: expSec });
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

function rejectedRefresh(status = 401): Response {
    return jsonResponse(
        { status: -1, msg: "token invalid or expired" },
        status,
    );
}

type RouteHandler = (
    url: string,
    init: RequestInit | undefined,
) => Response | Promise<Response>;

/** Route mocked fetch calls by URL fragment; unknown URLs fail the test. */
function routeFetch(routes: Record<string, RouteHandler>): void {
    mockFetch.mockImplementation(
        async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            for (const [fragment, handler] of Object.entries(routes)) {
                if (url.includes(fragment)) return handler(url, init);
            }
            throw new Error(`unexpected fetch: ${url}`);
        },
    );
}

function authHeader(init: RequestInit | undefined): string | null {
    return new Headers(init?.headers).get("Authorization");
}

function callsTo(fragment: string): [string, RequestInit | undefined][] {
    return (mockFetch.mock.calls as [string, RequestInit | undefined][]).filter(
        ([url]) => String(url).includes(fragment),
    );
}

const workspacesOk: RouteHandler = () =>
    jsonResponse({
        status: 0,
        data: {
            workspaces: [
                {
                    workspace_id: "ws_personal",
                    member_id: "mem_x",
                    name: "Personal",
                    role: "admin",
                    status: "active",
                    workspace_type: "0",
                },
            ],
        },
    });

const mintOk: RouteHandler = () =>
    jsonResponse({
        status: 0,
        data: { workspace_token: "wt.workspace.token" },
    });

const devicesOk: RouteHandler = () =>
    jsonResponse({
        status: 0,
        msg: "success",
        data_devices: [
            { sn: "SN-1", name: "My Plaud", model: "Note", version_number: 1 },
        ],
    });

function authedSession(): void {
    (auth.api.getSession as unknown as Mock).mockResolvedValue({
        user: { id: USER_ID },
    });
}

/** Persist path: no existing connection or devices, so every row is inserted. */
function mockEmptySelectsAndInserts(): Mock {
    (db.select as Mock).mockReturnValue({
        from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
            }),
        }),
    });
    const values = vi.fn().mockResolvedValue(undefined);
    (db.insert as Mock).mockReturnValue({ values });
    return values;
}

interface UpdateSpies {
    set: Mock;
    where: Mock;
    returning: Mock;
}

/** `db.update().set().where()` is awaitable and also exposes `.returning()`. */
function mockUpdates(returningRows: unknown[] = [{ id: CONNECTION_ID }]) {
    const spies: UpdateSpies = {
        set: vi.fn(),
        where: vi.fn(),
        returning: vi.fn().mockResolvedValue(returningRows),
    };
    spies.where.mockImplementation(() =>
        Object.assign(Promise.resolve(undefined), {
            returning: spies.returning,
        }),
    );
    spies.set.mockReturnValue({ where: spies.where });
    (db.update as Mock).mockReturnValue({ set: spies.set });
    return spies;
}

function connectionInsert(values: Mock): Record<string, unknown> {
    const call = values.mock.calls.find(
        ([v]) => v && typeof v === "object" && "bearerToken" in v,
    );
    expect(call).toBeTruthy();
    return call?.[0] as Record<string, unknown>;
}

function makeConnection(
    overrides: Partial<PlaudConnectionCredentials> & {
        accessToken?: string;
        refreshTokenPlain?: string | null;
    } = {},
): PlaudConnectionCredentials {
    const { accessToken, refreshTokenPlain, ...rest } = overrides;
    const ut = accessToken ?? makeUserToken(nowSec() + 20 * HOUR, "old-ut");
    const rt =
        refreshTokenPlain === undefined
            ? makeRefreshToken(nowSec() + 20 * DAY, "old-rt")
            : refreshTokenPlain;
    return {
        id: CONNECTION_ID,
        userId: USER_ID,
        bearerToken: encrypt(ut),
        refreshToken: rt ? encrypt(rt) : null,
        accessExpiresAt: new Date((nowSec() + 20 * HOUR) * 1000),
        sessionExpiresAt: new Date((nowSec() + 20 * DAY) * 1000),
        apiBase: API_BASE,
        workspaceId: "ws_personal",
        ...rest,
    };
}

const dialect = new PgDialect();

// ── In-memory plaud_connections row ─────────────────────────────────────────

type ConnectionRow = Record<string, unknown>;

const columnKeyByName = new Map(
    Object.entries(getTableColumns(plaudConnections)).map(([key, column]) => [
        column.name,
        key,
    ]),
);

function sameValue(stored: unknown, param: unknown, op: "=" | "<"): boolean {
    if (stored instanceof Date) {
        const a = stored.getTime();
        const b = new Date(String(param)).getTime();
        return op === "=" ? a === b : a < b;
    }
    if (stored === null || stored === undefined) return false;
    return op === "=" ? stored === param : String(stored) < String(param);
}

/**
 * Evaluate a rendered Drizzle WHERE clause against one row. Supports the
 * subset the Plaud persistence code emits: and/or, parentheses, `=`, `<`,
 * `is null`, `is not null` on `plaud_connections` columns.
 */
function rowMatches(where: SQL, row: ConnectionRow): boolean {
    const { sql, params } = dialect.sqlToQuery(where);
    const tokens =
        sql.match(
            /\(|\)|"plaud_connections"\."[a-z_]+"|\$\d+|is not null|is null|=|<|and|or/g,
        ) ?? [];
    let pos = 0;
    const next = () => tokens[pos++];
    const peek = () => tokens[pos];

    const factor = (): boolean => {
        const token = next();
        if (token === "(") {
            const value = expr();
            expect(next()).toBe(")");
            return value;
        }
        const column = /"plaud_connections"\."([a-z_]+)"/.exec(token ?? "");
        if (!column) throw new Error(`unsupported SQL near ${token}: ${sql}`);
        const key = columnKeyByName.get(column[1]);
        if (!key) throw new Error(`unknown column ${column[1]}`);
        const stored = row[key];
        const op = next();
        if (op === "is null") return stored === null || stored === undefined;
        if (op === "is not null") {
            return stored !== null && stored !== undefined;
        }
        if (op === "=" || op === "<") {
            const param = params[Number(next()?.slice(1)) - 1];
            return sameValue(stored, param, op);
        }
        throw new Error(`unsupported operator ${op}: ${sql}`);
    };
    const term = (): boolean => {
        let value = factor();
        while (peek() === "and") {
            next();
            value = factor() && value;
        }
        return value;
    };
    const expr = (): boolean => {
        let value = term();
        while (peek() === "or") {
            next();
            value = term() || value;
        }
        return value;
    };

    const result = expr();
    expect(pos).toBe(tokens.length);
    return result;
}

/**
 * Apply one SET value to the row. Plain values are stored as is; the only
 * SQL expression the Plaud persistence code writes is
 * `least(<column>, $1::timestamp)`, which, like Postgres, ignores a null.
 */
function resolveSetValue(value: unknown, row: ConnectionRow): unknown {
    if (!is(value, SQL)) return value;
    const { sql, params } = dialect.sqlToQuery(value);
    const least =
        /^least\("plaud_connections"\."([a-z_]+)", \$1::timestamp\)$/.exec(sql);
    if (!least) throw new Error(`unsupported SET expression: ${sql}`);
    const key = columnKeyByName.get(least[1]);
    if (!key) throw new Error(`unknown column ${least[1]}`);
    const incoming = new Date(String(params[0]));
    const stored = row[key];
    if (!(stored instanceof Date)) return incoming;
    return stored.getTime() <= incoming.getTime() ? stored : incoming;
}

/**
 * Back `db` (and transactions) with a single in-memory `plaud_connections`
 * row. Updates only land when their WHERE clause matches the row, like
 * Postgres would. Writes to other tables are accepted and dropped.
 */
function installConnectionStore(row: ConnectionRow): void {
    (db.select as Mock).mockImplementation(() => ({
        from: (table: unknown) => ({
            where: (where: SQL) => ({
                limit: async () =>
                    table === plaudConnections && rowMatches(where, row)
                        ? [{ ...row }]
                        : [],
            }),
        }),
    }));
    (db.update as Mock).mockImplementation((table: unknown) => ({
        set: (values: ConnectionRow) => ({
            where: (where: SQL) => {
                const hit =
                    table === plaudConnections && rowMatches(where, row);
                if (hit) {
                    const resolved = Object.fromEntries(
                        Object.entries(values).map(([key, value]) => [
                            key,
                            resolveSetValue(value, row),
                        ]),
                    );
                    Object.assign(row, resolved);
                }
                const rows = hit ? [{ ...row }] : [];
                return Object.assign(Promise.resolve(undefined), {
                    returning: async () => rows,
                });
            },
        }),
    }));
    (db.insert as Mock).mockImplementation(() => ({
        values: async () => undefined,
    }));
}

function storedConnectionRow(input: {
    accessToken: string;
    refreshToken: string;
    accessExpiresAt: Date | null;
    sessionExpiresAt: Date | null;
}): ConnectionRow {
    return {
        id: CONNECTION_ID,
        userId: USER_ID,
        bearerToken: encrypt(input.accessToken),
        refreshToken: encrypt(input.refreshToken),
        accessExpiresAt: input.accessExpiresAt,
        sessionExpiresAt: input.sessionExpiresAt,
        apiBase: API_BASE,
        workspaceId: "ws_personal",
        plaudEmail: null,
        invalidatedAt: null,
    };
}

function credentialsFrom(row: ConnectionRow): PlaudConnectionCredentials {
    return {
        id: String(row.id),
        userId: String(row.userId),
        bearerToken: String(row.bearerToken),
        refreshToken: (row.refreshToken as string | null) ?? null,
        accessExpiresAt: (row.accessExpiresAt as Date | null) ?? null,
        sessionExpiresAt: (row.sessionExpiresAt as Date | null) ?? null,
        apiBase: String(row.apiBase),
        workspaceId: (row.workspaceId as string | null) ?? null,
    };
}

// ── JWT exp helper + token set ──────────────────────────────────────────────

describe("decodeAccessTokenExpiry edge cases", () => {
    it("reads exp from user and refresh tokens", () => {
        const exp = nowSec() + DAY;
        expect(decodeAccessTokenExpiry(makeUserToken(exp))?.getTime()).toBe(
            exp * 1000,
        );
        expect(decodeAccessTokenExpiry(makeRefreshToken(exp))?.getTime()).toBe(
            exp * 1000,
        );
    });

    it("returns null for zero, negative, non-numeric or missing exp", () => {
        expect(decodeAccessTokenExpiry(makeJwt({ exp: 0 }))).toBeNull();
        expect(decodeAccessTokenExpiry(makeJwt({ exp: -5 }))).toBeNull();
        expect(decodeAccessTokenExpiry(makeJwt({ exp: "1700000000" }))).toBe(
            null,
        );
        expect(decodeAccessTokenExpiry(makeJwt({ sub: "x" }))).toBeNull();
    });

    it("returns null for malformed tokens and non-object payloads", () => {
        expect(decodeAccessTokenExpiry("a.b.c")).toBeNull();
        expect(decodeAccessTokenExpiry("only.two")).toBeNull();
        expect(decodeAccessTokenExpiry("a.b.c.d")).toBeNull();
        const nullPayload = `x.${Buffer.from("null").toString("base64url")}.y`;
        expect(decodeAccessTokenExpiry(nullPayload)).toBeNull();
    });
});

describe("buildPlaudTokenSet", () => {
    it("prefers Plaud's explicit unix-second expiries over JWT exp", () => {
        const ut = makeUserToken(nowSec() + HOUR);
        const rt = makeRefreshToken(nowSec() + 2 * DAY);
        const set = buildPlaudTokenSet({
            accessToken: ut,
            refreshToken: rt,
            accessExpireAt: 1_900_000_000,
            refreshExpireAt: 1_900_000_500,
        });
        expect(set.accessExpiresAt?.getTime()).toBe(1_900_000_000_000);
        expect(set.sessionExpiresAt?.getTime()).toBe(1_900_000_500_000);
    });

    it("falls back to JWT exp and ends the session with the UT when there is no refresh token", () => {
        const exp = nowSec() + DAY;
        const set = buildPlaudTokenSet({ accessToken: makeUserToken(exp) });
        expect(set.refreshToken).toBeNull();
        expect(set.accessExpiresAt?.getTime()).toBe(exp * 1000);
        expect(set.sessionExpiresAt?.getTime()).toBe(exp * 1000);
    });

    it("uses the refresh token's exp as the session end", () => {
        const rtExp = nowSec() + 30 * DAY;
        const set = buildPlaudTokenSet({
            accessToken: makeUserToken(nowSec() + DAY),
            refreshToken: makeRefreshToken(rtExp),
        });
        expect(set.sessionExpiresAt?.getTime()).toBe(rtExp * 1000);
    });

    it("leaves the session end unknown when the refresh token has no exp", () => {
        const set = buildPlaudTokenSet({
            accessToken: makeUserToken(nowSec() + DAY),
            refreshToken: makeJwt({ sub: "x" }),
        });
        expect(set.sessionExpiresAt).toBeNull();
    });

    it("treats an empty refresh token as absent", () => {
        const set = buildPlaudTokenSet({
            accessToken: makeUserToken(nowSec() + DAY),
            refreshToken: "",
        });
        expect(set.refreshToken).toBeNull();
    });
});

// ── Plaud auth HTTP helpers ─────────────────────────────────────────────────

describe("plaudVerifyOtp", () => {
    it("returns the refresh token and expiries from otp-login", async () => {
        const ut = makeUserToken(nowSec() + 30 * DAY);
        const rt = makeRefreshToken(nowSec() + 30 * DAY);
        routeFetch({
            "/auth/otp-login": () =>
                jsonResponse({
                    status: 0,
                    access_token: ut,
                    refresh_token: rt,
                    token_type: "bearer",
                    ut_expires_in: 2592000,
                    urt_expires_in: 2592000,
                    ut_expire_at: 1_900_000_000,
                    urt_expire_at: 1_900_000_100,
                }),
        });
        const tokens = await plaudVerifyOtp("123456", "otp.token", API_BASE);
        expect(tokens).toEqual({
            accessToken: ut,
            refreshToken: rt,
            accessExpiresAt: new Date(1_900_000_000_000),
            sessionExpiresAt: new Date(1_900_000_100_000),
        });
    });
});

describe("plaudRefreshUserToken", () => {
    it("POSTs the refresh token as Bearer with the Plaud UA and no body", async () => {
        const newUt = makeUserToken(nowSec() + DAY, "new-ut");
        const newRt = makeRefreshToken(nowSec() + 20 * DAY, "new-rt");
        routeFetch({
            "/auth/refresh-user-token": () =>
                jsonResponse({
                    status: 0,
                    access_token: newUt,
                    refresh_token: newRt,
                    ut_expire_at: 1_900_000_000,
                    urt_expire_at: 1_900_000_900,
                }),
        });
        const tokens = await plaudRefreshUserToken(
            "old.refresh.token",
            API_BASE,
        );

        const [[url, init]] = callsTo("/auth/refresh-user-token");
        expect(url).toBe(`${API_BASE}/auth/refresh-user-token`);
        expect(init?.method).toBe("POST");
        expect(init?.body).toBeUndefined();
        expect(authHeader(init)).toBe("Bearer old.refresh.token");
        expect(new Headers(init?.headers).get("User-Agent")).toBe(
            PLAUD_USER_AGENT,
        );
        expect(tokens.accessToken).toBe(newUt);
        expect(tokens.refreshToken).toBe(newRt);
        expect(tokens.accessExpiresAt?.getTime()).toBe(1_900_000_000_000);
        expect(tokens.sessionExpiresAt?.getTime()).toBe(1_900_000_900_000);
    });

    it("keeps the old refresh token when Plaud does not rotate it", async () => {
        const oldRt = makeRefreshToken(nowSec() + 5 * DAY);
        routeFetch({
            "/auth/refresh-user-token": () =>
                jsonResponse({
                    status: 0,
                    access_token: makeUserToken(nowSec() + DAY),
                }),
        });
        const tokens = await plaudRefreshUserToken(oldRt, API_BASE);
        expect(tokens.refreshToken).toBe(oldRt);
    });

    it.each([
        [400, ErrorCode.PLAUD_UPSTREAM_ERROR],
        [401, ErrorCode.PLAUD_INVALID_TOKEN],
        [403, ErrorCode.PLAUD_UPSTREAM_ERROR],
        [407, ErrorCode.PLAUD_UPSTREAM_ERROR],
        [429, ErrorCode.PLAUD_RATE_LIMITED],
        [503, ErrorCode.PLAUD_UPSTREAM_ERROR],
    ])("maps HTTP %i to %s", async (status, code) => {
        routeFetch({
            "/auth/refresh-user-token": () =>
                jsonResponse(
                    { status: -1, msg: "Platnost přihlášení byla zrušena" },
                    status,
                ),
        });
        await expect(
            plaudRefreshUserToken("rt.rt.rt", API_BASE),
        ).rejects.toMatchObject({ code });
    });

    it.each([
        200, 401,
    ])("recognizes a Plaud credential rejection in HTTP %i", async (status) => {
        routeFetch({
            "/auth/refresh-user-token": () => rejectedRefresh(status),
        });
        await expect(
            plaudRefreshUserToken("rt.rt.rt", API_BASE),
        ).rejects.toMatchObject({ code: ErrorCode.PLAUD_INVALID_TOKEN });
    });

    it("treats an HTML 401 from a gateway as transient", async () => {
        routeFetch({
            "/auth/refresh-user-token": () =>
                new Response("<html>Gateway sign-in required</html>", {
                    status: 401,
                }),
        });
        await expect(
            plaudRefreshUserToken("rt.rt.rt", API_BASE),
        ).rejects.toMatchObject({ code: ErrorCode.PLAUD_UPSTREAM_ERROR });
    });

    it("treats an unrelated Plaud business error as transient", async () => {
        routeFetch({
            "/auth/refresh-user-token": () =>
                jsonResponse({ status: -1, msg: "service unavailable" }),
        });
        await expect(
            plaudRefreshUserToken("rt.rt.rt", API_BASE),
        ).rejects.toMatchObject({ code: ErrorCode.PLAUD_UPSTREAM_ERROR });
    });

    it("refuses a non-Plaud API base without calling out", async () => {
        await expect(
            plaudRefreshUserToken("rt.rt.rt", "https://evil.example.com"),
        ).rejects.toMatchObject({ code: ErrorCode.PLAUD_INVALID_API_BASE });
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

// ── Persist on connect ──────────────────────────────────────────────────────

describe("POST /api/plaud/auth/verify stores refresh tokens", () => {
    it.each([
        true,
        false,
    ])("caps the OTP session only when it is refreshable: %s", async (refreshable) => {
        authedSession();
        const values = mockEmptySelectsAndInserts();
        const expires = nowSec() + 90 * DAY;
        const before = Date.now();
        routeFetch({
            "/auth/otp-login": () =>
                jsonResponse({
                    status: 0,
                    access_token: makeUserToken(expires),
                    refresh_token: refreshable
                        ? makeRefreshToken(expires)
                        : undefined,
                    ut_expire_at: expires,
                    urt_expire_at: expires,
                }),
            "/team-app/workspaces/list": workspacesOk,
            "/workspace/token/": mintOk,
            "/device/list": devicesOk,
        });
        const response = await verifyPOST(
            new Request("http://localhost/api/plaud/auth/verify", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    code: "123456",
                    otpToken: "otp.token",
                    apiBase: API_BASE,
                }),
            }),
        );
        expect(response.status).toBe(200);
        const row = connectionInsert(values);
        expect(row.accessExpiresAt).toEqual(new Date(expires * 1000));
        if (refreshable) {
            const end = (row.sessionExpiresAt as Date).getTime();
            expect(end).toBeGreaterThanOrEqual(before + 31 * DAY * 1000);
            expect(end).toBeLessThanOrEqual(Date.now() + 31 * DAY * 1000);
        } else {
            expect(row.sessionExpiresAt).toEqual(row.accessExpiresAt);
        }
    });

    it("persists the encrypted refresh token and both expiries", async () => {
        authedSession();
        const values = mockEmptySelectsAndInserts();
        const ut = makeUserToken(nowSec() + 30 * DAY);
        const rt = makeRefreshToken(nowSec() + 30 * DAY);
        const expireAt = nowSec() + 30 * DAY;
        routeFetch({
            "/auth/otp-login": () =>
                jsonResponse({
                    status: 0,
                    access_token: ut,
                    refresh_token: rt,
                    ut_expire_at: expireAt,
                    urt_expire_at: expireAt,
                }),
            "/team-app/workspaces/list": workspacesOk,
            "/workspace/token/": mintOk,
            "/device/list": devicesOk,
        });

        const res = await verifyPOST(
            new Request("http://localhost/api/plaud/auth/verify", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    code: "123456",
                    otpToken: "otp.token",
                    apiBase: API_BASE,
                    email: "me@example.com",
                }),
            }),
        );
        expect(res.status).toBe(200);

        const row = connectionInsert(values);
        expect(row.userId).toBe(USER_ID);
        expect(String(row.bearerToken)).not.toContain("eyJ");
        expect(String(row.refreshToken)).not.toContain("eyJ");
        expect(decrypt(String(row.bearerToken))).toBe(ut);
        expect(decrypt(String(row.refreshToken))).toBe(rt);
        expect(row.accessExpiresAt).toEqual(new Date(expireAt * 1000));
        expect(row.sessionExpiresAt).toEqual(new Date(expireAt * 1000));
    });
});

function connectTokenRequest(body: unknown): Request {
    return new Request("http://localhost/api/plaud/auth/connect-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

function routeConnectTokenHappyPath(): void {
    routeFetch({
        "/user/me": () => jsonResponse({ status: 0, data: { email: null } }),
        "/team-app/workspaces/list": workspacesOk,
        "/workspace/token/": mintOk,
        "/device/list": devicesOk,
    });
}

describe("POST /api/plaud/auth/connect-token refresh tokens", () => {
    it("accepts a refreshToken, stores it encrypted and never logs it", async () => {
        authedSession();
        const values = mockEmptySelectsAndInserts();
        routeConnectTokenHappyPath();
        const utExp = nowSec() + DAY;
        const rtExp = nowSec() + 30 * DAY;
        const ut = makeUserToken(utExp);
        const rt = makeRefreshToken(rtExp);

        const res = await connectTokenPOST(
            connectTokenRequest({
                accessToken: ut,
                refreshToken: rt,
                apiBase: API_BASE,
                source: "connector",
            }),
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.warning).toBeUndefined();

        const row = connectionInsert(values);
        expect(decrypt(String(row.refreshToken))).toBe(rt);
        expect(String(row.refreshToken)).not.toContain(rt);
        expect(row.accessExpiresAt).toEqual(new Date(utExp * 1000));
        expect(row.sessionExpiresAt).toEqual(new Date(rtExp * 1000));

        const logged = [
            ...(console.log as Mock).mock.calls,
            ...(console.warn as Mock).mock.calls,
            ...(console.error as Mock).mock.calls,
        ]
            .flat()
            .map(String)
            .join("\n");
        expect(logged).not.toContain(rt);
    });

    it("keeps working for older connectors that send no refreshToken", async () => {
        authedSession();
        const values = mockEmptySelectsAndInserts();
        routeConnectTokenHappyPath();
        const res = await connectTokenPOST(
            connectTokenRequest({
                accessToken: makeUserToken(nowSec() + 30 * DAY),
                refreshToken: "",
                apiBase: API_BASE,
                source: "connector",
            }),
        );
        expect(res.status).toBe(200);
        expect(connectionInsert(values).refreshToken).toBeNull();
    });

    it.each([
        ["a number", 12345],
        ["not JWT-shaped", "not-a-jwt"],
        ["an undecodable payload", "a.b.c"],
        ["over the length cap", `${"a".repeat(5000)}.${"b".repeat(5000)}.c`],
        [
            "a workspace token",
            makeJwt({
                sub: "user-sub",
                ut_ref: "x",
                wid: "ws_1",
                exp: nowSec() + DAY,
            }),
        ],
        ["already expired", makeRefreshToken(nowSec() - 60)],
        ["missing sub", makeJwt({ typ: "refresh", exp: nowSec() + DAY })],
    ])("drops a refreshToken that is %s and connects with a warning", async (_label, refreshToken) => {
        authedSession();
        const values = mockEmptySelectsAndInserts();
        routeConnectTokenHappyPath();
        const res = await connectTokenPOST(
            connectTokenRequest({
                accessToken: makeUserToken(nowSec() + DAY),
                refreshToken,
                apiBase: API_BASE,
                source: "connector",
            }),
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.warning).toMatch(/refresh token could not be used/);
        expect(body.warning).toMatch(/expires in/);
        const row = connectionInsert(values);
        expect(row.refreshToken).toBeNull();
        expect(callsTo("/auth/refresh-user-token")).toHaveLength(0);
    });

    it("drops the refreshToken when the access token has no sub", async () => {
        authedSession();
        const values = mockEmptySelectsAndInserts();
        routeConnectTokenHappyPath();
        const res = await connectTokenPOST(
            connectTokenRequest({
                accessToken: makeJwt({ exp: nowSec() + DAY }),
                refreshToken: makeRefreshToken(nowSec() + 20 * DAY),
                apiBase: API_BASE,
                source: "connector",
            }),
        );
        expect(res.status).toBe(200);
        expect((await res.json()).warning).toMatch(
            /refresh token could not be used/,
        );
        expect(connectionInsert(values).refreshToken).toBeNull();
    });

    it("drops a refreshToken for a different Plaud account and still connects", async () => {
        authedSession();
        const values = mockEmptySelectsAndInserts();
        routeConnectTokenHappyPath();
        const res = await connectTokenPOST(
            connectTokenRequest({
                accessToken: makeUserToken(nowSec() + DAY),
                refreshToken: makeJwt({
                    sub: "someone-else",
                    exp: nowSec() + 20 * DAY,
                }),
                apiBase: API_BASE,
                source: "connector",
            }),
        );
        expect(res.status).toBe(200);
        expect((await res.json()).warning).toMatch(
            /refresh token could not be used/,
        );
        expect(connectionInsert(values).refreshToken).toBeNull();
        expect(callsTo("/auth/refresh-user-token")).toHaveLength(0);
    });

    it.each([
        ["claims ten years", nowSec() + 3650 * DAY],
        ["has no exp", undefined],
    ])("caps the session end at 31 days when the refresh token %s", async (_label, exp) => {
        authedSession();
        const values = mockEmptySelectsAndInserts();
        routeConnectTokenHappyPath();
        const before = Date.now();
        const res = await connectTokenPOST(
            connectTokenRequest({
                accessToken: makeUserToken(nowSec() + DAY),
                refreshToken: makeJwt({ sub: "user-sub", exp }),
                apiBase: API_BASE,
                source: "connector",
            }),
        );
        expect(res.status).toBe(200);
        const row = connectionInsert(values);
        expect(row.refreshToken).not.toBeNull();
        const sessionEnd = (row.sessionExpiresAt as Date).getTime();
        expect(sessionEnd).toBeGreaterThanOrEqual(before + 31 * DAY * 1000);
        expect(sessionEnd).toBeLessThanOrEqual(Date.now() + 31 * DAY * 1000);
    });

    it("warns when a pasted token without refresh token expires within two days", async () => {
        authedSession();
        mockEmptySelectsAndInserts();
        routeConnectTokenHappyPath();
        const res = await connectTokenPOST(
            connectTokenRequest({
                accessToken: makeUserToken(nowSec() + 5 * HOUR - 30),
                apiBase: API_BASE,
                source: "paste",
            }),
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.warning).toMatch(/expires in 5 hours/);
    });

    it("tells connector users without a refresh token which connector version lasts 30 days", async () => {
        authedSession();
        mockEmptySelectsAndInserts();
        routeConnectTokenHappyPath();
        const res = await connectTokenPOST(
            connectTokenRequest({
                accessToken: makeUserToken(nowSec() + DAY - 30),
                apiBase: API_BASE,
                source: "connector",
            }),
        );
        expect(res.status).toBe(200);
        expect((await res.json()).warning).toMatch(
            /expires in 24 hours.*Connector 0\.2\.4 or newer/,
        );
    });

    it.each([
        undefined,
        "",
        " \t ",
    ])("does not warn for a long-lived pasted token with optional refresh value %j", async (refreshToken) => {
        authedSession();
        const values = mockEmptySelectsAndInserts();
        routeConnectTokenHappyPath();
        const res = await connectTokenPOST(
            connectTokenRequest({
                accessToken: makeUserToken(nowSec() + 200 * DAY),
                refreshToken,
                apiBase: API_BASE,
                source: "paste",
            }),
        );
        expect(res.status).toBe(200);
        expect((await res.json()).warning).toBeUndefined();
        expect(connectionInsert(values).refreshToken).toBeNull();
    });
});

// ── Refresh in the client factory ───────────────────────────────────────────

describe("shouldRefreshPlaudAccessToken", () => {
    const now = new Date("2026-11-18T12:00:00Z");
    it("refreshes within an hour of expiry or after it", () => {
        expect(
            shouldRefreshPlaudAccessToken(
                new Date("2026-11-18T12:59:00Z"),
                now,
            ),
        ).toBe(true);
        expect(
            shouldRefreshPlaudAccessToken(
                new Date("2026-11-18T11:00:00Z"),
                now,
            ),
        ).toBe(true);
    });

    it("does not refresh with more than an hour left or an unknown expiry", () => {
        expect(
            shouldRefreshPlaudAccessToken(
                new Date("2026-11-18T13:01:00Z"),
                now,
            ),
        ).toBe(false);
        expect(shouldRefreshPlaudAccessToken(null, now)).toBe(false);
    });
});

describe("createPlaudClient refresh", () => {
    it("refreshes a UT that expires within an hour and persists the rotated tokens", async () => {
        const updates = mockUpdates();
        const newUt = makeUserToken(nowSec() + DAY, "new-ut");
        const newRt = makeRefreshToken(nowSec() + 20 * DAY, "new-rt");
        const utExpireAt = nowSec() + DAY;
        const urtExpireAt = nowSec() + 20 * DAY;
        const oldRt = makeRefreshToken(nowSec() + 20 * DAY, "old-rt");
        routeFetch({
            "/auth/refresh-user-token": () =>
                jsonResponse({
                    status: 0,
                    access_token: newUt,
                    refresh_token: newRt,
                    ut_expire_at: utExpireAt,
                    urt_expire_at: urtExpireAt,
                }),
            "/workspace/token/": mintOk,
            "/device/list": devicesOk,
        });

        const client = await createPlaudClient(
            makeConnection({
                refreshTokenPlain: oldRt,
                accessExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
            }),
        );
        await client.listDevices();

        const refreshCalls = callsTo("/auth/refresh-user-token");
        expect(refreshCalls).toHaveLength(1);
        expect(authHeader(refreshCalls[0][1])).toBe(`Bearer ${oldRt}`);
        const [[, mintInit]] = callsTo("/workspace/token/");
        expect(authHeader(mintInit)).toBe(`Bearer ${newUt}`);

        expect(updates.set).toHaveBeenCalledTimes(1);
        const written = updates.set.mock.calls[0][0] as Record<string, unknown>;
        expect(decrypt(String(written.bearerToken))).toBe(newUt);
        expect(decrypt(String(written.refreshToken))).toBe(newRt);
        expect(String(written.bearerToken)).not.toContain("eyJ");
        expect(written.accessExpiresAt).toEqual(new Date(utExpireAt * 1000));
        const sessionSql = dialect.sqlToQuery(written.sessionExpiresAt as SQL);
        expect(sessionSql.sql).toBe(
            'least("plaud_connections"."session_expires_at", $1::timestamp)',
        );
        expect(sessionSql.params).toEqual([
            new Date(urtExpireAt * 1000).toISOString(),
        ]);

        const where = dialect.sqlToQuery(updates.where.mock.calls[0][0]);
        expect(where.sql).toContain('"plaud_connections"."id" = $');
        expect(where.sql).toContain('"plaud_connections"."user_id" = $');
        expect(where.params).toEqual(
            expect.arrayContaining([CONNECTION_ID, USER_ID]),
        );
    });

    it("does not refresh when the UT has more than an hour left", async () => {
        mockUpdates();
        routeFetch({
            "/workspace/token/": mintOk,
            "/device/list": devicesOk,
        });
        const oldUt = makeUserToken(nowSec() + 20 * HOUR, "old-ut");
        const client = await createPlaudClient(
            makeConnection({ accessToken: oldUt }),
        );
        await client.listDevices();

        expect(callsTo("/auth/refresh-user-token")).toHaveLength(0);
        expect(db.update).not.toHaveBeenCalled();
        const [[, mintInit]] = callsTo("/workspace/token/");
        expect(authHeader(mintInit)).toBe(`Bearer ${oldUt}`);
    });

    it("keeps using a still-valid UT when the refresh call fails transiently", async () => {
        mockUpdates();
        routeFetch({
            "/auth/refresh-user-token": () => jsonResponse({}, 503),
            "/workspace/token/": mintOk,
            "/device/list": devicesOk,
        });
        const oldUt = makeUserToken(nowSec() + 30 * 60, "old-ut");
        const client = await createPlaudClient(
            makeConnection({
                accessToken: oldUt,
                accessExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
            }),
        );
        await client.listDevices();

        expect(callsTo("/auth/refresh-user-token")).toHaveLength(1);
        expect(db.update).not.toHaveBeenCalled();
        const [[, mintInit]] = callsTo("/workspace/token/");
        expect(authHeader(mintInit)).toBe(`Bearer ${oldUt}`);
    });

    it("refreshes once when Plaud answers 401 for the UT, then retries", async () => {
        mockUpdates();
        const oldUt = makeUserToken(nowSec() + 20 * HOUR, "old-ut");
        const newUt = makeUserToken(nowSec() + DAY, "new-ut");
        const rejectOld: RouteHandler = (_url, init) =>
            authHeader(init) === `Bearer ${oldUt}`
                ? jsonResponse({ msg: "expired" }, 401)
                : jsonResponse({
                      status: 0,
                      data: { workspace_token: "wt.new" },
                  });
        routeFetch({
            "/auth/refresh-user-token": () =>
                jsonResponse({ status: 0, access_token: newUt }),
            "/workspace/token/": rejectOld,
            "/device/list": (url, init) =>
                authHeader(init) === `Bearer ${oldUt}`
                    ? jsonResponse({ msg: "expired" }, 401)
                    : devicesOk(url, init),
        });

        const client = await createPlaudClient(
            makeConnection({ accessToken: oldUt }),
        );
        const devices = await client.listDevices();

        expect(devices.data_devices).toHaveLength(1);
        expect(callsTo("/auth/refresh-user-token")).toHaveLength(1);
        const deviceCalls = callsTo("/device/list");
        expect(authHeader(deviceCalls.at(-1)?.[1])).toBe("Bearer wt.new");
    });

    it("does not loop when the refresh token is rejected after a 401", async () => {
        const updates = mockUpdates();
        routeFetch({
            "/auth/refresh-user-token": () => rejectedRefresh(),
            "/workspace/token/": () => jsonResponse({}, 401),
            "/device/list": () => jsonResponse({ msg: "expired" }, 401),
            "/file/simple/web": () => jsonResponse({ msg: "expired" }, 401),
        });

        const client = await createPlaudClient(makeConnection());
        await expect(client.listDevices()).rejects.toMatchObject({
            code: ErrorCode.PLAUD_INVALID_TOKEN,
        });
        await expect(client.getRecordings(0, 10)).rejects.toMatchObject({
            code: ErrorCode.PLAUD_INVALID_TOKEN,
        });
        expect(callsTo("/auth/refresh-user-token")).toHaveLength(1);
        expect(callsTo("/device/list")).toHaveLength(1);
        expect(updates.set).toHaveBeenCalledExactlyOnceWith({
            invalidatedAt: expect.any(Date),
        });
    });

    it("skips the refresh call once the sign-in has ended", async () => {
        await expect(
            createPlaudClient(
                makeConnection({
                    accessExpiresAt: new Date(Date.now() - 60_000),
                    sessionExpiresAt: new Date(Date.now() - 1000),
                }),
            ),
        ).rejects.toMatchObject({ code: ErrorCode.PLAUD_INVALID_TOKEN });
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("backfills expiries for a legacy connection without a refresh token", async () => {
        const updates = mockUpdates();
        const exp = nowSec() + 200 * DAY;
        await createPlaudClient(
            makeConnection({
                accessToken: makeUserToken(exp),
                refreshTokenPlain: null,
                accessExpiresAt: null,
                sessionExpiresAt: null,
            }),
        );

        expect(mockFetch).not.toHaveBeenCalled();
        expect(updates.set).toHaveBeenCalledWith({
            accessExpiresAt: new Date(exp * 1000),
            sessionExpiresAt: expect.any(SQL),
        });
        const where = dialect.sqlToQuery(updates.where.mock.calls[0][0]);
        expect(where.sql).toContain(
            '"plaud_connections"."access_expires_at" is null',
        );
        expect(where.params).toEqual(
            expect.arrayContaining([CONNECTION_ID, USER_ID]),
        );
    });

    it("keeps tokens and ciphertext out of logs and error capture when storing refreshed tokens fails", async () => {
        const oldRt = makeRefreshToken(nowSec() + 20 * DAY, "old-rt");
        const newUt = makeUserToken(nowSec() + DAY, "new-ut");
        const newRt = makeRefreshToken(nowSec() + 20 * DAY, "new-rt");
        const connection = makeConnection({
            refreshTokenPlain: oldRt,
            accessExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
        });
        const written: string[] = [];
        (db.update as Mock).mockReturnValue({
            set: (values: Record<string, unknown>) => ({
                where: () => {
                    const params = [
                        values.bearerToken,
                        values.refreshToken,
                        connection.refreshToken,
                    ].map(String);
                    written.push(...params);
                    throw new DrizzleQueryError(
                        'update "plaud_connections" set "bearer_token" = $1, "refresh_token" = $2 where "refresh_token" = $3',
                        params,
                        Object.assign(new Error("terminating connection"), {
                            code: "57P01",
                        }),
                    );
                },
            }),
        });
        routeFetch({
            "/auth/refresh-user-token": () =>
                jsonResponse({
                    status: 0,
                    access_token: newUt,
                    refresh_token: newRt,
                }),
            "/workspace/token/": mintOk,
            "/device/list": devicesOk,
        });

        const client = await createPlaudClient(connection);
        await client.listDevices();

        const [[, mintInit]] = callsTo("/workspace/token/");
        expect(authHeader(mintInit)).toBe(
            `Bearer ${decrypt(connection.bearerToken)}`,
        );

        const secrets = [
            ...written,
            String(connection.bearerToken),
            oldRt,
            newUt,
            newRt,
        ];
        const logged = JSON.stringify([
            (console.log as Mock).mock.calls,
            (console.info as Mock).mock.calls,
            (console.warn as Mock).mock.calls,
            (console.error as Mock).mock.calls,
        ]);
        const captured = JSON.stringify(
            (captureServerException as Mock).mock.calls.map(
                ([error, context]) => [
                    error instanceof Error
                        ? { message: error.message, cause: error.cause }
                        : error,
                    context,
                ],
            ),
        );
        for (const secret of secrets) {
            expect(logged).not.toContain(secret);
            expect(captured).not.toContain(secret);
        }

        expect(console.error).toHaveBeenCalledWith(
            "[plaud] failed to store refreshed tokens",
        );
        expect(captureServerException).toHaveBeenCalledTimes(1);
        const [error, context] = (captureServerException as Mock).mock.calls[0];
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("plaud_refresh_persist_failed");
        expect((error as Error).cause).toBeUndefined();
        expect(context).toEqual({
            source: "plaud",
            distinctId: USER_ID,
            reason: "refresh_persist_failed",
        });
    });
});

describe("persistRefreshedPlaudTokens compare-and-swap", () => {
    const tokens = {
        accessToken: "new.access.token",
        refreshToken: "new.refresh.token",
        accessExpiresAt: new Date("2026-11-19T12:00:00Z"),
        sessionExpiresAt: new Date("2026-12-10T12:00:00Z"),
    };

    it("only writes while the row still holds the refresh-token ciphertext that was read", async () => {
        const updates = mockUpdates();
        const storedRefreshToken = encrypt("old.refresh.token");
        await persistRefreshedPlaudTokens({
            userId: USER_ID,
            connectionId: CONNECTION_ID,
            storedRefreshToken,
            tokens,
        });

        const where = dialect.sqlToQuery(updates.where.mock.calls[0][0]);
        expect(where.sql).toContain('"plaud_connections"."refresh_token" = $');
        expect(where.sql).not.toContain("access_expires_at");
        expect(where.params).toEqual([
            CONNECTION_ID,
            USER_ID,
            storedRefreshToken,
        ]);
    });

    it("returns null when the stored ciphertext changed", async () => {
        mockUpdates([]);
        await expect(
            persistRefreshedPlaudTokens({
                userId: USER_ID,
                connectionId: CONNECTION_ID,
                storedRefreshToken: encrypt("old.refresh.token"),
                tokens,
            }),
        ).resolves.toBeNull();
    });
});

describe("refresh persistence against a stored row", () => {
    function refreshRoutes(refreshHandler: RouteHandler): void {
        routeFetch({
            "/auth/refresh-user-token": refreshHandler,
            "/team-app/workspaces/list": workspacesOk,
            "/workspace/token/": mintOk,
            "/device/list": devicesOk,
        });
    }

    it("a stale refresh does not overwrite tokens stored by a reconnect", async () => {
        const rtA = makeRefreshToken(nowSec() + 20 * DAY, "rt-a");
        const row = storedConnectionRow({
            accessToken: makeUserToken(nowSec() + 10 * 60, "ut-a"),
            refreshToken: rtA,
            accessExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
            sessionExpiresAt: new Date((nowSec() + 20 * DAY) * 1000),
        });
        installConnectionStore(row);
        const readByRefresher = credentialsFrom(row);

        const utB = makeUserToken(nowSec() + 23 * HOUR, "ut-b");
        const rtB = makeRefreshToken(nowSec() + 30 * DAY, "rt-b");
        const staleUtExp = nowSec() + DAY;
        refreshRoutes(async () => {
            await persistPlaudConnection({
                userId: USER_ID,
                tokens: buildPlaudTokenSet({
                    accessToken: utB,
                    refreshToken: rtB,
                }),
                apiBase: API_BASE,
                plaudEmail: null,
                method: "connector",
            });
            return jsonResponse({
                status: 0,
                access_token: makeUserToken(staleUtExp, "ut-stale"),
                refresh_token: makeRefreshToken(nowSec() + 20 * DAY, "rt-x"),
                ut_expire_at: staleUtExp,
                urt_expire_at: nowSec() + 20 * DAY,
            });
        });

        await createPlaudClient(readByRefresher);

        expect(callsTo("/auth/refresh-user-token")).toHaveLength(1);
        expect(decrypt(String(row.bearerToken))).toBe(utB);
        expect(decrypt(String(row.refreshToken))).toBe(rtB);
        expect(row.accessExpiresAt).toEqual(
            new Date((nowSec() + 23 * HOUR) * 1000),
        );
    });

    it("stores the refreshed tokens when nothing changed the row", async () => {
        const row = storedConnectionRow({
            accessToken: makeUserToken(nowSec() + 10 * 60, "ut-a"),
            refreshToken: makeRefreshToken(nowSec() + 20 * DAY, "rt-a"),
            accessExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
            sessionExpiresAt: new Date((nowSec() + 20 * DAY) * 1000),
        });
        installConnectionStore(row);
        const readCiphertext = row.refreshToken;
        const newUt = makeUserToken(nowSec() + DAY, "ut-new");
        const newRt = makeRefreshToken(nowSec() + 20 * DAY, "rt-new");
        refreshRoutes(() =>
            jsonResponse({
                status: 0,
                access_token: newUt,
                refresh_token: newRt,
            }),
        );

        await createPlaudClient(credentialsFrom(row));

        expect(decrypt(String(row.bearerToken))).toBe(newUt);
        expect(decrypt(String(row.refreshToken))).toBe(newRt);
        expect(row.refreshToken).not.toBe(readCiphertext);
    });

    it("re-encrypts an unrotated refresh token so a second stale writer still loses", async () => {
        const rt = makeRefreshToken(nowSec() + 20 * DAY, "rt-same");
        const row = storedConnectionRow({
            accessToken: makeUserToken(nowSec() + 10 * 60, "ut-a"),
            refreshToken: rt,
            accessExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
            sessionExpiresAt: new Date((nowSec() + 20 * DAY) * 1000),
        });
        installConnectionStore(row);
        const first = credentialsFrom(row);
        const second = credentialsFrom(row);
        const firstUt = makeUserToken(nowSec() + DAY, "ut-first");
        refreshRoutes(() => jsonResponse({ status: 0, access_token: firstUt }));
        await createPlaudClient(first);
        expect(decrypt(String(row.bearerToken))).toBe(firstUt);

        refreshRoutes(() =>
            jsonResponse({
                status: 0,
                access_token: makeUserToken(nowSec() + DAY, "ut-second"),
            }),
        );
        await createPlaudClient(second);

        expect(decrypt(String(row.bearerToken))).toBe(firstUt);
        expect(decrypt(String(row.refreshToken))).toBe(rt);
    });

    it.each([
        false,
        true,
    ])("adopts the winning refresh pair only if its row is healthy (invalidated: %s)", async (invalidated) => {
        const row = storedConnectionRow({
            accessToken: makeUserToken(nowSec() - 60, "expired"),
            refreshToken: makeRefreshToken(nowSec() + 20 * DAY),
            accessExpiresAt: new Date(Date.now() - 60_000),
            sessionExpiresAt: new Date((nowSec() + 20 * DAY) * 1000),
        });
        installConnectionStore(row);
        const snapshot = credentialsFrom(row);
        const firstStarted = Promise.withResolvers<void>();
        const firstResponse = Promise.withResolvers<Response>();
        const winningAccess = makeUserToken(nowSec() + DAY, "winner");
        const winningRefresh = makeRefreshToken(nowSec() + 20 * DAY, "winner");
        const onTokensStored = vi.fn();
        let refreshRequests = 0;
        refreshRoutes(() => {
            if (++refreshRequests === 1) {
                firstStarted.resolve();
                return firstResponse.promise;
            }
            return jsonResponse({
                status: 0,
                access_token: winningAccess,
                refresh_token: winningRefresh,
            });
        });

        const loser = createPlaudClient(snapshot, { onTokensStored });
        await firstStarted.promise;
        const winner = await createPlaudClient(snapshot);
        if (invalidated) row.invalidatedAt = new Date();
        firstResponse.resolve(
            jsonResponse({
                status: 0,
                access_token: makeUserToken(nowSec() + DAY, "unsaved"),
                refresh_token: makeRefreshToken(nowSec() + 20 * DAY, "unsaved"),
            }),
        );

        if (invalidated) {
            await expect(loser).rejects.toMatchObject({
                code: ErrorCode.PLAUD_UPSTREAM_ERROR,
            });
            expect(onTokensStored).not.toHaveBeenCalled();
        } else {
            const losingClient = await loser;
            await Promise.all([
                winner.listDevices(),
                losingClient.listDevices(),
            ]);
            expect(
                callsTo("/workspace/token/").map(([, init]) =>
                    authHeader(init),
                ),
            ).toEqual([`Bearer ${winningAccess}`, `Bearer ${winningAccess}`]);
            expect(onTokensStored).toHaveBeenCalledExactlyOnceWith(
                row.bearerToken,
            );
        }
        expect(decrypt(String(row.refreshToken))).toBe(winningRefresh);
        expect(refreshRequests).toBe(2);
    });

    it("keeps a known session end when the refresh response has none", async () => {
        const sessionEnd = new Date((nowSec() + 20 * DAY) * 1000);
        const row = storedConnectionRow({
            accessToken: makeUserToken(nowSec() + 10 * 60, "ut-a"),
            refreshToken: makeRefreshToken(nowSec() + 20 * DAY, "rt-a"),
            accessExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
            sessionExpiresAt: sessionEnd,
        });
        installConnectionStore(row);
        const newUt = makeUserToken(nowSec() + DAY, "ut-new");
        refreshRoutes(() =>
            jsonResponse({
                status: 0,
                access_token: newUt,
                refresh_token: makeJwt({ sub: "user-sub", tag: "no-exp" }),
            }),
        );

        await createPlaudClient(credentialsFrom(row));

        expect(decrypt(String(row.bearerToken))).toBe(newUt);
        expect(row.sessionExpiresAt).toEqual(sessionEnd);
    });

    it.each([
        ["later than the stored end", 10, 30, 10],
        ["earlier than the stored end", 20, 5, 5],
    ])("keeps the earlier session end when the refresh reports one %s", async (_label, storedDays, refreshedDays, expectedDays) => {
        const row = storedConnectionRow({
            accessToken: makeUserToken(nowSec() + 10 * 60, "ut-a"),
            refreshToken: makeRefreshToken(nowSec() + 20 * DAY, "rt-a"),
            accessExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
            sessionExpiresAt: new Date((nowSec() + storedDays * DAY) * 1000),
        });
        installConnectionStore(row);
        const expected = new Date((nowSec() + expectedDays * DAY) * 1000);
        refreshRoutes(() =>
            jsonResponse({
                status: 0,
                access_token: makeUserToken(nowSec() + DAY, "ut-new"),
                refresh_token: makeRefreshToken(nowSec() + 20 * DAY, "rt-new"),
                urt_expire_at: nowSec() + refreshedDays * DAY,
            }),
        );

        await createPlaudClient(credentialsFrom(row));

        expect(row.sessionExpiresAt).toEqual(expected);
    });

    it("stores the refreshed session end when none was known", async () => {
        const row = storedConnectionRow({
            accessToken: makeUserToken(nowSec() + 10 * 60, "ut-a"),
            refreshToken: makeRefreshToken(nowSec() + 20 * DAY, "rt-a"),
            accessExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
            sessionExpiresAt: null,
        });
        installConnectionStore(row);
        const urtExpireAt = nowSec() + 12 * DAY;
        refreshRoutes(() =>
            jsonResponse({
                status: 0,
                access_token: makeUserToken(nowSec() + DAY, "ut-new"),
                urt_expire_at: urtExpireAt,
            }),
        );

        await createPlaudClient(credentialsFrom(row));

        expect(row.sessionExpiresAt).toEqual(new Date(urtExpireAt * 1000));
    });
});

// ── Sync: refresh failure marks reconnect ───────────────────────────────────

function mockSyncSelects(connection: PlaudConnectionCredentials): void {
    const chain = (rows: unknown[]) => ({
        from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue(rows),
            }),
        }),
    });
    (db.select as Mock)
        .mockReturnValueOnce(chain([connection]))
        .mockReturnValueOnce(chain([{ id: "settings-1" }]))
        .mockReturnValueOnce(chain([{ email: "me@example.com" }]));
}

describe("sync with a rejected refresh token", () => {
    it("marks the connection for reconnect after a single refresh attempt", async () => {
        const connection = makeConnection({
            accessToken: makeUserToken(nowSec() - 60),
            accessExpiresAt: new Date(Date.now() - 60_000),
        });
        mockSyncSelects(connection);
        const updates = mockUpdates();
        routeFetch({
            "/auth/refresh-user-token": () => rejectedRefresh(),
        });

        const result = await syncRecordingsForUser(USER_ID);

        expect(result.needsReconnect).toBe(true);
        expect(updates.set).toHaveBeenCalledWith(
            expect.objectContaining({ invalidatedAt: expect.any(Date) }),
        );
        expect(callsTo("/auth/refresh-user-token")).toHaveLength(1);
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("surfaces the refresh rejection as PLAUD_INVALID_TOKEN", async () => {
        routeFetch({
            "/auth/refresh-user-token": () => rejectedRefresh(),
        });
        const err = await createPlaudClient(
            makeConnection({ accessExpiresAt: new Date(Date.now() - 1000) }),
        ).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe(ErrorCode.PLAUD_INVALID_TOKEN);
    });
});

describe("sync invalidation against a stored row", () => {
    function expiredRow(): ConnectionRow {
        return storedConnectionRow({
            accessToken: makeUserToken(nowSec() - 60, "ut-a"),
            refreshToken: makeRefreshToken(nowSec() + 20 * DAY, "rt-a"),
            accessExpiresAt: new Date(Date.now() - 60_000),
            sessionExpiresAt: new Date((nowSec() + 20 * DAY) * 1000),
        });
    }

    it("does not flag a reconnect that replaced the sign-in which failed", async () => {
        const row = expiredRow();
        installConnectionStore(row);
        const utB = makeUserToken(nowSec() + DAY, "ut-b");
        const rtB = makeRefreshToken(nowSec() + 30 * DAY, "rt-b");
        routeFetch({
            "/auth/refresh-user-token": async () => {
                await persistPlaudConnection({
                    userId: USER_ID,
                    tokens: buildPlaudTokenSet({
                        accessToken: utB,
                        refreshToken: rtB,
                    }),
                    apiBase: API_BASE,
                    plaudEmail: null,
                    method: "connector",
                });
                return rejectedRefresh();
            },
            "/team-app/workspaces/list": workspacesOk,
            "/workspace/token/": mintOk,
            "/device/list": devicesOk,
        });

        const result = await syncRecordingsForUser(USER_ID);

        expect(decrypt(String(row.bearerToken))).toBe(utB);
        expect(row.invalidatedAt).toBeNull();
        expect(result.needsReconnect).toBeFalsy();
        expect(result.errors.join(" ")).toMatch(/changed during this sync/);
    });

    it("flags the row while it still holds the token that failed", async () => {
        const row = expiredRow();
        installConnectionStore(row);
        routeFetch({
            "/auth/refresh-user-token": () => rejectedRefresh(),
        });

        const result = await syncRecordingsForUser(USER_ID);

        expect(row.invalidatedAt).toBeInstanceOf(Date);
        expect(result.needsReconnect).toBe(true);
    });

    it("flags the row after the failing client stored a refresh of its own", async () => {
        const row = storedConnectionRow({
            accessToken: makeUserToken(nowSec() + 10 * 60, "ut-a"),
            refreshToken: makeRefreshToken(nowSec() + 20 * DAY, "rt-a"),
            accessExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
            sessionExpiresAt: new Date((nowSec() + 20 * DAY) * 1000),
        });
        installConnectionStore(row);
        const readCiphertext = row.bearerToken;
        let refreshCalls = 0;
        routeFetch({
            "/auth/refresh-user-token": () => {
                refreshCalls += 1;
                return refreshCalls === 1
                    ? jsonResponse({
                          status: 0,
                          access_token: makeUserToken(
                              nowSec() + DAY,
                              "ut-refreshed",
                          ),
                      })
                    : rejectedRefresh();
            },
            "/workspace/token/": mintOk,
            "/file/simple/web": () => jsonResponse({ msg: "expired" }, 401),
        });

        const result = await syncRecordingsForUser(USER_ID);

        expect(refreshCalls).toBe(2);
        expect(row.bearerToken).not.toBe(readCiphertext);
        expect(row.invalidatedAt).toBeInstanceOf(Date);
        expect(result.needsReconnect).toBe(true);
    });
});

// ── Workspace token 401s ─────────────────────────────────────────────────────

/**
 * Mint hands out `wt.1`, `wt.2`, ... per user token; device list and
 * recordings accept only the workspace tokens in `accepted`.
 */
function routeWorkspaceTokens(input: {
    accepted: (wt: string) => boolean;
    refresh?: RouteHandler;
}): { mintedBy: string[] } {
    const mintedBy: string[] = [];
    const dataRoute =
        (ok: RouteHandler): RouteHandler =>
        (url, init) => {
            const wt = authHeader(init)?.replace(/^Bearer /, "") ?? "";
            return input.accepted(wt)
                ? ok(url, init)
                : jsonResponse({ msg: "expired" }, 401);
        };
    routeFetch({
        "/auth/refresh-user-token":
            input.refresh ??
            (() => {
                throw new Error("unexpected refresh");
            }),
        "/workspace/token/": (_url, init) => {
            mintedBy.push(authHeader(init) ?? "");
            return jsonResponse({
                status: 0,
                data: { workspace_token: `wt.${mintedBy.length}` },
            });
        },
        "/device/list": dataRoute(devicesOk),
        "/file/simple/web": dataRoute(() =>
            jsonResponse({ status: 0, data_file_list: [] }),
        ),
    });
    return { mintedBy };
}

describe("workspace token 401", () => {
    it.each([
        "legacy",
        "v4",
    ])("fails a %s listing when the mint after refresh is rejected", async (listing) => {
        const oldUt = makeUserToken(nowSec() + DAY, "old-ut");
        const newUt = makeUserToken(nowSec() + DAY, "new-ut");
        const row = storedConnectionRow({
            accessToken: oldUt,
            refreshToken: makeRefreshToken(nowSec() + 20 * DAY),
            accessExpiresAt: new Date((nowSec() + DAY) * 1000),
            sessionExpiresAt: new Date((nowSec() + 20 * DAY) * 1000),
        });
        installConnectionStore(row);
        let mints = 0;
        const list: RouteHandler = (_url, init) =>
            authHeader(init) === "Bearer wt.workspace.token"
                ? jsonResponse({ msg: "expired" }, 401)
                : jsonResponse({
                      status: 0,
                      data_file_list: [],
                      data: { items: [] },
                  });
        routeFetch({
            "/workspace/token/": (url, init) =>
                ++mints === 1 ? mintOk(url, init) : jsonResponse({}, 401),
            "/auth/refresh-user-token": () =>
                jsonResponse({ status: 0, access_token: newUt }),
            "/file/simple/web": (url, init) =>
                listing === "v4"
                    ? jsonResponse({
                          status: -1800907,
                          msg: "Account migrated to 4.0",
                      })
                    : list(url, init),
            "/file-app/v4/recordings/all": list,
        });

        const result = await syncRecordingsForUser(USER_ID);

        expect(result).toMatchObject({
            errorCode: ErrorCode.PLAUD_INVALID_TOKEN,
            needsReconnect: true,
        });
        expect(row.lastSync).toBeUndefined();
        expect(decrypt(String(row.bearerToken))).toBe(newUt);
        expect(callsTo("/auth/refresh-user-token")).toHaveLength(1);
        expect(
            callsTo(listing === "v4" ? "/recordings/all" : "/file/simple/web"),
        ).toHaveLength(1);
        expect(
            callsTo("/workspace/token/").map(([, init]) => authHeader(init)),
        ).toEqual([`Bearer ${oldUt}`, `Bearer ${oldUt}`, `Bearer ${newUt}`]);
    });

    it("refreshes after a cached re-mint 404 and a workspace discovery 401", async () => {
        mockUpdates();
        const oldUt = makeUserToken(nowSec() + DAY, "old-ut");
        const newUt = makeUserToken(nowSec() + DAY, "new-ut");
        let mints = 0;
        routeFetch({
            "/workspace/token/": (_url, init) => {
                mints++;
                if (mints === 2) return jsonResponse({}, 404);
                return jsonResponse({
                    status: 0,
                    data: {
                        workspace_token:
                            authHeader(init) === `Bearer ${oldUt}`
                                ? "wt.old"
                                : "wt.new",
                    },
                });
            },
            "/team-app/workspaces/list": () => jsonResponse({}, 401),
            "/auth/refresh-user-token": () =>
                jsonResponse({ status: 0, access_token: newUt }),
            "/file/simple/web": (_url, init) =>
                authHeader(init) === "Bearer wt.old"
                    ? jsonResponse({}, 401)
                    : jsonResponse({
                          status: 0,
                          data_file_list: [{ id: "recording-1" }],
                      }),
        });
        const client = await createPlaudClient(
            makeConnection({ accessToken: oldUt }),
        );

        const result = await client.getRecordings(0, 10);

        expect(result.data_file_list.map(({ id }) => id)).toEqual([
            "recording-1",
        ]);
        expect(callsTo("").map(([url]) => new URL(url).pathname)).toEqual([
            "/user-app/auth/workspace/token/ws_personal",
            "/file/simple/web",
            "/user-app/auth/workspace/token/ws_personal",
            "/team-app/workspaces/list",
            "/auth/refresh-user-token",
            "/user-app/auth/workspace/token/ws_personal",
            "/file/simple/web",
        ]);
    });

    it("discovers a workspace after a rate-limited first cached mint on a legacy connection", async () => {
        const oldUt = makeUserToken(nowSec() + DAY, "legacy-ut");
        let mints = 0;
        routeFetch({
            "/workspace/token/": (url, init) =>
                ++mints === 1 ? jsonResponse({}, 429) : mintOk(url, init),
            "/team-app/workspaces/list": workspacesOk,
            "/file/simple/web": (_url, init) =>
                jsonResponse({
                    status: 0,
                    data_file_list:
                        authHeader(init) === "Bearer wt.workspace.token"
                            ? [{ id: "recording-1" }]
                            : [],
                }),
        });
        const client = await createPlaudClient(
            makeConnection({ accessToken: oldUt, refreshTokenPlain: null }),
        );

        const result = await client.getRecordings(0, 10);

        expect(result.data_file_list.map(({ id }) => id)).toEqual([
            "recording-1",
        ]);
        expect(callsTo("").map(([url]) => new URL(url).pathname)).toEqual([
            "/user-app/auth/workspace/token/ws_personal",
            "/team-app/workspaces/list",
            "/user-app/auth/workspace/token/ws_personal",
            "/file/simple/web",
        ]);
    });

    it("refreshes once after a re-mint 401 before retrying concurrent listings", async () => {
        const updates = mockUpdates();
        const oldUt = makeUserToken(nowSec() + DAY, "old-ut");
        const newUt = makeUserToken(nowSec() + DAY, "new-ut");
        let oldMints = 0;
        routeFetch({
            "/auth/refresh-user-token": () =>
                jsonResponse({ status: 0, access_token: newUt }),
            "/workspace/token/": (_url, init) => {
                if (authHeader(init) === `Bearer ${newUt}`) {
                    return jsonResponse({
                        status: 0,
                        data: { workspace_token: "wt.new" },
                    });
                }
                oldMints++;
                return oldMints === 1
                    ? jsonResponse({
                          status: 0,
                          data: { workspace_token: "wt.old" },
                      })
                    : jsonResponse({ msg: "expired" }, 401);
            },
            "/file/simple/web": (_url, init) =>
                authHeader(init) === "Bearer wt.old"
                    ? jsonResponse({ msg: "expired" }, 401)
                    : jsonResponse({ status: 0, data_file_list: [] }),
        });
        const client = await createPlaudClient(
            makeConnection({ accessToken: oldUt }),
        );
        await Promise.all([
            client.getRecordings(0, 10),
            client.getRecordings(0, 10),
        ]);

        expect(oldMints).toBe(2);
        expect(callsTo("/auth/refresh-user-token")).toHaveLength(1);
        const listAuth = callsTo("/file/simple/web").map(([, init]) =>
            authHeader(init),
        );
        expect(listAuth).not.toContain(`Bearer ${oldUt}`);
        expect(
            listAuth.filter((auth) => auth === "Bearer wt.new"),
        ).toHaveLength(2);
        expect(updates.set).toHaveBeenCalledTimes(1);
    });

    it("keeps the original 401 when a legacy re-mint fails and the user token would return an empty list", async () => {
        const oldUt = makeUserToken(nowSec() + DAY, "legacy-ut");
        let mints = 0;
        routeFetch({
            "/workspace/token/": () => {
                mints++;
                return mints === 1
                    ? mintOk("", undefined)
                    : jsonResponse({}, 401);
            },
            "/file/simple/web": (_url, init) =>
                authHeader(init) === `Bearer ${oldUt}`
                    ? jsonResponse({ status: 0, data_file_list: [] })
                    : jsonResponse({ msg: "expired" }, 401),
        });
        const client = await createPlaudClient(
            makeConnection({ accessToken: oldUt, refreshTokenPlain: null }),
        );

        await expect(client.getRecordings(0, 10)).rejects.toMatchObject({
            code: ErrorCode.PLAUD_INVALID_TOKEN,
            statusCode: 401,
        });
        expect(mints).toBe(2);
        expect(callsTo("/file/simple/web")).toHaveLength(1);
        expect(callsTo("/auth/refresh-user-token")).toHaveLength(0);
    });

    it("re-mints the workspace token without refreshing a valid user token", async () => {
        mockUpdates();
        const ut = makeUserToken(nowSec() + 20 * HOUR, "ut");
        const { mintedBy } = routeWorkspaceTokens({
            accepted: (wt) => wt === "wt.2",
            refresh: () => jsonResponse({}, 500),
        });

        const client = await createPlaudClient(
            makeConnection({ accessToken: ut }),
        );
        const devices = await client.listDevices();

        expect(devices.data_devices).toHaveLength(1);
        expect(callsTo("/auth/refresh-user-token")).toHaveLength(0);
        expect(mintedBy).toEqual([`Bearer ${ut}`, `Bearer ${ut}`]);
        expect(db.update).not.toHaveBeenCalled();
    });

    it("re-mints once for a legacy connection without a refresh token", async () => {
        const ut = makeUserToken(nowSec() + 200 * DAY, "legacy-ut");
        const { mintedBy } = routeWorkspaceTokens({
            accepted: (wt) => wt === "wt.2",
        });

        const client = await createPlaudClient(
            makeConnection({
                accessToken: ut,
                refreshTokenPlain: null,
                accessExpiresAt: new Date((nowSec() + 200 * DAY) * 1000),
            }),
        );
        const devices = await client.listDevices();

        expect(devices.data_devices).toHaveLength(1);
        expect(mintedBy).toHaveLength(2);
        expect(callsTo("/auth/refresh-user-token")).toHaveLength(0);
    });

    it("fails a legacy connection after one re-mint with zero refresh calls", async () => {
        const { mintedBy } = routeWorkspaceTokens({ accepted: () => false });

        const client = await createPlaudClient(
            makeConnection({
                refreshTokenPlain: null,
                accessExpiresAt: new Date((nowSec() + 200 * DAY) * 1000),
            }),
        );
        await expect(client.listDevices()).rejects.toMatchObject({
            code: ErrorCode.PLAUD_INVALID_TOKEN,
        });
        await expect(client.getRecordings(0, 10)).rejects.toMatchObject({
            code: ErrorCode.PLAUD_INVALID_TOKEN,
        });

        expect(mintedBy).toHaveLength(2);
        expect(callsTo("/device/list")).toHaveLength(2);
        expect(callsTo("/file/simple/web")).toHaveLength(1);
        expect(callsTo("/auth/refresh-user-token")).toHaveLength(0);
    });

    it("refreshes the user token only after the re-minted workspace token also 401s", async () => {
        mockUpdates();
        const oldUt = makeUserToken(nowSec() + 20 * HOUR, "old-ut");
        const newUt = makeUserToken(nowSec() + DAY, "new-ut");
        const { mintedBy } = routeWorkspaceTokens({
            accepted: (wt) => wt === "wt.3",
            refresh: () => jsonResponse({ status: 0, access_token: newUt }),
        });

        const client = await createPlaudClient(
            makeConnection({ accessToken: oldUt }),
        );
        const devices = await client.listDevices();

        expect(devices.data_devices).toHaveLength(1);
        expect(callsTo("/auth/refresh-user-token")).toHaveLength(1);
        expect(mintedBy).toEqual([
            `Bearer ${oldUt}`,
            `Bearer ${oldUt}`,
            `Bearer ${newUt}`,
        ]);
    });

    it("shares one re-mint and one refresh between concurrent 401s", async () => {
        mockUpdates();
        const oldUt = makeUserToken(nowSec() + 20 * HOUR, "old-ut");
        const newUt = makeUserToken(nowSec() + DAY, "new-ut");
        const { mintedBy } = routeWorkspaceTokens({
            accepted: (wt) => wt === "wt.3",
            refresh: async () => {
                await new Promise((resolve) => setTimeout(resolve, 5));
                return jsonResponse({ status: 0, access_token: newUt });
            },
        });

        const client = await createPlaudClient(
            makeConnection({ accessToken: oldUt }),
        );
        const [devices, recordings, again] = await Promise.all([
            client.listDevices(),
            client.getRecordings(0, 10),
            client.listDevices(),
        ]);

        expect(devices.data_devices).toHaveLength(1);
        expect(again.data_devices).toHaveLength(1);
        expect(recordings.data_file_list).toEqual([]);
        expect(callsTo("/auth/refresh-user-token")).toHaveLength(1);
        expect(mintedBy).toHaveLength(3);
    });
});

describe("repeated 401 episodes on one client", () => {
    function rotatingRefresh(delayMs = 0): {
        handler: RouteHandler;
        issued: { ut: string; rt: string }[];
    } {
        const issued: { ut: string; rt: string }[] = [];
        const handler: RouteHandler = async () => {
            const n = issued.length + 1;
            const ut = makeUserToken(nowSec() + DAY, `ut-${n}`);
            const rt = makeRefreshToken(nowSec() + 20 * DAY, `rt-${n}`);
            issued.push({ ut, rt });
            if (delayMs) {
                await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
            return jsonResponse({
                status: 0,
                access_token: ut,
                refresh_token: rt,
            });
        };
        return { handler, issued };
    }

    it("refreshes again on a later 401 and shares that refresh between concurrent requests", async () => {
        const updates = mockUpdates();
        const oldUt = makeUserToken(nowSec() + 20 * HOUR, "old-ut");
        const oldRt = makeRefreshToken(nowSec() + 20 * DAY, "old-rt");
        const connection = makeConnection({
            accessToken: oldUt,
            refreshTokenPlain: oldRt,
        });
        let acceptedWt = "wt.3";
        const refresh = rotatingRefresh(5);
        const { mintedBy } = routeWorkspaceTokens({
            accepted: (wt) => wt === acceptedWt,
            refresh: refresh.handler,
        });

        const client = await createPlaudClient(connection);
        await client.listDevices();
        expect(callsTo("/auth/refresh-user-token")).toHaveLength(1);

        acceptedWt = "wt.5";
        const results = await Promise.all([
            client.listDevices(),
            client.getRecordings(0, 10),
            client.listDevices(),
        ]);
        expect(results).toHaveLength(3);

        const refreshCalls = callsTo("/auth/refresh-user-token");
        expect(refreshCalls).toHaveLength(2);
        expect(authHeader(refreshCalls[0][1])).toBe(`Bearer ${oldRt}`);
        expect(authHeader(refreshCalls[1][1])).toBe(
            `Bearer ${refresh.issued[0].rt}`,
        );
        expect(mintedBy).toEqual([
            `Bearer ${oldUt}`,
            `Bearer ${oldUt}`,
            `Bearer ${refresh.issued[0].ut}`,
            `Bearer ${refresh.issued[0].ut}`,
            `Bearer ${refresh.issued[1].ut}`,
        ]);

        expect(updates.set).toHaveBeenCalledTimes(2);
        const firstWrite = updates.set.mock.calls[0][0] as Record<
            string,
            unknown
        >;
        const secondWhere = dialect.sqlToQuery(updates.where.mock.calls[1][0]);
        expect(secondWhere.params).toEqual([
            CONNECTION_ID,
            USER_ID,
            firstWrite.refreshToken,
        ]);
    });

    it("stops after one re-mint and one refresh when Plaud rejects every workspace token", async () => {
        mockUpdates();
        const refresh = rotatingRefresh();
        const { mintedBy } = routeWorkspaceTokens({
            accepted: () => false,
            refresh: refresh.handler,
        });

        const client = await createPlaudClient(makeConnection());
        await expect(client.listDevices()).rejects.toMatchObject({
            code: ErrorCode.PLAUD_INVALID_TOKEN,
        });

        expect(callsTo("/auth/refresh-user-token")).toHaveLength(1);
        expect(callsTo("/device/list")).toHaveLength(3);
        expect(mintedBy).toHaveLength(3);
    });
});

// ── Transient refresh failures ────────────────────────────────────────────────

type RefreshFailure = [string, RouteHandler, ErrorCode];

const transientRefreshFailures: RefreshFailure[] = [
    [
        "a 429",
        () => jsonResponse({ msg: "slow down" }, 429),
        ErrorCode.PLAUD_RATE_LIMITED,
    ],
    [
        "a 503",
        () => jsonResponse({ msg: "down" }, 503),
        ErrorCode.PLAUD_UPSTREAM_ERROR,
    ],
    [
        "a network error",
        () => {
            throw new TypeError("fetch failed");
        },
        ErrorCode.PLAUD_UPSTREAM_ERROR,
    ],
];

const mintFailures: RefreshFailure[] = [
    ["a 401", () => jsonResponse({}, 401), ErrorCode.PLAUD_INVALID_TOKEN],
    ...transientRefreshFailures,
];

it.each([
    ...mintFailures.flatMap(([failure, fail, code]) => [
        ...(["first mint", "re-mint"] as const).flatMap((phase) =>
            [false, true].map((refreshable) => ({
                phase,
                failure,
                fail,
                code,
                refreshable,
            })),
        ),
        {
            phase: "mint after refresh" as const,
            failure,
            fail,
            code,
            refreshable: true,
        },
    ]),
    ...transientRefreshFailures.map(([failure, fail, code]) => ({
        phase: "data retry" as const,
        failure,
        fail,
        code,
        refreshable: true,
    })),
])("$phase facing $failure (refresh support: $refreshable)", async ({
    phase,
    fail,
    code,
    refreshable,
}) => {
    mockUpdates();
    const oldUt = makeUserToken(nowSec() + DAY, "old-ut");
    const newUt = makeUserToken(nowSec() + DAY, "new-ut");
    const events: string[] = [];
    let mints = 0;
    routeFetch({
        "/workspace/token/": (url, init) => {
            const isNew = authHeader(init) === `Bearer ${newUt}`;
            events.push(isNew ? "mint new" : "mint old");
            mints++;
            if (phase === "first mint") return fail(url, init);
            if (mints === 1) return mintOk(url, init);
            if (phase === "re-mint" && !isNew) return fail(url, init);
            if (phase === "mint after refresh") {
                return isNew ? fail(url, init) : jsonResponse({}, 401);
            }
            return jsonResponse({
                status: 0,
                data: { workspace_token: "wt.new" },
            });
        },
        "/team-app/workspaces/list": (url, init) => {
            events.push("discover");
            return workspacesOk(url, init);
        },
        "/auth/refresh-user-token": () => {
            events.push("refresh");
            return jsonResponse({ status: 0, access_token: newUt });
        },
        "/file/simple/web": (url, init) => {
            const bearer = authHeader(init);
            if (bearer === "Bearer wt.workspace.token") {
                events.push("list with old workspace token");
                return jsonResponse({}, 401);
            }
            events.push(
                bearer === "Bearer wt.new"
                    ? "list with new workspace token"
                    : "list with user token",
            );
            if (phase === "data retry") return fail(url, init);
            return jsonResponse({
                status: 0,
                data_file_list: [{ id: "recording-1" }],
            });
        },
    });
    const client = await createPlaudClient(
        makeConnection({
            accessToken: oldUt,
            ...(refreshable ? {} : { refreshTokenPlain: null }),
        }),
    );
    const request = client.getRecordings(0, 10);

    if (phase === "first mint") {
        await expect(request).resolves.toMatchObject({
            data_file_list: [{ id: "recording-1" }],
        });
        expect(events).toEqual([
            "mint old",
            ...(code === ErrorCode.PLAUD_RATE_LIMITED
                ? ["discover", "mint old"]
                : []),
            "list with user token",
        ]);
    } else if (
        phase === "re-mint" &&
        refreshable &&
        code === ErrorCode.PLAUD_INVALID_TOKEN
    ) {
        await expect(request).resolves.toMatchObject({
            data_file_list: [{ id: "recording-1" }],
        });
        expect(events).toEqual([
            "mint old",
            "list with old workspace token",
            "mint old",
            "refresh",
            "mint new",
            "list with new workspace token",
        ]);
    } else {
        await expect(request).rejects.toMatchObject({ code });
        expect(events).toEqual([
            "mint old",
            "list with old workspace token",
            "mint old",
            ...(phase === "mint after refresh" ? ["refresh", "mint new"] : []),
            ...(phase === "data retry"
                ? ["list with new workspace token"]
                : []),
        ]);
    }
});

describe("transient failures during a workspace re-mint", () => {
    it.each(
        transientRefreshFailures,
    )("propagates %s without using the user token", async (_label, fail, code) => {
        let mints = 0;
        routeFetch({
            "/workspace/token/": (url, init) => {
                mints++;
                return mints === 1 ? mintOk(url, init) : fail(url, init);
            },
            "/file/simple/web": (_url, init) =>
                authHeader(init) === "Bearer wt.workspace.token"
                    ? jsonResponse({ msg: "expired" }, 401)
                    : jsonResponse({ status: 0, data_file_list: [] }),
        });
        const client = await createPlaudClient(
            makeConnection({ refreshTokenPlain: null }),
        );

        await expect(client.getRecordings(0, 10)).rejects.toMatchObject({
            code,
        });
        expect(mints).toBe(2);
        expect(callsTo("/file/simple/web")).toHaveLength(1);
        expect(callsTo("/auth/refresh-user-token")).toHaveLength(0);
    });
});

/** Plaud rejects `rejectedUt` everywhere and accepts anything else. */
function routeWithExpiredUserToken(
    rejectedUt: string,
    refresh: RouteHandler,
): void {
    const rejectOld =
        (ok: RouteHandler): RouteHandler =>
        (url, init) =>
            authHeader(init) === `Bearer ${rejectedUt}`
                ? jsonResponse({ msg: "expired" }, 401)
                : ok(url, init);
    routeFetch({
        "/auth/refresh-user-token": refresh,
        "/workspace/token/": rejectOld(() =>
            jsonResponse({ status: 0, data: { workspace_token: "wt.new" } }),
        ),
        "/device/list": rejectOld(devicesOk),
        "/file/simple/web": rejectOld(() =>
            jsonResponse({ status: 0, data_file_list: [] }),
        ),
    });
}

describe("transient refresh failures after a 401", () => {
    it.each(
        transientRefreshFailures,
    )("rethrows %s instead of reporting an invalid token", async (_label, refresh, code) => {
        mockUpdates();
        const oldUt = makeUserToken(nowSec() + 20 * HOUR, "old-ut");
        routeWithExpiredUserToken(oldUt, refresh);

        const client = await createPlaudClient(
            makeConnection({ accessToken: oldUt }),
        );

        await expect(client.listDevices()).rejects.toMatchObject({ code });
        expect(callsTo("/auth/refresh-user-token")).toHaveLength(1);
    });

    it("retries the refresh on a later 401 after a transient failure", async () => {
        mockUpdates();
        const oldUt = makeUserToken(nowSec() + 20 * HOUR, "old-ut");
        const newUt = makeUserToken(nowSec() + DAY, "new-ut");
        let refreshCalls = 0;
        routeWithExpiredUserToken(oldUt, () => {
            refreshCalls += 1;
            return refreshCalls === 1
                ? jsonResponse({}, 503)
                : jsonResponse({ status: 0, access_token: newUt });
        });

        const client = await createPlaudClient(
            makeConnection({ accessToken: oldUt }),
        );
        await expect(client.listDevices()).rejects.toMatchObject({
            code: ErrorCode.PLAUD_UPSTREAM_ERROR,
        });
        const devices = await client.listDevices();

        expect(devices.data_devices).toHaveLength(1);
        expect(callsTo("/auth/refresh-user-token")).toHaveLength(2);
    });

    it("does not mark the connection for reconnect when the refresh fails transiently", async () => {
        const oldUt = makeUserToken(nowSec() + 20 * HOUR, "old-ut");
        mockSyncSelects(makeConnection({ accessToken: oldUt }));
        const updates = mockUpdates();
        routeWithExpiredUserToken(oldUt, () => jsonResponse({}, 503));

        const result = await syncRecordingsForUser(USER_ID);

        expect(result.needsReconnect).toBeFalsy();
        expect(updates.set).not.toHaveBeenCalledWith(
            expect.objectContaining({ invalidatedAt: expect.any(Date) }),
        );
        expect(result.errors.join(" ")).toMatch(/temporarily unavailable/);
    });
});

it.each([
    false,
    true,
])("handles a 401 on the first-mint user-token fallback (refresh support: %s)", async (refreshable) => {
    mockUpdates();
    const oldUt = makeUserToken(nowSec() + DAY, "old-ut");
    const newUt = makeUserToken(nowSec() + DAY, "new-ut");
    routeWithExpiredUserToken(oldUt, () =>
        jsonResponse({ status: 0, access_token: newUt }),
    );
    const client = await createPlaudClient(
        makeConnection({
            accessToken: oldUt,
            ...(refreshable ? {} : { refreshTokenPlain: null }),
        }),
    );

    const request = client.listDevices();
    if (refreshable) {
        await expect(request).resolves.toMatchObject({ status: 0 });
    } else {
        await expect(request).rejects.toMatchObject({
            code: ErrorCode.PLAUD_INVALID_TOKEN,
        });
    }
    expect(callsTo("").map(([url]) => new URL(url).pathname)).toEqual([
        "/user-app/auth/workspace/token/ws_personal",
        "/device/list",
        ...(refreshable
            ? [
                  "/auth/refresh-user-token",
                  "/user-app/auth/workspace/token/ws_personal",
                  "/device/list",
              ]
            : []),
    ]);
});

it("keeps using the user-token fallback when workspace minting still fails after refresh", async () => {
    mockUpdates();
    const oldUt = makeUserToken(nowSec() + DAY, "old-ut");
    const newUt = makeUserToken(nowSec() + DAY, "new-ut");
    routeFetch({
        "/workspace/token/": () => jsonResponse({}, 401),
        "/auth/refresh-user-token": () =>
            jsonResponse({ status: 0, access_token: newUt }),
        "/file/simple/web": (_url, init) =>
            authHeader(init) === `Bearer ${newUt}`
                ? jsonResponse({
                      status: 0,
                      data_file_list: [{ id: "recording-1" }],
                  })
                : jsonResponse({}, 401),
    });
    const client = await createPlaudClient(
        makeConnection({ accessToken: oldUt }),
    );

    await expect(client.getRecordings(0, 10)).resolves.toMatchObject({
        data_file_list: [{ id: "recording-1" }],
    });
    expect(client.usingUserTokenFallback).toBe(true);
    expect(
        callsTo("/workspace/token/").map(([, init]) => authHeader(init)),
    ).toEqual([`Bearer ${oldUt}`, `Bearer ${newUt}`]);
    expect(
        callsTo("/file/simple/web").map(([, init]) => authHeader(init)),
    ).toEqual([`Bearer ${oldUt}`, `Bearer ${newUt}`]);
    expect(callsTo("/auth/refresh-user-token")).toHaveLength(1);
});

describe("transient failures of the early refresh", () => {
    it("does not invalidate a connection when refresh returns a proxy 407", async () => {
        mockSyncSelects(
            makeConnection({ accessExpiresAt: new Date(Date.now() - 60_000) }),
        );
        const updates = mockUpdates();
        routeFetch({
            "/auth/refresh-user-token": () =>
                jsonResponse({ detail: "proxy authentication required" }, 407),
        });

        const result = await syncRecordingsForUser(USER_ID);

        expect(result.errorCode).toBe(ErrorCode.PLAUD_UPSTREAM_ERROR);
        expect(result.needsReconnect).toBeFalsy();
        expect(updates.set).not.toHaveBeenCalled();
    });

    it.each(
        transientRefreshFailures,
    )("uses the still-valid token after %s and retries on a later 401", async (_label, refresh) => {
        mockUpdates();
        const oldUt = makeUserToken(nowSec() + 30 * 60, "old-ut");
        const newUt = makeUserToken(nowSec() + DAY, "new-ut");
        let refreshCalls = 0;
        let oldUtAccepted = true;
        const acceptsOldUt: RouteHandler = (_url, init) =>
            authHeader(init) === `Bearer ${oldUt}` && !oldUtAccepted
                ? jsonResponse({ msg: "expired" }, 401)
                : jsonResponse({
                      status: 0,
                      data: {
                          workspace_token:
                              authHeader(init) === `Bearer ${oldUt}`
                                  ? "wt.old"
                                  : "wt.new",
                      },
                  });
        routeFetch({
            "/auth/refresh-user-token": (url, init) => {
                refreshCalls += 1;
                return refreshCalls === 1
                    ? refresh(url, init)
                    : jsonResponse({ status: 0, access_token: newUt });
            },
            "/workspace/token/": acceptsOldUt,
            "/device/list": (url, init) =>
                !oldUtAccepted &&
                ["Bearer wt.old", `Bearer ${oldUt}`].includes(
                    authHeader(init) ?? "",
                )
                    ? jsonResponse({ msg: "expired" }, 401)
                    : devicesOk(url, init),
        });

        const client = await createPlaudClient(
            makeConnection({
                accessToken: oldUt,
                accessExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
            }),
        );
        await client.listDevices();
        expect(refreshCalls).toBe(1);

        oldUtAccepted = false;
        await client.listDevices();

        expect(refreshCalls).toBe(2);
        expect(authHeader(callsTo("/device/list").at(-1)?.[1])).toBe(
            "Bearer wt.new",
        );
    });

    it.each(
        transientRefreshFailures,
    )("surfaces %s, not an invalid token, when the token already expired", async (_label, refresh, code) => {
        routeFetch({ "/auth/refresh-user-token": refresh });
        await expect(
            createPlaudClient(
                makeConnection({
                    accessExpiresAt: new Date(Date.now() - 1000),
                }),
            ),
        ).rejects.toMatchObject({ code });
    });

    it("does not mark the connection for reconnect when the early refresh fails transiently", async () => {
        mockSyncSelects(
            makeConnection({
                accessToken: makeUserToken(nowSec() - 60),
                accessExpiresAt: new Date(Date.now() - 60_000),
            }),
        );
        const updates = mockUpdates();
        routeFetch({
            "/auth/refresh-user-token": () => jsonResponse({}, 429),
        });

        const result = await syncRecordingsForUser(USER_ID);

        expect(result.needsReconnect).toBeFalsy();
        expect(updates.set).not.toHaveBeenCalledWith(
            expect.objectContaining({ invalidatedAt: expect.any(Date) }),
        );
    });
});

// ── Connection status route ─────────────────────────────────────────────────

describe("GET /api/plaud/connection autoRenews", () => {
    async function autoRenewsFor(
        overrides: Partial<ConnectionRow>,
    ): Promise<unknown> {
        authedSession();
        installConnectionStore({
            ...storedConnectionRow({
                accessToken: makeUserToken(nowSec() + DAY),
                refreshToken: makeRefreshToken(nowSec() + 20 * DAY),
                accessExpiresAt: new Date((nowSec() + DAY) * 1000),
                sessionExpiresAt: new Date((nowSec() + 20 * DAY) * 1000),
            }),
            ...overrides,
        });
        const res = await connectionGET(
            new Request("http://localhost/api/plaud/connection"),
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(JSON.stringify(body)).not.toContain("eyJ");
        return body.autoRenews;
    }

    it("is true for a healthy connection with a refresh token", async () => {
        expect(await autoRenewsFor({})).toBe(true);
        expect(await autoRenewsFor({ sessionExpiresAt: null })).toBe(true);
    });

    it("is false without a refresh token", async () => {
        expect(await autoRenewsFor({ refreshToken: null })).toBe(false);
    });

    it("is false once Plaud rejected the sign-in", async () => {
        expect(await autoRenewsFor({ invalidatedAt: new Date() })).toBe(false);
    });

    it("is false once the sign-in has ended", async () => {
        expect(
            await autoRenewsFor({
                sessionExpiresAt: new Date(Date.now() - 1000),
            }),
        ).toBe(false);
    });
});

describe("GET /api/dev/plaud/info", () => {
    it("reports an ended sign-in as unreachable and still returns the connection", async () => {
        authedSession();
        installConnectionStore(
            storedConnectionRow({
                accessToken: makeUserToken(nowSec() - 60),
                refreshToken: makeRefreshToken(nowSec() - 30),
                accessExpiresAt: new Date(Date.now() - 60_000),
                sessionExpiresAt: new Date(Date.now() - 30_000),
            }),
        );

        const res = await devInfoGET(
            new Request("http://localhost/api/dev/plaud/info"),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.connected).toBe(true);
        expect(body.reachable).toBe(false);
        expect(body.error).toMatch(/sign-in has ended/);
        expect(body.connection).toMatchObject({
            id: CONNECTION_ID,
            apiBase: API_BASE,
            workspaceId: "ws_personal",
            workspaceIdSource: "cache",
            workspaceTokenFallback: false,
        });
        expect(JSON.stringify(body)).not.toContain("eyJ");
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe("Plaud 4.0 listing authentication", () => {
    it.each([
        true,
        false,
    ])("handles a v4 list 401 when refreshed credentials are accepted: %s", async (acceptRefreshed) => {
        const original = makeUserToken(nowSec() + DAY, "original");
        const refreshed = makeUserToken(nowSec() + DAY, "refreshed");
        const row = storedConnectionRow({
            accessToken: original,
            refreshToken: makeRefreshToken(nowSec() + 20 * DAY),
            accessExpiresAt: new Date((nowSec() + DAY) * 1000),
            sessionExpiresAt: new Date((nowSec() + 20 * DAY) * 1000),
        });
        installConnectionStore(row);
        const listAuth: Array<string | null> = [];
        routeFetch({
            "/workspace/token/": (_url, init) =>
                jsonResponse({
                    status: 0,
                    data: {
                        workspace_token:
                            authHeader(init) === `Bearer ${original}`
                                ? "wt.original"
                                : "wt.refreshed",
                    },
                }),
            "/file/simple/web": () =>
                jsonResponse({
                    status: -1800907,
                    msg: "Account migrated to 4.0",
                }),
            "/file-app/v4/recordings/all": (_url, init) => {
                const auth = authHeader(init);
                listAuth.push(auth);
                return acceptRefreshed && auth === "Bearer wt.refreshed"
                    ? jsonResponse({ status: 0, data: { items: [] } })
                    : jsonResponse({ status: -1 }, 401);
            },
            "/auth/refresh-user-token": () =>
                jsonResponse({ status: 0, access_token: refreshed }),
        });

        const result = await syncRecordingsForUser(USER_ID);

        expect(callsTo("/auth/refresh-user-token")).toHaveLength(1);
        expect(listAuth).toEqual([
            "Bearer wt.original",
            "Bearer wt.original",
            "Bearer wt.refreshed",
        ]);
        expect(decrypt(String(row.bearerToken))).toBe(refreshed);
        if (acceptRefreshed) {
            expect(result.errors).toEqual([]);
            expect(row.lastSync).toBeInstanceOf(Date);
            expect(row.invalidatedAt).toBeNull();
        } else {
            expect(result).toMatchObject({
                needsReconnect: true,
                errorCode: ErrorCode.PLAUD_INVALID_TOKEN,
            });
            expect(row.lastSync).toBeUndefined();
            expect(row.invalidatedAt).toBeInstanceOf(Date);
        }
    });
});

function installV4BatchConnection(
    row: ConnectionRow,
    secondRecordingGate?: Promise<void>,
): void {
    installConnectionStore(row);
    const select = db.select as Mock;
    const original = select.getMockImplementation();
    if (!original) throw new Error("Expected the Plaud connection store mock");
    let joins = 0;
    select.mockImplementation((...args) => {
        const query = original(...args);
        return {
            ...query,
            from: (table: unknown) => {
                const from = query.from(table);
                return {
                    ...from,
                    innerJoin: () => ({
                        where: () => ({
                            limit: async () => {
                                if (++joins === 2) await secondRecordingGate;
                                return [];
                            },
                        }),
                    }),
                };
            },
        };
    });
}

function v4BatchList(...fileIds: string[]): Response {
    return jsonResponse({
        status: 0,
        data: {
            items: fileIds.map((fileId) => ({
                file_id: fileId,
                filename: fileId,
                version_ms: 1,
            })),
            next_cursor: null,
        },
    });
}

it("retries a delayed v4 401 with the current bearer after another request refreshes", async () => {
    const row = storedConnectionRow({
        accessToken: makeUserToken(nowSec() + DAY, "original"),
        refreshToken: makeRefreshToken(nowSec() + 20 * DAY),
        accessExpiresAt: new Date((nowSec() + DAY) * 1000),
        sessionExpiresAt: new Date((nowSec() + 20 * DAY) * 1000),
    });
    const firstRetryStarted = Promise.withResolvers<void>();
    const delayed401 = Promise.withResolvers<Response>();
    installV4BatchConnection(row, firstRetryStarted.promise);
    const fresh = makeUserToken(nowSec() + DAY, "second-refresh");
    const calls: (string | null)[] = [];
    let minted = 0;
    let refreshed = 0;
    routeFetch({
        "/workspace/token/": () =>
            jsonResponse({
                status: 0,
                data: { workspace_token: `wt.${++minted}` },
            }),
        "/file/simple/web": () => jsonResponse({ status: -1800907 }),
        "/v4/recordings/all": () => v4BatchList("recording-a", "recording-b"),
        "/auth/refresh-user-token": () =>
            jsonResponse({
                status: 0,
                access_token:
                    ++refreshed === 1
                        ? makeUserToken(nowSec() + DAY, "first-refresh")
                        : fresh,
            }),
        "/v4/files/detail/": (_url, init) => {
            const bearer = authHeader(init);
            calls.push(bearer);
            if (
                bearer === "Bearer wt.3" &&
                calls.indexOf(bearer) === calls.length - 1
            ) {
                firstRetryStarted.resolve();
                return delayed401.promise;
            }
            if (bearer === "Bearer wt.5") {
                delayed401.resolve(jsonResponse({}, 401));
                return jsonResponse({ status: 0, data: {} });
            }
            return jsonResponse({}, 401);
        },
    });

    const result = await syncRecordingsForUser(USER_ID);

    expect(refreshed).toBe(2);
    expect(decrypt(String(row.bearerToken))).toBe(fresh);
    expect(row.invalidatedAt).toBeNull();
    expect(result.needsReconnect).toBeFalsy();
    expect(calls).toEqual([
        "Bearer wt.1",
        "Bearer wt.2",
        "Bearer wt.3",
        "Bearer wt.3",
        "Bearer wt.4",
        "Bearer wt.5",
        "Bearer wt.5",
    ]);
});

it("keeps an invalidation on a refreshed token unused by any successful data request", async () => {
    const row = storedConnectionRow({
        accessToken: makeUserToken(nowSec() + DAY, "original"),
        refreshToken: makeRefreshToken(nowSec() + 20 * DAY),
        accessExpiresAt: new Date((nowSec() + DAY) * 1000),
        sessionExpiresAt: new Date((nowSec() + 20 * DAY) * 1000),
    });
    installV4BatchConnection(row);
    const fresh = makeUserToken(nowSec() + DAY, "refreshed");
    const invalidatedAt = new Date(nowSec() * 1000);
    let minted = 0;
    routeFetch({
        "/workspace/token/": () => {
            if (++minted < 3) {
                return jsonResponse({
                    status: 0,
                    data: { workspace_token: `wt.${minted}` },
                });
            }
            expect(decrypt(String(row.bearerToken))).toBe(fresh);
            row.invalidatedAt = invalidatedAt;
            return jsonResponse({}, 503);
        },
        "/file/simple/web": () => jsonResponse({ status: -1800907 }),
        "/v4/recordings/all": () => v4BatchList("recording-a"),
        "/auth/refresh-user-token": () =>
            jsonResponse({ status: 0, access_token: fresh }),
        "/v4/files/detail/": () => jsonResponse({}, 401),
    });

    await syncRecordingsForUser(USER_ID);

    expect(minted).toBe(3);
    expect(row.invalidatedAt).toBe(invalidatedAt);
});

it("writes lastSync and workspaceId before content import, then clears invalidation", async () => {
    const invalidatedAt = new Date();
    const row = {
        ...storedConnectionRow({
            accessToken: makeUserToken(nowSec() + DAY),
            refreshToken: makeRefreshToken(nowSec() + 20 * DAY),
            accessExpiresAt: new Date((nowSec() + DAY) * 1000),
            sessionExpiresAt: new Date((nowSec() + 20 * DAY) * 1000),
        }),
        workspaceId: null,
        invalidatedAt,
    };
    installConnectionStore(row);
    const select = db.select as Mock;
    const original = select.getMockImplementation();
    if (!original) throw new Error("Expected the Plaud connection store mock");
    select.mockImplementation((...args) => {
        const query = original(...args);
        return {
            ...query,
            from: (table: unknown) => {
                if (table === userSettings) {
                    return {
                        where: () => ({
                            limit: async () => [{ importPlaudContent: true }],
                        }),
                    };
                }
                if (table === recordings) {
                    return {
                        innerJoin: () => ({
                            where: () => ({
                                limit: async () => [
                                    {
                                        recording: {
                                            id: "recording-id",
                                            plaudVersion: "1",
                                        },
                                    },
                                ],
                            }),
                        }),
                    };
                }
                return query.from(table);
            },
        };
    });
    let observedAtImport: ConnectionRow | undefined;
    routeFetch({
        "/team-app/workspaces/list": workspacesOk,
        "/workspace/token/": mintOk,
        "/file/simple/web": () =>
            jsonResponse({
                status: 0,
                data_file_list: [
                    { id: "plaud-recording", version_ms: 1, is_trans: true },
                ],
            }),
        "/file/detail/": () => {
            observedAtImport = { ...row };
            return jsonResponse({ status: 0, data: { content_list: [] } });
        },
    });

    const result = await syncRecordingsForUser(USER_ID);

    expect(result.errors).toEqual([]);
    expect(observedAtImport).toMatchObject({
        lastSync: expect.any(Date),
        workspaceId: "ws_personal",
        invalidatedAt,
    });
    expect(row.invalidatedAt).toBeNull();
});

it("keeps a newer connection's invalidation after a stale successful sync", async () => {
    const row = storedConnectionRow({
        accessToken: makeUserToken(nowSec() + DAY, "original"),
        refreshToken: makeRefreshToken(nowSec() + 20 * DAY, "original"),
        accessExpiresAt: new Date((nowSec() + DAY) * 1000),
        sessionExpiresAt: new Date((nowSec() + 20 * DAY) * 1000),
    });
    installConnectionStore(row);
    const replacement = encrypt(makeUserToken(nowSec() + DAY, "replacement"));
    const invalidatedAt = new Date();
    routeFetch({
        "/workspace/token/": mintOk,
        "/file/simple/web": () => {
            row.bearerToken = replacement;
            row.invalidatedAt = invalidatedAt;
            return jsonResponse({ status: 0, data_file_list: [] });
        },
    });

    const result = await syncRecordingsForUser(USER_ID);

    expect(result.errors).toEqual([]);
    expect(row.bearerToken).toBe(replacement);
    expect(row.invalidatedAt).toBe(invalidatedAt);
    expect(row.lastSync).toBeInstanceOf(Date);
});

it.each([
    true,
    false,
])("reports legacy expiry before sync when the JWT has an exp: %s", async (hasExpiry) => {
    const exp = nowSec() + DAY;
    const row = {
        ...storedConnectionRow({
            accessToken: hasExpiry
                ? makeUserToken(exp)
                : makeJwt({ sub: "legacy-user" }),
            refreshToken: makeRefreshToken(exp),
            accessExpiresAt: null,
            sessionExpiresAt: null,
        }),
        refreshToken: null,
        updatedAt: new Date(),
    };
    authedSession();
    installConnectionStore(row);
    const expected = hasExpiry ? new Date(exp * 1000) : null;

    const response = await connectionGET(
        new Request("http://localhost/api/plaud/connection"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
        accessExpiresAt: expected?.toISOString() ?? null,
        sessionExpiresAt: expected?.toISOString() ?? null,
        autoRenews: false,
    });
    expect(await getPlaudConnection(USER_ID)).toEqual({
        invalidatedAt: null,
        sessionExpiresAt: expected,
        updatedAt: row.updatedAt,
    });
    expect(db.update).not.toHaveBeenCalled();
});

// ── Dashboard banner predicate ──────────────────────────────────────────────

describe("plaudConnectionBannerState", () => {
    const now = new Date("2026-11-18T12:00:00Z");
    const inDays = (d: number) =>
        new Date(now.getTime() + d * DAY * 1000).toISOString();

    it("shows reconnect when Plaud rejected the sign-in", () => {
        expect(
            plaudConnectionBannerState({
                needsReconnect: true,
                sessionExpiresAt: inDays(20),
                now,
            }),
        ).toBe("reconnect");
    });

    it("warns within three days of the session end", () => {
        expect(
            plaudConnectionBannerState({
                needsReconnect: false,
                sessionExpiresAt: inDays(2.5),
                now,
            }),
        ).toBe("ending-soon");
        expect(
            plaudConnectionBannerState({
                needsReconnect: false,
                sessionExpiresAt: new Date(
                    now.getTime() + PLAUD_SESSION_WARNING_WINDOW_MS,
                ),
                now,
            }),
        ).toBe("ending-soon");
    });

    it("stays hidden with more than three days left or no known end", () => {
        expect(
            plaudConnectionBannerState({
                needsReconnect: false,
                sessionExpiresAt: inDays(3.1),
                now,
            }),
        ).toBeNull();
        expect(
            plaudConnectionBannerState({
                needsReconnect: false,
                sessionExpiresAt: null,
                now,
            }),
        ).toBeNull();
        expect(
            plaudConnectionBannerState({
                needsReconnect: false,
                sessionExpiresAt: "not a date",
                now,
            }),
        ).toBeNull();
    });

    it("asks for a reconnect once the session end has passed", () => {
        expect(
            plaudConnectionBannerState({
                needsReconnect: false,
                sessionExpiresAt: inDays(-1),
                now: now.getTime(),
            }),
        ).toBe("reconnect");
    });
});
