import {
    createLocalJWKSet,
    errors,
    exportJWK,
    generateKeyPair,
    type JWK,
    type JWTVerifyGetKey,
    SignJWT,
} from "jose";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockEnv = vi.hoisted(() => ({
    IS_HOSTED: false,
    MCP_AUDIENCE: undefined as string | undefined,
    OIDC_ISSUER_URL: undefined as string | undefined,
    OIDC_CLIENT_ID: "riffado",
    OIDC_CLIENT_SECRET: "secret",
}));

vi.mock("@/lib/env", () => ({ env: mockEnv }));

import { verifyMcpToken } from "@/lib/mcp/token";

const ISSUER = "https://id.example.com/realms/acme";
const AUDIENCE = "riffado-mcp";

let privateKey: CryptoKey;
let otherKey: CryptoKey;
let publicJwk: JWK;
let keys: JWTVerifyGetKey;

beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    otherKey = (await generateKeyPair("RS256")).privateKey;
    publicJwk = {
        ...(await exportJWK(pair.publicKey)),
        kid: "k1",
        alg: "RS256",
        use: "sig",
    };
    keys = createLocalJWKSet({ keys: [publicJwk] });
});

interface TokenOptions {
    issuer?: string;
    audience?: string | string[];
    exp?: string;
    kid?: string;
    sub?: string | null;
    key?: CryptoKey;
}

function token(
    claims: Record<string, unknown> = {},
    options: TokenOptions = {},
): Promise<string> {
    const jwt = new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: options.kid ?? "k1" })
        .setIssuer(options.issuer ?? ISSUER)
        .setAudience(options.audience ?? AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(options.exp ?? "5m");
    if (options.sub !== null) jwt.setSubject(options.sub ?? "user-sub");
    return jwt.sign(options.key ?? privateKey);
}

function verify(jwt: string, audience = AUDIENCE) {
    return verifyMcpToken(jwt, { issuer: ISSUER, audience, keys });
}

function base64url(value: unknown): string {
    return Buffer.from(JSON.stringify(value)).toString("base64url");
}

describe("verifyMcpToken", () => {
    it("accepts a good token and returns its claims", async () => {
        const claims = await verify(
            await token({
                azp: "claude",
                resource_access: { [AUDIENCE]: { roles: ["tasks:read"] } },
            }),
        );
        expect(claims?.sub).toBe("user-sub");
        expect(claims?.azp).toBe("claude");
    });

    it("accepts a token whose audience list includes the server", async () => {
        const claims = await verify(
            await token({}, { audience: ["account", AUDIENCE] }),
        );
        expect(claims?.sub).toBe("user-sub");
    });

    it("rejects a wrong audience", async () => {
        expect(await verify(await token(), "other")).toBeNull();
        expect(
            await verify(await token({}, { audience: "account" })),
        ).toBeNull();
    });

    it("rejects a wrong issuer", async () => {
        expect(
            await verify(
                await token(
                    {},
                    { issuer: "https://evil.example.com/realms/acme" },
                ),
            ),
        ).toBeNull();
        expect(
            await verify(await token({}, { issuer: `${ISSUER}/` })),
        ).toBeNull();
    });

    it("rejects an expired token beyond the clock tolerance", async () => {
        expect(await verify(await token({}, { exp: "-2m" }))).toBeNull();
    });

    it("tolerates a little clock skew", async () => {
        expect(await verify(await token({}, { exp: "-10s" }))).not.toBeNull();
    });

    it("rejects a token without exp", async () => {
        const jwt = await new SignJWT({})
            .setProtectedHeader({ alg: "RS256", kid: "k1" })
            .setIssuer(ISSUER)
            .setAudience(AUDIENCE)
            .setSubject("user-sub")
            .sign(privateKey);
        expect(await verify(jwt)).toBeNull();
    });

    it("rejects a token without sub", async () => {
        expect(await verify(await token({}, { sub: null }))).toBeNull();
    });

    it("rejects a token signed by another key", async () => {
        expect(await verify(await token({}, { key: otherKey }))).toBeNull();
    });

    it("rejects a token naming an unknown key", async () => {
        expect(await verify(await token({}, { kid: "k2" }))).toBeNull();
    });

    it("rejects garbage and an empty token", async () => {
        expect(await verify("not-a-jwt")).toBeNull();
        expect(await verify("")).toBeNull();
        for (const garbage of ["a.b.c", "é.é.é", "eyJ.eyJ.x", "..", "a.b"]) {
            expect(await verify(garbage)).toBeNull();
        }
        const header = base64url({ alg: "RS256", kid: "k1" });
        for (const payload of ["null", "[]", "1", "é"]) {
            const body = Buffer.from(payload).toString("base64url");
            expect(await verify(`${header}.${body}.c2ln`)).toBeNull();
        }
    });

    it("rejects alg none", async () => {
        const exp = Math.floor(Date.now() / 1000) + 60;
        const none = `${base64url({ alg: "none" })}.${base64url({
            iss: ISSUER,
            aud: AUDIENCE,
            sub: "x",
            exp,
        })}.`;
        expect(await verify(none)).toBeNull();
    });

    it("rejects an algorithm outside the allowlist even with a matching key", async () => {
        const pair = await generateKeyPair("RS512");
        const jwk = await exportJWK(pair.publicKey);
        const rs512Keys = createLocalJWKSet({ keys: [{ ...jwk, kid: "k3" }] });
        const jwt = await new SignJWT({})
            .setProtectedHeader({ alg: "RS512", kid: "k3" })
            .setIssuer(ISSUER)
            .setAudience(AUDIENCE)
            .setSubject("user-sub")
            .setExpirationTime("5m")
            .sign(pair.privateKey);
        expect(
            await verifyMcpToken(jwt, {
                issuer: ISSUER,
                audience: AUDIENCE,
                keys: rs512Keys,
            }),
        ).toBeNull();
    });

    it("accepts an access token and rejects an ID token", async () => {
        expect(await verify(await token({ typ: "Bearer" }))).not.toBeNull();
        expect(await verify(await token({ typ: "ID" }))).toBeNull();
        expect(await verify(await token({ typ: "Refresh" }))).toBeNull();
    });

    it("throws when the key set cannot be fetched, not calling the token bad", async () => {
        const jwt = await token();
        const unreachable =
            (error: Error): JWTVerifyGetKey =>
            () => {
                throw error;
            };
        for (const error of [
            new TypeError("fetch failed"),
            new errors.JWKSTimeout(),
            new errors.JWKSInvalid("JSON Web Key Set malformed"),
            new errors.JOSEError(
                "Expected 200 OK from the JSON Web Key Set HTTP response",
            ),
        ]) {
            await expect(
                verifyMcpToken(jwt, {
                    issuer: ISSUER,
                    audience: AUDIENCE,
                    keys: unreachable(error),
                }),
            ).rejects.toBe(error);
        }
    });

    it("still calls a token bad when the key set has no key for it", async () => {
        const jwt = await token();
        const keyless: JWTVerifyGetKey = () => {
            throw new errors.JWKSNoMatchingKey();
        };
        expect(
            await verifyMcpToken(jwt, {
                issuer: ISSUER,
                audience: AUDIENCE,
                keys: keyless,
            }),
        ).toBeNull();
    });

    it("rejects a symmetric (HS256) signature", async () => {
        const jwt = await new SignJWT({})
            .setProtectedHeader({ alg: "HS256", kid: "k1" })
            .setIssuer(ISSUER)
            .setAudience(AUDIENCE)
            .setSubject("user-sub")
            .setExpirationTime("5m")
            .sign(new TextEncoder().encode("x".repeat(32)));
        expect(await verify(jwt)).toBeNull();
    });
});

describe("verifyMcpToken with the configured realm", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const INTERNAL = "http://keycloak:8080/realms/acme";

    beforeEach(() => {
        fetchSpy.mockReset();
        fetchSpy.mockImplementation(async (input) => {
            const url = String(input);
            if (url === `${INTERNAL}/.well-known/openid-configuration`) {
                return Response.json({
                    issuer: ISSUER,
                    jwks_uri: `${INTERNAL}/protocol/openid-connect/certs`,
                });
            }
            if (url === `${INTERNAL}/protocol/openid-connect/certs`) {
                return Response.json({ keys: [publicJwk] });
            }
            return new Response(null, { status: 404 });
        });
    });

    beforeEach(() => {
        mockEnv.IS_HOSTED = false;
    });

    it("returns null while the server is off", async () => {
        mockEnv.MCP_AUDIENCE = undefined;
        mockEnv.OIDC_ISSUER_URL = INTERNAL;
        expect(await verifyMcpToken(await token())).toBeNull();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("returns null on hosted, which ignores single sign-on", async () => {
        mockEnv.IS_HOSTED = true;
        mockEnv.MCP_AUDIENCE = AUDIENCE;
        mockEnv.OIDC_ISSUER_URL = INTERNAL;
        expect(await verifyMcpToken(await token())).toBeNull();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("reaches the SSO realm at its internal URL and checks the frontend issuer", async () => {
        mockEnv.MCP_AUDIENCE = AUDIENCE;
        mockEnv.OIDC_ISSUER_URL = INTERNAL;
        const claims = await verifyMcpToken(await token());
        expect(claims?.sub).toBe("user-sub");
        expect(
            await verifyMcpToken(await token({}, { issuer: INTERNAL })),
        ).toBeNull();
    });

    it("throws when the realm's keys cannot be fetched", async () => {
        const down = "http://keycloak-down:8080/realms/acme";
        mockEnv.MCP_AUDIENCE = AUDIENCE;
        mockEnv.OIDC_ISSUER_URL = down;
        fetchSpy.mockImplementation(async (input) => {
            if (String(input) === `${down}/.well-known/openid-configuration`) {
                return Response.json({
                    issuer: ISSUER,
                    jwks_uri: `${down}/protocol/openid-connect/certs`,
                });
            }
            throw new TypeError("fetch failed");
        });
        await expect(verifyMcpToken(await token())).rejects.toThrow(
            "fetch failed",
        );
    });

    it("throws when the realm cannot be discovered", async () => {
        mockEnv.MCP_AUDIENCE = AUDIENCE;
        mockEnv.OIDC_ISSUER_URL = "http://keycloak:8080/realms/missing";
        await expect(verifyMcpToken(await token())).rejects.toThrow(
            "discovery 404",
        );
    });
});
