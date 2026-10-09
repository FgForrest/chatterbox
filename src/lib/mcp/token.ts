import {
    createRemoteJWKSet,
    errors,
    type JWTPayload,
    type JWTVerifyGetKey,
    jwtVerify,
} from "jose";
import { env } from "@/lib/env";
import { isMcpEnabled, issuerMetadata } from "@/lib/mcp/config";
import { mcpResourceUrl } from "@/lib/mcp/metadata";

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
    /** Values of which `aud` must contain one. */
    audiences: readonly string[];
    /** The realm's signing keys. */
    keys: JWTVerifyGetKey;
}

/**
 * What {@link verifyMcpToken} found: an access token the realm issued for
 * this server, a genuine access token of the realm issued for another
 * audience (a user without any MCP role gets one), or anything else.
 */
export type McpTokenCheck =
    | { kind: "valid"; claims: McpTokenClaims }
    | { kind: "other-audience"; claims: McpTokenClaims }
    | { kind: "invalid" };

const INVALID: McpTokenCheck = { kind: "invalid" };

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
    return {
        issuer: metadata.issuer,
        audiences: env.MCP_RESOURCE_AUDIENCE
            ? [audience, mcpResourceUrl()]
            : [audience],
        keys: remote.keys,
    };
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
 * Check an access token against the realm: signature, exact issuer, expiry,
 * `sub`, a `typ` of `Bearer` when it has one (an ID token is invalid), then
 * the audience. Throws when the realm cannot be asked: its discovery
 * document (without `options`) or its signing keys out of reach.
 */
export async function verifyMcpToken(
    token: string,
    options?: McpTokenVerifyOptions,
): Promise<McpTokenCheck> {
    const resolved = options ?? (await configuredOptions());
    if (!resolved || !token) return INVALID;
    let payload: JWTPayload;
    try {
        ({ payload } = await jwtVerify(token, resolved.keys, {
            issuer: resolved.issuer,
            algorithms: ALGORITHMS,
            clockTolerance: CLOCK_TOLERANCE_SECONDS,
            requiredClaims: ["exp", "sub"],
        }));
    } catch (error) {
        if (realmUnavailable(error)) throw error;
        return INVALID;
    }
    if (payload.typ !== undefined && payload.typ !== ACCESS_TOKEN_TYPE) {
        return INVALID;
    }
    if (typeof payload.sub !== "string" || !payload.sub) return INVALID;
    const claims = payload as McpTokenClaims;
    const audience = [payload.aud ?? []].flat();
    return resolved.audiences.some((value) => audience.includes(value))
        ? { kind: "valid", claims }
        : { kind: "other-audience", claims };
}
