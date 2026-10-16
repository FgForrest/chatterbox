import { and, eq, inArray, sql } from "drizzle-orm";
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
    recordingFolderAssignments,
    recordingFolders,
    recordingTasks,
    taskMentions,
    taskUpdateProposals,
    users,
} from "@/db/schema";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { mailShareProblems } from "@/lib/mail/share-gate";
import type { TaskViewer } from "@/lib/tasks/access";
import {
    applyRoutedTaskProposal,
    listRoutedTaskProposals,
} from "@/lib/tasks/routing";
import { mergeTaskIntoTask } from "@/lib/tasks/tasks";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    return {
        dbRef: ref,
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
        SELF_HOST_MODE: "shared",
        AUTHZ_MODE: "local",
        ORG_ACCOUNT_EMAIL: "org@example.test",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        BETTER_AUTH_SECRET: "task-merges-test-secret",
        DATABASE_URL: "postgres://unused",
    },
}));
vi.mock("@/lib/org/config", () => ({
    assertOrgScopeWritable: vi.fn(),
    getOrgUserId: async () => "merge-org",
}));
vi.mock("@/lib/export/document-sidecars", () => ({
    exportRecordingSidecarsIfEnabled: vi.fn(),
    refreshExistingRecordingSidecars: vi.fn(),
}));
vi.mock("@/lib/sharing/notify", () => ({ notifyIfShared: vi.fn() }));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const ALICE = "merge-alice";
const BOB = "merge-bob";
const CAROL = "merge-carol";
const ORG = "merge-org";

function viewer(userId: string, isCurator = false): TaskViewer {
    return {
        userId,
        emailHash: lookupHash(`${userId}@example.test`),
        isOrg: userId === ORG,
        isCurator,
        orgUserId: ORG,
    };
}

describeWithDatabase("task merges", () => {
    let database: TestPostgresDatabase | null = null;

    function db() {
        if (!database) throw new Error("test database not ready");
        return database.db;
    }

    async function item(id: string, userId: string, shared = false) {
        await db()
            .insert(chatterItems)
            .values({
                id,
                userId,
                kind: "mail",
                title: encryptText(id),
                occurredAt: new Date("2026-10-01T10:00:00.000Z"),
            });
        if (shared) {
            await db().insert(recordingFolderAssignments).values({
                itemId: id,
                userId,
                folderId: "merge-org-team",
            });
        }
    }

    async function task(input: {
        id: string;
        itemId: string;
        userId: string;
        text?: string;
        status?: "proposed" | "open" | "done";
        dueDate?: string | null;
        duePhrase?: string | null;
        statementAt?: Date;
        view?: "private" | "org";
    }) {
        const statementAt =
            input.statementAt ?? new Date("2026-10-01T10:00:00.000Z");
        await db()
            .insert(recordingTasks)
            .values({
                id: input.id,
                itemId: input.itemId,
                userId: input.userId,
                status: input.status ?? "open",
                text: encryptText(input.text ?? input.id),
                source: "manual",
                dueDate: input.dueDate ?? null,
                duePhrase: input.duePhrase
                    ? encryptText(input.duePhrase)
                    : null,
                statusEffectiveAt: statementAt,
                dueEffectiveAt: statementAt,
                assigneeEffectiveAt: statementAt,
                originItemId: input.itemId,
            });
        await db()
            .insert(taskMentions)
            .values({
                id: `${input.id}-mention`,
                taskId: input.id,
                itemId: input.itemId,
                userId: input.userId,
                view: input.view ?? "private",
                quote: encryptText(`${input.id} evidence`),
                statementAt,
                matchDecision: "home",
            });
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "task_merges",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        await db().delete(users);
        await db()
            .insert(users)
            .values([
                { id: ALICE, email: `${ALICE}@example.test` },
                { id: BOB, email: `${BOB}@example.test` },
                { id: CAROL, email: `${CAROL}@example.test` },
                { id: ORG, email: `${ORG}@example.test`, role: "org" },
            ]);
        await db()
            .insert(recordingFolders)
            .values({
                id: "merge-org-root",
                userId: ORG,
                parentId: null,
                name: encryptText("Organization"),
                nameHash: lookupHash("Organization"),
                kind: "public",
            });
        await db()
            .insert(recordingFolders)
            .values({
                id: "merge-org-team",
                userId: ORG,
                parentId: "merge-org-root",
                name: encryptText("Team"),
                nameHash: lookupHash("Team"),
                kind: "custom",
            });
    });

    it("lets a home owner merge one own task into another and moves mentions", async () => {
        await item("alice-source-item", ALICE);
        await item("alice-target-item", ALICE);
        await task({
            id: "alice-source",
            itemId: "alice-source-item",
            userId: ALICE,
        });
        await task({
            id: "alice-target",
            itemId: "alice-target-item",
            userId: ALICE,
        });

        const merged = await mergeTaskIntoTask(
            viewer(ALICE),
            "alice-source",
            "alice-target",
        );

        expect(merged.id).toBe("alice-target");
        expect(
            await db()
                .select({ id: recordingTasks.id })
                .from(recordingTasks)
                .where(eq(recordingTasks.id, "alice-source")),
        ).toEqual([]);
        expect(
            await db()
                .select({ taskId: taskMentions.taskId })
                .from(taskMentions)
                .where(eq(taskMentions.id, "alice-source-mention")),
        ).toEqual([{ taskId: "alice-target" }]);
    });

    it("lets a curator merge two shared tasks with the same home owner", async () => {
        await item("shared-source-item", ALICE, true);
        await item("shared-target-item", ALICE, true);
        await task({
            id: "shared-source",
            itemId: "shared-source-item",
            userId: ALICE,
            view: "org",
        });
        await task({
            id: "shared-target",
            itemId: "shared-target-item",
            userId: ALICE,
            view: "org",
        });

        await expect(
            mergeTaskIntoTask(
                viewer(CAROL, true),
                "shared-source",
                "shared-target",
            ),
        ).resolves.toMatchObject({ id: "shared-target" });
    });

    it("attaches an own shared task to another owner's task and routes every supported difference", async () => {
        const statementAt = new Date("2026-10-05T12:00:00.000Z");
        await item("cross-source-item", ALICE, true);
        await item("cross-target-item", BOB, true);
        await task({
            id: "cross-source",
            itemId: "cross-source-item",
            userId: ALICE,
            text: "Publish the final launch brief",
            status: "done",
            dueDate: "2026-10-20",
            duePhrase: "by launch day",
            statementAt,
            view: "org",
        });
        await task({
            id: "cross-target",
            itemId: "cross-target-item",
            userId: BOB,
            text: "Publish the launch brief",
            status: "open",
            dueDate: "2026-10-18",
            statementAt: new Date("2026-10-02T12:00:00.000Z"),
            view: "org",
        });

        await mergeTaskIntoTask(viewer(ALICE), "cross-source", "cross-target");

        const [target] = await db()
            .select({
                text: recordingTasks.text,
                status: recordingTasks.status,
                dueDate: recordingTasks.dueDate,
            })
            .from(recordingTasks)
            .where(eq(recordingTasks.id, "cross-target"));
        expect(target).toMatchObject({ status: "open", dueDate: "2026-10-18" });
        expect(target?.text ? decryptText(target.text) : null).toBe(
            "Publish the launch brief",
        );
        const proposals = await db()
            .select({
                id: taskUpdateProposals.id,
                kind: taskUpdateProposals.kind,
                state: taskUpdateProposals.state,
                routedTo: taskUpdateProposals.routedTo,
                dueDate: taskUpdateProposals.dueDate,
                duePhrase: taskUpdateProposals.duePhrase,
            })
            .from(taskUpdateProposals)
            .where(eq(taskUpdateProposals.taskId, "cross-target"));
        expect(proposals.map((row) => row.kind).sort()).toEqual([
            "attach_merge",
            "done",
            "due",
        ]);
        expect(proposals).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: "attach_merge",
                    state: "awaiting_target_review",
                    routedTo: [BOB],
                }),
                expect.objectContaining({ kind: "done" }),
                expect.objectContaining({
                    kind: "due",
                    dueDate: "2026-10-20",
                }),
            ]),
        );
        const due = proposals.find((row) => row.kind === "due");
        const attach = proposals.find((row) => row.kind === "attach_merge");
        if (!attach || !due) throw new Error("missing routed merge proposals");
        expect(due?.duePhrase ? decryptText(due.duePhrase) : null).toBe(
            "by launch day",
        );
        expect(
            await db()
                .select({
                    taskId: taskMentions.taskId,
                    statementAt: taskMentions.statementAt,
                })
                .from(taskMentions)
                .where(eq(taskMentions.id, "cross-source-mention")),
        ).toEqual([{ taskId: "cross-target", statementAt }]);

        await expect(
            applyRoutedTaskProposal(
                viewer(BOB),
                "cross-source-item",
                attach.id,
            ),
        ).resolves.toEqual({ state: "applied", obsoleteReason: null });
        expect(
            await db()
                .select({ dueDate: recordingTasks.dueDate })
                .from(recordingTasks)
                .where(eq(recordingTasks.id, "cross-target")),
        ).toEqual([{ dueDate: "2026-10-18" }]);
        await expect(
            applyRoutedTaskProposal(viewer(BOB), "cross-source-item", due.id),
        ).resolves.toEqual({ state: "applied", obsoleteReason: null });
        expect(
            await db()
                .select({
                    dueDate: recordingTasks.dueDate,
                    dueEffectiveAt: recordingTasks.dueEffectiveAt,
                })
                .from(recordingTasks)
                .where(eq(recordingTasks.id, "cross-target")),
        ).toEqual([{ dueDate: "2026-10-20", dueEffectiveAt: statementAt }]);
    });

    it("refuses a merge by someone who owns neither task", async () => {
        await item("wrong-source-item", ALICE, true);
        await item("wrong-target-item", BOB, true);
        await task({
            id: "wrong-source",
            itemId: "wrong-source-item",
            userId: ALICE,
            view: "org",
        });
        await task({
            id: "wrong-target",
            itemId: "wrong-target-item",
            userId: BOB,
            view: "org",
        });

        await expect(
            mergeTaskIntoTask(viewer(CAROL), "wrong-source", "wrong-target"),
        ).rejects.toMatchObject({
            statusCode: 403,
            message: expect.stringContaining("home owner"),
        });
    });

    it("allows someone else's task into one's own only for a curator", async () => {
        await item("curator-source-item", ALICE, true);
        await item("curator-target-item", BOB, true);
        await task({
            id: "curator-source",
            itemId: "curator-source-item",
            userId: ALICE,
            view: "org",
        });
        await task({
            id: "curator-target",
            itemId: "curator-target-item",
            userId: BOB,
            view: "org",
        });

        await expect(
            mergeTaskIntoTask(viewer(BOB), "curator-source", "curator-target"),
        ).rejects.toMatchObject({
            statusCode: 403,
            message: expect.stringContaining("curator"),
        });
        await expect(
            mergeTaskIntoTask(
                viewer(BOB, true),
                "curator-source",
                "curator-target",
            ),
        ).resolves.toMatchObject({ id: "curator-target" });
    });

    it("answers 404 when either merge task is not visible", async () => {
        await item("hidden-source-item", ALICE);
        await item("hidden-target-item", BOB);
        await task({
            id: "hidden-source",
            itemId: "hidden-source-item",
            userId: ALICE,
        });
        await task({
            id: "hidden-target",
            itemId: "hidden-target-item",
            userId: BOB,
        });

        await expect(
            mergeTaskIntoTask(viewer(CAROL), "hidden-source", "hidden-target"),
        ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("refuses private into Organization until the source item is shared", async () => {
        await item("private-source-item", ALICE);
        await item("organization-target-item", BOB, true);
        await task({
            id: "private-source",
            itemId: "private-source-item",
            userId: ALICE,
        });
        await task({
            id: "organization-target",
            itemId: "organization-target-item",
            userId: BOB,
            view: "org",
        });

        await expect(
            mergeTaskIntoTask(
                viewer(ALICE),
                "private-source",
                "organization-target",
            ),
        ).rejects.toMatchObject({
            statusCode: 403,
            message: expect.stringContaining("shared"),
        });

        await db().insert(recordingFolderAssignments).values({
            itemId: "private-source-item",
            userId: ALICE,
            folderId: "merge-org-team",
        });
        await db()
            .update(taskMentions)
            .set({ view: "org" })
            .where(eq(taskMentions.taskId, "private-source"));
        await expect(
            mergeTaskIntoTask(
                viewer(ALICE),
                "private-source",
                "organization-target",
            ),
        ).resolves.toMatchObject({ id: "organization-target" });
    });

    it("marks a reviewed proposal's moved home mention as an accepted manual match", async () => {
        await item("proposal-item", ALICE);
        await item("proposal-target-item", ALICE);
        await task({
            id: "proposal-source",
            itemId: "proposal-item",
            userId: ALICE,
            status: "proposed",
        });
        await task({
            id: "proposal-target",
            itemId: "proposal-target-item",
            userId: ALICE,
        });

        await mergeTaskIntoTask(
            viewer(ALICE),
            "proposal-source",
            "proposal-target",
            { reviewItemId: "proposal-item" },
        );

        expect(
            await db()
                .select({
                    taskId: taskMentions.taskId,
                    decision: taskMentions.matchDecision,
                    decidedBy: taskMentions.decidedByUserId,
                })
                .from(taskMentions)
                .where(eq(taskMentions.id, "proposal-source-mention")),
        ).toEqual([
            {
                taskId: "proposal-target",
                decision: "accepted",
                decidedBy: ALICE,
            },
        ]);
    });

    it("serializes two merges into the same target without losing mentions", async () => {
        await item("concurrent-source-one-item", ALICE);
        await item("concurrent-source-two-item", ALICE);
        await item("concurrent-target-item", ALICE);
        await task({
            id: "concurrent-source-one",
            itemId: "concurrent-source-one-item",
            userId: ALICE,
        });
        await task({
            id: "concurrent-source-two",
            itemId: "concurrent-source-two-item",
            userId: ALICE,
        });
        await task({
            id: "concurrent-target",
            itemId: "concurrent-target-item",
            userId: ALICE,
        });

        await Promise.all([
            mergeTaskIntoTask(
                viewer(ALICE),
                "concurrent-source-one",
                "concurrent-target",
            ),
            mergeTaskIntoTask(
                viewer(ALICE),
                "concurrent-source-two",
                "concurrent-target",
            ),
        ]);

        expect(
            await db()
                .select({ id: recordingTasks.id })
                .from(recordingTasks)
                .where(
                    inArray(recordingTasks.id, [
                        "concurrent-source-one",
                        "concurrent-source-two",
                    ]),
                ),
        ).toEqual([]);
        expect(
            await db()
                .select({ id: taskMentions.id })
                .from(taskMentions)
                .where(eq(taskMentions.taskId, "concurrent-target")),
        ).toHaveLength(3);
    });

    it("moves pending proposals, reroutes target review, and leaves earlier statements behind", async () => {
        await item("pending-source-item", ALICE, true);
        await item("pending-target-item", BOB, true);
        await item("pending-review-item", ALICE);
        await item("pending-routed-item", ALICE, true);
        await item("pending-share-item", ALICE);
        await item("pending-earlier-item", ALICE, true);
        await task({
            id: "pending-source",
            itemId: "pending-source-item",
            userId: ALICE,
            view: "org",
        });
        await task({
            id: "pending-target",
            itemId: "pending-target-item",
            userId: BOB,
            statementAt: new Date("2026-10-02T00:00:00.000Z"),
            view: "org",
        });
        await db()
            .update(recordingTasks)
            .set({ version: 5 })
            .where(eq(recordingTasks.id, "pending-target"));
        await db()
            .insert(taskMentions)
            .values([
                {
                    id: "pending-review-mention",
                    taskId: "pending-source",
                    itemId: "pending-review-item",
                    userId: ALICE,
                    view: "private",
                    statementAt: new Date("2026-10-03T00:00:00.000Z"),
                    matchDecision: "suggested",
                },
                {
                    id: "pending-routed-mention",
                    taskId: "pending-source",
                    itemId: "pending-routed-item",
                    userId: ALICE,
                    view: "org",
                    statementAt: new Date("2026-10-04T00:00:00.000Z"),
                    matchDecision: "accepted",
                },
                {
                    id: "pending-earlier-mention",
                    taskId: "pending-source",
                    itemId: "pending-earlier-item",
                    userId: ALICE,
                    view: "org",
                    statementAt: new Date("2026-10-01T00:00:00.000Z"),
                    matchDecision: "accepted",
                },
                {
                    id: "pending-share-mention",
                    taskId: "pending-source",
                    itemId: "pending-share-item",
                    userId: ALICE,
                    view: "private",
                    statementAt: new Date("2026-10-05T00:00:00.000Z"),
                    matchDecision: "accepted",
                },
            ]);
        await db()
            .insert(taskUpdateProposals)
            .values([
                {
                    id: "pending-review",
                    taskId: "pending-source",
                    itemId: "pending-review-item",
                    userId: ALICE,
                    kind: "done",
                    statementAt: new Date("2026-10-03T00:00:00.000Z"),
                    state: "awaiting_source_review",
                },
                {
                    id: "pending-routed",
                    taskId: "pending-source",
                    itemId: "pending-routed-item",
                    userId: ALICE,
                    kind: "due",
                    dueDate: "2026-10-20",
                    statementAt: new Date("2026-10-04T00:00:00.000Z"),
                    state: "awaiting_target_review",
                    routedTo: [ALICE],
                },
                {
                    id: "pending-earlier",
                    taskId: "pending-source",
                    itemId: "pending-earlier-item",
                    userId: ALICE,
                    kind: "due_phrase",
                    duePhrase: encryptText("next week"),
                    statementAt: new Date("2026-10-01T00:00:00.000Z"),
                    state: "awaiting_share",
                },
                {
                    id: "pending-share",
                    taskId: "pending-source",
                    itemId: "pending-share-item",
                    userId: ALICE,
                    kind: "due_phrase",
                    duePhrase: encryptText("after approval"),
                    statementAt: new Date("2026-10-05T00:00:00.000Z"),
                    state: "awaiting_share",
                },
            ]);

        await mergeTaskIntoTask(
            viewer(ALICE),
            "pending-source",
            "pending-target",
        );

        expect(
            await db()
                .select({
                    id: taskUpdateProposals.id,
                    taskId: taskUpdateProposals.taskId,
                    state: taskUpdateProposals.state,
                    routedTo: taskUpdateProposals.routedTo,
                    version: taskUpdateProposals.version,
                })
                .from(taskUpdateProposals)
                .where(
                    inArray(taskUpdateProposals.id, [
                        "pending-review",
                        "pending-routed",
                        "pending-share",
                        "pending-earlier",
                    ]),
                ),
        ).toEqual(
            expect.arrayContaining([
                {
                    id: "pending-review",
                    taskId: "pending-target",
                    state: "awaiting_source_review",
                    routedTo: null,
                    version: 5,
                },
                {
                    id: "pending-routed",
                    taskId: "pending-target",
                    state: "awaiting_target_review",
                    routedTo: [BOB],
                    version: 5,
                },
                {
                    id: "pending-share",
                    taskId: "pending-target",
                    state: "awaiting_share",
                    routedTo: null,
                    version: 5,
                },
            ]),
        );
        expect(
            await db()
                .select({ id: taskUpdateProposals.id })
                .from(taskUpdateProposals)
                .where(eq(taskUpdateProposals.id, "pending-earlier")),
        ).toEqual([]);
        await expect(
            db().transaction((tx) =>
                mailShareProblems(tx, "pending-review-item", ALICE),
            ),
        ).resolves.toContainEqual({ kind: "tasks_unreviewed", proposals: 1 });
    });

    it("collapses a suggested target mention into the moved linked mention", async () => {
        await item("duplicate-source-item", ALICE);
        await item("duplicate-target-item", ALICE);
        await item("duplicate-evidence-item", ALICE);
        await task({
            id: "duplicate-source",
            itemId: "duplicate-source-item",
            userId: ALICE,
        });
        await task({
            id: "duplicate-target",
            itemId: "duplicate-target-item",
            userId: ALICE,
        });
        await db()
            .insert(taskMentions)
            .values([
                {
                    id: "duplicate-source-linked",
                    taskId: "duplicate-source",
                    itemId: "duplicate-evidence-item",
                    userId: ALICE,
                    view: "private",
                    statementAt: new Date("2026-10-03T00:00:00.000Z"),
                    matchDecision: "accepted",
                },
                {
                    id: "duplicate-target-suggested",
                    taskId: "duplicate-target",
                    itemId: "duplicate-evidence-item",
                    userId: ALICE,
                    view: "private",
                    statementAt: new Date("2026-10-04T00:00:00.000Z"),
                    matchDecision: "suggested",
                    ticked: true,
                },
            ]);

        await mergeTaskIntoTask(
            viewer(ALICE),
            "duplicate-source",
            "duplicate-target",
        );

        expect(
            await db()
                .select({
                    id: taskMentions.id,
                    taskId: taskMentions.taskId,
                    decision: taskMentions.matchDecision,
                })
                .from(taskMentions)
                .where(eq(taskMentions.itemId, "duplicate-evidence-item")),
        ).toEqual([
            {
                id: "duplicate-source-linked",
                taskId: "duplicate-target",
                decision: "accepted",
            },
        ]);
    });

    it("keeps the target proposal when both tasks have the same item and kind", async () => {
        await item("conflict-source-item", ALICE);
        await item("conflict-target-item", ALICE);
        await item("conflict-evidence-item", ALICE);
        await task({
            id: "conflict-source",
            itemId: "conflict-source-item",
            userId: ALICE,
        });
        await task({
            id: "conflict-target",
            itemId: "conflict-target-item",
            userId: ALICE,
        });
        await db()
            .insert(taskMentions)
            .values({
                id: "conflict-evidence-mention",
                taskId: "conflict-source",
                itemId: "conflict-evidence-item",
                userId: ALICE,
                view: "private",
                statementAt: new Date("2026-10-04T00:00:00.000Z"),
                matchDecision: "suggested",
            });
        await db()
            .insert(taskUpdateProposals)
            .values([
                {
                    id: "conflict-source-proposal",
                    taskId: "conflict-source",
                    itemId: "conflict-evidence-item",
                    userId: ALICE,
                    kind: "done",
                    state: "awaiting_source_review",
                },
                {
                    id: "conflict-target-proposal",
                    taskId: "conflict-target",
                    itemId: "conflict-evidence-item",
                    userId: ALICE,
                    kind: "done",
                    state: "awaiting_source_review",
                },
            ]);

        await mergeTaskIntoTask(
            viewer(ALICE),
            "conflict-source",
            "conflict-target",
        );

        expect(
            await db()
                .select({ id: taskUpdateProposals.id })
                .from(taskUpdateProposals)
                .where(eq(taskUpdateProposals.taskId, "conflict-target")),
        ).toEqual([{ id: "conflict-target-proposal" }]);
    });

    it("moves a pending proposal past decided history without duplicating pending rows", async () => {
        await item("history-source-item", ALICE);
        await item("history-target-item", ALICE);
        await item("history-evidence-item", ALICE);
        await task({
            id: "history-source",
            itemId: "history-source-item",
            userId: ALICE,
        });
        await task({
            id: "history-target",
            itemId: "history-target-item",
            userId: ALICE,
        });
        await db()
            .insert(taskUpdateProposals)
            .values([
                {
                    id: "history-source-pending",
                    taskId: "history-source",
                    itemId: "history-evidence-item",
                    userId: ALICE,
                    kind: "done",
                    state: "awaiting_source_review",
                },
                {
                    id: "history-target-decided",
                    taskId: "history-target",
                    itemId: "history-evidence-item",
                    userId: ALICE,
                    kind: "done",
                    state: "rejected",
                    decidedAt: new Date(),
                },
            ]);

        await mergeTaskIntoTask(
            viewer(ALICE),
            "history-source",
            "history-target",
        );

        expect(
            await db()
                .select({
                    id: taskUpdateProposals.id,
                    state: taskUpdateProposals.state,
                })
                .from(taskUpdateProposals)
                .where(eq(taskUpdateProposals.taskId, "history-target")),
        ).toEqual(
            expect.arrayContaining([
                {
                    id: "history-source-pending",
                    state: "awaiting_source_review",
                },
                { id: "history-target-decided", state: "rejected" },
            ]),
        );
        const duplicates = await db()
            .select({ count: sql<number>`count(*)::int` })
            .from(taskUpdateProposals)
            .where(
                inArray(taskUpdateProposals.state, [
                    "awaiting_source_review",
                    "awaiting_share",
                    "awaiting_target_review",
                ]),
            )
            .groupBy(
                taskUpdateProposals.taskId,
                taskUpdateProposals.itemId,
                taskUpdateProposals.kind,
            )
            .having(sql`count(*) > 1`);
        expect(duplicates).toEqual([]);
    });

    it("refuses Organization tasks into private tasks for owners and curators", async () => {
        await item("org-private-source-item", ALICE, true);
        await item("org-private-owner-target-item", ALICE);
        await item("org-private-curator-target-item", CAROL);
        await task({
            id: "org-private-source",
            itemId: "org-private-source-item",
            userId: ALICE,
            view: "org",
        });
        await task({
            id: "org-private-owner-target",
            itemId: "org-private-owner-target-item",
            userId: ALICE,
        });
        await task({
            id: "org-private-curator-target",
            itemId: "org-private-curator-target-item",
            userId: CAROL,
        });
        const expected = {
            statusCode: 403,
            message:
                "Merge rule: an Organization task can be merged only into an Organization task",
        };

        await expect(
            mergeTaskIntoTask(
                viewer(ALICE),
                "org-private-source",
                "org-private-owner-target",
            ),
        ).rejects.toMatchObject(expected);
        await expect(
            mergeTaskIntoTask(
                viewer(CAROL, true),
                "org-private-source",
                "org-private-curator-target",
            ),
        ).rejects.toMatchObject(expected);
        expect(
            await db()
                .select({ id: recordingTasks.id })
                .from(recordingTasks)
                .where(
                    inArray(recordingTasks.id, [
                        "org-private-source",
                        "org-private-owner-target",
                        "org-private-curator-target",
                    ]),
                ),
        ).toHaveLength(3);
    });

    it("applies an attachment notice after the target version changes", async () => {
        await item("notice-source-item", ALICE, true);
        await item("notice-target-item", BOB, true);
        await task({
            id: "notice-source",
            itemId: "notice-source-item",
            userId: ALICE,
            text: "Attach the launch follow-up",
            view: "org",
        });
        await task({
            id: "notice-target",
            itemId: "notice-target-item",
            userId: BOB,
            text: "Launch follow-up",
            view: "org",
        });
        await mergeTaskIntoTask(
            viewer(ALICE),
            "notice-source",
            "notice-target",
        );
        const [notice] = await db()
            .select({ id: taskUpdateProposals.id })
            .from(taskUpdateProposals)
            .where(eq(taskUpdateProposals.kind, "attach_merge"));
        if (!notice) throw new Error("missing attachment notice");
        await db()
            .update(recordingTasks)
            .set({ version: 7 })
            .where(eq(recordingTasks.id, "notice-target"));

        expect(await listRoutedTaskProposals(viewer(BOB))).toContainEqual(
            expect.objectContaining({
                id: notice.id,
                kind: "attach_merge",
                sourceItem: {
                    id: "notice-source-item",
                    kind: "mail",
                    title: "notice-source-item",
                },
                proposedBy: {
                    id: ALICE,
                    name: `${ALICE}@example.test`,
                },
            }),
        );
        await expect(
            applyRoutedTaskProposal(
                viewer(BOB),
                "notice-source-item",
                notice.id,
            ),
        ).resolves.toEqual({ state: "applied", obsoleteReason: null });
    });

    it("reports an earlier routed field statement distinctly", async () => {
        await item("chronology-source-item", ALICE, true);
        await item("chronology-target-item", BOB, true);
        await task({
            id: "chronology-source",
            itemId: "chronology-source-item",
            userId: ALICE,
            dueDate: "2026-10-20",
            statementAt: new Date("2026-10-05T00:00:00.000Z"),
            view: "org",
        });
        await task({
            id: "chronology-target",
            itemId: "chronology-target-item",
            userId: BOB,
            dueDate: "2026-10-18",
            statementAt: new Date("2026-10-02T00:00:00.000Z"),
            view: "org",
        });
        await mergeTaskIntoTask(
            viewer(ALICE),
            "chronology-source",
            "chronology-target",
        );
        const [due] = await db()
            .select({ id: taskUpdateProposals.id })
            .from(taskUpdateProposals)
            .where(eq(taskUpdateProposals.kind, "due"));
        if (!due) throw new Error("missing due proposal");
        await db()
            .update(recordingTasks)
            .set({ dueEffectiveAt: new Date("2026-10-06T00:00:00.000Z") })
            .where(eq(recordingTasks.id, "chronology-target"));

        await expect(
            applyRoutedTaskProposal(
                viewer(BOB),
                "chronology-source-item",
                due.id,
            ),
        ).resolves.toEqual({
            state: "obsolete",
            obsoleteReason: "earlier_statement",
        });
    });

    it("settles crossed concurrent merges without deadlock or lost mentions", async () => {
        await item("crossed-a-item", ALICE);
        await item("crossed-b-item", ALICE);
        await task({
            id: "crossed-a",
            itemId: "crossed-a-item",
            userId: ALICE,
        });
        await task({
            id: "crossed-b",
            itemId: "crossed-b-item",
            userId: ALICE,
        });

        const results = await Promise.allSettled([
            mergeTaskIntoTask(viewer(ALICE), "crossed-a", "crossed-b"),
            mergeTaskIntoTask(viewer(ALICE), "crossed-b", "crossed-a"),
        ]);
        const fulfilled = results.filter(
            (result) => result.status === "fulfilled",
        );
        const rejected = results.filter(
            (result): result is PromiseRejectedResult =>
                result.status === "rejected",
        );

        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect([403, 404]).toContain(rejected[0]?.reason.statusCode);
        const remaining = await db().select().from(recordingTasks);
        expect(remaining).toHaveLength(1);
        expect(
            await db()
                .select({ id: taskMentions.id })
                .from(taskMentions)
                .where(eq(taskMentions.taskId, remaining[0]?.id ?? "")),
        ).toHaveLength(2);
    });

    it("keeps both tasks when a merge is refused", async () => {
        await item("refused-source-item", ALICE, true);
        await item("refused-target-item", BOB, true);
        await task({
            id: "refused-source",
            itemId: "refused-source-item",
            userId: ALICE,
            view: "org",
        });
        await task({
            id: "refused-target",
            itemId: "refused-target-item",
            userId: BOB,
            view: "org",
        });

        await expect(
            mergeTaskIntoTask(
                viewer(CAROL),
                "refused-source",
                "refused-target",
            ),
        ).rejects.toMatchObject({ statusCode: 403 });
        expect(
            await db()
                .select({ id: recordingTasks.id })
                .from(recordingTasks)
                .where(
                    and(
                        inArray(recordingTasks.id, [
                            "refused-source",
                            "refused-target",
                        ]),
                    ),
                ),
        ).toHaveLength(2);
    });
});
