import { inspect } from "node:util";
import { and, eq } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";
import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { POST as categorize } from "@/app/api/recordings/[id]/categorize/route";
import {
    claimDueJobs,
    completeJob,
    failJobAttempt,
} from "@/db/queries/async-jobs";
import {
    aiEnhancements,
    apiCredentials,
    asyncJobs,
    chatterItems,
    folderDefaultProfiles,
    itemProcessing,
    itemShares,
    learnReviewItems,
    learnRuns,
    plaudConnections,
    processingProfileRevisions,
    processingProfiles,
    recordingFolderAssignments,
    recordingFolders,
    recordings,
    transcriptions,
    userSettings,
    users,
} from "@/db/schema";
import { encrypt } from "@/lib/encryption";
import {
    decryptJsonField,
    encryptJsonField,
    encryptText,
} from "@/lib/encryption/fields";
import { env } from "@/lib/env";
import { unshareRecordingWithOutcome } from "@/lib/folders/folders";
import type { JobHandler } from "@/lib/jobs/types";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { startLearnRun } from "@/lib/learn/learn-job";
import { learnJobHandler } from "@/lib/learn/learn-job-handler";
import { finishReview } from "@/lib/learn/review";
import { pipelineAdvanceJobHandler } from "@/lib/pipeline/advance-job";
import { gatherFacts } from "@/lib/pipeline/facts";
import { pipelineMayQueue } from "@/lib/pipeline/pending";
import { planAdvance } from "@/lib/pipeline/plan";
import { loadPrivateItemProcessing } from "@/lib/pipeline/presentation";
import { requestProviderRecovery } from "@/lib/pipeline/provider-recovery";
import { sweepAutomaticTranscriptionRetries } from "@/lib/pipeline/sweep";
import { requestAdvance } from "@/lib/pipeline/trigger";
import type { PhaseRecord, PipelinePhases } from "@/lib/pipeline/types";
import { deriveWorkflowWidgets } from "@/lib/pipeline/workflow-widgets";
import { createPlaudClient } from "@/lib/plaud/client-factory";
import { mapPlaudV4Item, plaudV4DetailToLegacy } from "@/lib/plaud/v4";
import { captureServerException } from "@/lib/posthog-server";
import { defaultProfileSettings } from "@/lib/profiles/settings";
import { requestRecordingCut } from "@/lib/recordings/cut";
import {
    commitRecordingCut,
    recordingCutJobHandler,
} from "@/lib/recordings/cut-job-handler";
import { trimJobHandler } from "@/lib/recordings/trim-job";
import { requireRecordingView } from "@/lib/sharing/access";
import { summaryJobHandler } from "@/lib/summary/summary-job-handler";
import { syncRecordingsForUser } from "@/lib/sync/sync-recordings";
import { upsertTranscription } from "@/lib/transcription/persist";
import {
    enqueueTranscriptionJob,
    TRANSCRIPTION_JOB_KIND,
} from "@/lib/transcription/transcription-job";
import { transcriptionJobHandler } from "@/lib/transcription/transcription-job-handler";
import { insertRecordings } from "@/tests/integration/items";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { ref, proxy } = vi.hoisted(() => {
    const ref: { db: Record<PropertyKey, unknown> | null } = { db: null };
    const proxy = new Proxy(
        {},
        {
            get: (_target, key) => {
                if (!ref.db) throw new Error("Test database is not ready");
                const value = ref.db[key];
                return typeof value === "function" ? value.bind(ref.db) : value;
            },
        },
    );
    return { ref, proxy };
});
const { createCompletion, transcribeAudio } = vi.hoisted(() => ({
    createCompletion: vi.fn(),
    transcribeAudio: vi.fn(),
}));
vi.mock("openai", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    OpenAI: class {
        chat = { completions: { create: createCompletion } };
    },
}));
vi.mock("@/lib/learn/run-fallback", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    runFallbackPass: async () => ({
        output: {
            newRecords: [],
            speakers: [],
            corrections: [],
            facts: [],
            relationPhrases: [],
            language: { code: "cs", confidence: 0.99 },
        },
        calls: 1,
        lookups: 0,
        windows: 1,
        repairs: 0,
        failedWindows: 0,
    }),
}));
vi.mock(
    "@/lib/transcription/elevenlabs-transcribe",
    async (importOriginal) => ({
        ...(await importOriginal<Record<string, unknown>>()),
        elevenLabsTranscribe: transcribeAudio,
    }),
);
vi.mock("@/lib/audio/ingest-waveform", () => ({
    generateIngestWaveform: async () => null,
}));
vi.mock("@/db", () => ({ db: proxy, sqlClient: null }));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async () => ({ user: { id: "test-owner" } }),
}));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/env", () => ({
    env: {
        IS_HOSTED: false,
        SELF_HOST_MODE: "local",
        DEFAULT_STORAGE_TYPE: "local",
        AUTO_SUMMARY_RATE_LIMIT_PER_HOUR: 50,
        BETTER_AUTH_SECRET: "plaud-speakerless-test-secret",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/plaud/client-factory", () => ({ createPlaudClient: vi.fn() }));
vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: async () => ({
        uploadFile: vi.fn().mockResolvedValue(undefined),
        downloadFile: vi.fn().mockResolvedValue(Buffer.from("ID3test")),
    }),
}));
vi.mock("@/lib/webhooks/emit", () => ({
    emitEvent: vi.fn().mockResolvedValue(undefined),
}));

const databaseUrl = getTestDatabaseUrl();
const owner = "test-owner";
const itemId = "test-recording";
const folderId = "test-folder";
const profileId = "test-profile";
const at = new Date("2026-11-20T12:00:00.000Z");
const scope = { itemId, userId: owner, view: "private" } as const;
const input = {
    contentId: "test-plaud-transcript",
    contentSourceId: "plaud",
    contentRevision: 0,
};
const done = { state: "done", generation: 1, at: at.toISOString() } as const;
const arrived = { ...done, reason: "categorized", arrivalGeneration: 1 };
const autoFailure = {
    ...done,
    state: "failed",
    reason: "TRANSCRIPTION_FAILED",
    automatic: true,
} as const;
const processingScope = and(
    eq(itemProcessing.itemId, itemId),
    eq(itemProcessing.userId, owner),
    eq(itemProcessing.view, "private"),
);
const audioScope = and(eq(recordings.id, itemId), eq(recordings.userId, owner));
const transcriptScope = and(
    eq(transcriptions.recordingId, itemId),
    eq(transcriptions.userId, owner),
    eq(transcriptions.source, "plaud"),
);

describe.skipIf(!databaseUrl)(
    "#458 Plaud speaker-less transcripts in PostgreSQL",
    () => {
        let database: TestPostgresDatabase;

        beforeAll(async () => {
            if (!databaseUrl) throw new Error("Test database URL is missing");
            database = await createMigratedTestDatabase(
                databaseUrl,
                "plaud_speakerless",
            );
            ref.db = database.db as unknown as Record<PropertyKey, unknown>;
        }, 120_000);

        afterAll(async () => {
            ref.db = null;
            await database?.dispose();
        }, 30_000);

        beforeEach(async () => {
            const db = database.db;
            await db.delete(users);
            await db
                .insert(users)
                .values({ id: owner, email: "owner@example.test" });
            await insertRecordings(db, {
                id: itemId,
                userId: owner,
                plaudFileId: "f_test",
                filename: encryptText("Draft review"),
                duration: 1000,
                startTime: at,
                endTime: new Date(at.getTime() + 1000),
                deviceSn: "TEST-DEVICE",
                filesize: 10,
                fileMd5: "0".repeat(32),
                storageType: "local",
                storagePath: "test-audio.mp3",
                plaudVersion: "1",
            });
        });

        afterEach(() => {
            env.SELF_HOST_MODE = "local";
            env.ORG_ACCOUNT_EMAIL = undefined;
            env.ORG_ACCOUNT_PASSWORD = undefined;
            vi.restoreAllMocks();
            vi.unstubAllGlobals();
        });

        async function addProfile(
            id: string,
            settings: ReturnType<typeof audioSettings>,
        ) {
            const db = database.db;
            const revisionId = `${id}-revision`;
            await db.insert(processingProfiles).values({
                id,
                ownerUserId: owner,
                scope: "personal",
                channel: "audio",
                name: encryptText("Test profile"),
                currentRevisionId: revisionId,
                createdBy: owner,
                updatedBy: owner,
            });
            await db.insert(processingProfileRevisions).values({
                id: revisionId,
                profileId: id,
                createdBy: owner,
                settings: encryptText(JSON.stringify(settings)),
            });
            return revisionId;
        }

        function audioSettings({
            automaticSummary = false,
            automaticLearn = false,
            automaticTrim = false,
        } = {}) {
            const settings = defaultProfileSettings("audio");
            settings.steps.transcribe.automatic = true;
            settings.steps.trim.automatic = automaticTrim;
            settings.steps.learn.automatic = automaticLearn;
            settings.steps.summary.automatic = automaticSummary;
            settings.steps.title.automatic = false;
            settings.steps.topics.automatic = true;
            settings.steps.tasks.enabled = false;
            return settings;
        }

        async function addPrivateFolder() {
            await database.db.insert(recordingFolders).values([
                {
                    id: "test-root",
                    userId: owner,
                    kind: "private",
                    name: encryptText("Private"),
                    nameHash: lookupHash("Private"),
                },
                {
                    id: folderId,
                    userId: owner,
                    parentId: "test-root",
                    kind: "custom",
                    name: encryptText("Review"),
                    nameHash: lookupHash("Review"),
                },
            ]);
        }

        async function seed(
            speaker: string | null,
            transcribe?: PhaseRecord,
            {
                importTranscript = true,
                ...automation
            }: Parameters<typeof audioSettings>[0] & {
                importTranscript?: boolean;
            } = {},
        ) {
            const db = database.db;
            const revisionId = await addProfile(
                profileId,
                audioSettings(automation),
            );
            await addPrivateFolder();
            await db
                .insert(recordingFolderAssignments)
                .values({ itemId, userId: owner, folderId });
            await db.insert(itemProcessing).values({
                ...scope,
                profileId,
                profileRevisionId: revisionId,
                requestedGeneration: 1,
                processedGeneration: 1,
                phases: {
                    categorize: arrived,
                    transcribe,
                },
            });
            if (!importTranscript) return;
            await db.insert(transcriptions).values({
                id: input.contentId,
                recordingId: itemId,
                userId: owner,
                source: "plaud",
                provider: "plaud",
                model: "plaud-native",
                text: encryptText("Read the draft."),
                turns: encryptJsonField([
                    {
                        speaker,
                        startMs: 0,
                        endMs: 1000,
                        text: "Read the draft.",
                    },
                ]),
            });
        }

        async function advance(
            reason: "placement" | "step-settled" = "placement",
        ) {
            if (reason === "placement")
                await requestAdvance({ ...scope, reason });
            await runAdvance(itemId, reason);
        }

        async function runAdvance(id: string, reason: string) {
            await pipelineAdvanceJobHandler.run({
                jobId: "test-advance",
                userId: owner,
                payload: { itemId: id, view: "private", reason },
                signal: new AbortController().signal,
                attempt: 1,
                maxAttempts: 10,
                reportProgress: vi.fn(),
            });
        }

        function jobs() {
            return database.db
                .select()
                .from(asyncJobs)
                .where(
                    and(
                        eq(asyncJobs.userId, owner),
                        eq(asyncJobs.subjectId, itemId),
                        eq(asyncJobs.kind, TRANSCRIPTION_JOB_KIND),
                    ),
                );
        }

        async function expectSettled(contentRevision = 0) {
            const facts = await gatherFacts(itemId, "private", owner);
            expect(facts.phases.transcribe).toMatchObject({
                state: "done",
                reason: "plaud-transcript",
                inputs: { ...input, contentRevision },
            });
        }

        it("queues our transcription for an encrypted row without a speaker", async () => {
            await seed(null);
            expect(await pipelineMayQueue(owner, itemId, "topics")).toBe(false);
            await advance();
            expect(await jobs()).toMatchObject([
                { status: "pending", payload: { trigger: "pipeline" } },
            ]);
        });

        it("uses an encrypted row with a speaker", async () => {
            await seed("Speaker 1");
            expect(await pipelineMayQueue(owner, itemId, "topics")).toBe(true);
            await advance();
            await expectSettled();
            expect(await jobs()).toEqual([]);
        });

        it("keeps the settled speaker-less row on a filing advance", async () => {
            await seed(null, {
                ...done,
                reason: "plaud-transcript",
                inputs: input,
            });
            await advance();
            await expectSettled();
            expect(await jobs()).toEqual([]);
        });

        it("falls back after a real terminal job failure and stays settled through recovery", async () => {
            await seed(null);
            await advance();
            const [job] = await claimDueJobs(TRANSCRIPTION_JOB_KIND, 1);
            if (!job) throw new Error("Expected a queued transcription job");
            await failJobAttempt({
                jobId: job.id,
                claimToken: job.claimToken,
                code: "NO_TRANSCRIPTION_PROVIDER",
                message: "No transcription provider",
                retryable: false,
                delayMs: 0,
            });
            await advance("step-settled");
            await expectSettled();
            expect(
                await sweepAutomaticTranscriptionRetries(1, {
                    userId: owner,
                    itemId,
                }),
            ).toBe(0);
            await requestProviderRecovery(owner);
            await advance();
            await expectSettled();
            expect(await jobs()).toMatchObject([
                { id: job.id, status: "failed" },
            ]);
        });

        async function replacePhases(phases: PipelinePhases, generation = 1) {
            await database.db
                .update(itemProcessing)
                .set({ phases, requestedGeneration: generation })
                .where(processingScope);
        }

        async function file() {
            await fileRecording(itemId, profileId);
            await advance("step-settled");
        }

        async function fileRecording(id: string, chosenProfileId?: string) {
            const response = await categorize(
                new Request("https://app.example.test/categorize", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        folderIds: [folderId],
                        profileId: chosenProfileId,
                    }),
                }),
                { params: Promise.resolve({ id }) },
            );
            expect(response.status, await response.text()).toBe(200);
        }

        async function claimTranscription() {
            const [job] = await claimDueJobs(TRANSCRIPTION_JOB_KIND, 1);
            if (!job) throw new Error("Expected a transcription job");
            return job;
        }

        async function failTranscription(
            job: Awaited<ReturnType<typeof claimTranscription>>,
        ) {
            await failJobAttempt({
                jobId: job.id,
                claimToken: job.claimToken,
                code: "TRANSCRIPTION_FAILED",
                message: "Test provider failure",
                retryable: false,
                delayMs: 0,
            });
        }

        async function shareReadOnly() {
            env.SELF_HOST_MODE = "shared";
            await assignOrganizationFolder();
        }

        async function assignOrganizationFolder() {
            const db = database.db;
            await db.insert(users).values({
                id: "test-org",
                email: "org@example.test",
                role: "org",
            });
            await db.insert(recordingFolders).values({
                id: "org-folder",
                userId: "test-org",
                kind: "custom",
                name: encryptText("Team"),
                nameHash: "team",
            });
            await db
                .insert(recordingFolderAssignments)
                .values({ itemId, userId: owner, folderId: "org-folder" });
        }

        async function mockOwnTranscription() {
            const db = database.db;
            const providerId = "test-owner-transcription";
            await db.insert(apiCredentials).values({
                id: providerId,
                userId: owner,
                provider: "ElevenLabs",
                apiKey: encrypt("test-transcription-key"),
                defaultModel: "scribe_v2+diarize",
            });
            await db.insert(userSettings).values({
                userId: owner,
                defaultTranscriptionProviderId: providerId,
            });
            transcribeAudio.mockReset().mockResolvedValue({
                text: "Speaker 1: Read the draft.",
                detectedLanguage: "en",
                turns: [
                    {
                        speaker: "Speaker 1",
                        startMs: 0,
                        endMs: 1000,
                        text: "Read the draft.",
                    },
                ],
            });
        }

        async function skipAfterSharing() {
            await requestAdvance({ ...scope, reason: "placement" });
            await runJob(pipelineAdvanceJobHandler);
            await shareReadOnly();
            expect(
                (await gatherFacts(itemId, "private", owner)).transcription
                    ?.sharedReadOnly,
            ).toBe(true);
            const { job, result } = await runJob(transcriptionJobHandler);
            expect(result).toMatchObject({
                outcome: { kind: "skipped", reason: "shared" },
            });
            expect(transcribeAudio).not.toHaveBeenCalled();
            expect(
                (await gatherFacts(itemId, "private", owner)).phases.transcribe,
            ).toMatchObject({ state: "skipped", reason: "shared" });
            return job;
        }

        it("keeps the settled transcript after committing an actual cut", async () => {
            await seed("", {
                ...done,
                reason: "plaud-transcript",
                inputs: input,
            });
            const result = await requestRecordingCut(owner, itemId, {
                startMs: 0,
                endMs: 900,
            });
            const [cut] = await claimDueJobs(recordingCutJobHandler.kind, 1);
            if (!cut || cut.id !== result.id)
                throw new Error("Expected the cut job");
            await database.db.transaction((tx) =>
                commitRecordingCut(
                    tx,
                    owner,
                    cut.id,
                    recordingCutJobHandler.parsePayload(cut.payload),
                    {
                        storagePath: "example-cut.mp3",
                        storageFilename: "example-cut.mp3",
                        filesize: 12,
                        md5: "1".repeat(32),
                        duration: 900,
                        peaks: [0.5],
                    },
                    null,
                    cut.claimToken,
                ),
            );
            await completeJob({ jobId: cut.id, claimToken: cut.claimToken });
            await advance("step-settled");
            await expectSettled(1);
            expect(await jobs()).toEqual([]);
        });

        it("keeps Plaud when competing sync imports revise its row in place", async () => {
            await seed(
                null,
                { ...done, reason: "plaud-transcript", inputs: input },
                { importTranscript: false },
            );
            await syncTranscript("cs", null, async () => {
                await upsertTranscription({
                    recordingId: itemId,
                    userId: owner,
                    text: "First import.",
                    detectedLanguage: "cs",
                    source: "plaud",
                    provider: "plaud",
                    model: "plaud-native",
                    turns: [
                        {
                            speaker: "",
                            startMs: 0,
                            endMs: 1000,
                            text: "First import.",
                        },
                    ],
                });
                const [first] = await database.db
                    .select()
                    .from(transcriptions)
                    .where(transcriptScope);
                await replacePhases({
                    categorize: arrived,
                    transcribe: {
                        ...done,
                        reason: "plaud-transcript",
                        inputs: { ...input, contentId: first.id },
                    },
                });
            });
            const [revised] = await database.db
                .select()
                .from(transcriptions)
                .where(transcriptScope);
            expect(revised.revision).toBe(1);
            await advance();
            const facts = await gatherFacts(itemId, "private", owner);
            expect(facts.phases.transcribe).toMatchObject({
                state: "done",
                inputs: { ...input, contentId: revised.id, contentRevision: 1 },
            });
            expect(await jobs()).toEqual([]);
        });

        it("keeps a fresh Plaud import on a read-only Organization share", async () => {
            await seed(null);
            await shareReadOnly();
            await advance();
            await advance();
            await expectSettled();
            expect(await jobs()).toEqual([]);
        });

        it.each([
            "writable Organization share",
            "shared mode without an Organization account",
            "retained Organization assignment in local mode",
            "person share",
        ] as const)("runs one owner transcription for a fresh import (%s)", async (sharing) => {
            await seed(null);
            await mockOwnTranscription();
            env.SELF_HOST_MODE =
                sharing === "retained Organization assignment in local mode"
                    ? "local"
                    : "shared";
            if (sharing === "writable Organization share") {
                await assignOrganizationFolder();
                env.ORG_ACCOUNT_EMAIL = "org@example.test";
                env.ORG_ACCOUNT_PASSWORD = "test-org-password";
            }
            if (sharing === "retained Organization assignment in local mode")
                await assignOrganizationFolder();
            if (sharing === "person share") {
                const db = database.db;
                await db.insert(users).values({
                    id: "test-recipient",
                    email: "recipient@example.test",
                });
                await db.insert(itemShares).values({
                    itemId,
                    userId: owner,
                    receiverUserId: "test-recipient",
                    state: "accepted",
                });
            }
            expect(
                (await gatherFacts(itemId, "private", owner)).transcription
                    ?.sharedReadOnly,
            ).toBe(false);
            await requestAdvance({ ...scope, reason: "placement" });
            await runJob(pipelineAdvanceJobHandler);
            const { job, result } = await runJob(transcriptionJobHandler);
            expect(result).toMatchObject({ transcribed: true });
            await runJob(pipelineAdvanceJobHandler);
            expect(transcribeAudio).toHaveBeenCalledOnce();
            expect(await jobs()).toMatchObject([
                { id: job.id, status: "completed" },
            ]);
            expect(
                (await gatherFacts(itemId, "private", owner)).phases.transcribe,
            ).toMatchObject({ state: "done", reason: "content-available" });
        });

        it("runs our transcription in local mode after a real shared skip despite the retained assignment", async () => {
            await seed(null);
            await mockOwnTranscription();
            const skipped = await skipAfterSharing();
            env.SELF_HOST_MODE = "local";
            expect(await pipelineMayQueue(owner, itemId, "topics")).toBe(false);
            await runJob(pipelineAdvanceJobHandler);
            const { job, result } = await runJob(transcriptionJobHandler);
            expect(result).toMatchObject({ transcribed: true });
            await runJob(pipelineAdvanceJobHandler);
            expect(transcribeAudio).toHaveBeenCalledOnce();
            expect(await jobs()).toHaveLength(2);
            expect(await jobs()).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        id: skipped.id,
                        status: "completed",
                    }),
                    expect.objectContaining({
                        id: job.id,
                        status: "completed",
                    }),
                ]),
            );
            expect(
                (await gatherFacts(itemId, "private", owner)).phases.transcribe,
            ).toMatchObject({ state: "done", reason: "content-available" });
        });

        it.each([
            {
                importTranscript: true,
                name: "keeps the Plaud transcript settled after a real shared skip and withdrawal",
            },
            {
                importTranscript: false,
                name: "requeues once after withdrawing a skipped/shared recording without a Plaud transcript",
            },
        ])("$name", async ({ importTranscript }) => {
            await seed("", undefined, { importTranscript });
            await mockOwnTranscription();
            const job = await skipAfterSharing();
            const wake = await runJob(pipelineAdvanceJobHandler);
            expect(wake.job.payload).toMatchObject({ reason: "step-settled" });
            if (importTranscript) await expectSettled();
            else
                expect(
                    (await gatherFacts(itemId, "private", owner)).phases
                        .transcribe,
                ).toMatchObject({ state: "skipped", reason: "shared" });
            expect(await jobs()).toMatchObject([
                { id: job.id, status: "completed" },
            ]);

            expect(
                await unshareRecordingWithOutcome(owner, itemId, {
                    withdraw: true,
                }),
            ).toBe(true);
            await runJob(pipelineAdvanceJobHandler);
            await advance();
            if (importTranscript) {
                await expectSettled();
                expect(await jobs()).toMatchObject([
                    { id: job.id, status: "completed" },
                ]);
                return;
            }
            expect(await jobs()).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        id: job.id,
                        status: "completed",
                    }),
                    expect.objectContaining({ status: "pending" }),
                ]),
            );
            expect(await jobs()).toHaveLength(2);
        });

        it("keeps Plaud when a sparse done phase has no input tuple", async () => {
            await seed(null, { ...done, reason: "plaud-transcript" });
            await file();
            await expectSettled();
            expect(await jobs()).toEqual([]);
        });

        it("keeps a legacy unphased Plaud row after filing replaces the legacy marker", async () => {
            await seed(null);
            await replacePhases({});
            const legacy = await gatherFacts(itemId, "private", owner);
            expect(legacy.phases.categorize).toMatchObject({
                reason: "legacy",
            });
            await file();
            await expectSettled();
            expect(await jobs()).toEqual([]);
        });

        it("keeps Plaud after a failed manual retranscription", async () => {
            await seed(null, {
                ...done,
                reason: "plaud-transcript",
                inputs: input,
            });
            await enqueueTranscriptionJob({
                userId: owner,
                recordingId: itemId,
                trigger: "manual",
                force: true,
            });
            const job = await claimTranscription();
            await failTranscription(job);
            expect(
                (await gatherFacts(itemId, "private", owner)).phases.transcribe,
            ).toMatchObject({ state: "failed", automatic: false });
            await advance("step-settled");
            await expectSettled();
            expect(await jobs()).toMatchObject([
                { id: job.id, status: "failed" },
            ]);
        });

        it("queues Process again when its request is newer than a failed phase", async () => {
            await seed(null, autoFailure);
            await replacePhases(
                {
                    categorize: {
                        ...arrived,
                        generation: 2,
                        reason: "process_again",
                    },
                    transcribe: autoFailure,
                },
                2,
            );
            await advance("step-settled");
            expect(await jobs()).toMatchObject([{ status: "pending" }]);
        });

        it("uses a late Plaud import after audio retention", async () => {
            await seed(null, undefined, { importTranscript: false });
            await database.db
                .update(recordings)
                .set({ audioReapedAt: at })
                .where(audioScope);
            await syncTranscript("cs");
            await advance();
            const facts = await gatherFacts(itemId, "private", owner);
            expect(facts.phases.transcribe).toMatchObject({
                state: "done",
                reason: "plaud-transcript",
            });
            expect(await pipelineMayQueue(owner, itemId, "topics")).toBe(true);
            expect(await jobs()).toEqual([]);
        });

        it("settles on Plaud after a delayed sweep wins and its retry fails", async () => {
            await seed(null, autoFailure);
            expect(
                await sweepAutomaticTranscriptionRetries(1, {
                    userId: owner,
                    itemId,
                }),
            ).toBe(1);
            await advance("step-settled");
            const job = await claimTranscription();
            await failTranscription(job);
            await advance("step-settled");
            await expectSettled();
            expect(
                await sweepAutomaticTranscriptionRetries(1, {
                    userId: owner,
                    itemId,
                }),
            ).toBe(0);
            expect(await jobs()).toMatchObject([
                { id: job.id, status: "failed" },
            ]);
        });

        it("shows the stored transcript before binding and throughout a queued, running and failed attempt", async () => {
            await seed(null);
            async function verify(state: string) {
                const processing = await loadPrivateItemProcessing(
                    owner,
                    itemId,
                );
                if (!processing) throw new Error("Expected a projection");
                expect(processing.versions.transcripts).toHaveProperty("plaud");
                expect(processing.outputs.transcript).toBe(true);
                expect(
                    deriveWorkflowWidgets(processing).transcript.visible,
                ).toBe(true);
                expect(processing.steps.transcribe.state).toBe(state);
            }
            await verify("pending");
            await advance();
            await verify("queued");
            const job = await claimTranscription();
            await verify("running");
            await failTranscription(job);
            await verify("failed");
        });

        it("does not report Summary pending for an advance that only queues Transcribe", async () => {
            await seed(null, undefined, { automaticSummary: true });
            const facts = await gatherFacts(itemId, "private", owner);
            expect(planAdvance(facts).actions).toContainEqual({
                type: "queueTranscription",
            });
            expect(await pipelineMayQueue(owner, itemId, "summary")).toBe(
                false,
            );
        });

        it("keeps an arrived item with a saved custom summary", async () => {
            await seed(null);
            await database.db.insert(aiEnhancements).values({
                itemId,
                userId: owner,
                transcriptionId: input.contentId,
                source: "riffado",
                provider: "test",
                model: "test",
                summary: encryptText("Saved summary."),
            });
            await advance();
            await expectSettled();
            expect(await jobs()).toEqual([]);
        });

        it("queues automatic transcription for Learn's placeholder label", async () => {
            await seed(" Speaker ");
            await advance();
            expect(await jobs()).toMatchObject([{ status: "pending" }]);
        });

        it.each([
            "Agenda: Read the draft.",
            "Speaker 1: Read the draft.\n\nMore details.\n\nMore discussion.",
        ])("uses an untimed Plaud row regardless of speaker-looking text (%s)", async (text) => {
            await seed(null);
            await database.db
                .update(transcriptions)
                .set({ turns: null, text: encryptText(text) })
                .where(transcriptScope);
            await advance();
            await expectSettled();
            expect(await jobs()).toEqual([]);
        });

        async function addEnhancementCredential() {
            await database.db.insert(apiCredentials).values({
                userId: owner,
                provider: "openai",
                apiKey: encrypt("test-key"),
                defaultModel: "test-model",
                isDefaultEnhancement: true,
            });
        }

        it.each([
            { status: "queued", withReview: false, shouldQueue: true },
            { status: "running", withReview: false, shouldQueue: true },
            { status: "finished", withReview: false, shouldQueue: false },
            { status: "superseded", withReview: true, shouldQueue: false },
        ] as const)("uses manual Learn $status with review items $withReview as prior output only after processing", async ({
            status,
            withReview,
            shouldQueue,
        }) => {
            const db = database.db;
            await seed("", undefined, {
                automaticLearn: true,
                automaticSummary: true,
            });
            await addEnhancementCredential();
            const run = await startLearnRun({
                access: await requireRecordingView(owner, itemId, "private"),
                actorUserId: owner,
                source: "plaud",
                trigger: "manual",
            });
            const runScope = and(
                eq(learnRuns.id, run.runId),
                eq(learnRuns.userId, owner),
            );
            await db.update(learnRuns).set({ status }).where(runScope);
            if (withReview) {
                await db.insert(learnReviewItems).values({
                    runId: run.runId,
                    userId: owner,
                    kind: "language",
                    fingerprintHmac: "0".repeat(64),
                    payload: encryptJsonField({ language: "cs" }),
                });
            }
            expect(
                (await gatherFacts(itemId, "private", owner)).phases.learn,
            ).toBeUndefined();
            await advance();
            if (shouldQueue) {
                expect(await jobs()).toMatchObject([{ status: "pending" }]);
            } else {
                await expectSettled();
                expect(await jobs()).toEqual([]);
            }
        });

        async function connectPlaud() {
            await database.db.insert(plaudConnections).values({
                userId: owner,
                bearerToken: encrypt("test-token"),
                apiBase: "https://example.com",
            });
        }

        async function runJob<P>(handler: JobHandler<P>) {
            const [job] = await claimDueJobs(handler.kind, 1);
            if (!job) throw new Error(`Expected a ${handler.kind} job`);
            const result = await handler.run({
                jobId: job.id,
                userId: job.userId,
                claimToken: job.claimToken,
                payload: handler.parsePayload(job.payload),
                attempt: job.attempts,
                maxAttempts: job.maxAttempts,
                signal: new AbortController().signal,
                reportProgress: vi.fn(),
            });
            await completeJob({
                jobId: job.id,
                claimToken: job.claimToken,
                result: result ?? undefined,
            });
            return { job, result };
        }

        function chatResponse(content: object) {
            return {
                choices: [{ message: { content: JSON.stringify(content) } }],
                usage: { prompt_tokens: 10, completion_tokens: 10 },
            };
        }

        it.each([
            { timing: "same sync before first advance", folderOverride: false },
            { timing: "same sync after first advance", folderOverride: true },
            { timing: "later sync before first advance", folderOverride: true },
            { timing: "later sync after first advance", folderOverride: false },
            { timing: "later sync after filing", folderOverride: true },
        ] as const)("runs Transcribe, Learn and Summary for real v4 import in $timing (folder override $folderOverride)", async ({
            timing,
            folderOverride,
        }) => {
            const db = database.db;
            const settings = audioSettings({
                automaticSummary: true,
                automaticLearn: true,
                automaticTrim: folderOverride,
            });
            const revisionId = await addProfile(profileId, settings);
            await addPrivateFolder();
            const ownerDefaultProfileId = folderOverride
                ? "owner-default-profile"
                : profileId;
            if (folderOverride) {
                const ownerDefault = audioSettings();
                ownerDefault.steps.transcribe.automatic = false;
                await addProfile(ownerDefaultProfileId, ownerDefault);
                await db
                    .insert(folderDefaultProfiles)
                    .values({ folderId, channel: "audio", profileId });
            }
            const providerId = "test-transcription-provider";
            await addEnhancementCredential();
            await db.insert(apiCredentials).values({
                id: providerId,
                userId: owner,
                provider: "ElevenLabs",
                apiKey: encrypt("test-transcription-key"),
                defaultModel: "scribe_v2+diarize",
            });
            await db.insert(userSettings).values({
                userId: owner,
                importPlaudContent: true,
                defaultAudioProfileId: ownerDefaultProfileId,
                defaultTranscriptionProviderId: providerId,
            });
            await connectPlaud();

            const fileId = "f_new_draft";
            const listing = mapPlaudV4Item({
                file_id: fileId,
                name: "New draft",
                duration_ms: 1000,
                version_ms: 1,
                created_at_show_ms: at.getTime(),
            });
            const detail = plaudV4DetailToLegacy({
                objects: [
                    {
                        object_type: "TRANSCRIPT",
                        task_status: 1,
                        content_url: "https://example.com/transcript.json",
                        language: "cs",
                    },
                    {
                        object_type: "SUMMARY",
                        task_status: 1,
                        content_url: "https://example.com/summary.json",
                    },
                ],
            });
            const laterSync = timing.startsWith("later sync");
            let nativeContentReady = !laterSync;
            async function arrivedId() {
                const [row] = await db
                    .select({ id: recordings.id })
                    .from(recordings)
                    .where(
                        and(
                            eq(recordings.userId, owner),
                            eq(recordings.plaudFileId, fileId),
                        ),
                    );
                if (!row)
                    throw new Error("Expected the newly synced recording");
                return row.id;
            }
            const client = {
                getRecordings: vi.fn(async () => ({
                    data_file_list: [
                        {
                            ...listing,
                            is_trans: nativeContentReady,
                            is_summary: nativeContentReady,
                        },
                    ],
                })),
                hydrateRecording: vi.fn(
                    async (recording: typeof listing) => recording,
                ),
                downloadRecording: vi.fn(async () => Buffer.from("ID3test")),
                getFileDetail: vi.fn(async () => detail),
                fetchContentLink: vi.fn(async (url: string) => {
                    if (url.endsWith("summary.json"))
                        return { summary: "Plaud summary text." };
                    if (timing === "same sync after first advance")
                        await runAdvance(await arrivedId(), "arrival");
                    return [
                        {
                            start_time: 0,
                            end_time: 1000,
                            content: "Imported draft.",
                            segment_uid: "test-segment",
                        },
                    ];
                }),
            };
            vi.mocked(createPlaudClient).mockResolvedValue(
                client as unknown as Awaited<
                    ReturnType<typeof createPlaudClient>
                >,
            );
            expect(await syncRecordingsForUser(owner)).toMatchObject({
                errors: [],
                newRecordings: 1,
            });
            const id = await arrivedId();
            async function importInLaterSync() {
                nativeContentReady = true;
                expect(await syncRecordingsForUser(owner)).toMatchObject({
                    errors: [],
                    newRecordings: 0,
                });
            }
            if (timing === "later sync before first advance")
                await importInLaterSync();
            await runAdvance(id, "arrival");
            expect(
                (await gatherFacts(id, "private", owner)).phases.categorize,
            ).toMatchObject({
                state: "waiting",
                reason: "needs_folder",
                arrivalGeneration: 1,
            });
            if (timing === "later sync after filing") {
                await fileRecording(id);
                await runAdvance(id, "categorized");
            }
            if (
                timing === "later sync after filing" ||
                timing === "later sync after first advance"
            )
                await importInLaterSync();
            if (timing !== "later sync after filing") await fileRecording(id);
            await runAdvance(id, "transcript");

            const itemJobs = () =>
                db
                    .select()
                    .from(asyncJobs)
                    .where(
                        and(
                            eq(asyncJobs.userId, owner),
                            eq(asyncJobs.subjectId, id),
                        ),
                    );
            const itemLearn = () =>
                db
                    .select()
                    .from(learnRuns)
                    .where(
                        and(
                            eq(learnRuns.userId, owner),
                            eq(learnRuns.itemId, id),
                        ),
                    );
            async function expectNoSummaryJob() {
                expect(
                    (await itemJobs()).filter(
                        ({ kind }) => kind === summaryJobHandler.kind,
                    ),
                ).toEqual([]);
            }
            const facts = await gatherFacts(id, "private", owner);
            expect(facts.phases.categorize?.arrivalGeneration).toBe(1);
            expect(facts.profile).toMatchObject({
                revisionId,
                automatic: { learn: true, summary: true },
                transcribe: { automatic: true, plaudTranscript: "use" },
            });
            expect(facts.transcription?.plaud).toMatchObject({ timed: true });
            expect(
                (await itemJobs()).filter(
                    ({ kind }) => kind === TRANSCRIPTION_JOB_KIND,
                ),
            ).toMatchObject([{ status: "pending" }]);
            expect(await itemLearn()).toEqual([]);
            await expectNoSummaryJob();

            const ownText = "Read the complete draft.";
            transcribeAudio.mockReset().mockResolvedValue({
                text: `Speaker 1: ${ownText}`,
                detectedLanguage: "en",
                turns: [
                    {
                        speaker: "Speaker 1",
                        startMs: 0,
                        endMs: 1000,
                        text: ownText,
                    },
                ],
            });
            const transcribed = await runJob(transcriptionJobHandler);
            expect(transcribed.job.subjectId).toBe(id);
            expect(transcribed.result).toMatchObject({
                outcome: { kind: "done" },
            });
            expect(transcribeAudio).toHaveBeenCalledOnce();
            const [own] = await db
                .select({ id: transcriptions.id })
                .from(transcriptions)
                .where(
                    and(
                        eq(transcriptions.recordingId, id),
                        eq(transcriptions.userId, owner),
                        eq(transcriptions.source, "riffado"),
                    ),
                );
            await runAdvance(id, "step-settled");

            if (folderOverride) {
                createCompletion
                    .mockReset()
                    .mockResolvedValue(
                        chatResponse({ start: null, end: null }),
                    );
                const trim = await runJob(trimJobHandler);
                expect(trim.job.payload.input).toMatchObject({
                    contentId: own.id,
                    contentSourceId: "riffado",
                });
                await runAdvance(id, "step-settled");
            }
            const [learn] = await itemLearn();
            expect(learn).toMatchObject({
                transcriptionId: own.id,
                status: "queued",
            });
            const [recording] = await db
                .select({ summaryDueAt: chatterItems.summaryDueAt })
                .from(chatterItems)
                .where(
                    and(
                        eq(chatterItems.id, id),
                        eq(chatterItems.userId, owner),
                    ),
                );
            expect(recording.summaryDueAt).not.toBeNull();
            await expectNoSummaryJob();
            const learned = await runJob(learnJobHandler);
            expect(learned.result).toMatchObject({
                outcome: { kind: "waiting" },
            });
            const review = await db
                .select()
                .from(learnReviewItems)
                .where(
                    and(
                        eq(learnReviewItems.runId, learn.id),
                        eq(learnReviewItems.userId, owner),
                    ),
                );
            expect(
                review.map(({ kind, payload }) => ({
                    kind,
                    payload: decryptJsonField(payload),
                })),
            ).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        kind: "speaker",
                        payload: expect.objectContaining({
                            label: "Speaker 1",
                        }),
                    }),
                ]),
            );
            await expectNoSummaryJob();

            expect(
                await finishReview(
                    await requireRecordingView(owner, id, "private"),
                    owner,
                    {
                        runId: learn.id,
                        quick: true,
                        versions: Object.fromEntries(
                            review.map((row) => [row.id, row.version]),
                        ),
                    },
                ),
            ).toMatchObject({ status: "finished" });
            await runAdvance(id, "step-settled");
            createCompletion.mockReset().mockResolvedValue(
                chatResponse({
                    summary: "The complete draft.",
                    keyPoints: ["Read it."],
                    actionItems: [],
                }),
            );
            const summarized = await runJob(summaryJobHandler);
            expect(summarized.job.payload).toMatchObject({ trigger: "auto" });
            const saved = await db
                .select()
                .from(aiEnhancements)
                .where(
                    and(
                        eq(aiEnhancements.itemId, id),
                        eq(aiEnhancements.userId, owner),
                    ),
                );
            expect(saved).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        source: "riffado",
                        transcriptionId: own.id,
                    }),
                    expect.objectContaining({ source: "plaud" }),
                ]),
            );
            expect(JSON.stringify(createCompletion.mock.calls)).toContain(
                ownText,
            );
        });

        async function mockTranscriptImport(
            language: string,
            payloadLanguage?: string | null,
            duringFetch?: () => Promise<void>,
        ) {
            const db = database.db;
            await db
                .insert(userSettings)
                .values({ userId: owner, importPlaudContent: true });
            await connectPlaud();
            const object = {
                object_type: "TRANSCRIPT",
                task_status: 1,
                content_url: "https://example.com/transcript.json",
                language,
            };
            const segments = [
                {
                    start_time: 0,
                    end_time: 1000,
                    content: "Read the draft.",
                    segment_uid: "test-segment",
                },
            ];
            const client = {
                getRecordings: vi.fn().mockResolvedValue({
                    data_file_list: [
                        {
                            ...mapPlaudV4Item({
                                file_id: "f_test",
                                name: "Draft review",
                                duration_ms: 1000,
                                version_ms: 1,
                            }),
                            is_trans: true,
                        },
                    ],
                }),
                getFileDetail: vi
                    .fn()
                    .mockResolvedValue(
                        plaudV4DetailToLegacy({ objects: [object] }),
                    ),
                fetchContentLink: vi.fn(async () => {
                    await duringFetch?.();
                    return payloadLanguage
                        ? { language: payloadLanguage, segments }
                        : segments;
                }),
            };
            vi.mocked(createPlaudClient).mockResolvedValue(
                client as unknown as Awaited<
                    ReturnType<typeof createPlaudClient>
                >,
            );
        }

        async function syncTranscript(
            language: string,
            payloadLanguage?: string | null,
            duringFetch?: () => Promise<void>,
        ) {
            const db = database.db;
            await mockTranscriptImport(language, payloadLanguage, duringFetch);
            expect(await syncRecordingsForUser(owner)).toMatchObject({
                errors: [],
                newRecordings: 0,
                updatedRecordings: 0,
            });
            const [transcript] = await db
                .select()
                .from(transcriptions)
                .where(transcriptScope);
            return transcript;
        }

        it.each([
            { manifest: " CA ", payload: null, expected: "ca" },
            { manifest: "en", payload: " CA-es ", expected: "ca" },
            {
                manifest: "cs",
                payload: "malformed-language-that-does-not-fit",
                expected: "cs",
            },
            {
                manifest: "cs",
                payload: "sk-this-is-not-a-valid-language-tag",
                expected: "cs",
            },
            {
                manifest: "zz",
                payload: "malformed-language-that-does-not-fit",
                expected: null,
            },
        ])("normalizes Plaud import language from manifest $manifest and payload $payload", async ({
            manifest,
            payload,
            expected,
        }) => {
            expect(await syncTranscript(manifest, payload)).toMatchObject({
                source: "plaud",
                detectedLanguage: expected,
            });
        });

        it("keeps raw language and presigned query data out of import errors and logs", async () => {
            const language = "test-private-language-value";
            const query = "test-private-presign";
            const url = `https://downloads.example.test/transcript?signature=${query}`;
            const unsafeError = new DrizzleQueryError(
                "insert into transcriptions values ($1)",
                [language, url],
                new Error(`Import failed for ${language} at ${url}`),
            );
            const warnings = vi
                .spyOn(console, "warn")
                .mockImplementation(() => undefined);
            const errors = vi
                .spyOn(console, "error")
                .mockImplementation(() => undefined);
            vi.mocked(captureServerException).mockClear();
            await mockTranscriptImport(language, null, async () => {
                throw unsafeError;
            });
            const result = await syncRecordingsForUser(owner);
            expect(result.errors).toEqual([
                "Plaud content import failed for f_test (DrizzleQueryError)",
            ]);
            const diagnostics = inspect(
                [
                    result.errors,
                    warnings.mock.calls,
                    errors.mock.calls,
                    vi.mocked(captureServerException).mock.calls,
                ],
                { depth: null },
            );
            expect(diagnostics).not.toContain(language);
            expect(diagnostics).not.toContain(query);
        });

        it.each([
            ["cs", null, "cs"],
            ["cs", "sk", "sk"],
            ["garbage", null, null],
            ["constructor", null, null],
            ["__proto__", null, null],
        ])("imports manifest %s and payload %s with the expected language", async (language, payloadLanguage, expected) => {
            expect(
                await syncTranscript(language, payloadLanguage),
            ).toMatchObject({
                source: "plaud",
                detectedLanguage: expected,
            });
        });
    },
);
