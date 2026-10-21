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
import {
    aiEnhancements,
    chatterItems,
    itemProcessing,
    recordingTasks,
    taskMentions,
    taskUpdateProposals,
    users,
} from "@/db/schema";
import type { PhaseRecord } from "@/lib/pipeline/types";
import type { TaskViewer } from "@/lib/tasks/access";
import {
    applyPlaudActionItemProposals,
    plaudActionItemsFingerprint,
} from "@/lib/tasks/plaud-proposals";
import { taskFingerprint } from "@/lib/tasks/proposals";
import { writeTaskProposalsInTx } from "@/lib/tasks/store";
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
        API_TOKEN_HASH_SECRET: "plaud-proposals-test-secret",
        BETTER_AUTH_SECRET: "plaud-proposals-test-secret",
        IS_HOSTED: false,
    },
}));
vi.mock("@/lib/encryption/fields", () => ({
    decryptJsonField: <T>(value: T) => value,
    decryptText: (value: string | null) => value,
    encryptText: (value: string | null) => value,
}));
vi.mock("@/lib/tasks/access", () => ({
    taskViewerById: vi.fn(async (userId: string) => ({
        userId,
        emailHash: "owner",
        isOrg: false,
        isCurator: false,
        orgUserId: null,
    })),
}));

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const USER_ID = "plaud-proposals-user";
const ITEM_ID = "plaud-proposals-item";
const reviewer: TaskViewer = {
    userId: USER_ID,
    emailHash: "owner",
    isOrg: false,
    isCurator: false,
    orgUserId: null,
};

function phaseRecord(fingerprint: string): PhaseRecord {
    const content = {
        contentId: "transcript-1",
        contentSourceId: "plaud",
        contentRevision: 1,
    };
    return {
        state: "done",
        reason: "completed",
        generation: 1,
        inputs: content,
        at: "2026-10-15T12:00:00.000Z",
        steps: {
            summary: {
                ...content,
                generation: 1,
                state: "done",
                reason: "plaud_tasks",
                sourceFingerprint: fingerprint,
            },
        },
    };
}

describeWithDatabase("Plaud summary task proposals", () => {
    let database: TestPostgresDatabase | null = null;

    function db() {
        if (!database) throw new Error("test database not ready");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "plaud_proposals",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        await db().delete(users);
        await db().insert(users).values({
            id: USER_ID,
            email: "plaud-proposals@example.test",
        });
        await db()
            .insert(chatterItems)
            .values({
                id: ITEM_ID,
                userId: USER_ID,
                kind: "audio",
                title: "Recording",
                occurredAt: new Date("2026-10-15T10:00:00.000Z"),
            });
        await db().insert(itemProcessing).values({
            itemId: ITEM_ID,
            userId: USER_ID,
            view: "private",
            requestedGeneration: 1,
            phases: {},
        });
    });

    async function storePlaudSummary(actionItems: string[]) {
        await db()
            .insert(aiEnhancements)
            .values({
                itemId: ITEM_ID,
                userId: USER_ID,
                summary: "Plaud summary",
                actionItems,
                keyPoints: [],
                provider: "plaud",
                model: "plaud-native",
                source: "plaud",
            })
            .onConflictDoUpdate({
                target: [
                    aiEnhancements.itemId,
                    aiEnhancements.userId,
                    aiEnhancements.source,
                ],
                set: { actionItems },
            });
    }

    it("[E] writes only new Plaud tasks, never drop or assignee updates", async () => {
        const firstItems = ["Keep the signed decision", "Draft the report"];
        await storePlaudSummary(firstItems);
        const firstFingerprint = plaudActionItemsFingerprint(firstItems);

        expect(
            await applyPlaudActionItemProposals({
                itemId: ITEM_ID,
                userId: USER_ID,
                view: "private",
                expectedFingerprint: firstFingerprint,
                record: phaseRecord(firstFingerprint),
            }),
        ).toBe(true);

        const first = await db()
            .select()
            .from(recordingTasks)
            .where(eq(recordingTasks.itemId, ITEM_ID));
        expect(first).toHaveLength(2);
        expect(first.every((task) => task.source === "plaud")).toBe(true);
        expect(first.every((task) => task.status === "open")).toBe(true);
        expect(await db().select().from(taskUpdateProposals)).toHaveLength(0);
        const mentions = await db().select().from(taskMentions);
        expect(mentions).toHaveLength(2);
        expect(
            mentions.every((mention) => mention.matchDecision === "home"),
        ).toBe(true);

        const decided = first.find(
            (task) => task.text === "Keep the signed decision",
        );
        if (!decided) throw new Error("expected decided proposal");
        await db()
            .update(recordingTasks)
            .set({ status: "open", version: 1 })
            .where(eq(recordingTasks.id, decided.id));

        const secondItems = ["Send the final report"];
        await storePlaudSummary(secondItems);
        const secondFingerprint = plaudActionItemsFingerprint(secondItems);
        await applyPlaudActionItemProposals({
            itemId: ITEM_ID,
            userId: USER_ID,
            view: "private",
            expectedFingerprint: secondFingerprint,
            record: phaseRecord(secondFingerprint),
        });

        const replaced = await db()
            .select()
            .from(recordingTasks)
            .where(eq(recordingTasks.itemId, ITEM_ID));
        expect(replaced.map((task) => task.text).sort()).toEqual([
            "Draft the report",
            "Keep the signed decision",
            "Send the final report",
        ]);
        expect(replaced.find((task) => task.id === decided.id)?.status).toBe(
            "open",
        );
        const [processing] = await db()
            .select({ phases: itemProcessing.phases })
            .from(itemProcessing)
            .where(eq(itemProcessing.itemId, ITEM_ID));
        const [processingGeneration] = await db()
            .select({ requestedGeneration: itemProcessing.requestedGeneration })
            .from(itemProcessing)
            .where(eq(itemProcessing.itemId, ITEM_ID));
        expect(processing?.phases.summary?.steps?.summary).toMatchObject({
            reason: "plaud_tasks",
            sourceFingerprint: secondFingerprint,
        });
        expect(processingGeneration?.requestedGeneration).toBe(3);
    });

    it("keeps accepted Plaud tasks when an AI summary adds tasks", async () => {
        const items = ["Plaud-only suggestion"];
        await storePlaudSummary(items);
        const fingerprint = plaudActionItemsFingerprint(items);
        await applyPlaudActionItemProposals({
            itemId: ITEM_ID,
            userId: USER_ID,
            view: "private",
            expectedFingerprint: fingerprint,
            record: phaseRecord(fingerprint),
        });

        await db().transaction((tx) =>
            writeTaskProposalsInTx(tx, {
                recordingId: ITEM_ID,
                ownerUserId: USER_ID,
                actorUserId: USER_ID,
                proposals: {
                    source: "riffado",
                    tasks: [
                        {
                            text: "AI-validated task",
                            fingerprint: taskFingerprint("AI-validated task"),
                            assigneePersonId: null,
                            assigneeHint: null,
                            assigneeCheck: false,
                            dueDate: null,
                            duePhrase: null,
                            quote: null,
                            evidenceStartMs: null,
                        },
                    ],
                    matches: [],
                    updates: [],
                    reviewer,
                    fingerprintOf: taskFingerprint,
                },
            }),
        );

        const rows = await db()
            .select({
                source: recordingTasks.source,
                text: recordingTasks.text,
            })
            .from(recordingTasks)
            .where(eq(recordingTasks.itemId, ITEM_ID));
        expect(rows).toEqual(
            expect.arrayContaining([
                { source: "plaud", text: "Plaud-only suggestion" },
                { source: "riffado", text: "AI-validated task" },
            ]),
        );
    });

    it("does not duplicate a task when Plaud and AI summary writers run concurrently", async () => {
        const text = "Draft the concurrent report";
        await storePlaudSummary([text]);
        const fingerprint = plaudActionItemsFingerprint([text]);
        await Promise.all([
            applyPlaudActionItemProposals({
                itemId: ITEM_ID,
                userId: USER_ID,
                view: "private",
                expectedFingerprint: fingerprint,
                record: phaseRecord(fingerprint),
            }),
            db().transaction((tx) =>
                writeTaskProposalsInTx(tx, {
                    recordingId: ITEM_ID,
                    ownerUserId: USER_ID,
                    actorUserId: USER_ID,
                    proposals: {
                        source: "riffado",
                        tasks: [
                            {
                                text,
                                fingerprint: taskFingerprint(text),
                                assigneePersonId: null,
                                assigneeHint: null,
                                assigneeCheck: false,
                                dueDate: null,
                                duePhrase: null,
                                quote: null,
                                evidenceStartMs: null,
                            },
                        ],
                        updates: [],
                        reviewer,
                        fingerprintOf: taskFingerprint,
                    },
                }),
            ),
        ]);
        const tasks = await db()
            .select()
            .from(recordingTasks)
            .where(eq(recordingTasks.itemId, ITEM_ID));
        expect(tasks).toHaveLength(1);
        expect(tasks[0]).toMatchObject({
            text,
            status: "open",
            acceptedByUserId: USER_ID,
        });
        expect(await db().select().from(taskMentions)).toHaveLength(1);
    });

    it("does not write or leave Task review waiting on a fingerprint mismatch", async () => {
        const items = ["Plaud task with a changed source"];
        await storePlaudSummary(items);

        expect(
            await applyPlaudActionItemProposals({
                itemId: ITEM_ID,
                userId: USER_ID,
                view: "private",
                expectedFingerprint: plaudActionItemsFingerprint([
                    "stale source",
                ]),
                record: phaseRecord("stale source"),
            }),
        ).toBe(false);

        expect(await db().select().from(recordingTasks)).toHaveLength(0);
        const [processing] = await db()
            .select({ requestedGeneration: itemProcessing.requestedGeneration })
            .from(itemProcessing)
            .where(eq(itemProcessing.itemId, ITEM_ID));
        expect(processing?.requestedGeneration).toBe(1);
        expect(
            (await db().select().from(itemProcessing))[0]?.phases.taskReview,
        ).toBeUndefined();
    });
});
