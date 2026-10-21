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
    chatterItems,
    folderDefaultProfiles,
    itemProcessing,
    learnRuns,
    mailContents,
    mailMessages,
    mailPendingShares,
    processingProfileRevisions,
    recordingFolderAssignments,
    recordingFolders,
    recordings,
    recordingTaskRejections,
    transcriptions,
    transcriptSpeakers,
    userSettings,
    users,
} from "@/db/schema";
import { addRecordingToFolder } from "@/lib/folders/folders";
import { JobDeferredError } from "@/lib/jobs/retryable";
import * as summaryRefresh from "@/lib/learn/summary-refresh";
import { gatherFacts } from "@/lib/pipeline/facts";
import { planAdvance } from "@/lib/pipeline/plan";
import { updatePhaseInTx } from "@/lib/pipeline/state";
import {
    PIPELINE_ADVANCE_JOB_KIND,
    requestAdvance,
} from "@/lib/pipeline/trigger";
import {
    resolveDefaultProfile,
    resolveItemProfile,
} from "@/lib/profiles/resolve";
import { defaultProfileSettings } from "@/lib/profiles/settings";
import { taskFingerprint } from "@/lib/tasks/proposals";
import { insertRecordings } from "@/tests/integration/items";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const mocks = vi.hoisted(() => ({
    autoLearnMail: vi.fn(),
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
            API_TOKEN_HASH_SECRET: "pipeline-advance-test-secret",
            BETTER_AUTH_SECRET: "pipeline-advance-test-secret",
        },
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/encryption", () => ({
    decrypt: vi.fn((value: string) => value),
}));
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
    TITLE_JOB_KIND: "title.generate",
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/summary/auto-summary", () => ({
    queueAutoSummary: mocks.queueAutoSummary,
}));
vi.mock("@/lib/topics/topics-job", () => ({
    TOPICS_JOB_KIND: "topics",
    queueAutoTopics: mocks.queueAutoTopics,
}));

import { pipelineAdvanceJobHandler } from "@/lib/pipeline/advance-job";
import {
    sweepAutomaticTranscriptionRetries,
    sweepOrphanedPipelineSteps,
    sweepStalledPipelines,
} from "@/lib/pipeline/sweep";
import { TRANSCRIPTION_JOB_KIND } from "@/lib/transcription/transcription-job";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const USER_ID = "pipeline-advance-user";
const ITEM_ID = "pipeline-advance-item";

function jobContext(itemId = ITEM_ID, reason = "transcript") {
    return {
        jobId: `pipeline-job-${itemId}`,
        userId: USER_ID,
        attempt: 1,
        maxAttempts: 10,
        payload: { itemId, view: "private" as const, reason },
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

    async function seedAudio(
        itemId = ITEM_ID,
        revision = 1,
        categorized = true,
    ): Promise<void> {
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
        if (!categorized) return;
        const profile = await resolveDefaultProfile(USER_ID, "audio");
        await db().insert(recordingFolderAssignments).values({
            userId: USER_ID,
            itemId,
            folderId: "pipeline-folder",
        });
        await db()
            .insert(itemProcessing)
            .values({
                itemId,
                userId: USER_ID,
                view: "private",
                profileId: profile.profile.id,
                profileRevisionId: profile.revisionId,
                phases: {
                    categorize: {
                        state: "done",
                        reason: "categorized",
                        generation: 0,
                        at: new Date().toISOString(),
                    },
                },
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

    async function seedPlaudTaskPipeline(
        actionItems: unknown[],
        itemId = ITEM_ID,
    ): Promise<void> {
        await seedAudio(itemId);
        const current = await processing(itemId);
        if (!current?.profileRevisionId) {
            throw new Error("expected a frozen profile revision");
        }
        const settings = defaultProfileSettings("audio");
        settings.steps.title = { ...settings.steps.title, automatic: false };
        settings.steps.topics = {
            ...settings.steps.topics,
            automatic: false,
        };
        settings.steps.summary = {
            ...settings.steps.summary,
            automatic: true,
        };
        await db()
            .update(processingProfileRevisions)
            .set({ settings: JSON.stringify(settings) })
            .where(
                eq(processingProfileRevisions.id, current.profileRevisionId),
            );
        await db()
            .delete(apiCredentials)
            .where(eq(apiCredentials.userId, USER_ID));
        await db()
            .insert(aiEnhancements)
            .values({
                itemId,
                userId: USER_ID,
                transcriptionId: `transcription-${itemId}`,
                summary: "Plaud summary",
                actionItems,
                keyPoints: [],
                provider: "plaud",
                model: "plaud-native",
                source: "plaud",
            });
        await db()
            .insert(transcriptSpeakers)
            .values({
                userId: USER_ID,
                transcriptionId: `transcription-${itemId}`,
                label: "speaker_0",
                personId: null,
                source: "user",
                status: "confirmed",
                markedUnknown: true,
                confirmedByUserId: USER_ID,
            });
        await db().insert(mailPendingShares).values({
            userId: USER_ID,
            itemId,
            folderId: "pipeline-folder",
        });
        await requestAdvance({
            itemId,
            userId: USER_ID,
            view: "private",
            reason: "summary",
        });
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
        mockEnv.IS_HOSTED = false;
        mocks.autoLearnMail.mockResolvedValue({ status: "started" });
        mocks.queueAutoSummary.mockResolvedValue(undefined);
        mocks.queueAutoTopics.mockResolvedValue(undefined);

        await db().delete(users);
        await db().insert(users).values({
            id: USER_ID,
            email: "pipeline-advance@example.test",
        });
        await db().insert(userSettings).values({
            userId: USER_ID,
            autoTranscribe: true,
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
        await db()
            .insert(recordingFolders)
            .values([
                {
                    id: "pipeline-root",
                    userId: USER_ID,
                    parentId: null,
                    name: "Private",
                    nameHash: "pipeline-root-hash",
                    kind: "private",
                },
                {
                    id: "pipeline-folder",
                    userId: USER_ID,
                    parentId: "pipeline-root",
                    name: "Pipeline",
                    nameHash: "pipeline-folder-hash",
                    kind: "custom",
                },
            ]);
    });

    it("skips Learn as hosted and still queues Summary", async () => {
        mockEnv.IS_HOSTED = true;
        await db()
            .update(userSettings)
            .set({ autoLearn: true })
            .where(eq(userSettings.userId, USER_ID));
        await seedAudio();
        await requestAdvance({
            itemId: ITEM_ID,
            userId: USER_ID,
            view: "private",
            reason: "transcript",
        });

        await pipelineAdvanceJobHandler.run(jobContext());

        expect((await processing())?.phases.learn).toMatchObject({
            state: "skipped",
            reason: "hosted",
        });
        expect(mocks.queueAutoSummary).toHaveBeenCalledOnce();
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

    it("freezes the resolved profile and processes an item filed through the folder toggle", async () => {
        await seedAudio(ITEM_ID, 1, false);
        await requestAdvance({
            itemId: ITEM_ID,
            userId: USER_ID,
            view: "private",
            reason: "arrival",
        });
        await pipelineAdvanceJobHandler.run(jobContext(ITEM_ID, "arrival"));
        const profile = await resolveDefaultProfile(USER_ID, "audio");
        await db().insert(folderDefaultProfiles).values({
            folderId: "pipeline-folder",
            channel: "audio",
            profileId: profile.profile.id,
        });

        await addRecordingToFolder({
            userId: USER_ID,
            recordingId: ITEM_ID,
            folderId: "pipeline-folder",
        });
        await pipelineAdvanceJobHandler.run(jobContext());

        expect(await processing()).toMatchObject({
            profileId: profile.profile.id,
            profileRevisionId: profile.revisionId,
            phases: {
                categorize: expect.objectContaining({
                    state: "done",
                    reason: "categorized",
                }),
            },
        });
        expect(mocks.queueAutoSummary).toHaveBeenCalledOnce();
    });

    it("waits with needs_profile when folder defaults conflict", async () => {
        await seedAudio(ITEM_ID, 1, false);
        await requestAdvance({
            itemId: ITEM_ID,
            userId: USER_ID,
            view: "private",
            reason: "arrival",
        });
        await pipelineAdvanceJobHandler.run(jobContext(ITEM_ID, "arrival"));
        const profile = await resolveDefaultProfile(USER_ID, "audio");
        await db().insert(recordingFolders).values({
            id: "pipeline-folder-2",
            userId: USER_ID,
            parentId: "pipeline-root",
            name: "Pipeline 2",
            nameHash: "pipeline-folder-2-hash",
            kind: "custom",
        });
        await db()
            .insert(folderDefaultProfiles)
            .values([
                {
                    folderId: "pipeline-folder",
                    channel: "audio",
                    profileId: profile.profile.id,
                },
                {
                    folderId: "pipeline-folder-2",
                    channel: "audio",
                    manualOnly: true,
                },
            ]);
        await db()
            .insert(recordingFolderAssignments)
            .values([
                {
                    userId: USER_ID,
                    itemId: ITEM_ID,
                    folderId: "pipeline-folder",
                },
                {
                    userId: USER_ID,
                    itemId: ITEM_ID,
                    folderId: "pipeline-folder-2",
                },
            ]);
        await requestAdvance({
            itemId: ITEM_ID,
            userId: USER_ID,
            view: "private",
            reason: "placement",
        });

        await pipelineAdvanceJobHandler.run(jobContext());

        expect(await processing()).toMatchObject({
            profileId: null,
            phases: {
                categorize: expect.objectContaining({
                    state: "waiting",
                    reason: "needs_profile",
                }),
            },
        });
        expect(mocks.queueAutoSummary).not.toHaveBeenCalled();
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

    it("settles a non-Organization share intent as unavailable without deferring", async () => {
        await db()
            .update(userSettings)
            .set({
                autoLearn: false,
                autoSummarize: false,
                autoDetectTopics: false,
                autoGenerateTitle: false,
            })
            .where(eq(userSettings.userId, USER_ID));
        await seedAudio();
        await db()
            .insert(transcriptSpeakers)
            .values({
                userId: USER_ID,
                transcriptionId: `transcription-${ITEM_ID}`,
                label: "speaker_0",
                personId: null,
                source: "user",
                status: "confirmed",
                markedUnknown: true,
                confirmedByUserId: USER_ID,
            });
        await db().insert(mailPendingShares).values({
            userId: USER_ID,
            itemId: ITEM_ID,
            folderId: "pipeline-folder",
        });
        await requestAdvance({
            itemId: ITEM_ID,
            userId: USER_ID,
            view: "private",
            reason: "placement",
        });

        await expect(
            pipelineAdvanceJobHandler.run(jobContext()),
        ).resolves.toMatchObject({ processedGeneration: 1 });
        expect((await processing())?.phases.share).toMatchObject({
            state: "waiting",
            reason: "org_unavailable",
        });
        expect(
            await db()
                .select()
                .from(mailPendingShares)
                .where(eq(mailPendingShares.itemId, ITEM_ID)),
        ).toHaveLength(1);
    });

    it("settles Task review and reaches the share gate when Plaud proposals are filtered out", async () => {
        const actionItem = "Already rejected by the task validator";
        await seedPlaudTaskPipeline([actionItem]);
        await db()
            .insert(recordingTaskRejections)
            .values({
                userId: USER_ID,
                itemId: ITEM_ID,
                fingerprintHmac: taskFingerprint(actionItem),
            });

        await expect(
            pipelineAdvanceJobHandler.run(jobContext()),
        ).resolves.toMatchObject({ processedGeneration: 2 });

        expect((await processing())?.phases).toMatchObject({
            taskReview: { state: "done", reason: "reviewed" },
            share: { state: "waiting", reason: "org_unavailable" },
        });
    });

    it("waits for Task review and blocks sharing when Plaud proposals are valid", async () => {
        await seedPlaudTaskPipeline(["Draft the final report"]);

        await expect(
            pipelineAdvanceJobHandler.run(jobContext()),
        ).resolves.toMatchObject({ processedGeneration: 2 });

        expect((await processing())?.phases).toMatchObject({
            taskReview: { state: "waiting", reason: "needs_review" },
            share: {
                state: "waiting",
                reason: "gate_blocked",
                problems: [
                    expect.objectContaining({ kind: "tasks_unreviewed" }),
                ],
            },
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
            { strict: true },
        );
        expect(mocks.queueAutoSummary).toHaveBeenLastCalledWith(
            USER_ID,
            ITEM_ID,
            null,
            { strict: true },
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
        expect((await processing())?.phases).toMatchObject({
            categorize: { state: "done", reason: "categorized" },
            transcribe: { state: "done", reason: "content-available" },
            learn: { state: "skipped", reason: "profile_off" },
        });
    });

    it("checks an existing summary for a later Learn decision", async () => {
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
            .spyOn(summaryRefresh, "staleReadingFingerprint")
            .mockResolvedValue("current-reading");
        await requestAdvance({
            itemId: ITEM_ID,
            userId: USER_ID,
            view: "private",
            reason: "transcript",
        });

        await pipelineAdvanceJobHandler.run(jobContext());

        expect(stale).toHaveBeenCalledWith(
            expect.objectContaining({
                transcriptionId: `transcription-${ITEM_ID}`,
            }),
        );
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
            .spyOn(summaryRefresh, "staleReadingFingerprint")
            .mockResolvedValue("current-reading");

        await pipelineAdvanceJobHandler.run(jobContext());

        expect(stale).toHaveBeenCalledWith(
            expect.objectContaining({
                transcriptionId: `transcription-${ITEM_ID}`,
            }),
        );
    });

    it("does not recreate a reaped transcript after a placement trigger", async () => {
        await seedAudio();
        await db()
            .delete(transcriptions)
            .where(
                and(
                    eq(transcriptions.recordingId, ITEM_ID),
                    eq(transcriptions.userId, USER_ID),
                ),
            );
        await db()
            .update(chatterItems)
            .set({ contentReapedAt: new Date() })
            .where(
                and(
                    eq(chatterItems.id, ITEM_ID),
                    eq(chatterItems.userId, USER_ID),
                ),
            );
        await requestAdvance({
            itemId: ITEM_ID,
            userId: USER_ID,
            view: "private",
            reason: "placement",
        });

        await pipelineAdvanceJobHandler.run(jobContext());

        expect((await processing())?.phases.transcribe).toMatchObject({
            state: "skipped",
            reason: "content_reaped",
        });
        expect(
            await db()
                .select()
                .from(asyncJobs)
                .where(
                    and(
                        eq(asyncJobs.userId, USER_ID),
                        eq(asyncJobs.kind, TRANSCRIPTION_JOB_KIND),
                        eq(asyncJobs.subjectId, ITEM_ID),
                    ),
                ),
        ).toEqual([]);
    });

    it("leaves a triggered legacy item without a transcript idle", async () => {
        await seedAudio();
        await db()
            .delete(transcriptions)
            .where(
                and(
                    eq(transcriptions.recordingId, ITEM_ID),
                    eq(transcriptions.userId, USER_ID),
                ),
            );
        await db()
            .update(itemProcessing)
            .set({
                profileId: null,
                profileRevisionId: null,
                phases: {
                    categorize: {
                        state: "done",
                        reason: "legacy",
                        generation: 0,
                        at: new Date().toISOString(),
                    },
                },
            })
            .where(
                and(
                    eq(itemProcessing.itemId, ITEM_ID),
                    eq(itemProcessing.userId, USER_ID),
                    eq(itemProcessing.view, "private"),
                ),
            );
        await requestAdvance({
            itemId: ITEM_ID,
            userId: USER_ID,
            view: "private",
            reason: "placement",
        });

        await pipelineAdvanceJobHandler.run(jobContext());

        expect(
            await db()
                .select()
                .from(asyncJobs)
                .where(
                    and(
                        eq(asyncJobs.userId, USER_ID),
                        eq(asyncJobs.kind, TRANSCRIPTION_JOB_KIND),
                        eq(asyncJobs.subjectId, ITEM_ID),
                    ),
                ),
        ).toEqual([]);
    });

    it("preserves legacy state when the first trigger creates an empty processing row", async () => {
        await seedAudio(ITEM_ID, 1, false);

        await requestAdvance({
            itemId: ITEM_ID,
            userId: USER_ID,
            view: "private",
            reason: "placement",
        });
        await pipelineAdvanceJobHandler.run(jobContext());

        expect((await processing())?.phases).toMatchObject({
            categorize: { state: "skipped", reason: "legacy" },
            learn: { state: "done", reason: "legacy" },
            summary: { state: "done", reason: "legacy" },
        });
        expect(mocks.queueAutoTopics).not.toHaveBeenCalled();
        expect(mocks.queueAutoSummary).not.toHaveBeenCalled();
    });

    it("finishes a Learn hold that started before the legacy cutover without filing", async () => {
        await seedAudio(ITEM_ID, 1, false);
        const cutover = new Date("2026-10-15T10:00:00.000Z");
        const input = {
            contentId: `transcription-${ITEM_ID}`,
            contentSourceId: "riffado",
            contentRevision: 1,
        };
        await db()
            .insert(itemProcessing)
            .values({
                itemId: ITEM_ID,
                userId: USER_ID,
                view: "private",
                phases: {
                    categorize: {
                        state: "skipped",
                        reason: "legacy",
                        generation: 0,
                        at: cutover.toISOString(),
                    },
                    learn: {
                        state: "done",
                        reason: "released",
                        generation: 1,
                        inputs: input,
                        at: "2026-10-15T10:01:00.000Z",
                    },
                    summary: {
                        state: "done",
                        reason: "legacy",
                        generation: 0,
                        inputs: input,
                        steps: {
                            title: { ...input, generation: 0 },
                            topics: { ...input, generation: 0 },
                            summary: { ...input, generation: 0 },
                        },
                        at: cutover.toISOString(),
                    },
                },
            });
        await db()
            .insert(learnRuns)
            .values({
                id: "pre-cutover-learn",
                userId: USER_ID,
                scopeUserId: USER_ID,
                itemId: ITEM_ID,
                transcriptionId: input.contentId,
                view: "private",
                actorUserId: USER_ID,
                trigger: "auto",
                transcriptRevision: 1,
                vocabularyVersion: 0,
                status: "finished",
                createdAt: new Date("2026-10-15T09:59:00.000Z"),
            });
        await requestAdvance({
            itemId: ITEM_ID,
            userId: USER_ID,
            view: "private",
            reason: "learn-released",
        });

        await pipelineAdvanceJobHandler.run(jobContext());

        expect(mocks.queueAutoTopics).toHaveBeenCalledOnce();
        expect(mocks.queueAutoSummary).toHaveBeenCalledOnce();
        expect((await processing())?.phases.categorize).toMatchObject({
            state: "skipped",
            reason: "legacy",
        });
    });

    it("waits for filing when a Learn run started after the legacy cutover", async () => {
        await seedAudio(ITEM_ID, 1, false);
        const cutover = new Date("2026-10-15T10:00:00.000Z");
        const input = {
            contentId: `transcription-${ITEM_ID}`,
            contentSourceId: "riffado",
            contentRevision: 1,
        };
        await db()
            .insert(itemProcessing)
            .values({
                itemId: ITEM_ID,
                userId: USER_ID,
                view: "private",
                phases: {
                    categorize: {
                        state: "skipped",
                        reason: "legacy",
                        generation: 0,
                        at: cutover.toISOString(),
                    },
                    learn: {
                        state: "done",
                        reason: "released",
                        generation: 1,
                        inputs: input,
                        at: "2026-10-15T10:02:00.000Z",
                    },
                },
            });
        await db()
            .insert(learnRuns)
            .values({
                id: "post-cutover-learn",
                userId: USER_ID,
                scopeUserId: USER_ID,
                itemId: ITEM_ID,
                transcriptionId: input.contentId,
                view: "private",
                actorUserId: USER_ID,
                trigger: "auto",
                transcriptRevision: 1,
                vocabularyVersion: 0,
                status: "finished",
                createdAt: new Date("2026-10-15T10:01:00.000Z"),
            });
        await requestAdvance({
            itemId: ITEM_ID,
            userId: USER_ID,
            view: "private",
            reason: "learn-released",
        });

        await pipelineAdvanceJobHandler.run(jobContext());

        expect((await processing())?.phases.categorize).toMatchObject({
            state: "waiting",
            reason: "needs_folder",
        });
        expect(mocks.queueAutoSummary).not.toHaveBeenCalled();
    });

    it.each([
        {
            name: "before",
            createdAt: new Date("2026-10-15T09:59:00.000Z"),
            processed: true,
        },
        {
            name: "after",
            createdAt: new Date("2026-10-15T10:01:00.000Z"),
            processed: false,
        },
    ])("handles a transcription started $name the legacy cutover according to its start time", async ({
        createdAt,
        processed,
    }) => {
        await seedAudio(ITEM_ID, 1, false);
        const cutover = new Date("2026-10-15T10:00:00.000Z");
        await db()
            .insert(itemProcessing)
            .values({
                itemId: ITEM_ID,
                userId: USER_ID,
                view: "private",
                phases: {
                    categorize: {
                        state: "skipped",
                        reason: "legacy",
                        generation: 0,
                        at: cutover.toISOString(),
                    },
                },
            });
        await db()
            .insert(asyncJobs)
            .values({
                id: `cutover-transcription-${processed}`,
                userId: USER_ID,
                kind: TRANSCRIPTION_JOB_KIND,
                subjectId: ITEM_ID,
                payload: {
                    recordingId: ITEM_ID,
                    trigger: "pipeline",
                    force: false,
                },
                status: "completed",
                createdAt,
                completedAt: new Date("2026-10-15T10:02:00.000Z"),
            });
        await requestAdvance({
            itemId: ITEM_ID,
            userId: USER_ID,
            view: "private",
            reason: "transcript",
        });

        await pipelineAdvanceJobHandler.run(jobContext());

        if (processed) {
            expect(mocks.queueAutoSummary).toHaveBeenCalledOnce();
            expect((await processing())?.phases.categorize).toMatchObject({
                state: "skipped",
                reason: "legacy",
            });
        } else {
            expect(mocks.queueAutoSummary).not.toHaveBeenCalled();
            expect((await processing())?.phases.categorize).toMatchObject({
                state: "waiting",
                reason: "needs_folder",
            });
        }
    });

    it("marks an unavailable frozen profile without planning paid work", async () => {
        await db().insert(users).values({
            id: "pipeline-org",
            email: "org@example.test",
            role: "org",
        });
        await seedAudio();
        const organizationProfile = await resolveItemProfile(
            ITEM_ID,
            "org",
            USER_ID,
        );
        await db()
            .update(itemProcessing)
            .set({
                profileId: organizationProfile.profile.id,
                profileRevisionId: organizationProfile.revisionId,
            })
            .where(
                and(
                    eq(itemProcessing.itemId, ITEM_ID),
                    eq(itemProcessing.userId, USER_ID),
                ),
            );
        mockEnv.SELF_HOST_MODE = "local";
        await requestAdvance({
            itemId: ITEM_ID,
            userId: USER_ID,
            view: "private",
            reason: "placement",
        });

        try {
            await pipelineAdvanceJobHandler.run(jobContext());
        } finally {
            mockEnv.SELF_HOST_MODE = "shared";
        }

        expect((await processing())?.phases.categorize).toMatchObject({
            state: "failed",
            reason: "profile_unavailable",
        });
        expect(mocks.queueAutoTopics).not.toHaveBeenCalled();
        expect(mocks.queueAutoSummary).not.toHaveBeenCalled();
    });

    it("queues a mail summary pinned to an Organization provider for a member without keys", async () => {
        const mailId = "mail-with-org-provider";
        const orgUserId = "pipeline-org-provider-owner";
        const credentialId = "pipeline-org-summary-provider";
        await db()
            .delete(apiCredentials)
            .where(eq(apiCredentials.userId, USER_ID));
        await db().insert(users).values({
            id: orgUserId,
            email: "org@example.test",
            role: "org",
        });
        await db().insert(apiCredentials).values({
            id: credentialId,
            userId: orgUserId,
            provider: "openai",
            apiKey: "organization-key",
            defaultModel: "organization-model",
            isDefaultEnhancement: true,
        });
        const profile = await resolveDefaultProfile(USER_ID, "mail");
        const settings = defaultProfileSettings("mail");
        settings.steps.summary = {
            ...settings.steps.summary,
            automatic: true,
            provider: { credentialId, scope: "organization" },
        };
        await db()
            .update(processingProfileRevisions)
            .set({ settings: JSON.stringify(settings) })
            .where(eq(processingProfileRevisions.id, profile.revisionId));
        await db().insert(chatterItems).values({
            id: mailId,
            userId: USER_ID,
            kind: "mail",
            title: "Organization provider mail",
            occurredAt: new Date(),
        });
        await db().insert(mailMessages).values({
            id: mailId,
            userId: USER_ID,
            rawHash: "org-provider-mail-hash",
            receivedAt: new Date(),
            sizeBytes: 100,
            auth: {},
            senderVerified: true,
        });
        await db()
            .insert(mailContents)
            .values({
                id: `content-${mailId}`,
                itemId: mailId,
                userId: USER_ID,
                revision: 1,
                parserVersion: 1,
                segments: [],
            });
        await db().insert(recordingFolderAssignments).values({
            userId: USER_ID,
            itemId: mailId,
            folderId: "pipeline-folder",
        });
        await db()
            .insert(itemProcessing)
            .values({
                itemId: mailId,
                userId: USER_ID,
                view: "private",
                profileId: profile.profile.id,
                profileRevisionId: profile.revisionId,
                requestedGeneration: 1,
                phases: {
                    categorize: {
                        state: "done",
                        reason: "categorized",
                        generation: 1,
                        at: new Date().toISOString(),
                    },
                },
            });

        const mailFacts = await gatherFacts(mailId, "private", USER_ID);
        expect(mailFacts.hasEnhancementCredential).toBe(true);
        expect(mailFacts.stepAvailability?.summary).toBe("available");
        expect(mailFacts.profile?.automatic.summary).toBe(true);
        expect(planAdvance(mailFacts).actions).toContainEqual({
            type: "queueSummary",
            presetId: null,
            strict: true,
        });

        await pipelineAdvanceJobHandler.run(jobContext(mailId, "categorized"));

        expect(mocks.queueAutoSummary).toHaveBeenCalledWith(
            USER_ID,
            mailId,
            null,
            { strict: true },
        );
    });

    it("settles running pipeline steps whose terminal jobs were buried", async () => {
        const steps = ["summary", "title", "topics"] as const;
        const old = new Date(Date.now() - 31 * 60_000);
        const failedAt = new Date(old.getTime() + 60_000);
        const transcribeItem = "orphaned-transcribe";
        await seedAudio(transcribeItem);
        await db()
            .delete(transcriptions)
            .where(eq(transcriptions.recordingId, transcribeItem));
        await db()
            .update(itemProcessing)
            .set({
                phases: {
                    categorize: {
                        state: "done",
                        reason: "categorized",
                        generation: 0,
                        at: old.toISOString(),
                    },
                    transcribe: {
                        state: "running",
                        reason: "started",
                        automatic: true,
                        generation: 1,
                        at: old.toISOString(),
                    },
                },
                requestedGeneration: 1,
                processedGeneration: 1,
            })
            .where(eq(itemProcessing.itemId, transcribeItem));

        for (const step of steps) {
            const itemId = `orphaned-${step}`;
            await seedAudio(itemId);
            await db()
                .update(itemProcessing)
                .set({
                    phases: {
                        categorize: {
                            state: "done",
                            reason: "categorized",
                            generation: 0,
                            at: old.toISOString(),
                        },
                        summary: {
                            state: "pending",
                            reason: "requested",
                            generation: 1,
                            at: old.toISOString(),
                            steps: {
                                [step]: {
                                    contentId: `transcription-${itemId}`,
                                    contentRevision: 1,
                                    generation: 1,
                                    state: "running",
                                    reason: "started",
                                    at: old.toISOString(),
                                },
                            },
                        },
                    },
                    requestedGeneration: 1,
                    processedGeneration: 1,
                })
                .where(eq(itemProcessing.itemId, itemId));
        }

        await db()
            .insert(asyncJobs)
            .values([
                {
                    userId: USER_ID,
                    kind: TRANSCRIPTION_JOB_KIND,
                    subjectId: transcribeItem,
                    payload: {
                        recordingId: transcribeItem,
                        trigger: "pipeline",
                        force: false,
                    },
                    status: "failed",
                    errorCode: "TRANSCRIPTION_CRASHED",
                    completedAt: failedAt,
                },
                ...steps.map((step) => ({
                    userId: USER_ID,
                    kind:
                        step === "summary"
                            ? "summary"
                            : step === "title"
                              ? "title.generate"
                              : "topics",
                    subjectId: `orphaned-${step}`,
                    payload: {
                        recordingId: `orphaned-${step}`,
                        trigger: "auto",
                        ...(step === "topics" ? { source: "riffado" } : {}),
                    },
                    status: "failed" as const,
                    errorCode: `${step.toUpperCase()}_CRASHED`,
                    completedAt: failedAt,
                })),
            ]);

        await expect(sweepOrphanedPipelineSteps()).resolves.toBe(4);
        await expect(sweepOrphanedPipelineSteps()).resolves.toBe(0);
        expect(
            (await processing(transcribeItem))?.phases.transcribe,
        ).toMatchObject({
            state: "failed",
            reason: "TRANSCRIPTION_CRASHED",
            automatic: true,
        });
        for (const step of steps) {
            expect(
                (await processing(`orphaned-${step}`))?.phases.summary?.steps?.[
                    step
                ],
            ).toMatchObject({
                state: "failed",
                reason: `${step.toUpperCase()}_CRASHED`,
            });
        }
    });

    it("retries an old automatic transcription failure within the daily bound", async () => {
        const ids = {
            eligible: "transcription-retry-eligible",
            recent: "transcription-retry-recent",
            poison: "transcription-retry-poison",
            contentReaped: "transcription-retry-content-reaped",
            audioReaped: "transcription-retry-audio-reaped",
            shared: "transcription-retry-shared",
        };
        const now = new Date();
        const old = new Date(now.getTime() - 31 * 60_000);
        for (const itemId of Object.values(ids)) {
            await seedAudio(itemId);
            await db()
                .delete(transcriptions)
                .where(
                    and(
                        eq(transcriptions.recordingId, itemId),
                        eq(transcriptions.userId, USER_ID),
                    ),
                );
            await db()
                .update(itemProcessing)
                .set({
                    phases: {
                        categorize: {
                            state: "done",
                            reason: "categorized",
                            generation: 0,
                            at: old.toISOString(),
                        },
                        transcribe: {
                            state: "failed",
                            reason: "TRANSCRIPTION_FAILED",
                            generation: 1,
                            at:
                                itemId === ids.recent
                                    ? now.toISOString()
                                    : old.toISOString(),
                            automatic: true,
                        },
                    },
                    requestedGeneration: 1,
                    processedGeneration: 1,
                })
                .where(
                    and(
                        eq(itemProcessing.itemId, itemId),
                        eq(itemProcessing.userId, USER_ID),
                    ),
                );
        }
        await db()
            .update(chatterItems)
            .set({ contentReapedAt: now })
            .where(eq(chatterItems.id, ids.contentReaped));
        await db()
            .update(recordings)
            .set({ audioReapedAt: now })
            .where(eq(recordings.id, ids.audioReaped));
        await db().insert(users).values({
            id: "pipeline-org",
            email: "org@example.test",
            role: "org",
        });
        await db().insert(recordingFolders).values({
            id: "pipeline-org-root",
            userId: "pipeline-org",
            parentId: null,
            name: "Organization",
            nameHash: "pipeline-org-root-hash",
            kind: "private",
        });
        await db().insert(recordingFolderAssignments).values({
            userId: USER_ID,
            itemId: ids.shared,
            folderId: "pipeline-org-root",
        });
        await db()
            .insert(asyncJobs)
            .values(
                Object.values(ids).flatMap((itemId) =>
                    Array.from(
                        { length: itemId === ids.poison ? 3 : 1 },
                        (_, index) => ({
                            id: `failed-transcription-${itemId}-${index}`,
                            userId: USER_ID,
                            kind: TRANSCRIPTION_JOB_KIND,
                            subjectId: itemId,
                            payload: {
                                recordingId: itemId,
                                trigger: "pipeline",
                                force: false,
                            },
                            status: "failed" as const,
                            attempts: 3,
                            maxAttempts: 3,
                            errorCode: "TRANSCRIPTION_FAILED",
                            completedAt: old,
                        }),
                    ),
                ),
            );

        await expect(sweepAutomaticTranscriptionRetries()).resolves.toBe(2);
        await expect(sweepAutomaticTranscriptionRetries()).resolves.toBe(0);

        expect(
            (await processing(ids.eligible))?.phases.transcribe,
        ).toMatchObject({
            state: "pending",
            reason: "automatic_retry",
            automatic: true,
        });
        const pipelineSubjects = await db()
            .select({ subjectId: asyncJobs.subjectId })
            .from(asyncJobs)
            .where(
                and(
                    eq(asyncJobs.userId, USER_ID),
                    eq(asyncJobs.kind, PIPELINE_ADVANCE_JOB_KIND),
                    inArray(asyncJobs.status, ["pending", "processing"]),
                ),
            );
        expect(pipelineSubjects.map((row) => row.subjectId).sort()).toEqual(
            [ids.eligible, ids.shared].sort(),
        );
    });

    it("sweeps only old, unclaimed, non-poison stalled rows", async () => {
        const ids = {
            stalled: "pipeline-sweep-stalled",
            healthy: "pipeline-sweep-healthy",
            active: "pipeline-sweep-active",
            fresh: "pipeline-sweep-fresh",
            poison: "pipeline-sweep-poison",
        };
        for (const itemId of Object.values(ids)) {
            await seedAudio(itemId, 1, false);
        }
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
