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
import { insertAudioItem } from "@/db/items";
import { asyncJobs, chatterItems, itemProcessing, users } from "@/db/schema";
import { pipelineAdvanceJobHandler } from "@/lib/pipeline/advance-job";
import { upsertTranscription } from "@/lib/transcription/persist";
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
vi.mock("@/lib/env", () => ({
    env: {
        IS_HOSTED: false,
        SELF_HOST_MODE: "shared",
        ORG_ACCOUNT_EMAIL: "org@example.test",
        ORG_ACCOUNT_PASSWORD: "organization-password",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
        DATABASE_URL: "postgres://unused",
    },
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
    captureServerException: vi.fn(),
}));

import {
    PIPELINE_ADVANCE_JOB_KIND,
    requestAdvance,
    requestAdvanceForViewInTx,
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

    it("routes an Organization content event to the owner's existing private driver", async () => {
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
        expect(result).toEqual({ requestedGeneration: 2, enqueued: false });
        expect(await processingRows()).toMatchObject([
            { view: "private", requestedGeneration: 2 },
        ]);
        expect(await pipelineJobs()).toMatchObject([
            { subjectId: ITEM_ID, payload: { view: "private" } },
        ]);
        expect(await processingRows()).toHaveLength(1);
        expect(await pipelineJobs()).toHaveLength(1);
    });

    it("keeps exact-view maintenance separate for legacy Organization rows", async () => {
        await requestAdvance({
            itemId: ITEM_ID,
            userId: USER_ID,
            view: "private",
            reason: "arrival",
        });
        await db().transaction((tx) =>
            requestAdvanceForViewInTx(tx, {
                itemId: ITEM_ID,
                userId: USER_ID,
                view: "org",
                reason: "summary-step-failed",
            }),
        );
        expect(await processingRows()).toHaveLength(2);
        expect(await pipelineJobs()).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ subjectId: ITEM_ID }),
                expect.objectContaining({
                    subjectId: `org:${ITEM_ID}`,
                    payload: {
                        itemId: ITEM_ID,
                        view: "org",
                        reason: "summary-step-failed",
                    },
                }),
            ]),
        );
    });

    it("advances a newly inserted audio item to Categorize waiting", async () => {
        const itemId = "pipeline-arrival-audio";
        await insertAudioItem(
            db(),
            {
                id: itemId,
                userId: USER_ID,
                deviceSn: "upload",
                plaudFileId: "upload-pipeline-arrival-audio",
                title: "Arrival audio",
                duration: 1_000,
                occurredAt: new Date("2026-10-14T02:00:00.000Z"),
                endTime: new Date("2026-10-14T02:00:01.000Z"),
                filesize: 100,
                fileMd5: "0".repeat(32),
                storageType: "local",
                storagePath: `${USER_ID}/${itemId}.mp3`,
                plaudVersion: "1",
            },
            { pipeline: "arrival" },
        );

        await pipelineAdvanceJobHandler.run({
            jobId: "arrival-job",
            userId: USER_ID,
            payload: {
                itemId,
                view: "private",
                reason: "arrival",
            },
            attempt: 1,
            maxAttempts: 10,
            signal: new AbortController().signal,
            reportProgress: vi.fn(),
        });

        const [processing] = await db()
            .select()
            .from(itemProcessing)
            .where(
                and(
                    eq(itemProcessing.itemId, itemId),
                    eq(itemProcessing.userId, USER_ID),
                ),
            );
        expect(processing?.phases.categorize).toMatchObject({
            state: "waiting",
            reason: "needs_folder",
        });
    });

    it("leaves a restored audio item on the legacy path", async () => {
        const itemId = "pipeline-legacy-audio";
        await insertAudioItem(
            db(),
            {
                id: itemId,
                userId: USER_ID,
                deviceSn: "restore",
                plaudFileId: "restore-pipeline-legacy-audio",
                title: "Restored audio",
                duration: 1_000,
                occurredAt: new Date("2026-10-14T03:00:00.000Z"),
                endTime: new Date("2026-10-14T03:00:01.000Z"),
                filesize: 100,
                fileMd5: "1".repeat(32),
                storageType: "local",
                storagePath: `${USER_ID}/${itemId}.mp3`,
                plaudVersion: "1",
            },
            { pipeline: "legacy" },
        );
        await upsertTranscription({
            userId: USER_ID,
            recordingId: itemId,
            text: "Restored transcript",
            detectedLanguage: "en",
            source: "riffado",
            provider: "restore",
            model: "restore",
            pipeline: "legacy",
        });

        expect(
            await db()
                .select()
                .from(itemProcessing)
                .where(eq(itemProcessing.itemId, itemId)),
        ).toEqual([]);
        expect(
            (await pipelineJobs()).some((job) => job.subjectId === itemId),
        ).toBe(false);
    });
});
