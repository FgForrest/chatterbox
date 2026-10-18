import { MCP_PERMISSIONS } from "@/lib/authz/catalog";
import { deploymentProductName } from "@/lib/deployment-brand";
import { env } from "@/lib/env";
import { defaultLocale } from "@/lib/i18n/config";
import { isMcpEnabled, issuerMetadata } from "@/lib/mcp/config";

const RESOURCE_PATH = "/api/mcp";
const METADATA_PATH = `/.well-known/oauth-protected-resource${RESOURCE_PATH}`;
/** The scope a 401 asks for: sign-in only; the realm decides the permissions. */
const CHALLENGE_SCOPES = ["openid"];
/** Every scope the resource understands: sign-in and the catalog's permissions. */
const SUPPORTED_SCOPES = ["openid", ...MCP_PERMISSIONS];

function appUrl(): string {
    return (env.APP_URL ?? "").replace(/\/+$/, "");
}

/** The canonical URL of the MCP resource (`APP_URL` + `/api/mcp`). */
export function mcpResourceUrl(): string {
    return `${appUrl()}${RESOURCE_PATH}`;
}

/** Where the resource's RFC 9728 metadata is published. */
export function resourceMetadataUrl(): string {
    return `${appUrl()}${METADATA_PATH}`;
}

/**
 * The RFC 9728 protected-resource metadata: 404 while MCP is off, 503 while
 * the realm cannot be discovered.
 */
export async function protectedResourceMetadata(): Promise<Response> {
    if (!isMcpEnabled()) return new Response(null, { status: 404 });
    try {
        const { issuer } = await issuerMetadata();
        return Response.json(
            {
                resource: mcpResourceUrl(),
                authorization_servers: [issuer],
                scopes_supported: SUPPORTED_SCOPES,
                bearer_methods_supported: ["header"],
                resource_name: deploymentProductName(defaultLocale),
            },
            { headers: { "Cache-Control": "public, max-age=300" } },
        );
    } catch {
        return new Response(null, { status: 503 });
    }
}

/**
 * 401 pointing the client at the resource metadata and naming the scope to
 * request (MCP authorization); `invalidToken` for a token that was sent
 * but not accepted.
 */
export function unauthorized(invalidToken = false): Response {
    const params = [
        ...(invalidToken ? ['error="invalid_token"'] : []),
        `resource_metadata="${resourceMetadataUrl()}"`,
        `scope="${CHALLENGE_SCOPES.join(" ")}"`,
    ];
    return Response.json(
        { error: "Unauthorized" },
        {
            status: 401,
            headers: { "WWW-Authenticate": `Bearer ${params.join(", ")}` },
        },
    );
}

/**
 * 403 for a tool the token's permissions do not cover (RFC 6750
 * `insufficient_scope`), naming the permissions any of which would do.
 * A token with the same permissions always gets the same answer.
 */
export function insufficientScope(scopes: readonly string[]): Response {
    const params = [
        'error="insufficient_scope"',
        `scope="${scopes.join(" ")}"`,
        `resource_metadata="${resourceMetadataUrl()}"`,
    ];
    return Response.json(
        { error: "This token does not permit this tool" },
        {
            status: 403,
            headers: { "WWW-Authenticate": `Bearer ${params.join(", ")}` },
        },
    );
}
