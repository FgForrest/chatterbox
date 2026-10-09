import { ErrorCode } from "@/lib/errors";
import type { McpCaller } from "@/lib/mcp/caller";
import { type McpTokenClaims, tokenClient } from "@/lib/mcp/token";
import {
    consumeRateLimitBucket,
    getClientIp,
    type RateLimitResult,
} from "@/lib/rate-limit";

const WINDOW_MS = 60_000;
const UNKNOWN_IP = "unknown";

/** Requests per minute for one caller (subject and client). */
export const MCP_CALLER_LIMIT = 60;
/** Decrypting searches per minute for one caller. */
export const MCP_SCAN_LIMIT = 10;

function callerKey(caller: Pick<McpCaller, "subject" | "clientId">): string {
    return JSON.stringify([caller.subject, caller.clientId]);
}

function tooMany(result: RateLimitResult): Response {
    const retryAfter = Math.max(
        1,
        Math.ceil((result.resetAt.getTime() - Date.now()) / 1000),
    );
    return Response.json(
        { error: "Rate limit exceeded", code: ErrorCode.RATE_LIMITED },
        { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
}

/**
 * The client IP for the access log, or null when it cannot be told (proxy
 * headers not trusted, or absent).
 */
export function mcpClientIp(request: Request): string | null {
    const ip = getClientIp(request);
    return ip === UNKNOWN_IP ? null : ip;
}

/**
 * 429 when the token's caller (`sub`, and `azp` else `client_id`, as
 * `resolveCaller` names it) is over its per-minute budget. Charged before
 * the caller is resolved, so a refused caller spends the same budget.
 */
export async function limitMcpSubject(
    claims: McpTokenClaims,
): Promise<Response | null> {
    const key = callerKey({
        subject: claims.sub,
        clientId: tokenClient(claims),
    });
    const result = await consumeRateLimitBucket(`mcp:caller:${key}`, {
        limit: MCP_CALLER_LIMIT,
        windowMs: WINDOW_MS,
    });
    return result.allowed ? null : tooMany(result);
}

/** Whether the caller may run one more decrypting scan this minute. */
export async function allowMcpScan(caller: McpCaller): Promise<boolean> {
    const result = await consumeRateLimitBucket(
        `mcp:scan:${callerKey(caller)}`,
        { limit: MCP_SCAN_LIMIT, windowMs: WINDOW_MS },
    );
    return result.allowed;
}
