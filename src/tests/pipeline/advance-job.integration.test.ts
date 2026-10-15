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
import * as pipelineQueries from "@/db/queries/pipeline";
import {
    aiEnhancements,
    apiCredentials,
    asyncJobs,
    itemProcessing,
    transcriptions,
    userSettings,
    users,
} from "@/db/schema";
import { JobDeferredError } from "@/lib/jobs/retryable";
import * as summaryRefresh from "@/lib/learn/summary-refresh";
import { updatePhaseInTx } from "@/lib/pipeline/state";
import {
    PIPELINE_ADVANCE_JOB_KIND,
    requestAdvance,
} from "@/lib/pipeline/trigger";
import { insertRecordings } from "@/tests/integration/items";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const mocks = vi.hoisted(() => ({
    autoLearnMail: vi.fn(),
    enqueueTitleJob: vi.fn(),
    queueAutoSummary: vi.fn(),
    queueAutoTopics: vi.fn(),
}));

const { dbProxy, dbRef, mockEnv } = vi.hoisted(() => {
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
        mockEnv: {
            IS_HOSTED: false,
            SELF_HOST_MODE: "shared",
            ORG_ACCOUNT_EMAIL: "org@example.test",
            ORG_ACCOUNT_PASSWORD: "organization-password",
            DATABASE_URL: "postgres://unused",
            AUTO_SUMMARY_RATE_LIMIT_PER_HOUR: 20,
        },
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/encryption/fields", () => ({
    decryptJsonField: vi.fn((value: unknown) => value),
    decryptText: vi.fn((value: string | null) => value),
    encryptJsonField: vi.fn((value: unknown) => value),
    encryptText: vi.fn((value: string | null) => value),
}));
vi.mock("@/lib/mail/auto-process", () => ({
    autoLearnMail: mocks.autoLearnMail,
}));
vi.mock("@/lib/recordings/title-job", () => ({
    enqueueTitleJob: mocks.enqueueTitleJob,
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/summary/auto-summary", () => ({
    queueAutoSummary: mocks.queueAutoSummary,
}));
vi.mock("@/lib/topics/topics-job", () => ({
    queueAutoTopics: mocks.queueAutoTopics,
}));

import { pipelineAdvanceJobHandler } from "@/lib/pipeline/advance-job";
import { sweepStalledPipelines } from "@/lib/pipeline/sweep";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const USER_ID = "pipeline-advance-user";
const ITEM_ID = "pipeline-advance-item";

function jobContext(itemId = ITEM_ID) {
    return {
        jobId: `pipeline-job-${itemId}`,
        userId: USER_ID,
        attempt: 1,
        maxAttempts: 10,
        payload: { itemId, view: "private" as const, reason: "transcript" },
        signal: new AbortController().signal,
        reportProgress: vi.fn(),
    };
}

describeWithDatabase("pipeline.advance (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    async function seedAudio(itemId = ITEM_ID, revision = 1): Promise<void> {
        await insertRecordings(db(), {
            id: itemId,
            userId: USER_ID,
            deviceSn: `device-${itemId}`,
            plaudFileId: `plaud-${itemId}`,
            filename: `Recording ${itemId}`,
            duration: 1_000,
            startTime: new Date("2026-10-14T10:00:00.000Z"),
            endTime: new Date("2026-10-14T10:00:01.000Z"),
            filesize: 10,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: `${USER_ID}/${itemId}.mp3`,
            plaudVersion: "1",
        });
        await db()
            .insert(transcriptions)
            .values({
                id: `transcription-${itemId}`,
                recordingId: itemId,
                userId: USER_ID,
                text: "Transcript",
                turns: [{ speaker: "speaker_0", startMs: 0, endMs: 1_000 }],
                provider: "test",
                model: "test",
                source: "riffado",
                revision,
            });
    }

    async function processing(itemId = ITEM_ID) {
        const [row] = await db()
            .select()
            .from(itemProcessing)
            .where(
                and(
                    eq(itemProcessing.itemId, itemId),
                    eq(itemProcessing.userId, USER_ID),
                    eq(itemProcessing.view, "private"),
                ),
            )
            .limit(1);
        return row;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "pipeline_advance",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        vi.restoreAllMocks();
        vi.clearAllMocks();
        mocks.autoLearnMail.mockResolvedValue(undefined);
        mocks.enqueueTitleJob.mockResolvedValue(undefined);
        mocks.queueAutoSummary.mockResolvedValue(undefined);
        mocks.queueAutoTopics.mockResolvedValue(undefined);

        await db().delete(users);
        await db().insert(users).values({
            id: USER_ID,
            email: "pipeline-advance@example.test",
        });
        await db().insert(userSettings).values({
            userId: USER_ID,
            autoDetectTopics: true,
            autoGenerateTitle: true,
            autoSummarize: true,
            autoSummarizePreset: "meeting-notes",
        });
        await db().insert(apiCredentials).values({
            userId: USER_ID,
            provider: "openai",
            apiKey: "test-key",
            defaultModel: "test-model",
            isDefaultEnhancement: true,
        });
    });

    it("loops when a trigger arrives after the generation read", async () => {
        await seedAudio();
        await requestAdvance({
            itemId: ITEM_ID,
            userId: USER_ID,
            view: "private",
            reason: "transcript",
        });
        mocks.queueAutoTopics.mockImplementationOnce(async () => {
            await requestAdvance({
                itemId: ITEM_ID,
                userId: USER_ID,
                view: "private",
                reason: "transcript",
            });
        });

        await pipelineAdvanceJobHandler.run(jobContext());

        expect(await processing()).toMatchObject({
            requestedGeneration: 2,
            processedGeneration: 2,
        });
        expect(mocks.queueAutoTopics).toHaveBeenCalledOnce();
        expect(mocks.queueAutoSummary).toHaveBeenCalledOnce();
    });

    it("keeps one active driver job per item and view", async () => {
        await seedAudio();
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

        expect(first?.enqueued).toBe(true);
        expect(second?.enqueued).toBe(false);
        const jobs = await db()
            .select()
            .from(asyncJobs)
            .where(
                and(
                    eq(asyncJobs.userId, USER_ID),
                    eq(asyncJobs.kind, PIPELINE_ADVANCE_JOB_KIND),
                    inArray(asyncJobs.status, ["pending", "processing"]),
                ),
            );
        expect(jobs).toHaveLength(1);
    });

    it("does not repeat queue actions after a crash before the final check", async () => {
        await seedAudio();
        await requestAdvance({
            itemId: ITEM_ID,
            userId: USER_ID,
            view: "private",
            reason: "transcript",
        });
        const finalCheck = vi
            .spyOn(pipelineQueries, "completeProcessingGenerationInTx")
            .mockRejectedValueOnce(new Error("simulated crash"));

        await expect(
            pipelineAdvanceJobHandler.run(jobContext()),
        ).rejects.toThrow("simulated crash");
        finalCheck.mockRestore();
        await pipelineAdvanceJobHandler.run(jobContext());

        expect(mocks.queueAutoTopics).toHaveBeenCalledOnce();
        expect(mocks.queueAutoSummary).toHaveBeenCalledOnce();
        expect(await processing()).toMatchObject({
            requestedGeneration: 1,
            processedGeneration: 1,
        });
    });

    it("runs the synchronously released Learn path exactly once", async () => {
        await seedAudio();
        const requested = await requestAdvance({
            itemId: ITEM_ID,
            userId: USER_ID,
            view: "private",
            reason: "learn-released",
        });
        await db().transaction((tx) =>
            updatePhaseInTx(tx, ITEM_ID, "private", USER_ID, "learn", {
                state: "done",
                reason: "released",
                generation: requested?.requestedGeneration ?? 1,
                inputs: {
                    contentId: `transcription-${ITEM_ID}`,
                    contentSourceId: "riffado",
                    contentRevision: 1,
                },
                at: new Date().toISOString(),
            }),
        );

        await pipelineAdvanceJobHandler.run(jobContext());
        await pipelineAdvanceJobHandler.run(jobContext());

        expect(mocks.queueAutoSummary).toHaveBeenCalledOnce();
        expect(mocks.queueAutoSummary).toHaveBeenCalledWith(
            USER_ID,
            ITEM_ID,
            null,
            { strict: true },
        );
        expect(mocks.queueAutoTopics).toHaveBeenCalledOnce();
        expect(mocks.queueAutoTopics).toHaveBeenCalledWith(
            USER_ID,
            ITEM_ID,
            "riffado",
            { strict: true },
        );
        expect(mocks.enqueueTitleJob).toHaveBeenCalledOnce();
    });

    it("queues transcript follow-ups again after the content row is replaced", async () => {
        await seedAudio(ITEM_ID, 0);
        await requestAdvance({
            itemId: ITEM_ID,
            userId: USER_ID,
            view: "private",
            reason: "transcript",
        });
        await pipelineAdvanceJobHandler.run(jobContext());

        await db()
            .delete(transcriptions)
            .where(
                and(
                    eq(transcriptions.recordingId, ITEM_ID),
                    eq(transcriptions.userId, USER_ID),
                ),
            );
        await db()
            .insert(transcriptions)
            .values({
                id: "replacement-transcription",
                recordingId: ITEM_ID,
                userId: USER_ID,
                text: "Replacement transcript",
                turns: [{ speaker: "speaker_0", startMs: 0, endMs: 1_000 }],
                provider: "test",
                model: "test",
                source: "riffado",
            });
        await requestAdvance({
            itemId: ITEM_ID,
            userId: USER_ID,
            view: "private",
            reason: "transcript",
        });

        await pipelineAdvanceJobHandler.run(jobContext());

        expect(mocks.queueAutoTopics).toHaveBeenCalledTimes(2);
        expect(mocks.queueAutoSummary).toHaveBeenCalledTimes(2);
    });

    it("ignores a Learn release belonging to an erased content row", async () => {
        await seedAudio(ITEM_ID, 0);
        const requested = await requestAdvance({
            itemId: ITEM_ID,
            userId: USER_ID,
            view: "private",
            reason: "learn-released",
        });
        await db().transaction((tx) =>
            updatePhaseInTx(tx, ITEM_ID, "private", USER_ID, "learn", {
                state: "done",
                reason: "released",
                generation: requested?.requestedGeneration ?? 1,
                inputs: {
                    contentId: `transcription-${ITEM_ID}`,
                    contentSourceId: "riffado",
                    contentRevision: 0,
                },
                at: new Date().toISOString(),
            }),
        );
        await pipelineAdvanceJobHandler.run(jobContext());

        await db()
            .delete(transcriptions)
            .where(
                and(
                    eq(transcriptions.recordingId, ITEM_ID),
                    eq(transcriptions.userId, USER_ID),
                ),
            );
        await db()
            .insert(transcriptions)
            .values({
                id: "post-release-transcription",
                recordingId: ITEM_ID,
                userId: USER_ID,
                text: "Replacement transcript",
                turns: [{ speaker: "speaker_0", startMs: 0, endMs: 1_000 }],
                provider: "test",
                model: "test",
                source: "riffado",
            });
        await requestAdvance({
            itemId: ITEM_ID,
            userId: USER_ID,
            view: "private",
            reason: "transcript",
        });

        await pipelineAdvanceJobHandler.run(jobContext());

        expect(mocks.queueAutoTopics).toHaveBeenLastCalledWith(
            USER_ID,
            ITEM_ID,
            "riffado",
        );
        expect(mocks.queueAutoSummary).toHaveBeenLastCalledWith(
            USER_ID,
            ITEM_ID,
            null,
        );
    });

    it("stops between actions when the worker attempt is aborted", async () => {
        await seedAudio();
        await requestAdvance({
            itemId: ITEM_ID,
            userId: USER_ID,
            view: "private",
            reason: "transcript",
        });
        const controller = new AbortController();
        const abandoned = new Error("worker abandoned");
        mocks.queueAutoTopics.mockImplementationOnce(async () => {
            controller.abort(abandoned);
        });

        await expect(
            pipelineAdvanceJobHandler.run({
                ...jobContext(),
                signal: controller.signal,
            }),
        ).rejects.toBe(abandoned);
        expect(mocks.queueAutoSummary).not.toHaveBeenCalled();
        expect((await processing())?.phases).toEqual({});
    });

    it("does not check summary staleness outside the Learn release path", async () => {
        await seedAudio();
        await db()
            .insert(aiEnhancements)
            .values({
                itemId: ITEM_ID,
                userId: USER_ID,
                transcriptionId: `transcription-${ITEM_ID}`,
                summary: "Existing summary",
                provider: "test",
                model: "test",
                source: "riffado",
            });
        const stale = vi
            .spyOn(summaryRefresh, "isSummaryStale")
            .mockResolvedValue(true);
        await requestAdvance({
            itemId: ITEM_ID,
            userId: USER_ID,
            view: "private",
            reason: "transcript",
        });

        await pipelineAdvanceJobHandler.run(jobContext());

        expect(stale).not.toHaveBeenCalled();
    });

    it("checks summary staleness for the current released content", async () => {
        await seedAudio();
        await db()
            .insert(aiEnhancements)
            .values({
                itemId: ITEM_ID,
                userId: USER_ID,
                transcriptionId: `transcription-${ITEM_ID}`,
                summary: "Existing summary",
                provider: "test",
                model: "test",
                source: "riffado",
            });
        const requested = await requestAdvance({
            itemId: ITEM_ID,
            userId: USER_ID,
            view: "private",
            reason: "learn-released",
        });
        await db().transaction((tx) =>
            updatePhaseInTx(tx, ITEM_ID, "private", USER_ID, "learn", {
                state: "done",
                reason: "released",
                generation: requested?.requestedGeneration ?? 1,
                inputs: {
                    contentId: `transcription-${ITEM_ID}`,
                    contentSourceId: "riffado",
                    contentRevision: 1,
                },
                at: new Date().toISOString(),
            }),
        );
        const stale = vi
            .spyOn(summaryRefresh, "isSummaryStale")
            .mockResolvedValue(true);

        await pipelineAdvanceJobHandler.run(jobContext());

        expect(stale).toHaveBeenCalledWith(USER_ID, ITEM_ID);
    });

    it("sweeps only old, unclaimed, non-poison stalled rows", async () => {
        const ids = {
            stalled: "pipeline-sweep-stalled",
            healthy: "pipeline-sweep-healthy",
            active: "pipeline-sweep-active",
            fresh: "pipeline-sweep-fresh",
            poison: "pipeline-sweep-poison",
        };
        for (const itemId of Object.values(ids)) await seedAudio(itemId);
        const now = new Date();
        const old = new Date(now.getTime() - 3 * 60_000);
        await db()
            .insert(itemProcessing)
            .values([
                {
                    itemId: ids.stalled,
                    userId: USER_ID,
                    view: "private",
                    requestedGeneration: 2,
                    processedGeneration: 1,
                    updatedAt: old,
                },
                {
                    itemId: ids.healthy,
                    userId: USER_ID,
                    view: "private",
                    requestedGeneration: 2,
                    processedGeneration: 2,
                    updatedAt: old,
                },
                {
                    itemId: ids.active,
                    userId: USER_ID,
                    view: "private",
                    requestedGeneration: 2,
                    processedGeneration: 1,
                    updatedAt: old,
                },
                {
                    itemId: ids.fresh,
                    userId: USER_ID,
                    view: "private",
                    requestedGeneration: 2,
                    processedGeneration: 1,
                    updatedAt: now,
                },
                {
                    itemId: ids.poison,
                    userId: USER_ID,
                    view: "private",
                    requestedGeneration: 2,
                    processedGeneration: 1,
                    updatedAt: old,
                },
            ]);
        await db()
            .insert(asyncJobs)
            .values({
                userId: USER_ID,
                kind: PIPELINE_ADVANCE_JOB_KIND,
                subjectId: ids.active,
                payload: { itemId: ids.active, view: "private" },
                maxAttempts: 10,
            });
        await db()
            .insert(asyncJobs)
            .values(
                Array.from({ length: 3 }, (_, index) => ({
                    id: `failed-pipeline-${index}`,
                    userId: USER_ID,
                    kind: PIPELINE_ADVANCE_JOB_KIND,
                    subjectId: ids.poison,
                    payload: { itemId: ids.poison, view: "private" },
                    status: "failed" as const,
                    attempts: 10,
                    maxAttempts: 10,
                    completedAt: new Date(now.getTime() - 60_000),
                })),
            );

        await expect(sweepStalledPipelines()).resolves.toBe(1);

        const activeJobs = await db()
            .select({ subjectId: asyncJobs.subjectId })
            .from(asyncJobs)
            .where(
                and(
                    eq(asyncJobs.userId, USER_ID),
                    eq(asyncJobs.kind, PIPELINE_ADVANCE_JOB_KIND),
                    inArray(asyncJobs.status, ["pending", "processing"]),
                ),
            );
        expect(activeJobs.map((job) => job.subjectId).sort()).toEqual(
            [ids.active, ids.stalled].sort(),
        );
    });

    it("defers after ten unstable iterations", async () => {
        await seedAudio();
        await requestAdvance({
            itemId: ITEM_ID,
            userId: USER_ID,
            view: "private",
            reason: "transcript",
        });
        const finalCheck = vi
            .spyOn(pipelineQueries, "completeProcessingGenerationInTx")
            .mockResolvedValue("changed");

        await expect(
            pipelineAdvanceJobHandler.run(jobContext()),
        ).rejects.toBeInstanceOf(JobDeferredError);
        expect(finalCheck).toHaveBeenCalledTimes(10);
    });

    it("uses the release handler resource limits", () => {
        expect(pipelineAdvanceJobHandler).toMatchObject({
            kind: PIPELINE_ADVANCE_JOB_KIND,
            concurrency: 2,
            maxAttempts: 10,
            timeoutMs: 60_000,
            backoff: { baseMs: 10_000, maxMs: 300_000, jitter: 0.3 },
        });
    });
});
