import {
    createRemoteJWKSet,
    decodeJwt,
    errors,
    type JWTPayload,
    type JWTVerifyGetKey,
    jwtVerify,
} from "jose";
import { env } from "@/lib/env";
import { getClaimsProvider } from "@/lib/identity/factory";
import { IdentityProviderError } from "@/lib/identity/ports";
import { issuerMetadata } from "@/lib/mcp/config";

const ALGORITHMS = ["RS256", "PS256", "ES256"];
const CLOCK_TOLERANCE_SECONDS = 30;
const TOKEN_TIMEOUT_MS = 10_000;

/** The provider's tokens of one web sign-in. */
export interface ProviderTokens {
    accessToken: string;
    accessTokenExpiresAt: Date;
    refreshToken: string | null;
    refreshTokenExpiresAt: Date | null;
    idToken: string | null;
}

/** A token the provider issued that does not verify. */
export class SsoTokenError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SsoTokenError";
    }
}

let remote: { uri: string; keys: JWTVerifyGetKey } | null = null;

async function realm(): Promise<{
    issuer: string;
    keys: JWTVerifyGetKey;
    tokenEndpoint: string | null;
}> {
    let metadata: Awaited<ReturnType<typeof issuerMetadata>>;
    try {
        metadata = await issuerMetadata();
    } catch {
        throw new IdentityProviderError(
            "unavailable",
            "The identity provider could not be discovered",
        );
    }
    if (remote?.uri !== metadata.jwksUri) {
        remote = {
            uri: metadata.jwksUri,
            keys: createRemoteJWKSet(new URL(metadata.jwksUri)),
        };
    }
    return {
        issuer: metadata.issuer,
        keys: remote.keys,
        tokenEndpoint: metadata.tokenEndpoint ?? null,
    };
}

function keysUnavailable(error: unknown): boolean {
    return (
        !(error instanceof errors.JOSEError) ||
        error instanceof errors.JWKSTimeout ||
        error instanceof errors.JWKSInvalid ||
        error.code === errors.JOSEError.code
    );
}

async function verify(
    token: string,
    check: (payload: JWTPayload, issuer: string) => void,
    audience?: string,
): Promise<{ payload: JWTPayload; issuer: string }> {
    const { issuer, keys } = await realm();
    let payload: JWTPayload;
    try {
        ({ payload } = await jwtVerify(token, keys, {
            issuer,
            algorithms: ALGORITHMS,
            clockTolerance: CLOCK_TOLERANCE_SECONDS,
            requiredClaims: ["exp", "sub", "iat"],
            ...(audience ? { audience } : {}),
        }));
    } catch (error) {
        if (keysUnavailable(error)) {
            throw new IdentityProviderError(
                "unavailable",
                "The identity provider's signing keys are unavailable",
            );
        }
        throw new SsoTokenError("The token does not verify");
    }
    check(payload, issuer);
    return { payload, issuer };
}

function clientId(): string {
    const id = env.OIDC_CLIENT_ID;
    if (!id) throw new Error("OIDC_CLIENT_ID is not configured");
    return id;
}

/**
 * Verify an ID token of the web sign-in: signature by the realm's keys,
 * exact issuer, this client as audience (and as `azp` when present),
 * expiry, and a `typ` of `ID` when the token says.
 */
export function verifyIdToken(
    idToken: string,
): Promise<{ payload: JWTPayload; issuer: string }> {
    const client = clientId();
    return verify(
        idToken,
        (payload) => {
            if (!getClaimsProvider().acceptsIdToken(payload, client)) {
                throw new SsoTokenError(
                    "ID token does not match the provider profile",
                );
            }
        },
        client,
    );
}

/**
 * Verify an access token of the web sign-in: signature, exact issuer,
 * expiry, `typ` `Bearer`, issued to this client (`azp`). Only such a
 * token may supply the capabilities; an MCP client's token never does.
 */
export function verifyWebAccessToken(
    accessToken: string,
): Promise<{ payload: JWTPayload; issuer: string }> {
    const client = clientId();
    return verify(accessToken, (payload) => {
        if (!getClaimsProvider().acceptsAccessToken(payload, client)) {
            throw new SsoTokenError(
                "Access token does not match the provider profile",
            );
        }
    });
}

function expiry(token: string | null, seconds: unknown): Date | null {
    if (typeof seconds === "number" && seconds > 0) {
        return new Date(Date.now() + seconds * 1000);
    }
    if (!token) return null;
    try {
        const { exp } = decodeJwt(token);
        return typeof exp === "number" ? new Date(exp * 1000) : null;
    } catch {
        return null;
    }
}

/**
 * Exchange a refresh token at the realm's token endpoint. An
 * `invalid_grant` (session ended, user disabled or deleted, token revoked)
 * is `reauthentication_required`; network and 5xx failures are
 * `unavailable`, retried once.
 */
export async function refreshProviderTokens(
    refreshToken: string,
): Promise<ProviderTokens> {
    const { tokenEndpoint } = await realm();
    if (!tokenEndpoint) {
        throw new IdentityProviderError(
            "invalid_response",
            "The identity provider names no token endpoint",
        );
    }
    const secret = env.OIDC_CLIENT_SECRET ?? "";
    let response: Response | null = null;
    for (let attempt = 1; attempt <= 2 && !response; attempt++) {
        try {
            response = await fetch(tokenEndpoint, {
                method: "POST",
                headers: {
                    "content-type": "application/x-www-form-urlencoded",
                    authorization: `Basic ${Buffer.from(
                        `${encodeURIComponent(clientId())}:${encodeURIComponent(secret)}`,
                    ).toString("base64")}`,
                },
                body: new URLSearchParams({
                    grant_type: "refresh_token",
                    refresh_token: refreshToken,
                }),
                signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
            });
            if (response.status >= 500 && attempt < 2) {
                await response.body?.cancel().catch(() => {});
                response = null;
            }
        } catch {
            response = null;
            if (attempt === 2) {
                throw new IdentityProviderError(
                    "unavailable",
                    "The identity provider could not be reached",
                );
            }
        }
    }
    if (!response) {
        throw new IdentityProviderError(
            "unavailable",
            "The identity provider could not be reached",
        );
    }
    const body = (await response.json().catch(() => null)) as Record<
        string,
        unknown
    > | null;
    if (!response.ok) {
        if (body?.error === "invalid_grant") {
            throw new IdentityProviderError(
                "reauthentication_required",
                "The identity provider ended the sign-in",
                response.status,
            );
        }
        throw new IdentityProviderError(
            response.status >= 500 ? "unavailable" : "invalid_response",
            "The identity provider could not renew the sign-in",
            response.status,
        );
    }
    if (typeof body?.access_token !== "string") {
        throw new IdentityProviderError(
            "invalid_response",
            "The identity provider sent no access token",
        );
    }
    const nextRefresh =
        typeof body.refresh_token === "string" ? body.refresh_token : null;
    return {
        accessToken: body.access_token,
        accessTokenExpiresAt:
            expiry(body.access_token, body.expires_in) ??
            new Date(Date.now() + 60_000),
        refreshToken: nextRefresh ?? refreshToken,
        refreshTokenExpiresAt: expiry(
            nextRefresh ?? refreshToken,
            body.refresh_expires_in,
        ),
        idToken: typeof body.id_token === "string" ? body.id_token : null,
    };
}
