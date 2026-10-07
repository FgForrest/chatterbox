import {
    createRemoteJWKSet,
    errors,
    type JWTPayload,
    type JWTVerifyGetKey,
    jwtVerify,
} from "jose";
import { env } from "@/lib/env";
import { isMcpEnabled, issuerMetadata } from "@/lib/mcp/config";

const ALGORITHMS = ["RS256", "PS256", "ES256"];
const CLOCK_TOLERANCE_SECONDS = 30;
const ACCESS_TOKEN_TYPE = "Bearer";

/** The claims of a verified MCP bearer token. */
export interface McpTokenClaims extends JWTPayload {
    sub: string;
}

/** What a token is checked against. */
export interface McpTokenVerifyOptions {
    /** Exact `iss` the token must carry. */
    issuer: string;
    /** Value `aud` must contain. */
    audience: string;
    /** The realm's signing keys. */
    keys: JWTVerifyGetKey;
}

let remote: { uri: string; keys: JWTVerifyGetKey } | null = null;

async function configuredOptions(): Promise<McpTokenVerifyOptions | null> {
    const audience = env.MCP_AUDIENCE;
    if (!audience || !isMcpEnabled()) return null;
    const metadata = await issuerMetadata();
    if (remote?.uri !== metadata.jwksUri) {
        remote = {
            uri: metadata.jwksUri,
            keys: createRemoteJWKSet(new URL(metadata.jwksUri)),
        };
    }
    return { issuer: metadata.issuer, audience, keys: remote.keys };
}

/** The client a token was issued to: `azp`, else `client_id`. */
export function tokenClient(claims: JWTPayload): string | null {
    for (const value of [claims.azp, claims.client_id]) {
        if (typeof value === "string" && value) return value;
    }
    return null;
}

function realmUnavailable(error: unknown): boolean {
    return (
        !(error instanceof errors.JOSEError) ||
        error instanceof errors.JWKSTimeout ||
        error instanceof errors.JWKSInvalid ||
        error.code === errors.JOSEError.code
    );
}

/**
 * The verified claims of an access token the realm issued for this server,
 * or null for any token that is not (an ID token included). Throws when
 * the realm cannot be asked: its discovery document (without `options`) or
 * its signing keys out of reach.
 */
export async function verifyMcpToken(
    token: string,
    options?: McpTokenVerifyOptions,
): Promise<McpTokenClaims | null> {
    const resolved = options ?? (await configuredOptions());
    if (!resolved || !token) return null;
    try {
        const { payload } = await jwtVerify(token, resolved.keys, {
            issuer: resolved.issuer,
            audience: resolved.audience,
            algorithms: ALGORITHMS,
            clockTolerance: CLOCK_TOLERANCE_SECONDS,
            requiredClaims: ["exp", "sub"],
        });
        if (payload.typ !== undefined && payload.typ !== ACCESS_TOKEN_TYPE) {
            return null;
        }
        return typeof payload.sub === "string" && payload.sub
            ? (payload as McpTokenClaims)
            : null;
    } catch (error) {
        if (realmUnavailable(error)) throw error;
        return null;
    }
}
