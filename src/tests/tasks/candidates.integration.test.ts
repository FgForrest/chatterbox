import { eq } from "drizzle-orm";
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { explainScopedTaskCandidatePlan } from "@/db/queries/tasks";
import {
    chatterItems,
    mailContents,
    mailMessages,
    mailPendingShares,
    recordingFolderAssignments,
    recordingFolders,
    recordingTasks,
    taskContentVectors,
    taskMentions,
    taskVectors,
    users,
} from "@/db/schema";
import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
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

import {
    loadTasksPromptContext,
    searchMergeCandidates,
} from "@/lib/tasks/proposals";
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
    isCurator: false,
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

    it("searches the scope with the same visibility and linked-mention rules", async () => {
        const sources = [
            ["search-in", OWNER, "private-a-child"],
            ["search-out", OWNER, "private-outside"],
            ["search-other-private", OTHER, "private-a-child"],
            ["search-other-shared-mention", OTHER, "org-team-child"],
            ["search-suggested", OWNER, "private-a-child"],
        ] as const;
        for (const [id, userId, folderId] of sources) {
            await item(id, userId, "mail");
            await db().insert(recordingFolderAssignments).values({
                itemId: id,
                userId,
                folderId,
            });
        }
        await candidate({
            id: "search-task-in",
            itemId: "search-in",
            userId: OWNER,
            text: "Prepare the quarterly launch brief",
            view: "private",
        });
        await candidate({
            id: "search-task-out",
            itemId: "search-out",
            userId: OWNER,
            text: "Prepare the quarterly launch brief outside",
            view: "private",
        });
        await candidate({
            id: "search-task-other-private",
            itemId: "search-other-private",
            userId: OTHER,
            text: "Prepare the quarterly launch brief privately",
            view: "private",
        });
        await db()
            .insert(taskMentions)
            .values({
                id: "search-task-other-private-shared-mention",
                taskId: "search-task-other-private",
                itemId: "search-other-shared-mention",
                userId: OTHER,
                view: "org",
                statementAt: new Date("2026-10-02T00:00:00.000Z"),
                matchDecision: "accepted",
            });
        await candidate({
            id: "search-task-suggested",
            itemId: "search-suggested",
            userId: OWNER,
            text: "Prepare the quarterly launch brief suggestion",
            view: "private",
            decision: "suggested",
        });

        const result = await searchMergeCandidates(reviewer, TARGET, {
            text: "quarterly launch brief",
            offset: 0,
            limit: 20,
        });

        expect(result.candidates.map((row) => row.id)).toEqual([
            "search-task-in",
        ]);
        expect(result.nextOffset).toBeNull();
    });

    it("finds a matching task outside the summary's top 40 and paginates", async () => {
        await item("search-many-source", OWNER, "mail");
        await db().insert(recordingFolderAssignments).values({
            itemId: "search-many-source",
            userId: OWNER,
            folderId: "private-a-child",
        });
        const ordinaryIds = Array.from(
            { length: TASK_CANDIDATE_LIMIT + 1 },
            (_, index) => `search-many-${String(index).padStart(2, "0")}`,
        );
        for (const id of ordinaryIds) {
            await candidate({
                id,
                itemId: "search-many-source",
                userId: OWNER,
                text: "Routine status follow up",
                view: "private",
            });
        }
        await candidate({
            id: "search-many-exact",
            itemId: "search-many-source",
            userId: OWNER,
            text: "Calibrate the cobalt spectrometer",
            view: "private",
            statementAt: new Date("2026-09-01T00:00:00.000Z"),
        });
        await candidate({
            id: "search-many-second",
            itemId: "search-many-source",
            userId: OWNER,
            text: "Inspect the cobalt spectrometer",
            view: "private",
            statementAt: new Date("2026-08-01T00:00:00.000Z"),
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
            itemText: "Routine status follow up",
        });
        expect([...context.refs.values()]).not.toContain("search-many-exact");

        const first = await searchMergeCandidates(reviewer, TARGET, {
            text: "cobalt spectrometer calibration",
            offset: 0,
            limit: 1,
        });
        const second = await searchMergeCandidates(reviewer, TARGET, {
            text: "cobalt spectrometer calibration",
            offset: first.nextOffset ?? 0,
            limit: 1,
        });

        expect(first.candidates.map((row) => row.id)).toEqual([
            "search-many-exact",
        ]);
        expect(first.nextOffset).toBe(1);
        expect(second.candidates.map((row) => row.id)).toEqual([
            "search-many-second",
        ]);
    });

    it("matches prefixes without diacritics", async () => {
        await item("search-prefix-source", OWNER, "mail");
        await db().insert(recordingFolderAssignments).values({
            itemId: "search-prefix-source",
            userId: OWNER,
            folderId: "private-a-child",
        });
        await candidate({
            id: "search-prefix-task",
            itemId: "search-prefix-source",
            userId: OWNER,
            text: "Inspect the mólo crane",
            view: "private",
        });

        const result = await searchMergeCandidates(reviewer, TARGET, {
            text: "mol",
            offset: 0,
            limit: 20,
        });

        expect(result.candidates.map((row) => row.id)).toEqual([
            "search-prefix-task",
        ]);
    });

    it("ranks an empty search against the item's content", async () => {
        await db()
            .update(chatterItems)
            .set({ title: encryptText("Calibrate the cobalt spectrometer") })
            .where(eq(chatterItems.id, TARGET));
        await db()
            .insert(mailMessages)
            .values({
                id: TARGET,
                userId: OWNER,
                rawHash: "target-mail",
                receivedAt: new Date("2026-10-01T00:00:00.000Z"),
                sizeBytes: 1,
                auth: {},
                senderVerified: true,
            });
        await db()
            .insert(mailContents)
            .values({
                id: "target-content",
                itemId: TARGET,
                userId: OWNER,
                revision: 3,
                parserVersion: 1,
                segments: encryptJsonField([
                    {
                        index: 0,
                        role: "body",
                        participantRef: null,
                        depth: 0,
                        at: null,
                        text: "Calibrate the cobalt spectrometer",
                    },
                ]),
            });
        await item("search-empty-similar", OWNER, "mail");
        await item("search-empty-recent", OWNER, "mail");
        await db()
            .insert(recordingFolderAssignments)
            .values([
                {
                    itemId: "search-empty-similar",
                    userId: OWNER,
                    folderId: "private-a-child",
                },
                {
                    itemId: "search-empty-recent",
                    userId: OWNER,
                    folderId: "private-a-child",
                },
            ]);
        await candidate({
            id: "search-empty-similar-task",
            itemId: "search-empty-similar",
            userId: OWNER,
            text: "Calibrate the cobalt spectrometer",
            view: "private",
            statementAt: new Date("2026-09-01T00:00:00.000Z"),
        });
        const embed = vi.fn(async (texts: readonly string[]) =>
            texts.map((value) =>
                Float32Array.from([
                    value.includes("cobalt") ? 1 : 0,
                    value.includes("catering") ? 1 : 0,
                ]),
            ),
        );
        embeddingClientMock.mockReturnValue({
            model: "candidate-model",
            available: true,
            embed,
        });
        await candidate({
            id: "search-empty-recent-task",
            itemId: "search-empty-recent",
            userId: OWNER,
            text: "Book catering",
            view: "private",
            statementAt: new Date("2026-10-10T00:00:00.000Z"),
        });
        await db()
            .insert(taskContentVectors)
            .values([
                {
                    id: "target-content-old-revision",
                    userId: OWNER,
                    itemId: TARGET,
                    contentSourceId: "target-content",
                    contentRevision: 2,
                    vectorGeneration: "candidate-model",
                    chunkIndex: 0,
                    dim: 2,
                    vector: "stale-revision",
                    inputHmac: "0".repeat(64),
                },
                {
                    id: "target-content-old-generation",
                    userId: OWNER,
                    itemId: TARGET,
                    contentSourceId: "target-content",
                    contentRevision: 3,
                    vectorGeneration: "old-model",
                    chunkIndex: 0,
                    dim: 2,
                    vector: "stale-generation",
                    inputHmac: "0".repeat(64),
                },
            ]);

        const result = await searchMergeCandidates(reviewer, TARGET, {
            text: "",
            offset: 0,
            limit: 1,
        });

        expect(result.candidates.map((row) => row.id)).toEqual([
            "search-empty-similar-task",
        ]);
        expect(result.nextOffset).toBe(1);
        const secondPage = await searchMergeCandidates(reviewer, TARGET, {
            text: "",
            offset: 1,
            limit: 1,
        });
        expect(secondPage.candidates.map((row) => row.id)).toEqual([
            "search-empty-recent-task",
        ]);
        expect(embed).toHaveBeenCalledTimes(1);
        expect(
            await db()
                .select({
                    revision: taskContentVectors.contentRevision,
                    generation: taskContentVectors.vectorGeneration,
                })
                .from(taskContentVectors),
        ).toEqual([{ revision: 3, generation: "candidate-model#r1" }]);
    });

    it("keeps private and Organization merge targets in their matching scope", async () => {
        await item("search-private-org-home", OTHER, "mail");
        await db().insert(recordingFolderAssignments).values({
            itemId: "search-private-org-home",
            userId: OTHER,
            folderId: "org-team-child",
        });
        await candidate({
            id: "search-private-org-task",
            itemId: "search-private-org-home",
            userId: OTHER,
            text: "Scoped launch target",
            view: "org",
        });
        await db()
            .insert(taskMentions)
            .values({
                id: "search-private-org-private-mention",
                taskId: "search-private-org-task",
                itemId: TARGET,
                userId: OWNER,
                view: "private",
                statementAt: new Date("2026-10-02T00:00:00.000Z"),
                matchDecision: "accepted",
            });
        expect(
            (
                await searchMergeCandidates(reviewer, TARGET, {
                    text: "scoped launch",
                    offset: 0,
                    limit: 20,
                })
            ).candidates,
        ).toEqual([]);

        await db().insert(recordingFolderAssignments).values({
            itemId: TARGET,
            userId: OWNER,
            folderId: "org-team",
        });
        await item("search-org-private-home", OWNER, "mail");
        await db().insert(recordingFolderAssignments).values({
            itemId: "search-org-private-home",
            userId: OWNER,
            folderId: "private-a-child",
        });
        await candidate({
            id: "search-org-private-task",
            itemId: "search-org-private-home",
            userId: OWNER,
            text: "Scoped launch target",
            view: "private",
        });
        await db()
            .insert(taskMentions)
            .values({
                id: "search-org-private-org-mention",
                taskId: "search-org-private-task",
                itemId: "search-private-org-home",
                userId: OTHER,
                view: "org",
                statementAt: new Date("2026-10-03T00:00:00.000Z"),
                matchDecision: "accepted",
            });

        const organization = await searchMergeCandidates(reviewer, TARGET, {
            text: "scoped launch",
            offset: 0,
            limit: 20,
        });
        expect(organization.candidates.map((row) => row.id)).toContain(
            "search-private-org-task",
        );
        expect(organization.candidates.map((row) => row.id)).not.toContain(
            "search-org-private-task",
        );
    });

    it("plans a seeded folder-first candidate lookup without scanning all tasks", async () => {
        const folderRows = Array.from({ length: 60 }, (_, index) => ({
            id: `scale-folder-${String(index).padStart(2, "0")}`,
            userId: index < 30 ? OWNER : ORG,
            parentId: index < 30 ? "private-a" : "org-team",
            name: encryptText(`Scale ${index}`),
            nameHash: lookupHash(`scale-${index}`),
            kind: "custom" as const,
        }));
        await db().insert(recordingFolders).values(folderRows);
        const itemRows = Array.from({ length: 3_000 }, (_, index) => ({
            id: `scale-item-${String(index).padStart(4, "0")}`,
            userId: index % 3 === 1 ? OTHER : OWNER,
            kind: "mail" as const,
            title: encryptText(`Scale item ${index}`),
            occurredAt: new Date("2026-09-01T00:00:00.000Z"),
        }));
        const taskRows = itemRows.map((row, index) => ({
            id: `scale-task-${String(index).padStart(4, "0")}`,
            itemId: row.id,
            userId: row.userId,
            status: "open" as const,
            text: encryptText(`Scale task ${index}`),
            source: "manual" as const,
        }));
        const mentionRows = taskRows.map((row, index) => ({
            id: `scale-mention-${String(index).padStart(4, "0")}`,
            taskId: row.id,
            itemId: row.itemId,
            userId: row.userId,
            view: index >= 1_500 ? ("org" as const) : ("private" as const),
            statementAt: new Date("2026-09-01T00:00:00.000Z"),
            matchDecision: "home" as const,
        }));
        const assignmentRows = itemRows.map((row, index) => ({
            itemId: row.id,
            userId: row.userId,
            folderId: folderRows[Math.floor(index / 50)]?.id ?? "",
        }));
        for (let offset = 0; offset < itemRows.length; offset += 500) {
            await db()
                .insert(chatterItems)
                .values(itemRows.slice(offset, offset + 500));
            await db()
                .insert(recordingTasks)
                .values(taskRows.slice(offset, offset + 500));
            await db()
                .insert(taskMentions)
                .values(mentionRows.slice(offset, offset + 500));
            await db()
                .insert(recordingFolderAssignments)
                .values(assignmentRows.slice(offset, offset + 500));
        }

        const plan = await explainScopedTaskCandidatePlan(
            itemRows.slice(0, 50).map((row) => row.id),
        );
        expect(plan.join("\n")).not.toMatch(
            /Seq Scan on (?:public\.)?recording_tasks/u,
        );
        const result = await searchMergeCandidates(reviewer, TARGET, {
            text: "Scale task 25",
            offset: 0,
            limit: 5,
        });
        expect(result.candidates).toHaveLength(5);
        expect(
            result.candidates.every((row) => row.id.startsWith("scale-task-")),
        ).toBe(true);
    }, 30_000);

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
