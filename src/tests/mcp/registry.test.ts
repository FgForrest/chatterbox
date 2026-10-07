import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { record, capture } = vi.hoisted(() => ({
    record: vi.fn(),
    capture: vi.fn(),
}));

vi.mock("@/lib/mcp/audit", () => ({ recordMcpAccess: record }));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: capture }));

import type { McpCaller } from "@/lib/mcp/caller";
import { McpToolError, notFound } from "@/lib/mcp/errors";
import {
    allowedTools,
    buildMcpServer,
    defineTool,
    type McpToolDef,
} from "@/lib/mcp/registry";
import type { McpRole } from "@/lib/mcp/roles";

const IP = "203.0.113.7";

function userCaller(roles: McpRole[]): McpCaller {
    return {
        kind: "user",
        userId: "user-alice",
        email: "alice@example.test",
        subject: "alice-sub",
        clientId: "claude",
        roles: new Set(roles),
        orgUserId: "user-org",
    };
}

const readOnly = { readOnlyHint: true };

const runEcho = vi.fn();
const runTasks = vi.fn();

const echo = defineTool({
    name: "echo_note",
    anyOf: ["knowledge:read"],
    title: "Echo",
    description: "Echoes its text.",
    annotations: readOnly,
    input: { text: z.string(), entity: z.string().optional() },
    hideInput: (caller) =>
        caller.roles.has("transcripts:read") ? [] : ["entity"],
    output: { echo: z.string(), entity: z.string().nullable() },
    run: async (context, args) => {
        runEcho(args);
        context.touched.push("e1", "e2", "e1");
        return { echo: args.text, entity: args.entity ?? null };
    },
});

const tasks = defineTool({
    name: "peek_tasks",
    anyOf: ["tasks:read"],
    title: "Peek",
    description: "Peeks at tasks.",
    annotations: readOnly,
    input: {},
    output: { count: z.number() },
    run: async () => {
        runTasks();
        return { count: 1 };
    },
});

function failing(name: string, error: () => Error): McpToolDef {
    return defineTool({
        name,
        anyOf: ["knowledge:read"],
        title: name,
        description: name,
        annotations: readOnly,
        input: {},
        output: { ok: z.boolean() },
        run: async (context) => {
            context.touched.push("x1");
            throw error();
        },
    });
}

const leaky = defineTool({
    name: "leaky",
    anyOf: ["knowledge:read"],
    title: "Leaky",
    description: "Returns more than it declares.",
    annotations: readOnly,
    input: {},
    output: { name: z.string() },
    run: async () => ({ name: "Orion", secret: "hidden text" }),
});

const wrongShape: McpToolDef = {
    name: "wrong_shape",
    anyOf: ["knowledge:read"],
    title: "Wrong",
    description: "Breaks its own output schema.",
    annotations: readOnly,
    input: () => ({}),
    output: { count: z.number() },
    run: async () => ({ count: "secret detail" }),
};

const TOOLS: McpToolDef[] = [
    echo,
    tasks,
    failing(
        "ambiguous",
        () =>
            new McpToolError("Ambiguous name", "invalid", {
                candidates: [{ id: "p1", name: "Orion" }],
            }),
    ),
    failing("missing", notFound),
    failing("boom", () => new Error("secret detail")),
    leaky,
    wrongShape,
];

async function connect(caller: McpCaller, tools: McpToolDef[] = TOOLS) {
    const server = buildMcpServer(tools, caller, IP);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(clientSide);
    return {
        client,
        close: async () => {
            await client.close();
            await server.close();
        },
    };
}

function textOf(result: CallToolResult): string {
    const [first] = result.content;
    return first?.type === "text" ? first.text : "";
}

describe("allowedTools", () => {
    it("keeps the tools any of whose roles the caller holds", () => {
        expect(
            allowedTools(TOOLS, userCaller(["tasks:read"])).map((t) => t.name),
        ).toEqual(["peek_tasks"]);
        expect(allowedTools(TOOLS, userCaller(["summaries:read"]))).toEqual([]);
    });
});

describe("buildMcpServer", () => {
    let session: Awaited<ReturnType<typeof connect>> | null = null;

    beforeEach(() => {
        record.mockReset().mockResolvedValue(undefined);
        runEcho.mockReset();
        runTasks.mockReset();
    });

    afterEach(async () => {
        await session?.close();
        session = null;
    });

    it("lists only the caller's tools, with their schemas", async () => {
        session = await connect(userCaller(["tasks:read"]));
        const { tools } = await session.client.listTools();
        expect(tools.map((tool) => tool.name)).toEqual(["peek_tasks"]);
        expect(tools[0]).toMatchObject({
            title: "Peek",
            description: "Peeks at tasks.",
            annotations: { readOnlyHint: true },
            inputSchema: { type: "object" },
            outputSchema: {
                type: "object",
                properties: { count: { type: "number" } },
            },
        });
    });

    it("shapes the arguments to the caller's roles", async () => {
        session = await connect(userCaller(["knowledge:read"]));
        const [listed] = (await session.client.listTools()).tools;
        expect(Object.keys(listed?.inputSchema.properties ?? {})).toEqual([
            "text",
        ]);
        await session.client.callTool({
            name: "echo_note",
            arguments: { text: "hi", entity: "smuggled" },
        });
        expect(runEcho).toHaveBeenCalledWith({ text: "hi" });

        await session.close();
        session = await connect(
            userCaller(["knowledge:read", "transcripts:read"]),
        );
        const [wide] = (await session.client.listTools()).tools;
        expect(Object.keys(wide?.inputSchema.properties ?? {})).toEqual([
            "text",
            "entity",
        ]);
    });

    it("answers a call with structured content and audits it once", async () => {
        session = await connect(userCaller(["knowledge:read"]));
        const result = (await session.client.callTool({
            name: "echo_note",
            arguments: { text: "hello" },
        })) as CallToolResult;
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toEqual({
            echo: "hello",
            entity: null,
        });
        expect(JSON.parse(textOf(result))).toEqual(result.structuredContent);
        expect(record).toHaveBeenCalledTimes(1);
        expect(record).toHaveBeenCalledWith({
            caller: expect.objectContaining({ subject: "alice-sub" }),
            tool: "echo_note",
            outcome: "ok",
            targetIds: ["e1", "e2", "e1"],
            ip: IP,
        });
    });

    it("drops output fields the schema does not declare", async () => {
        session = await connect(userCaller(["knowledge:read"]));
        const result = (await session.client.callTool({
            name: "leaky",
            arguments: {},
        })) as CallToolResult;
        expect(result.structuredContent).toEqual({ name: "Orion" });
        expect(textOf(result)).not.toContain("hidden text");
    });

    it("treats a tool outside the caller's roles as unknown", async () => {
        session = await connect(userCaller(["knowledge:read"]));
        const hidden = (await session.client.callTool({
            name: "peek_tasks",
            arguments: {},
        })) as CallToolResult;
        const unknown = (await session.client.callTool({
            name: "no_such_tool",
            arguments: {},
        })) as CallToolResult;
        expect(hidden).toEqual(unknown);
        expect(hidden.isError).toBe(true);
        expect(JSON.parse(textOf(hidden))).toEqual({ error: "Unknown tool" });
        expect(runTasks).not.toHaveBeenCalled();
        expect(record).toHaveBeenCalledTimes(2);
        expect(record).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ tool: "peek_tasks", outcome: "denied" }),
        );
        expect(record).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ tool: null, outcome: "invalid" }),
        );
    });

    it("lists nothing and runs nothing for a caller without tools", async () => {
        session = await connect(userCaller(["summaries:read"]));
        await expect(session.client.listTools()).resolves.toEqual({
            tools: [],
        });
        const result = (await session.client.callTool({
            name: "peek_tasks",
            arguments: {},
        })) as CallToolResult;
        expect(JSON.parse(textOf(result))).toEqual({ error: "Unknown tool" });
        expect(runTasks).not.toHaveBeenCalled();
    });

    it("refuses invalid arguments without running the tool", async () => {
        session = await connect(userCaller(["knowledge:read"]));
        const result = (await session.client.callTool({
            name: "echo_note",
            arguments: { text: 42 },
        })) as CallToolResult;
        expect(result.isError).toBe(true);
        expect(JSON.parse(textOf(result))).toEqual({
            error: "Invalid arguments",
            details: [{ path: "text", message: expect.any(String) }],
        });
        expect(runEcho).not.toHaveBeenCalled();
        expect(record).toHaveBeenCalledWith(
            expect.objectContaining({ tool: "echo_note", outcome: "invalid" }),
        );
    });

    it("passes a tool's own error and details through", async () => {
        session = await connect(userCaller(["knowledge:read"]));
        const result = (await session.client.callTool({
            name: "ambiguous",
            arguments: {},
        })) as CallToolResult;
        expect(result.isError).toBe(true);
        expect(JSON.parse(textOf(result))).toEqual({
            error: "Ambiguous name",
            details: { candidates: [{ id: "p1", name: "Orion" }] },
        });
        expect(record).toHaveBeenCalledTimes(1);
        expect(record).toHaveBeenCalledWith(
            expect.objectContaining({
                tool: "ambiguous",
                outcome: "invalid",
                targetIds: ["x1"],
            }),
        );

        const missing = (await session.client.callTool({
            name: "missing",
            arguments: {},
        })) as CallToolResult;
        expect(JSON.parse(textOf(missing))).toEqual({ error: "Not found" });
        expect(record).toHaveBeenLastCalledWith(
            expect.objectContaining({ outcome: "not_found" }),
        );
    });

    it("hides an unexpected failure behind a fixed message", async () => {
        const logged = vi.spyOn(console, "error").mockImplementation(() => {});
        session = await connect(userCaller(["knowledge:read"]));
        for (const name of ["boom", "wrong_shape"]) {
            const result = (await session.client.callTool({
                name,
                arguments: {},
            })) as CallToolResult;
            expect(result.isError).toBe(true);
            expect(JSON.parse(textOf(result))).toEqual({
                error: "Internal error",
            });
            expect(JSON.stringify(result)).not.toContain("secret detail");
            expect(record).toHaveBeenLastCalledWith(
                expect.objectContaining({ tool: name, outcome: "error" }),
            );
        }
        expect(record).toHaveBeenCalledTimes(2);
        expect(logged).toHaveBeenCalled();
        expect(capture).toHaveBeenCalledTimes(2);
        expect(String(capture.mock.calls[1]?.[0])).not.toContain(
            "secret detail",
        );
        logged.mockRestore();
    });
});
