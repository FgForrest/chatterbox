import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    itemScopeAlmanacUsage: vi.fn(),
    findEntities: vi.fn(),
}));

vi.mock("@/db", () => ({
    db: {
        update: vi.fn(() => ({
            set: vi.fn(() => ({
                where: vi.fn(() => ({
                    returning: vi.fn(async () => [{ id: "run-1" }]),
                })),
            })),
        })),
    },
}));
vi.mock("@/lib/folders/item-scope", () => ({
    itemScopeAlmanacUsage: mocks.itemScopeAlmanacUsage,
}));
vi.mock("@/lib/learn/tools", () => ({
    findEntities: mocks.findEntities,
    findFacts: vi.fn(),
    getEntity: vi.fn(),
}));

import { handleLearnMcp } from "@/lib/learn/mcp";

const run = {
    id: "run-1",
    kind: "learn" as const,
    userId: "user-1",
    itemId: "item-1",
    view: "private" as const,
};

function find(id: number, text: string) {
    return handleLearnMcp(
        {
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name: "find_entities", arguments: { text } },
        },
        run,
    );
}

describe("Learn MCP scope usage", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.itemScopeAlmanacUsage.mockResolvedValue([
            { id: "entity-1", count: 2 },
        ]);
        mocks.findEntities.mockResolvedValue({ entities: [] });
    });

    it("computes folder scope usage once per run", async () => {
        await find(1, "Orion");
        await find(2, "Orijon");

        expect(mocks.itemScopeAlmanacUsage).toHaveBeenCalledOnce();
        expect(mocks.findEntities).toHaveBeenCalledTimes(2);
    });
});
