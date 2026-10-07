import { db } from "@/db";
import { pruneMcpAccessLog } from "@/db/queries/mcp-audit";
import { mcpAccessLog } from "@/db/schema";
import { env } from "@/lib/env";
import type { McpCaller } from "@/lib/mcp/caller";

/** How an MCP call ended, as the access log records it. */
export type McpOutcome = (typeof mcpAccessLog.$inferInsert)["outcome"];

/** One row of the MCP access log. */
export interface McpAccessEntry {
    /** Null when the token resolved to no caller. */
    caller: McpCaller | null;
    /** The token's `sub`, for a request without a caller. */
    subject?: string | null;
    /** The token's client, for a request without a caller. */
    clientId?: string | null;
    /** Null for a request refused before any tool ran. */
    tool: string | null;
    outcome: McpOutcome;
    /** Ids the call read or changed; de-duplicated, at most 200 kept. */
    targetIds?: readonly string[];
    ip: string | null;
}

const MAX_TARGETS = 200;
const PRUNE_MS = 60 * 60 * 1000;
const PRUNE_BATCH = 5_000;
const PRUNE_MAX_BATCHES = 20;

function message(error: unknown): unknown {
    return error instanceof Error ? error.message : error;
}

/** Record one MCP call. Never throws: auditing must not fail a call. */
export async function recordMcpAccess(entry: McpAccessEntry): Promise<void> {
    const { caller } = entry;
    try {
        await db.insert(mcpAccessLog).values({
            callerKind: caller?.kind ?? null,
            userId: caller?.kind === "user" ? caller.userId : null,
            subject: caller?.subject ?? entry.subject ?? null,
            clientId: caller?.clientId ?? entry.clientId ?? null,
            tool: entry.tool,
            outcome: entry.outcome,
            targetIds: [...new Set(entry.targetIds ?? [])].slice(
                0,
                MAX_TARGETS,
            ),
            ip: entry.ip,
        });
    } catch (error) {
        console.error("[mcp] audit write failed", message(error));
    }
}

async function pruneExpired(): Promise<void> {
    for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch++) {
        const deleted = await pruneMcpAccessLog(
            env.MCP_AUDIT_RETENTION_DAYS,
            PRUNE_BATCH,
        );
        if (deleted < PRUNE_BATCH) return;
    }
}

let pruner: ReturnType<typeof setInterval> | undefined;

/**
 * Hourly pruning of MCP access-log rows past MCP_AUDIT_RETENTION_DAYS. Runs
 * whether or not the MCP server is on, so turning it off still ages out
 * what it logged.
 */
export function startMcpAuditPruner(): void {
    if (pruner) return;
    pruner = setInterval(() => {
        void pruneExpired().catch((error: unknown) =>
            console.error("[mcp] audit prune failed", message(error)),
        );
    }, PRUNE_MS);
    pruner.unref?.();
}
