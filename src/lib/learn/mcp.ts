/**
 * The MCP endpoint a Learn run's model calls Riffado's read-only tools
 * through (Task 3.5, path 1): stateless JSON-RPC over HTTP, one request
 * per POST (`initialize`, `tools/list`, `tools/call`).
 *
 * The caller is a run, named by its token (`run-token.ts`); everything else
 * (user, recording, scopes) comes from the run. Each call spends one of the
 * run's lookups, counted in the database so it holds across processes.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { learnRuns } from "@/db/schema";
import {
    findEntities,
    findFacts,
    getEntity,
    type LearnToolContext,
} from "@/lib/learn/tools";

/** Lookups one run may make over MCP. */
export const MCP_TOOL_BUDGET = 60;
/** The largest request body read; a tool call needs a few hundred bytes. */
export const MCP_MAX_BODY_BYTES = 64 * 1024;
const MAX_ID_LENGTH = 200;
const PROTOCOL_VERSION = "2025-06-18";

export interface McpRun {
    id: string;
    userId: string;
    view: "private" | "org";
}

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
    jsonrpc: "2.0";
    id?: JsonRpcId;
    method: string;
    params?: Record<string, unknown>;
}

export type JsonRpcResponse =
    | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
    | {
          jsonrpc: "2.0";
          id: JsonRpcId;
          error: { code: number; message: string };
      };

export const LEARN_MCP_TOOLS = [
    {
        name: "find_entities",
        description:
            "Find the people, organizations, projects, products, terms and other things the knowledge base knows that a word or phrase from the transcript may name, best first, with why each matched.",
        inputSchema: {
            type: "object",
            properties: {
                text: {
                    type: "string",
                    description: "The words as written in the transcript.",
                },
                type: {
                    type: "string",
                    description:
                        "Optional: `person`, or an entity type key, to narrow the search.",
                },
            },
            required: ["text"],
            additionalProperties: false,
        },
    },
    {
        name: "get_entity",
        description:
            "One person or thing the knowledge base knows, by id: its name, type, description and other names.",
        inputSchema: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
            additionalProperties: false,
        },
    },
    {
        name: "find_facts",
        description:
            "The current facts the knowledge base holds about one person or thing, by id.",
        inputSchema: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
            additionalProperties: false,
        },
    },
] as const;

/** An id JSON-RPC allows, short enough to echo back. */
function isId(value: unknown): boolean {
    return (
        value === undefined ||
        value === null ||
        (typeof value === "number" && Number.isSafeInteger(value)) ||
        (typeof value === "string" && value.length <= MAX_ID_LENGTH)
    );
}

function isRequest(value: unknown): value is JsonRpcRequest {
    return (
        typeof value === "object" &&
        value !== null &&
        (value as { jsonrpc?: unknown }).jsonrpc === "2.0" &&
        typeof (value as { method?: unknown }).method === "string" &&
        isId((value as { id?: unknown }).id)
    );
}

/**
 * The request's JSON body, read no further than `MCP_MAX_BODY_BYTES`
 * whatever its length header says; `tooLarge` past that, and `undefined`
 * for a body that is not JSON.
 */
export async function readMcpBody(
    request: Request,
): Promise<{ tooLarge: true } | { tooLarge: false; body: unknown }> {
    const declared = Number(request.headers.get("content-length"));
    if (declared > MCP_MAX_BODY_BYTES) return { tooLarge: true };
    if (!request.body) return { tooLarge: false, body: undefined };
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MCP_MAX_BODY_BYTES) {
            await reader.cancel().catch(() => {});
            return { tooLarge: true };
        }
        chunks.push(value);
    }
    try {
        return {
            tooLarge: false,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        };
    } catch {
        return { tooLarge: false, body: undefined };
    }
}

/** Spend one lookup of the run's, atomically; false when none is left. */
async function spendLookup(runId: string): Promise<boolean> {
    const spent = await db
        .update(learnRuns)
        .set({
            stats: sql`coalesce(${learnRuns.stats}, '{}'::jsonb) || jsonb_build_object('tool_calls', coalesce((${learnRuns.stats}->>'tool_calls')::int, 0) + 1)`,
            updatedAt: new Date(),
        })
        .where(
            and(
                eq(learnRuns.id, runId),
                eq(learnRuns.status, "running"),
                sql`coalesce((${learnRuns.stats}->>'tool_calls')::int, 0) < ${MCP_TOOL_BUDGET}`,
            ),
        )
        .returning({ id: learnRuns.id });
    return spent.length > 0;
}

function text(value: unknown, isError = false) {
    return {
        content: [{ type: "text", text: JSON.stringify(value) }],
        ...(isError ? { isError: true } : {}),
    };
}

function stringArg(
    args: Record<string, unknown>,
    name: string,
): string | undefined {
    const value = args[name];
    return typeof value === "string" && value.length <= 200 ? value : undefined;
}

/**
 * Answer one JSON-RPC message for `run`; null for a notification, which
 * gets no answer.
 */
export async function handleLearnMcp(
    message: unknown,
    run: McpRun,
): Promise<JsonRpcResponse | null> {
    if (!isRequest(message)) {
        return {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32600, message: "Invalid request" },
        };
    }
    const id = message.id ?? null;
    if (message.id === undefined) return null;
    const answer = (result: unknown): JsonRpcResponse => ({
        jsonrpc: "2.0",
        id,
        result,
    });
    const fail = (code: number, errorMessage: string): JsonRpcResponse => ({
        jsonrpc: "2.0",
        id,
        error: { code, message: errorMessage },
    });

    switch (message.method) {
        case "initialize":
            return answer({
                protocolVersion: PROTOCOL_VERSION,
                capabilities: { tools: {} },
                serverInfo: { name: "riffado-learn", version: "1" },
            });
        case "ping":
            return answer({});
        case "tools/list":
            return answer({ tools: LEARN_MCP_TOOLS });
        case "tools/call": {
            const params = message.params ?? {};
            const name = params.name;
            const args =
                typeof params.arguments === "object" &&
                params.arguments !== null
                    ? (params.arguments as Record<string, unknown>)
                    : {};
            if (!LEARN_MCP_TOOLS.some((tool) => tool.name === name)) {
                return fail(-32602, "Unknown tool");
            }
            const needed = name === "find_entities" ? "text" : "id";
            const value = stringArg(args, needed);
            if (!value) return fail(-32602, `Missing or invalid "${needed}"`);
            if (!(await spendLookup(run.id))) {
                return answer(
                    text({ error: "This run has used all its lookups" }, true),
                );
            }
            // The run's scopes; the lookup was counted above.
            const context: LearnToolContext = {
                read: {
                    kind: "recording",
                    ownerUserId: run.userId,
                    shared: run.view === "org",
                },
                budget: { remaining: 1 },
            };
            if (name === "find_entities") {
                return answer(
                    text(
                        await findEntities(context, {
                            text: value,
                            type: stringArg(args, "type"),
                        }),
                    ),
                );
            }
            if (name === "get_entity") {
                return answer(text(await getEntity(context, value)));
            }
            return answer(text(await findFacts(context, value)));
        }
        default:
            return fail(-32601, "Method not found");
    }
}
