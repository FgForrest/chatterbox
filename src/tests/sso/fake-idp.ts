import { randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { expect } from "vitest";

/** Issuer of the fake identity provider the SSO integration tests run against. */
export const FAKE_ISSUER = "https://idp.example.test/realms/acme";
export const TEST_APP_URL = "http://localhost:3000";

export interface Claims {
    sub: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
}

type AuthHandler = (request: Request) => Promise<Response>;

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
    const key = generateKeyPair("RS256");
    const queued = new Map<string, { claims: Claims; nonce: string | null }>();
    const discovery: Record<string, unknown> = {
        issuer: FAKE_ISSUER,
        jwks_uri: `${FAKE_ISSUER}/certs`,
        id_token_signing_alg_values_supported: ["RS256"],
        authorization_endpoint: `${FAKE_ISSUER}/protocol/openid-connect/auth`,
        token_endpoint: `${FAKE_ISSUER}/protocol/openid-connect/token`,
        end_session_endpoint: `${FAKE_ISSUER}/protocol/openid-connect/logout`,
        userinfo_endpoint: `${FAKE_ISSUER}/protocol/openid-connect/userinfo`,
    };

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
            return Response.json(discovery);
        }
        if (url === `${FAKE_ISSUER}/certs`) {
            return Response.json({
                keys: [
                    {
                        ...(await exportJWK((await key).publicKey)),
                        kid: "test-key",
                        alg: "RS256",
                        use: "sig",
                    },
                ],
            });
        }
        if (url === `${FAKE_ISSUER}/protocol/openid-connect/token`) {
            const form = new URLSearchParams(
                input instanceof Request
                    ? await input.clone().text()
                    : String(init?.body ?? ""),
            );
            const entry = queued.get(form.get("code") ?? "");
            if (!entry) throw new Error("no claims queued for the token");
            const { claims, nonce } = entry;
            return Response.json({
                access_token: await new SignJWT({
                    sub: claims.sub,
                    typ: "Bearer",
                    azp: "riffado",
                    resource_access: { riffado: { roles: ["use"] } },
                })
                    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
                    .setIssuer(FAKE_ISSUER)
                    .setAudience("riffado")
                    .setIssuedAt()
                    .setExpirationTime("5m")
                    .sign((await key).privateKey),
                refresh_token: "provider-refresh-token",
                id_token: await new SignJWT({
                    ...claims,
                    ...(nonce === null ? {} : { nonce }),
                })
                    .setProtectedHeader({
                        alg: "RS256",
                        typ: "JWT",
                        kid: "test-key",
                    })
                    .setIssuer(FAKE_ISSUER)
                    .setAudience("riffado")
                    .setIssuedAt()
                    .setExpirationTime("5m")
                    .sign((await key).privateKey),
                token_type: "Bearer",
                expires_in: 300,
            });
        }
        return realFetch(input, init);
    }

    /** Start the sign-in, come back from the provider; where the app sends the browser. */
    async function login(
        claims: Claims,
        options: { idTokenNonce?: string | null } = {},
    ): Promise<{ location: string; cookie: string }> {
        const start = await handler()(
            new Request(`${TEST_APP_URL}/api/auth/sign-in/social`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    origin: TEST_APP_URL,
                },
                body: JSON.stringify({
                    provider: "oidc",
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
        const nonce = authorization.searchParams.get("nonce");
        expect(nonce).toBeTruthy();
        const code = randomUUID();
        queued.set(code, {
            claims,
            nonce:
                options.idTokenNonce === undefined
                    ? nonce
                    : options.idTokenNonce,
        });
        expect(authorization.searchParams.get("redirect_uri")).toBe(
            `${TEST_APP_URL}/api/auth/oauth2/callback/oidc`,
        );

        const callback = await handler()(
            new Request(
                `${TEST_APP_URL}/api/auth/oauth2/callback/oidc?code=${code}&state=${state}&iss=${encodeURIComponent(FAKE_ISSUER)}`,
                { headers: { cookie: cookiesFrom(start) } },
            ),
        );
        expect(callback.status).toBe(302);
        queued.delete(code);
        return {
            location: callback.headers.get("location") ?? "",
            cookie: cookiesFrom(callback),
        };
    }

    return { fetch, login, discovery };
}
