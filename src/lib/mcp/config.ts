import { env } from "@/lib/env";
import { isSsoEnabled, ssoDiscoveryUrl } from "@/lib/sso/config";

/** Largest JSON-RPC request body `/api/mcp` reads. */
export const MCP_MAX_BODY_BYTES = 256 * 1024;

/** Most items one page of a listing tool returns. */
export const MCP_PAGE_LIMIT = 50;

const DISCOVERY_TIMEOUT_MS = 5_000;

/**
 * Whether the external MCP server is on; off means 404. It needs an
 * audience and single sign-on, so hosted (which ignores SSO) keeps it off.
 */
export function isMcpEnabled(): boolean {
    return Boolean(env.MCP_AUDIENCE) && isSsoEnabled();
}

/** What Riffado needs from the realm's discovery document. */
export interface IssuerMetadata {
    /** The realm's own issuer string, as it appears in `iss`. */
    issuer: string;
    /** Where the realm publishes its signing keys. */
    jwksUri: string;
}

let discovery: { url: string; promise: Promise<IssuerMetadata> } | null = null;

function isHttpUrl(value: string): boolean {
    try {
        const { protocol } = new URL(value);
        return protocol === "http:" || protocol === "https:";
    } catch {
        return false;
    }
}

async function discover(url: string): Promise<IssuerMetadata> {
    const response = await fetch(ssoDiscoveryUrl(url), {
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`discovery ${response.status}`);
    const body = (await response.json()) as {
        issuer?: unknown;
        jwks_uri?: unknown;
    };
    if (
        typeof body.issuer !== "string" ||
        !body.issuer ||
        typeof body.jwks_uri !== "string" ||
        !isHttpUrl(body.jwks_uri)
    ) {
        throw new Error("discovery document lacks issuer or jwks_uri");
    }
    return { issuer: body.issuer, jwksUri: body.jwks_uri };
}

/**
 * The single sign-on realm's discovery document (from OIDC_ISSUER_URL, which
 * may be an internal URL), fetched once per issuer URL; a failed fetch is
 * retried on the next call.
 */
export function issuerMetadata(): Promise<IssuerMetadata> {
    const url = env.OIDC_ISSUER_URL;
    if (!url) return Promise.reject(new Error("MCP issuer is not configured"));
    if (discovery?.url === url) return discovery.promise;
    const promise = discover(url).catch((error: unknown) => {
        if (discovery?.promise === promise) discovery = null;
        throw error;
    });
    discovery = { url, promise };
    return promise;
}
