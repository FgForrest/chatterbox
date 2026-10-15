import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import {
    chatterItems,
    mailPendingShares,
    recordingFolderAssignments,
    recordingFolders,
    recordingTasks,
    taskMentions,
    taskVectors,
    users,
} from "@/db/schema";
import { encryptText } from "@/lib/encryption/fields";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import type { TaskViewer } from "@/lib/tasks/access";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef, embeddingClientMock } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    return {
        dbRef: ref,
        embeddingClientMock: vi.fn(),
        dbProxy: new Proxy(
            {},
            {
                get: (_target, property: string | symbol) => {
                    if (!ref.current)
                        throw new Error("test database not ready");
                    const value = ref.current[property];
                    return typeof value === "function"
                        ? value.bind(ref.current)
                        : value;
                },
            },
        ),
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({
    env: {
        IS_HOSTED: false,
        EMBEDDING_BASE_URL: undefined,
        EMBEDDING_MODEL: "test-embedding",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        BETTER_AUTH_SECRET: "task-candidates-test-secret",
        DATABASE_URL: "postgres://unused",
    },
}));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: async () => "candidate-org",
}));
vi.mock("@/lib/knowledge/embeddings", () => ({
    embeddingClient: embeddingClientMock,
}));

import { loadTasksPromptContext } from "@/lib/tasks/proposals";
import { TASK_CANDIDATE_LIMIT } from "@/lib/tasks/ranking";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const OWNER = "candidate-owner";
const OTHER = "candidate-other";
const ORG = "candidate-org";
const TARGET = "candidate-target";

const reviewer: TaskViewer = {
    userId: OWNER,
    emailHash: lookupHash("owner@example.test"),
    isOrg: false,
    orgUserId: ORG,
};

describeWithDatabase("task candidates in an item's folder scope", () => {
    let database: TestPostgresDatabase | null = null;

    function db() {
        if (!database) throw new Error("test database not ready");
        return database.db;
    }

    async function folder(
        id: string,
        userId: string,
        parentId: string | null,
        kind: "private" | "public" | "custom" = "custom",
    ) {
        await db()
            .insert(recordingFolders)
            .values({
                id,
                userId,
                parentId,
                name: encryptText(id),
                nameHash: lookupHash(id),
                kind,
            });
    }

    async function item(id: string, userId: string, kind: "audio" | "mail") {
        await db()
            .insert(chatterItems)
            .values({
                id,
                userId,
                kind,
                title: encryptText(id),
                occurredAt: new Date("2026-10-01T00:00:00.000Z"),
            });
    }

    async function candidate(input: {
        id: string;
        itemId: string;
        userId: string;
        text: string;
        view: "private" | "org";
        decision?: "home" | "accepted" | "suggested";
        statementAt?: Date;
    }) {
        await db()
            .insert(recordingTasks)
            .values({
                id: input.id,
                itemId: input.itemId,
                userId: input.userId,
                status: "open",
                text: encryptText(input.text),
                source: "manual",
            });
        await db()
            .insert(taskMentions)
            .values({
                id: `${input.id}-mention`,
                taskId: input.id,
                itemId: input.itemId,
                userId: input.userId,
                view: input.view,
                statementAt:
                    input.statementAt ?? new Date("2026-10-01T00:00:00.000Z"),
                matchDecision: input.decision ?? "home",
            });
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "task_candidates",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        embeddingClientMock.mockReset();
        embeddingClientMock.mockReturnValue(null);
        await db().delete(users);
        await db()
            .insert(users)
            .values([
                { id: OWNER, email: "owner@example.test" },
                { id: OTHER, email: "other@example.test" },
                { id: ORG, email: "org@example.test", role: "org" },
            ]);
        await item(TARGET, OWNER, "mail");

        await folder("private-root", OWNER, null, "private");
        await folder("private-a", OWNER, "private-root");
        await folder("private-a-child", OWNER, "private-a");
        await folder("private-b", OWNER, "private-root");
        await folder("private-b-child", OWNER, "private-b");
        await folder("private-outside", OWNER, "private-root");
        await folder("org-root", ORG, null, "public");
        await folder("org-team", ORG, "org-root");
        await folder("org-team-child", ORG, "org-team");

        await db()
            .insert(recordingFolderAssignments)
            .values([
                { itemId: TARGET, userId: OWNER, folderId: "private-a" },
                { itemId: TARGET, userId: OWNER, folderId: "private-b" },
            ]);
        await db().insert(mailPendingShares).values({
            itemId: TARGET,
            userId: OWNER,
            folderId: "org-team",
        });
    });

    it("uses the scope union and descendants, includes intended Organization tasks, and respects mention visibility", async () => {
        const sources = [
            ["source-a", OWNER, "mail", "private-a-child"],
            ["source-b", OWNER, "audio", "private-b-child"],
            ["source-out", OWNER, "mail", "private-outside"],
            ["source-root", OWNER, "mail", "private-root"],
            ["source-org", OTHER, "audio", "org-team-child"],
            ["source-other-private", OTHER, "mail", "private-a-child"],
            ["source-suggested", OWNER, "mail", "private-a-child"],
        ] as const;
        for (const [id, userId, kind, folderId] of sources) {
            await item(id, userId, kind);
            await db().insert(recordingFolderAssignments).values({
                itemId: id,
                userId,
                folderId,
            });
        }
        await candidate({
            id: "task-a",
            itemId: "source-a",
            userId: OWNER,
            text: "Prepare launch brief",
            view: "private",
        });
        await candidate({
            id: "task-b",
            itemId: "source-b",
            userId: OWNER,
            text: "Review launch budget",
            view: "private",
        });
        await candidate({
            id: "task-out",
            itemId: "source-out",
            userId: OWNER,
            text: "Outside task",
            view: "private",
        });
        await candidate({
            id: "task-root",
            itemId: "source-root",
            userId: OWNER,
            text: "Root task",
            view: "private",
        });
        await candidate({
            id: "task-org",
            itemId: "source-org",
            userId: OTHER,
            text: "Organization launch task",
            view: "org",
        });
        await candidate({
            id: "task-other-private",
            itemId: "source-other-private",
            userId: OTHER,
            text: "Other user's private task",
            view: "private",
        });
        await candidate({
            id: "task-suggested",
            itemId: "source-suggested",
            userId: OWNER,
            text: "Unaccepted match",
            view: "private",
            decision: "suggested",
        });

        const context = await loadTasksPromptContext({
            recording: {
                id: TARGET,
                userId: OWNER,
                occurredAt: new Date("2026-10-15T10:00:00.000Z"),
                timezone: null,
                zonemins: null,
            },
            transcriptionId: null,
            orgView: false,
            reviewer,
            noun: "mail",
            itemText: "The launch brief and budget need review.",
        });
        const ids = [...context.refs.values()];

        expect(ids).toEqual(
            expect.arrayContaining(["task-a", "task-b", "task-org"]),
        );
        expect(ids).not.toEqual(
            expect.arrayContaining([
                "task-out",
                "task-root",
                "task-other-private",
                "task-suggested",
            ]),
        );
        expect(context.text).toContain("Organization launch task");
        expect(context.text).not.toContain("Other user's private task");
    });

    it("computes a missing current-generation task vector lazily and reuses it", async () => {
        await item("source-vector", OWNER, "mail");
        await db().insert(recordingFolderAssignments).values({
            itemId: "source-vector",
            userId: OWNER,
            folderId: "private-a-child",
        });
        await candidate({
            id: "task-vector",
            itemId: "source-vector",
            userId: OWNER,
            text: "Prepare launch brief",
            view: "private",
        });
        const embed = vi.fn(async (texts: readonly string[]) =>
            texts.map(() => Float32Array.from([1, 0])),
        );
        embeddingClientMock.mockReturnValue({
            model: "candidate-model",
            available: true,
            embed,
        });
        const input = {
            recording: {
                id: TARGET,
                userId: OWNER,
                occurredAt: new Date("2026-10-15T10:00:00.000Z"),
                timezone: null,
                zonemins: null,
            },
            transcriptionId: null,
            orgView: false,
            reviewer,
            noun: "mail" as const,
            itemText: "Discuss the launch brief.",
        };

        await loadTasksPromptContext(input);
        await loadTasksPromptContext(input);

        expect(embed).toHaveBeenCalledTimes(2);
        expect(embed.mock.calls[0]?.[0]).toHaveLength(2);
        expect(embed.mock.calls[1]?.[0]).toHaveLength(1);
        expect(await db().select().from(taskVectors)).toHaveLength(1);
    });

    it("sends exactly the top 40 with a stable order for ties", async () => {
        await item("source-limit", OWNER, "mail");
        await db().insert(recordingFolderAssignments).values({
            itemId: "source-limit",
            userId: OWNER,
            folderId: "private-a-child",
        });
        const ids = Array.from(
            { length: TASK_CANDIDATE_LIMIT + 2 },
            (_, index) => `task-limit-${String(index).padStart(2, "0")}`,
        );
        await db()
            .insert(recordingTasks)
            .values(
                ids.map((id) => ({
                    id,
                    itemId: "source-limit",
                    userId: OWNER,
                    status: "open" as const,
                    text: encryptText("Same candidate text"),
                    source: "manual" as const,
                })),
            );
        await db()
            .insert(taskMentions)
            .values(
                ids.map((taskId) => ({
                    id: `${taskId}-mention`,
                    taskId,
                    itemId: "source-limit",
                    userId: OWNER,
                    view: "private" as const,
                    statementAt: new Date("2026-10-01T00:00:00.000Z"),
                    matchDecision: "home" as const,
                })),
            );

        const context = await loadTasksPromptContext({
            recording: {
                id: TARGET,
                userId: OWNER,
                occurredAt: new Date("2026-10-15T10:00:00.000Z"),
                timezone: null,
                zonemins: null,
            },
            transcriptionId: null,
            orgView: false,
            reviewer,
            noun: "mail",
            itemText: "No overlapping vocabulary",
        });

        expect([...context.refs.values()]).toEqual(
            ids.slice(0, TASK_CANDIDATE_LIMIT),
        );
    });

    it("warns and falls back when the configured embedding service fails", async () => {
        await item("source-fallback", OWNER, "mail");
        await db().insert(recordingFolderAssignments).values({
            itemId: "source-fallback",
            userId: OWNER,
            folderId: "private-a-child",
        });
        await candidate({
            id: "task-fallback",
            itemId: "source-fallback",
            userId: OWNER,
            text: "Prepare launch brief",
            view: "private",
        });
        embeddingClientMock.mockReturnValue({
            model: "candidate-model",
            available: true,
            embed: vi.fn().mockRejectedValue(new Error("offline")),
        });
        const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

        const context = await loadTasksPromptContext({
            recording: {
                id: TARGET,
                userId: OWNER,
                occurredAt: new Date("2026-10-15T10:00:00.000Z"),
                timezone: null,
                zonemins: null,
            },
            transcriptionId: null,
            orgView: false,
            reviewer,
            noun: "mail",
            itemText: "The launch brief needs preparation.",
        });

        expect([...context.refs.values()]).toContain("task-fallback");
        expect(warning).toHaveBeenCalledOnce();
        warning.mockRestore();
    });
});
