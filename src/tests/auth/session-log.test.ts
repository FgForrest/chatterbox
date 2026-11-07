import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    logSession,
    logSessionDeleted,
    providerErrorCode,
    providerErrorDescription,
} from "@/lib/auth/session-log";

beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(Date, "now").mockReturnValue(
        new Date("2026-11-01T12:00:00Z").getTime(),
    );
});
afterEach(() => vi.restoreAllMocks());

describe("provider diagnostic allowlists", () => {
    it.each([
        "invalid_grant",
        "invalid_client",
        "a",
        "a".repeat(40),
    ])("accepts the provider code %s", (value) =>
        expect(providerErrorCode(value)).toBe(value));

    it.each([
        "",
        "Invalid_grant",
        "invalid-grant",
        "error1",
        "invalid_grant\n",
        "a".repeat(41),
        "refresh_token=example-refresh",
        "example@example.com",
        123,
        null,
        undefined,
        {},
    ])("omits the unsafe provider code %j", (value) => {
        expect(providerErrorCode(value)).toBeUndefined();
    });

    it.each([
        "Session not active",
        "Token is not active",
        "Invalid refresh token",
        "Client session not active",
        "Session doesn't have required client",
        "Stale token",
        "Maximum allowed refresh token reuse exceeded",
        "The token does not verify",
        "ID token does not match the provider profile",
        "Access token does not match the provider profile",
        "The renewed token names someone else",
        'Session (inactive): retry, please; "sign-in".',
        "a".repeat(32),
        `${"a ".repeat(59)}ab`,
    ])("accepts the description %s", (value) => {
        expect(providerErrorDescription(value)).toBe(value);
    });

    it.each([
        "",
        "refresh_token=example-refresh email=example@example.com",
        "example@example.com",
        "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJleGFtcGxlIn0.c2lnbmF0dXJl",
        `${"a ".repeat(60)}a`,
        "a".repeat(33),
        "Session 1",
        "Session/ended",
        "Session_ended",
        "Session+ended",
        "Session\nended",
        "Session ended\n",
        123,
        null,
        undefined,
        {},
    ])("omits the unsafe description %j", (value) => {
        expect(providerErrorDescription(value)).toBeUndefined();
    });
});

describe("session log formatting", () => {
    it("omits unknown timings and logs a started session", () => {
        logSession("started", {
            user: "example-user",
            session: "example-session",
            expiresAt: new Date("2026-11-02T12:00:00Z"),
            authTime: new Date("2026-11-01T10:00:00Z"),
        });
        expect(console.info).toHaveBeenCalledExactlyOnceWith(
            "[session] started user=example-user session=example-session expiresAt=2026-11-02T12:00:00.000Z authAgeMin=120",
        );
    });

    it("sanitizes provider details and codes into one bounded ASCII line", () => {
        logSession("ended", {
            user: "example-user",
            session: "example-session",
            cause: "provider-refused",
            providerError: "invalid_grant\nforged=true",
            providerDetail: `Session "not active"\n\r\t\u001b\u007f ž \\ ${"x".repeat(200)}`,
        });
        const line = String(vi.mocked(console.info).mock.calls[0]?.[0]);
        expect(line).toContain("providerError=invalid_grant_forged_true");
        expect(line).toContain(
            String.raw`providerDetail="Session \"not active\"`,
        );
        expect(line).not.toMatch(/[^\x20-\x7e]/);
        const detail = line.split('providerDetail="')[1]?.slice(0, -1) ?? "";
        expect(detail).toContain("\\\\");
        expect(detail).toHaveLength(120);
        expect(line.endsWith('"')).toBe(true);
    });

    it("rounds an expiry just in the past to zero minutes", () => {
        logSession("ended", {
            cause: "provider-refused",
            refreshTokenExpiresAt: new Date(Date.now() - 1),
        });
        expect(console.info).toHaveBeenCalledExactlyOnceWith(
            "[session] ended cause=provider-refused refreshExpiresInMin=0",
        );
    });

    it("rounds durations to whole minutes", () => {
        logSession("ended", {
            cause: "provider-refused",
            createdAt: new Date(Date.now() - 90_000),
            expiresAt: new Date(Date.now() + 89_000),
            verifiedAt: new Date(Date.now() - 89_000),
            authTime: new Date(Date.now() - 90_000),
            refreshTokenExpiresAt: new Date(Date.now() - 91_000),
        });
        expect(console.info).toHaveBeenCalledExactlyOnceWith(
            "[session] ended cause=provider-refused ageMin=2 expiresInMin=1 sinceVerifiedMin=1 sinceAuthMin=2 refreshExpiresInMin=-2",
        );
    });

    it("never formats fields outside the allowlist", () => {
        const fields = {
            user: "example-user",
            session: "example-session",
            cause: "sign-out" as const,
            token: "example-session-token",
            accessToken: "example-access",
            refreshToken: "example-refresh",
            idToken: "example-id-token",
            email: "example@example.com",
            cookie: "example-cookie",
            name: "Acme",
        };
        logSession("ended", fields);
        const line = String(vi.mocked(console.info).mock.calls[0]?.[0]);
        expect(line).toBe(
            "[session] ended user=example-user session=example-session cause=sign-out",
        );
        for (const secret of [
            fields.token,
            fields.accessToken,
            fields.refreshToken,
            fields.idToken,
            fields.email,
            fields.cookie,
            fields.name,
        ])
            expect(line).not.toContain(secret);
    });

    it("survives formatting failures", () => {
        expect(() =>
            logSession("started", { expiresAt: new Date(Number.NaN) }),
        ).not.toThrow();
        expect(console.info).not.toHaveBeenCalled();
    });

    it.each([
        "info",
        "warn",
    ] as const)("survives a failing console.%s", (method) => {
        vi.mocked(console[method]).mockImplementation(() => {
            throw new Error("example failure");
        });
        expect(() =>
            logSession(method === "info" ? "started" : "renew-failed", {
                user: "example-user",
            }),
        ).not.toThrow();
    });
});

describe("deleted session logging", () => {
    it.each([
        ["/sign-out", "sign-out"],
        ["/reset-password", "password-reset"],
        ["/revoke-session", "session-revoked"],
        ["/revoke-sessions", "all-sessions-revoked"],
        ["/revoke-other-sessions", "other-sessions-revoked"],
        [undefined, "auth-deleted"],
    ])("logs the deletion cause for %s", (path, cause) => {
        logSessionDeleted(
            {
                id: "example-session",
                userId: "example-user",
                createdAt: new Date(Date.now() - 60_000),
                expiresAt: new Date(Date.now() + 60_000),
            },
            path,
        );
        expect(console.info).toHaveBeenCalledExactlyOnceWith(
            `[session] ended user=example-user session=example-session cause=${cause} ageMin=1 expiresInMin=1`,
        );
    });

    it.each([
        "/get-session",
        "/sign-out",
        "/reset-password",
        "/revoke-session",
        "/revoke-sessions",
        "/revoke-other-sessions",
        undefined,
    ])("logs expiry before the endpoint cause for %s", (path) => {
        logSessionDeleted(
            {
                id: "example-session",
                userId: "example-user",
                createdAt: new Date(Date.now() - 120_000),
                expiresAt: new Date(Date.now() - 60_000),
            },
            path,
        );
        expect(console.info).toHaveBeenCalledExactlyOnceWith(
            "[session] ended user=example-user session=example-session cause=expired ageMin=2 expiresInMin=-1",
        );
    });

    it("survives a malformed expiry while determining the cause", () => {
        expect(() =>
            logSessionDeleted(
                {
                    id: "example-session",
                    userId: "example-user",
                    createdAt: new Date(),
                    expiresAt: "unexpected" as unknown as Date,
                },
                undefined,
            ),
        ).not.toThrow();
        expect(console.info).not.toHaveBeenCalled();
        expect(console.warn).not.toHaveBeenCalled();
    });
});
