import { and, eq, inArray } from "drizzle-orm";
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { asyncJobs, chatterItems, itemProcessing, users } from "@/db/schema";
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
        dbProxy: new Proxy(
            {},
            {
                get: (_target, property: string | symbol) => {
                    const current = ref.current;
                    if (!current) {
                        throw new Error("test database was not initialized");
                    }
                    const value = current[property];
                    return typeof value === "function"
                        ? value.bind(current)
                        : value;
                },
            },
        ),
        dbRef: ref,
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));

import {
    PIPELINE_ADVANCE_JOB_KIND,
    requestAdvance,
} from "@/lib/pipeline/trigger";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const USER_ID = "pipeline-trigger-user";
const OTHER_USER_ID = "pipeline-trigger-other-user";
const ITEM_ID = "pipeline-trigger-item";

describeWithDatabase("pipeline triggers (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    async function processingRows() {
        return db()
            .select()
            .from(itemProcessing)
            .where(
                and(
                    eq(itemProcessing.itemId, ITEM_ID),
                    eq(itemProcessing.userId, USER_ID),
                ),
            );
    }

    async function pipelineJobs(userId = USER_ID) {
        return db()
            .select()
            .from(asyncJobs)
            .where(
                and(
                    eq(asyncJobs.userId, userId),
                    eq(asyncJobs.kind, PIPELINE_ADVANCE_JOB_KIND),
                    inArray(asyncJobs.status, ["pending", "processing"]),
                ),
            );
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "pipeline_trigger",
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
                { id: USER_ID, email: "pipeline-trigger@example.test" },
                {
                    id: OTHER_USER_ID,
                    email: "pipeline-trigger-other@example.test",
                },
            ]);
        await db()
            .insert(chatterItems)
            .values({
                id: ITEM_ID,
                userId: USER_ID,
                kind: "audio",
                title: "Pipeline trigger",
                occurredAt: new Date("2026-10-14T00:00:00.000Z"),
            });
    });

    it("increments twice while leaving one active advance job", async () => {
        const first = await requestAdvance({
            itemId: ITEM_ID,
            userId: USER_ID,
            view: "private",
            reason: "arrival",
        });
        const second = await requestAdvance({
            itemId: ITEM_ID,
            userId: USER_ID,
            view: "private",
            reason: "transcript",
        });

        expect(first).toEqual({ requestedGeneration: 1, enqueued: true });
        expect(second).toEqual({ requestedGeneration: 2, enqueued: false });
        expect(await processingRows()).toMatchObject([
            { view: "private", requestedGeneration: 2 },
        ]);
        expect(await pipelineJobs()).toMatchObject([
            {
                subjectId: ITEM_ID,
                maxAttempts: 10,
                payload: {
                    itemId: ITEM_ID,
                    view: "private",
                    reason: "arrival",
                },
            },
        ]);
    });

    it("increments but does not enqueue while the active job is processing", async () => {
        const deferredUntil = new Date(Date.now() + 60 * 60_000);
        await requestAdvance({
            itemId: ITEM_ID,
            userId: USER_ID,
            view: "private",
            reason: "arrival",
        });
        await db()
            .update(asyncJobs)
            .set({ status: "processing", nextAttemptAt: deferredUntil })
            .where(
                and(
                    eq(asyncJobs.userId, USER_ID),
                    eq(asyncJobs.kind, PIPELINE_ADVANCE_JOB_KIND),
                    eq(asyncJobs.subjectId, ITEM_ID),
                ),
            );

        const result = await requestAdvance({
            itemId: ITEM_ID,
            userId: USER_ID,
            view: "private",
            reason: "transcript",
        });

        expect(result).toEqual({ requestedGeneration: 2, enqueued: false });
        expect(await processingRows()).toMatchObject([
            { requestedGeneration: 2 },
        ]);
        expect(await pipelineJobs()).toHaveLength(1);
        expect((await pipelineJobs())[0]?.nextAttemptAt).toEqual(deferredUntil);
    });

    it("brings a deferred pending driver forward when new work is requested", async () => {
        await requestAdvance({
            itemId: ITEM_ID,
            userId: USER_ID,
            view: "private",
            reason: "arrival",
        });
        const deferredUntil = new Date(Date.now() + 60 * 60_000);
        await db()
            .update(asyncJobs)
            .set({ nextAttemptAt: deferredUntil })
            .where(
                and(
                    eq(asyncJobs.userId, USER_ID),
                    eq(asyncJobs.kind, PIPELINE_ADVANCE_JOB_KIND),
                    eq(asyncJobs.subjectId, ITEM_ID),
                ),
            );
        const requestedAt = new Date();

        const result = await requestAdvance({
            itemId: ITEM_ID,
            userId: USER_ID,
            view: "private",
            reason: "transcript",
        });

        expect(result).toEqual({ requestedGeneration: 2, enqueued: false });
        const [job] = await pipelineJobs();
        expect(job?.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
            requestedAt.getTime(),
        );
        expect(job?.nextAttemptAt.getTime()).toBeLessThan(
            deferredUntil.getTime(),
        );
    });

    it("increments exactly twice across parallel transactions", async () => {
        const results = await Promise.all([
            requestAdvance({
                itemId: ITEM_ID,
                userId: USER_ID,
                view: "private",
                reason: "arrival",
            }),
            requestAdvance({
                itemId: ITEM_ID,
                userId: USER_ID,
                view: "private",
                reason: "transcript",
            }),
        ]);

        expect(
            results.map((result) => result?.requestedGeneration).sort(),
        ).toEqual([1, 2]);
        expect(await processingRows()).toMatchObject([
            { requestedGeneration: 2 },
        ]);
        expect(await pipelineJobs()).toHaveLength(1);
    });

    it("does nothing for a wrong owner or deleted item", async () => {
        await expect(
            requestAdvance({
                itemId: ITEM_ID,
                userId: OTHER_USER_ID,
                view: "private",
                reason: "arrival",
            }),
        ).resolves.toBeNull();

        await db()
            .update(chatterItems)
            .set({ deletedAt: new Date("2026-10-14T01:00:00.000Z") })
            .where(
                and(
                    eq(chatterItems.id, ITEM_ID),
                    eq(chatterItems.userId, USER_ID),
                ),
            );
        await expect(
            requestAdvance({
                itemId: ITEM_ID,
                userId: USER_ID,
                view: "private",
                reason: "arrival",
            }),
        ).resolves.toBeNull();

        expect(await processingRows()).toEqual([]);
        expect(await pipelineJobs()).toEqual([]);
        expect(await pipelineJobs(OTHER_USER_ID)).toEqual([]);
    });

    it("keeps the Organization view and subject separate", async () => {
        await requestAdvance({
            itemId: ITEM_ID,
            userId: USER_ID,
            view: "private",
            reason: "arrival",
        });
        const result = await requestAdvance({
            itemId: ITEM_ID,
            userId: USER_ID,
            view: "org",
            reason: "learn-released",
        });

        expect(result).toEqual({ requestedGeneration: 1, enqueued: true });
        const rows = await processingRows();
        expect(rows).toHaveLength(2);
        expect(rows).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    view: "private",
                    requestedGeneration: 1,
                }),
                expect.objectContaining({
                    view: "org",
                    requestedGeneration: 1,
                }),
            ]),
        );
        const jobs = await pipelineJobs();
        expect(jobs).toHaveLength(2);
        expect(jobs).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ subjectId: ITEM_ID }),
                expect.objectContaining({
                    subjectId: `org:${ITEM_ID}`,
                    payload: {
                        itemId: ITEM_ID,
                        view: "org",
                        reason: "learn-released",
                    },
                }),
            ]),
        );
    });
});
