import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
    CallToolRequestSchema,
    type CallToolResult,
    ErrorCode,
    ListToolsRequestSchema,
    McpError,
    type Tool,
    type ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { type McpOutcome, recordMcpAccess } from "@/lib/mcp/audit";
import type { McpCaller } from "@/lib/mcp/caller";
import { McpToolError } from "@/lib/mcp/errors";
import type { McpRole } from "@/lib/mcp/roles";
import { captureServerException } from "@/lib/posthog-server";

/** What a tool's `run` gets besides its arguments. */
export interface ToolContext {
    caller: McpCaller;
    /** Ids this call read or changed, for the access log. */
    touched: string[];
}

/** One tool of the external MCP server. */
export interface McpToolDef {
    /** Snake-case name, unique in the registry. */
    name: string;
    /** The tool exists for a caller holding any of these roles. */
    anyOf: readonly McpRole[];
    title: string;
    description: string;
    annotations: ToolAnnotations;
    /** The arguments this caller may pass; anything else is dropped. */
    input: (caller: McpCaller) => z.ZodRawShape;
    /** The structured result; undeclared fields are dropped. */
    output: z.ZodRawShape;
    /**
     * Runs one call with validated arguments. Throw {@link McpToolError}
     * for a failure the caller may see; any other error reaches the caller
     * as "Internal error" only.
     */
    run: (
        context: ToolContext,
        args: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
}

/** A tool definition with typed arguments and result; see {@link defineTool}. */
export interface McpToolSpec<
    Input extends z.ZodRawShape,
    Output extends z.ZodRawShape,
> extends Omit<McpToolDef, "input" | "output" | "run"> {
    /** Every argument the tool knows. */
    input: Input;
    /**
     * Arguments this caller may not pass (they depend on roles). They are
     * left out of the caller's schema and dropped from a call, so they must
     * be optional in `input`.
     */
    hideInput?: (caller: McpCaller) => readonly (keyof Input & string)[];
    output: Output;
    run: (
        context: ToolContext,
        args: z.output<z.ZodObject<Input>>,
    ) => Promise<z.input<z.ZodObject<Output>>>;
}

/** An {@link McpToolDef} from a spec whose arguments and result are typed. */
export function defineTool<
    Input extends z.ZodRawShape,
    Output extends z.ZodRawShape,
>(spec: McpToolSpec<Input, Output>): McpToolDef {
    const { hideInput, input, run, ...rest } = spec;
    return {
        ...rest,
        input: (caller) => {
            const hidden = new Set<string>(hideInput?.(caller) ?? []);
            return Object.fromEntries(
                Object.entries(input).filter(([key]) => !hidden.has(key)),
            );
        },
        run: (context, args) =>
            run(context, args as z.output<z.ZodObject<Input>>),
    };
}

/** The tools a caller may see, in registry order. */
export function allowedTools(
    tools: readonly McpToolDef[],
    caller: McpCaller,
): McpToolDef[] {
    return tools.filter((tool) =>
        tool.anyOf.some((role) => caller.roles.has(role)),
    );
}

const UNKNOWN_TOOL = "Unknown tool";
const INTERNAL_ERROR = "Internal error";

function success(value: Record<string, unknown>): CallToolResult {
    return {
        content: [{ type: "text", text: JSON.stringify(value) }],
        structuredContent: value,
    };
}

function failure(error: McpToolError): CallToolResult {
    const body =
        error.details === undefined
            ? { error: error.message }
            : { error: error.message, details: error.details };
    return {
        content: [{ type: "text", text: JSON.stringify(body) }],
        isError: true,
    };
}

function issuesOf(error: z.ZodError): { path: string; message: string }[] {
    return error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
    }));
}

function listing(tool: McpToolDef, caller: McpCaller): Tool {
    return {
        name: tool.name,
        title: tool.title,
        description: tool.description,
        annotations: tool.annotations,
        inputSchema: z.toJSONSchema(z.object(tool.input(caller)), {
            target: "draft-7",
            io: "input",
        }) as Tool["inputSchema"],
        outputSchema: z.toJSONSchema(z.object(tool.output), {
            target: "draft-7",
            io: "output",
        }) as Tool["outputSchema"],
    };
}

async function callTool(
    tool: McpToolDef,
    caller: McpCaller,
    ip: string | null,
    rawArgs: unknown,
): Promise<CallToolResult> {
    const context: ToolContext = { caller, touched: [] };
    const audit = (outcome: McpOutcome) =>
        recordMcpAccess({
            caller,
            tool: tool.name,
            outcome,
            targetIds: context.touched,
            ip,
        });
    const internal = async (error: unknown) => {
        await audit("error");
        console.error("[mcp] tool failed", {
            tool: tool.name,
            callerKind: caller.kind,
            clientId: caller.clientId,
            error: error instanceof Error ? error.message : String(error),
        });
        captureServerException(error, {
            source: "mcp:tool",
            tool: tool.name,
            callerKind: caller.kind,
            clientId: caller.clientId,
        });
        return failure(new McpToolError(INTERNAL_ERROR, "error"));
    };

    const args = z.object(tool.input(caller)).safeParse(rawArgs ?? {});
    if (!args.success) {
        await audit("invalid");
        return failure(
            new McpToolError(
                "Invalid arguments",
                "invalid",
                issuesOf(args.error),
            ),
        );
    }
    let value: Record<string, unknown>;
    try {
        value = await tool.run(context, args.data);
    } catch (error) {
        if (!(error instanceof McpToolError)) return internal(error);
        await audit(error.outcome);
        return failure(error);
    }
    const output = z.object(tool.output).safeParse(value);
    if (!output.success) {
        return internal(
            new Error(
                `${tool.name} output outside its schema at ${issuesOf(
                    output.error,
                )
                    .map((issue) => issue.path || "(root)")
                    .join(", ")}`,
            ),
        );
    }
    await audit("ok");
    return success(output.data);
}

/**
 * A fresh server for one request with only the caller's tools. Every
 * `tools/call` writes exactly one access-log row: a tool outside the
 * caller's roles answers like a name that does not exist ("Unknown tool").
 */
export function buildMcpServer(
    tools: readonly McpToolDef[],
    caller: McpCaller,
    ip: string | null,
): McpServer {
    const visible = allowedTools(tools, caller);
    const byName = new Map(visible.map((tool) => [tool.name, tool]));
    const known = new Set(tools.map((tool) => tool.name));
    const server = new McpServer(
        { name: "riffado", version: "1" },
        { capabilities: { tools: {} } },
    );
    server.server.setRequestHandler(ListToolsRequestSchema, () => ({
        tools: visible.map((tool) => listing(tool, caller)),
    }));
    server.server.setRequestHandler(
        CallToolRequestSchema,
        async (request): Promise<CallToolResult> => {
            const { name, arguments: args, task } = request.params;
            const tool = byName.get(name);
            if (!tool) {
                await recordMcpAccess({
                    caller,
                    tool: known.has(name) ? name : null,
                    outcome: known.has(name) ? "denied" : "invalid",
                    ip,
                });
                return failure(new McpToolError(UNKNOWN_TOOL));
            }
            if (task) {
                await recordMcpAccess({
                    caller,
                    tool: name,
                    outcome: "invalid",
                    ip,
                });
                throw new McpError(
                    ErrorCode.InvalidParams,
                    "Task-augmented calls are not supported",
                );
            }
            return callTool(tool, caller, ip, args);
        },
    );
    return server;
}
