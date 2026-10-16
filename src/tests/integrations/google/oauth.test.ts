import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
    env: {
        APP_URL: "https://riffado.example",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        GOOGLE_CLIENT_ID: "client-id",
        GOOGLE_CLIENT_SECRET: "client-secret",
        GOOGLE_WORKSPACE_DOMAINS: ["example.com"],
        IS_HOSTED: false,
    },
}));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
}));
vi.mock("@/lib/integrations/google/connection", () => ({
    getGoogleConnectionStatus: vi.fn(),
}));

import { GET } from "@/app/api/integrations/google/connect/route";
import { encryptText } from "@/lib/encryption/fields";
import {
    GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE,
    type GoogleIntegrationConfig,
} from "@/lib/integrations/google/config";
import { getGoogleConnectionStatus } from "@/lib/integrations/google/connection";
import { GOOGLE_MEET_READ_SCOPE } from "@/lib/integrations/google/meet-consent";
import {
    buildAuthorizationUrl,
    createPkcePair,
    exchangeAuthorizationCode,
    readIdTokenClaims,
    refreshAccessToken,
    revokeToken,
} from "@/lib/integrations/google/oauth";
import {
    GOOGLE_OAUTH_COOKIE,
    openGoogleOAuthState,
    safeReturnTo,
    sealGoogleOAuthState,
} from "@/lib/integrations/google/oauth-state";

const CONFIG: GoogleIntegrationConfig = {
    clientId: "client-id",
    clientSecret: "client-secret",
    pickerApiKey: "picker-key",
    projectNumber: "1234",
    workspaceDomains: ["example.com"],
    redirectUri: "https://riffado.example/api/integrations/google/callback",
};

function idToken(claims: Record<string, unknown>): string {
    const encode = (value: unknown) =>
        Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${encode({ alg: "RS256" })}.${encode(claims)}.signature`;
}

function readStateCookie(response: Response) {
    const cookie = response.headers.get("set-cookie") ?? "";
    const match = new RegExp(`${GOOGLE_OAUTH_COOKIE}=([^;]+)`).exec(cookie);
    return openGoogleOAuthState(
        match?.[1] ? decodeURIComponent(match[1]) : undefined,
    );
}

describe("Google OAuth", () => {
    it("asks for offline access with PKCE and the Workspace hint", () => {
        const url = new URL(
            buildAuthorizationUrl({
                config: CONFIG,
                scopes: ["openid", "email"],
                state: "state-1",
                codeChallenge: "challenge",
                loginHint: "jane@example.com",
            }),
        );
        expect(url.origin + url.pathname).toBe(
            "https://accounts.google.com/o/oauth2/v2/auth",
        );
        expect(Object.fromEntries(url.searchParams)).toEqual({
            client_id: "client-id",
            redirect_uri: CONFIG.redirectUri,
            response_type: "code",
            scope: "openid email",
            state: "state-1",
            code_challenge: "challenge",
            code_challenge_method: "S256",
            access_type: "offline",
            prompt: "consent",
            include_granted_scopes: "true",
            hd: "example.com",
            login_hint: "jane@example.com",
        });
    });

    it("derives the S256 challenge from the verifier", () => {
        const pair = createPkcePair();
        expect(pair.challenge).toBe(
            createHash("sha256").update(pair.verifier).digest("base64url"),
        );
        expect(pair.verifier.length).toBeGreaterThanOrEqual(43);
    });

    it("exchanges a code and refreshes a token", async () => {
        const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
            const body = new URLSearchParams(String(init?.body));
            return new Response(
                JSON.stringify({
                    access_token: `access-for-${body.get("grant_type")}`,
                    expires_in: 1200,
                    refresh_token:
                        body.get("grant_type") === "authorization_code"
                            ? "refresh-1"
                            : undefined,
                    scope: "openid email https://www.googleapis.com/auth/drive.file",
                    id_token: "id",
                }),
                { status: 200 },
            );
        });
        const exchanged = await exchangeAuthorizationCode(
            { config: CONFIG, code: "code-1", codeVerifier: "verifier-1" },
            fetchImpl as unknown as typeof fetch,
        );
        expect(exchanged).toEqual({
            accessToken: "access-for-authorization_code",
            expiresInSeconds: 1200,
            refreshToken: "refresh-1",
            scopes: [
                "openid",
                "email",
                "https://www.googleapis.com/auth/drive.file",
            ],
            idToken: "id",
        });
        const sent = new URLSearchParams(
            String(fetchImpl.mock.calls[0]?.[1]?.body),
        );
        expect(sent.get("code_verifier")).toBe("verifier-1");
        expect(sent.get("redirect_uri")).toBe(CONFIG.redirectUri);
        const refreshed = await refreshAccessToken(
            CONFIG,
            "refresh-1",
            fetchImpl as unknown as typeof fetch,
        );
        expect(refreshed.accessToken).toBe("access-for-refresh_token");
        expect(refreshed.refreshToken).toBeNull();
    });

    it("reports a revoked grant as invalid_grant", async () => {
        const fetchImpl = vi.fn(
            async () =>
                new Response(
                    JSON.stringify({
                        error: "invalid_grant",
                        error_description: "Token has been expired or revoked.",
                    }),
                    { status: 400 },
                ),
        );
        await expect(
            refreshAccessToken(
                CONFIG,
                "refresh-1",
                fetchImpl as unknown as typeof fetch,
            ),
        ).rejects.toMatchObject({ status: 400, reason: "invalid_grant" });
    });

    it("treats revoking an already invalid token as done", async () => {
        const fetchImpl = vi.fn(async () => new Response("", { status: 400 }));
        await expect(
            revokeToken("gone", fetchImpl as unknown as typeof fetch),
        ).resolves.toBeUndefined();
    });

    it("reads the account from the ID token", () => {
        expect(
            readIdTokenClaims(
                idToken({
                    sub: "123",
                    email: "Jane@Example.com",
                    email_verified: true,
                    hd: "Example.com",
                }),
            ),
        ).toEqual({
            subject: "123",
            email: "jane@example.com",
            emailVerified: true,
            hostedDomain: "example.com",
        });
        expect(
            readIdTokenClaims(idToken({ sub: "1", email: "a@gmail.com" }))
                .hostedDomain,
        ).toBeNull();
        expect(() => readIdTokenClaims(idToken({ sub: "1" }))).toThrow();
        expect(() => readIdTokenClaims("garbage")).toThrow();
    });
});

describe("Google OAuth state cookie", () => {
    const state = {
        state: "s",
        verifier: "v",
        userId: "u1",
        returnTo: "/dashboard",
        expiresAt: Date.now() + 60_000,
    };

    it("opens what it sealed, until it expires", () => {
        const sealed = sealGoogleOAuthState(state);
        expect(openGoogleOAuthState(sealed)).toEqual(state);
        expect(openGoogleOAuthState(sealed, state.expiresAt + 1)).toBeNull();
    });

    it("refuses a cookie it did not seal", () => {
        expect(openGoogleOAuthState(JSON.stringify(state))).toBeNull();
        expect(openGoogleOAuthState(undefined)).toBeNull();
        expect(openGoogleOAuthState("v1:not-ciphertext")).toBeNull();
        expect(
            openGoogleOAuthState(encryptText(JSON.stringify({ state: "s" }))),
        ).toBeNull();
    });

    it("returns only to paths on the app itself", () => {
        const app = "https://riffado.example";
        expect(safeReturnTo("/dashboard?onboarding=google", app)).toBe(
            "/dashboard?onboarding=google",
        );
        expect(safeReturnTo("/dashboard?folder=a#x", app)).toBe(
            "/dashboard?folder=a#x",
        );
        for (const hostile of [
            "https://evil.example/",
            "//evil.example/",
            "/\t/evil.example/",
            "/\\evil.example",
            null,
            "",
        ]) {
            expect(safeReturnTo(hostile, app)).toBe("/dashboard");
        }
    });
});

describe("Google OAuth connect route", () => {
    beforeEach(() => {
        vi.mocked(getGoogleConnectionStatus).mockReset();
    });

    it("requests Calendar, Meet, and existing scopes for combined consent", async () => {
        vi.mocked(getGoogleConnectionStatus).mockResolvedValue({
            subject: "google-user-1",
            email: "jane@example.com",
            hostedDomain: "example.com",
            status: "active",
            scopes: [
                "openid",
                "email",
                "https://www.googleapis.com/auth/drive.file",
            ],
        });

        const response = await GET(
            new Request(
                "https://riffado.example/api/integrations/google/connect?purpose=calendar-meet&returnTo=%2Fdashboard%3Fonboarding%3Dgoogle",
            ),
        );

        expect(response.status).toBe(302);
        const redirect = new URL(response.headers.get("location") ?? "");
        expect(redirect.searchParams.get("scope")?.split(" ")).toEqual([
            "openid",
            "email",
            "https://www.googleapis.com/auth/drive.file",
            GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE,
            GOOGLE_MEET_READ_SCOPE,
        ]);
        expect(redirect.searchParams.get("login_hint")).toBe(
            "jane@example.com",
        );
        expect(readStateCookie(response)).toMatchObject({
            userId: "user-1",
            returnTo: "/dashboard?onboarding=google",
            purpose: "calendar-meet",
        });
    });

    it("starts combined consent without an existing connection", async () => {
        vi.mocked(getGoogleConnectionStatus).mockResolvedValue(null);

        const response = await GET(
            new Request(
                "https://riffado.example/api/integrations/google/connect?purpose=calendar-meet",
            ),
        );

        expect(response.status).toBe(302);
        const redirect = new URL(response.headers.get("location") ?? "");
        expect(redirect.searchParams.get("scope")?.split(" ")).toEqual([
            "openid",
            "email",
            GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE,
            GOOGLE_MEET_READ_SCOPE,
        ]);
        expect(readStateCookie(response)).toMatchObject({
            userId: "user-1",
            purpose: "calendar-meet",
        });
    });
});
