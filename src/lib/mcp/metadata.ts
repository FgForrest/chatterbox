import { env } from "@/lib/env";
import { isMcpEnabled, issuerMetadata } from "@/lib/mcp/config";

const RESOURCE_PATH = "/api/mcp";
const METADATA_PATH = `/.well-known/oauth-protected-resource${RESOURCE_PATH}`;

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
                bearer_methods_supported: ["header"],
                resource_name: "Riffado",
            },
            { headers: { "Cache-Control": "public, max-age=300" } },
        );
    } catch {
        return new Response(null, { status: 503 });
    }
}

/** 401 pointing the client at the resource metadata (MCP authorization). */
export function unauthorized(): Response {
    return Response.json(
        { error: "Unauthorized" },
        {
            status: 401,
            headers: {
                "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl()}"`,
            },
        },
    );
}
