import { expect } from "vitest";

/** Issuer of the fake identity provider the SSO integration tests run against. */
export const FAKE_ISSUER = "https://idp.example.test/realms/acme";
export const TEST_APP_URL = "http://localhost:3000";

export interface Claims {
    sub: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
}

type AuthHandler = (request: Request) => Promise<Response>;

function base64url(value: object): string {
    return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** An ID token as the token endpoint returns it; better-auth only decodes it. */
function idToken(claims: Claims): string {
    const now = Math.floor(Date.now() / 1000);
    return [
        base64url({ alg: "RS256", typ: "JWT" }),
        base64url({
            iss: FAKE_ISSUER,
            aud: "riffado",
            iat: now,
            exp: now + 300,
            ...claims,
        }),
        "signature",
    ].join(".");
}

function cookiesFrom(response: Response): string {
    return response.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0])
        .join("; ");
}

/**
 * An identity provider faked at the HTTP boundary: install `fetch` with
 * `vi.spyOn(globalThis, "fetch")`, then `login` runs the browser's round
 * trip against better-auth with the claims the next ID token carries.
 */
export function createFakeIdentityProvider(handler: () => AuthHandler) {
    const realFetch = globalThis.fetch;
    let nextClaims: Claims | null = null;

    async function fetch(
        input: string | URL | Request,
        init?: RequestInit,
    ): Promise<Response> {
        const url =
            typeof input === "string"
                ? input
                : input instanceof URL
                  ? input.toString()
                  : input.url;
        if (url === `${FAKE_ISSUER}/.well-known/openid-configuration`) {
            return Response.json({
                issuer: FAKE_ISSUER,
                authorization_endpoint: `${FAKE_ISSUER}/protocol/openid-connect/auth`,
                token_endpoint: `${FAKE_ISSUER}/protocol/openid-connect/token`,
                userinfo_endpoint: `${FAKE_ISSUER}/protocol/openid-connect/userinfo`,
            });
        }
        if (url === `${FAKE_ISSUER}/protocol/openid-connect/token`) {
            if (!nextClaims) throw new Error("no claims queued for the token");
            return Response.json({
                access_token: "provider-access-token",
                refresh_token: "provider-refresh-token",
                id_token: idToken(nextClaims),
                token_type: "Bearer",
                expires_in: 300,
            });
        }
        return realFetch(input, init);
    }

    /** Start the sign-in, come back from the provider; where the app sends the browser. */
    async function login(
        claims: Claims,
    ): Promise<{ location: string; cookie: string }> {
        nextClaims = claims;
        const start = await handler()(
            new Request(`${TEST_APP_URL}/api/auth/sign-in/oauth2`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    origin: TEST_APP_URL,
                },
                body: JSON.stringify({
                    providerId: "oidc",
                    callbackURL: "/dashboard",
                    errorCallbackURL: "/login",
                }),
            }),
        );
        expect(start.status).toBe(200);
        const { url } = (await start.json()) as { url: string };
        const authorization = new URL(url);
        expect(authorization.origin + authorization.pathname).toBe(
            `${FAKE_ISSUER}/protocol/openid-connect/auth`,
        );
        expect(authorization.searchParams.get("code_challenge")).toBeTruthy();
        const state = authorization.searchParams.get("state");

        const callback = await handler()(
            new Request(
                `${TEST_APP_URL}/api/auth/oauth2/callback/oidc?code=the-code&state=${state}&iss=${encodeURIComponent(FAKE_ISSUER)}`,
                { headers: { cookie: cookiesFrom(start) } },
            ),
        );
        expect(callback.status).toBe(302);
        nextClaims = null;
        return {
            location: callback.headers.get("location") ?? "",
            cookie: cookiesFrom(callback),
        };
    }

    return { fetch, login };
}
