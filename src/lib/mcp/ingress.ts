import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

const CONNECTOR_KEY_HEADER = "x-api-key";

/** Why the way a request came in refuses the client its token names. */
export type IngressRefusal = "client-not-public" | "connector-key";

function digest(value: string): Buffer {
    return createHash("sha256").update(value).digest();
}

/** Whether the public reverse proxy marked the request (MCP_PUBLIC_INGRESS_HEADER). */
export function viaPublicIngress(request: Request): boolean {
    const header = env.MCP_PUBLIC_INGRESS_HEADER;
    return header !== undefined && request.headers.has(header);
}

/**
 * Why a request is refused for the client its token was issued to, or
 * null. Through the public entrance only the clients in MCP_PUBLIC_CLIENTS
 * are served; a client in MCP_CONNECTOR_KEYS only with its key in
 * `X-API-Key`, whichever way it came in.
 */
export function ingressRefusal(
    request: Request,
    clientId: string | null,
): IngressRefusal | null {
    if (
        viaPublicIngress(request) &&
        (clientId === null || !env.MCP_PUBLIC_CLIENTS.includes(clientId))
    ) {
        return "client-not-public";
    }
    const expected = env.MCP_CONNECTOR_KEYS.find(
        (entry) => entry.client === clientId,
    );
    if (!expected) return null;
    const given = request.headers.get(CONNECTOR_KEY_HEADER) ?? "";
    return timingSafeEqual(digest(given), digest(expected.key))
        ? null
        : "connector-key";
}
