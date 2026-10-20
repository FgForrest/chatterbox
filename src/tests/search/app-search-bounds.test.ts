import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    list: vi.fn(),
    knowledge: vi.fn(),
    rows: vi.fn(),
    items: vi.fn(),
}));
vi.mock("@/db", () => ({
    db: {
        select: () => ({
            from: () => ({
                where: () => ({ orderBy: () => ({ limit: mocks.rows }) }),
            }),
        }),
    },
}));
vi.mock("@/lib/tasks/tasks", () => ({ listCallerTasks: mocks.list }));
vi.mock("@/lib/knowledge/knowledge-loader", () => ({
    knowledgeView: mocks.knowledge,
}));
vi.mock("@/lib/knowledge/vocabulary", () => ({
    vocabularyVisibleTo: async () => ({ entityTypes: [] }),
}));
vi.mock("@/lib/org/config", () => ({ getOrgUserId: async () => null }));
vi.mock("@/lib/mail/redact", () => ({ secretAddressMasker: vi.fn() }));
vi.mock("@/lib/encryption/fields", () => ({
    decryptText: (text: string) => text,
}));
vi.mock("@/lib/search/item-search", () => ({
    foldForSearch: (text: string) => text.toLowerCase(),
    searchItems: mocks.items,
}));

import { searchApp, searchTasks } from "@/lib/search/app-search";
import type { TaskViewer } from "@/lib/tasks/access";

const viewer: TaskViewer = {
    userId: "alice",
    orgUserId: null,
    emailHash: "hash",
    isOrg: false,
    isCurator: false,
};
const tasks = Array.from({ length: 100 }, (_, index) => ({
    id: `task-${index}`,
    text: "Matching task",
    dueDate: null,
    createdAt: "2026-10-19T12:00:00Z",
    recording: { id: "source", title: "Recording", view: "private" },
}));

beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue(tasks);
    mocks.rows.mockResolvedValue(
        Array.from({ length: 51 }, (_, index) => ({
            id: `item-${index}`,
            userId: "alice",
            title: "Matching item",
            kind: "audio",
        })),
    );
    mocks.knowledge.mockResolvedValue({
        items: Array.from({ length: 51 }, (_, index) => ({
            id: `person-${index}`,
            kind: "person",
            name: "Matching person",
            typeKey: "person",
            scope: "personal",
            description: null,
            names: [],
        })),
    });
    mocks.items.mockResolvedValue({
        hits: [{ id: "item-0", snippet: null }],
        complete: false,
    });
});
afterEach(() => vi.restoreAllMocks());

describe("app search bounds", () => {
    it("stops task pagination at the deadline even without matches", async () => {
        let now = 0;
        vi.spyOn(Date, "now").mockImplementation(() => now);
        mocks.list.mockImplementation(async () => {
            now += 3000;
            return tasks;
        });
        const result = await searchTasks(viewer, "unmatched");
        expect(result).toEqual({ hits: [], limited: true });
        expect(mocks.list).toHaveBeenCalledTimes(2);
    });
    it("stops an aborted task scan before the next query", async () => {
        const controller = new AbortController();
        mocks.list.mockImplementation(async () => {
            controller.abort();
            return tasks;
        });
        await expect(
            searchTasks(viewer, "unmatched", controller.signal),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(mocks.list).toHaveBeenCalledOnce();
    });
    it("does no work for an already aborted search", async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(
            searchApp(viewer, "all", "Matching", controller.signal),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(mocks.list).not.toHaveBeenCalled();
        expect(mocks.rows).not.toHaveBeenCalled();
        expect(mocks.knowledge).not.toHaveBeenCalled();
    });
    it.each([
        "chatter",
        "almanac",
        "tasks",
    ] as const)("reports limits only after typing in %s", async (scope) => {
        const recent = await searchApp(viewer, scope, "");
        expect(recent[scope]).toHaveLength(50);
        expect(recent.limited).toBe(false);
        expect((await searchApp(viewer, scope, "Matching")).limited).toBe(true);
    });
});
