import { beforeEach, expect, it, vi } from "vitest";
import { POST } from "@/app/api/mcp/learn/route";
import { learnRuns, transcriptCorrectionPasses } from "@/db/schema";
import { findEntities } from "@/lib/learn/tools";

const mocks = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock("@/db", () => ({
    db: {
        select: mocks.select,
        update: () => ({
            set: () => ({
                where: () => ({ returning: async () => [{ id: "run" }] }),
            }),
        }),
    },
}));
vi.mock("@/lib/learn/run-token", () => ({
    verifyLearnRunToken: (token: string) => (token === "learn" ? "run" : null),
    verifyCorrectionPassToken: (token: string) =>
        token === "correction" ? "run" : null,
}));
vi.mock("@/lib/recordings/read-language", () => ({
    readConfirmedLanguage: async () => null,
}));
vi.mock("@/lib/folders/item-scope", () => ({
    itemScopeAlmanacUsage: async () => [],
}));
vi.mock("@/lib/learn/tools", () => ({
    findEntities: vi.fn(async () => ({ byMeaning: false, entities: [] })),
    getEntity: vi.fn(),
    findFacts: vi.fn(),
}));

beforeEach(() => {
    vi.clearAllMocks();
    const query = {
        from: vi.fn(),
        innerJoin: vi.fn(),
        where: vi.fn(),
        limit: async () => [
            {
                id: "run",
                itemId: "item",
                userId: "owner",
                actorUserId: "actor",
                view: "org",
                language: "en",
            },
        ],
    };
    for (const fn of [query.from, query.innerJoin, query.where])
        fn.mockReturnValue(query);
    mocks.select.mockReturnValue(query);
});

it.each([
    "learn",
    "correction",
])("threads the %s actor from its stored run through the MCP lookup", async (kind) => {
    const response = await POST(
        new Request("https://example.com/api/mcp/learn", {
            method: "POST",
            headers: {
                authorization: `Bearer ${kind}`,
                "content-type": "application/json",
            },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: {
                    name: "find_entities",
                    arguments: { text: "example" },
                },
            }),
        }),
    );
    expect(response.status).toBe(200);
    expect(mocks.select).toHaveBeenCalledWith(
        expect.objectContaining({
            actorUserId:
                kind === "learn"
                    ? learnRuns.actorUserId
                    : transcriptCorrectionPasses.actorUserId,
        }),
    );
    expect(findEntities).toHaveBeenCalledWith(
        expect.objectContaining({
            read: {
                kind: "recording",
                ownerUserId: "owner",
                actorUserId: "actor",
                shared: true,
            },
        }),
        { text: "example", type: undefined },
    );
});
