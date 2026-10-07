import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@/lib/env", () => ({ env: { IS_HOSTED: false } }));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));
vi.mock("@/db", () => ({ db: {} }));

import type { McpCaller } from "@/lib/mcp/caller";
import { MCP_ROLES } from "@/lib/mcp/roles";
import { ALL_TOOLS } from "@/lib/mcp/tools";

const WRITE_TOOLS = new Set(["update_task"]);

const everything: McpCaller = {
    kind: "user",
    userId: "user-alice",
    email: "alice@example.test",
    subject: "alice-sub",
    clientId: "claude",
    roles: new Set(MCP_ROLES),
    orgUserId: "user-org",
};

describe("the MCP tool registry", () => {
    it("names every tool once, in snake case", () => {
        const names = ALL_TOOLS.map((tool) => tool.name);
        for (const name of names) expect(name).toMatch(/^[a-z_]+$/);
        expect(new Set(names).size).toBe(names.length);
    });

    it.each(
        ALL_TOOLS.map((tool) => [tool.name, tool] as const),
    )("%s needs a known role", (_name, tool) => {
        expect(tool.anyOf.length).toBeGreaterThan(0);
        for (const role of tool.anyOf) expect(MCP_ROLES).toContain(role);
    });

    it.each(
        ALL_TOOLS.map((tool) => [tool.name, tool] as const),
    )("%s is described and marked read-only unless it writes", (name, tool) => {
        expect(tool.title.trim()).not.toBe("");
        expect(tool.description.trim()).not.toBe("");
        expect(tool.annotations.readOnlyHint).toBe(!WRITE_TOOLS.has(name));
    });

    it.each(
        ALL_TOOLS.map((tool) => [tool.name, tool] as const),
    )("%s has schemas a client can read", (_name, tool) => {
        expect(() =>
            z.toJSONSchema(z.object(tool.input(everything)), { io: "input" }),
        ).not.toThrow();
        expect(() =>
            z.toJSONSchema(z.object(tool.output), { io: "output" }),
        ).not.toThrow();
    });

    it.each(
        ALL_TOOLS.filter((tool) => WRITE_TOOLS.has(tool.name)).map(
            (tool) => [tool.name, tool] as const,
        ),
    )("%s writes only with tasks:write", (_name, tool) => {
        expect(tool.anyOf).toEqual(["tasks:write"]);
        expect(tool.annotations.destructiveHint).toBe(false);
    });
});
