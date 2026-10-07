import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { env } from "@/lib/env";
import { deniedOnAdminHost } from "@/lib/hosted/hostname-gate";
import { readBoundedJson } from "@/lib/http/bounded-json";
import { recordMcpAccess } from "@/lib/mcp/audit";
import { type CallerRefusal, resolveCaller } from "@/lib/mcp/caller";
import { isMcpEnabled, MCP_MAX_BODY_BYTES } from "@/lib/mcp/config";
import { unauthorized } from "@/lib/mcp/metadata";
import { limitMcpIp, limitMcpSubject, mcpClientIp } from "@/lib/mcp/rate-limit";
import { buildMcpServer } from "@/lib/mcp/registry";
import {
    type McpTokenClaims,
    tokenClient,
    verifyMcpToken,
} from "@/lib/mcp/token";
import { ALL_TOOLS } from "@/lib/mcp/tools";

export const dynamic = "force-dynamic";

const BEARER = /^bearer\s+(\S+)\s*$/i;

function notFound(): Response {
    return new Response(null, { status: 404 });
}

function unavailable(request: Request): boolean {
    return !isMcpEnabled() || deniedOnAdminHost(request, env.ADMIN_HOSTNAME);
}

function forbidden(reason: CallerRefusal): Response {
    const error =
        reason === "no-account" ? "Sign in to Riffado once first" : "Forbidden";
    return Response.json({ error }, { status: 403 });
}

function jsonRpcError(status: number, code: number, message: string): Response {
    return Response.json(
        { jsonrpc: "2.0", error: { code, message }, id: null },
        { status },
    );
}

function bearerToken(request: Request): string {
    const header = request.headers.get("authorization") ?? "";
    return BEARER.exec(header)?.[1] ?? "";
}

/**
 * Riffado's external MCP server: stateless Streamable HTTP with JSON
 * responses, for a Keycloak token issued to `MCP_AUDIENCE`. 404 while MCP is
 * off or on the admin host, 401 (pointing at the resource metadata) for a
 * missing or rejected token, 403 for a token that names no caller, 503
 * while the realm cannot be reached, 400 for a JSON-RPC batch.
 */
export async function POST(request: Request): Promise<Response> {
    if (unavailable(request)) return notFound();
    const limitedIp = await limitMcpIp(request);
    if (limitedIp) return limitedIp;

    const token = bearerToken(request);
    if (!token) return unauthorized();
    let claims: McpTokenClaims | null;
    try {
        claims = await verifyMcpToken(token);
    } catch {
        return Response.json(
            { error: "Identity provider unavailable" },
            { status: 503 },
        );
    }
    if (!claims) return unauthorized();
    const limitedCaller = await limitMcpSubject(claims);
    if (limitedCaller) return limitedCaller;

    const ip = mcpClientIp(request);
    const resolved = await resolveCaller(claims);
    if (!resolved.ok) {
        await recordMcpAccess({
            caller: null,
            subject: claims.sub,
            clientId: tokenClient(claims),
            tool: null,
            outcome: "denied",
            ip,
        });
        return forbidden(resolved.reason);
    }

    const read = await readBoundedJson(request, MCP_MAX_BODY_BYTES);
    if (read.tooLarge) {
        return Response.json({ error: "Request too large" }, { status: 413 });
    }
    if (read.body === undefined) {
        return jsonRpcError(400, -32700, "Parse error");
    }
    if (Array.isArray(read.body)) {
        return jsonRpcError(400, -32600, "Batch requests are not supported");
    }

    const server = buildMcpServer(ALL_TOOLS, resolved.caller, ip);
    const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
        return await transport.handleRequest(request, {
            parsedBody: read.body,
        });
    } finally {
        await server.close();
    }
}

function methodNotAllowed(request: Request): Response {
    if (unavailable(request)) return notFound();
    return Response.json(
        {
            jsonrpc: "2.0",
            error: { code: -32000, message: "Method not allowed." },
            id: null,
        },
        { status: 405, headers: { Allow: "POST" } },
    );
}

export { methodNotAllowed as DELETE, methodNotAllowed as GET };
