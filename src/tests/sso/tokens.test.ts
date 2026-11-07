/**
 * Verification of the web sign-in's tokens, offline against a local key
 * set: what a token must be for its identity or capabilities to count, and
 * which failures mean "the provider cannot be asked" rather than "this
 * token is bad".
 */

import type * as Jose from "jose";
import {
    exportJWK,
    generateKeyPair,
    type JWK,
    SignJWT,
    UnsecuredJWT,
} from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const ISSUER = "https://id.example.com/realms/acme";
const CLIENT = "chatterbox";

const mockEnv = vi.hoisted(() => ({
    OIDC_ISSUER_URL: "https://id.example.com/realms/acme",
    OIDC_CLIENT_ID: "chatterbox",
    OIDC_CLIENT_SECRET: "secret",
    AUTHZ_MODE: "idp",
    IDENTITY_PROVIDER: "keycloak",
    KEYCLOAK_ROLES_CLIENT: undefined as string | undefined,
    MCP_AUDIENCE: undefined as string | undefined,
    APP_URL: "https://chatterbox.example",
}));
const realmKeys = vi.hoisted(() => ({ keys: [] as JWK[] }));

vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/mail/addresses", () => ({ ensureMailbox: vi.fn() }));
vi.mock("@/lib/sso/almanac", () => ({ recordSsoUserInAlmanac: vi.fn() }));
vi.mock("@/lib/mcp/config", () => ({
    issuerMetadata: vi.fn(async () => ({
        issuer: "https://id.example.com/realms/acme",
        tokenEndpoint: "https://id.example.com/realms/acme/token",
        jwksUri:
            "https://id.example.com/realms/acme/protocol/openid-connect/certs",
    })),
}));
vi.mock("jose", async (importOriginal) => {
    const actual = await importOriginal<typeof Jose>();
    return {
        ...actual,
        createRemoteJWKSet: () => actual.createLocalJWKSet(realmKeys),
    };
});

import { logSession } from "@/lib/auth/session-log";
import { IdentityProviderError } from "@/lib/identity/ports";
import { verifySsoLogin } from "@/lib/sso/auth-hooks";
import {
    refreshProviderTokens,
    SsoTokenError,
    verifyIdToken,
    verifyWebAccessToken,
} from "@/lib/sso/tokens";

let realmKey: CryptoKey;
let strangerKey: CryptoKey;

beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    realmKey = pair.privateKey;
    strangerKey = (await generateKeyPair("RS256")).privateKey;
    realmKeys.keys.push({
        ...(await exportJWK(pair.publicKey)),
        kid: "realm-1",
        alg: "RS256",
        use: "sig",
    });
});

interface Signing {
    key?: CryptoKey;
    kid?: string;
    issuer?: string;
    audience?: string;
    expiresIn?: string;
}

function sign(
    claims: Record<string, unknown>,
    {
        key = realmKey,
        kid = "realm-1",
        issuer = ISSUER,
        audience,
        expiresIn = "5m",
    }: Signing = {},
): Promise<string> {
    const jwt = new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid })
        .setIssuer(issuer)
        .setIssuedAt()
        .setExpirationTime(expiresIn);
    return (audience ? jwt.setAudience(audience) : jwt).sign(key);
}

const idToken = (claims: Record<string, unknown> = {}, signing?: Signing) =>
    sign(
        { sub: "alice", typ: "ID", azp: CLIENT, ...claims },
        { audience: CLIENT, ...signing },
    );

const accessToken = (claims: Record<string, unknown> = {}, signing?: Signing) =>
    sign(
        {
            sub: "alice",
            typ: "Bearer",
            azp: CLIENT,
            resource_access: { [CLIENT]: { roles: ["use"] } },
            ...claims,
        },
        signing,
    );

describe("verifyIdToken", () => {
    it("accepts the realm's ID token for this client", async () => {
        const { payload, issuer } = await verifyIdToken(await idToken());
        expect(payload.sub).toBe("alice");
        expect(issuer).toBe(ISSUER);
    });

    it.each([
        ["another issuer", () => idToken({}, { issuer: `${ISSUER}-other` })],
        ["another audience", () => idToken({}, { audience: "other-client" })],
        ["another client's azp", () => idToken({ azp: "claude" })],
        ["an access token", () => idToken({ typ: "Bearer" })],
        ["an expired token", () => idToken({}, { expiresIn: "-5m" })],
        ["no subject", () => idToken({ sub: undefined })],
        ["a stranger's signature", () => idToken({}, { key: strangerKey })],
        [
            "no signature (alg none)",
            async () =>
                new UnsecuredJWT({ sub: "alice", typ: "ID", azp: CLIENT })
                    .setIssuer(ISSUER)
                    .setAudience(CLIENT)
                    .setIssuedAt()
                    .setExpirationTime("5m")
                    .encode(),
        ],
        [
            "a shared-secret signature",
            () =>
                new SignJWT({ sub: "alice", typ: "ID", azp: CLIENT })
                    .setProtectedHeader({ alg: "HS256", kid: "realm-1" })
                    .setIssuer(ISSUER)
                    .setAudience(CLIENT)
                    .setIssuedAt()
                    .setExpirationTime("5m")
                    .sign(new TextEncoder().encode("secret".repeat(8))),
        ],
    ])("refuses %s as a bad token", async (_case, make) => {
        await expect(verifyIdToken(await make())).rejects.toBeInstanceOf(
            SsoTokenError,
        );
    });

    it("takes a key id the realm's key set lacks for unavailable keys, not a bad token", async () => {
        const rotated = await idToken({}, { kid: "realm-2" });
        await expect(verifyIdToken(rotated)).rejects.toMatchObject({
            constructor: IdentityProviderError,
            kind: "unavailable",
        });
    });
});

describe("verifyWebAccessToken", () => {
    it("accepts this client's access token", async () => {
        const { payload } = await verifyWebAccessToken(await accessToken());
        expect(payload.sub).toBe("alice");
    });

    it.each([
        ["without a type", () => accessToken({ typ: undefined })],
        ["an ID token", () => accessToken({ typ: "ID" })],
        ["an MCP client's token", () => accessToken({ azp: "claude" })],
        ["another issuer's", () => accessToken({}, { issuer: "https://x" })],
        ["an expired one", () => accessToken({}, { expiresIn: "-5m" })],
    ])("refuses %s", async (_case, make) => {
        await expect(verifyWebAccessToken(await make())).rejects.toBeInstanceOf(
            SsoTokenError,
        );
    });
});

describe("verifySsoLogin", () => {
    it("refuses an access token naming someone other than the ID token", async () => {
        const refused = verifySsoLogin({
            tokenType: "Bearer",
            idToken: await idToken({ sub: "alice" }),
            accessToken: await accessToken({ sub: "mallory" }),
        });
        await expect(refused).rejects.toMatchObject({
            headers: expect.objectContaining({
                location: expect.stringContaining("error=SSO_TOKEN_INVALID"),
            }),
        });
    });

    it("refuses a sign-in without `use` before anything is stored", async () => {
        const refused = verifySsoLogin({
            tokenType: "Bearer",
            idToken: await idToken(),
            accessToken: await accessToken({ resource_access: {} }),
        });
        await expect(refused).rejects.toMatchObject({
            headers: expect.objectContaining({
                location: expect.stringContaining("error=SSO_ACCESS_DENIED"),
            }),
        });
    });
});

describe("refreshProviderTokens diagnostics", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it.each([
        "refresh_token=example-refresh email=example@example.com",
        "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJleGFtcGxlIn0.c2lnbmF0dXJl",
    ])("discards token-shaped descriptions before storing or logging them: %s", async (description) => {
        const info = vi.spyOn(console, "info").mockImplementation(() => {});
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                Response.json(
                    {
                        error: "invalid_grant",
                        error_description: description,
                    },
                    { status: 400 },
                ),
            ),
        );
        let failure: IdentityProviderError | undefined;
        try {
            await refreshProviderTokens("example-refresh");
        } catch (error) {
            if (!(error instanceof IdentityProviderError)) throw error;
            failure = error;
        }
        expect(failure).toBeInstanceOf(IdentityProviderError);
        expect(failure?.providerDetail).toBeUndefined();
        logSession("ended", {
            cause: "provider-refused",
            providerError: failure?.providerError,
            providerDetail: failure?.providerDetail,
        });
        expect(info).toHaveBeenCalledExactlyOnceWith(
            "[session] ended cause=provider-refused providerError=invalid_grant",
        );
        expect(warn).not.toHaveBeenCalled();
        const stored = JSON.stringify(failure);
        const output = info.mock.calls.flat().join("\n");
        for (const part of description.split(/[ .]/)) {
            expect(stored).not.toContain(part);
            expect(failure?.message).not.toContain(part);
            expect(failure?.stack).not.toContain(part);
            expect(output).not.toContain(part);
        }
    });

    it("omits a credential-shaped error code from the error object", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                Response.json(
                    { error: "refresh_token=example-refresh" },
                    { status: 400 },
                ),
            ),
        );
        await expect(
            refreshProviderTokens("example-refresh"),
        ).rejects.toMatchObject({
            kind: "invalid_response",
            providerError: undefined,
            providerDetail: undefined,
        });
    });

    it.each([
        [
            400,
            "invalid_grant",
            "reauthentication_required",
            "The identity provider ended the sign-in",
        ],
        [
            503,
            "temporarily_unavailable",
            "unavailable",
            "The identity provider could not renew the sign-in",
        ],
        [
            400,
            "invalid_client",
            "invalid_response",
            "The identity provider could not renew the sign-in",
        ],
    ])("keeps provider diagnostics for HTTP %s %s without changing the error", async (status, code, kind, message) => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                Response.json(
                    {
                        error: code,
                        error_description: "Session not active",
                        access_token: "example-private-access",
                        refresh_token: "example-private-refresh",
                        email: "example@example.com",
                    },
                    { status },
                ),
            ),
        );
        await expect(
            refreshProviderTokens("example-refresh"),
        ).rejects.toMatchObject({
            kind,
            message,
            status,
            providerError: code,
            providerDetail: "Session not active",
        });
    });

    it("omits non-string diagnostics", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                Response.json(
                    {
                        error: "invalid_grant",
                        error_description: { secret: "example" },
                    },
                    { status: 400 },
                ),
            ),
        );
        await expect(
            refreshProviderTokens("example-refresh"),
        ).rejects.toMatchObject({
            providerError: "invalid_grant",
            providerDetail: undefined,
        });
    });
});
