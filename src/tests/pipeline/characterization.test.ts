import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as MailAutoProcessModule from "@/lib/mail/auto-process";
import { resolvedAudioProfile } from "@/tests/profiles/seeded-profile-fixture";

const mocks = vi.hoisted(() => ({
    dbSelect: vi.fn(),
    openAiCreate: vi.fn(),
    parseTranscriptionResponse: vi.fn(),
    resolveRunContext: vi.fn(),
    contentWriterRefusalNow: vi.fn(),
    isHostedLockedOut: vi.fn(),
    isOrgScopeEnabled: vi.fn(),
    upsertTranscription: vi.fn(),
    applyGeneratedTitle: vi.fn(),
    queueAutoTopics: vi.fn(),
    queueAutoSummary: vi.fn(),
    emitEvent: vi.fn(),
    isLearnAvailableFor: vi.fn(),
    resolveRecordingAccess: vi.fn(),
    consumeRateLimitBucket: vi.fn(),
    startLearnRun: vi.fn(),
    getActiveJob: vi.fn(),
    isSummaryStale: vi.fn(),
    enqueueTitleJob: vi.fn(),
    recordingJobSubject: vi.fn(),
    requestAdvance: vi.fn(),
    requestAdvanceInTx: vi.fn(),
    readProcessing: vi.fn(),
    gatherFacts: vi.fn(),
    completeProcessingGenerationInTx: vi.fn(),
    updatePhaseInTx: vi.fn(),
    markLearnReleasedInTx: vi.fn(),
    dbTransaction: vi.fn(),
    resolveItemProfile: vi.fn(),
    autoLearnMail: vi.fn(),
}));

vi.mock("@/db", () => ({
    db: {
        select: mocks.dbSelect,
        transaction: mocks.dbTransaction,
    },
}));

vi.mock("@/db/queries/pipeline", () => ({
    completeProcessingGenerationInTx: mocks.completeProcessingGenerationInTx,
}));

vi.mock("@/db/queries/async-jobs", () => ({
    enqueueJobInTx: vi.fn(),
    getActiveJob: mocks.getActiveJob,
}));

vi.mock("openai", () => ({
    OpenAI: class {
        audio = { transcriptions: { create: mocks.openAiCreate } };
    },
}));

vi.mock("@/lib/ai/provider-presets", () => ({
    getDefaultTranscriptionModel: vi.fn().mockReturnValue("whisper-1"),
    getTranscriptionStyle: vi.fn().mockReturnValue("whisper"),
    isEnhancementOnlyProvider: vi.fn().mockReturnValue(false),
    isTranscriptionOnlyProvider: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/ai/usage-cost", () => ({
    recordAiUsage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/encryption", () => ({
    decrypt: vi.fn().mockReturnValue("plain-key"),
}));

vi.mock("@/lib/encryption/fields", () => ({
    decryptText: vi.fn((value: string) => value),
    decryptJsonField: vi.fn((value: unknown) => value),
    encryptText: vi.fn((value: string) => value),
}));

vi.mock("@/lib/entitlements", () => ({
    isHostedLockedOut: mocks.isHostedLockedOut,
}));

vi.mock("@/lib/env", () => ({
    env: {
        AUTO_SUMMARY_RATE_LIMIT_PER_HOUR: 60,
        WHISPER_REQUEST_TIMEOUT_MS: 60_000,
    },
}));

vi.mock("@/lib/export/document-sidecars", () => ({
    exportRecordingSidecarsIfEnabled: vi.fn().mockResolvedValue(undefined),
    removeRecordingSidecar: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/hosted/transcription/mynah", () => ({
    isMynahConfigured: vi.fn().mockReturnValue(false),
    transcribeViaMynah: vi.fn(),
}));

vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));

vi.mock("@/lib/knowledge/attribution", () => ({
    copyMatchingSpeakerAttributions: vi.fn(),
}));

vi.mock("@/lib/knowledge/availability", () => ({
    isLearnAvailableFor: mocks.isLearnAvailableFor,
    isLearnDeploymentAvailable: vi.fn().mockReturnValue(true),
}));

vi.mock("@/lib/knowledge/speaker-label-rules", () => ({
    speakerVersionOf: vi.fn().mockReturnValue({ labels: [] }),
}));

vi.mock("@/lib/knowledge/speaker-labels", () => ({
    storedSpeakerVersion: vi.fn(),
}));

vi.mock("@/lib/knowledge/transcript-rewrite", () => ({
    stampNewTranscriptAudioInTx: vi.fn(),
    transcriptRewrittenInTx: vi.fn(),
}));

vi.mock("@/lib/learn/correction-pass-queue", () => ({
    LEARN_CORRECT_JOB_KIND: "learn.correct",
}));

vi.mock("@/lib/learn/learn-job", () => ({
    settleDeadLearnRuns: vi.fn(),
    startLearnRun: mocks.startLearnRun,
}));

vi.mock("@/lib/learn/learn-open", () => ({ learnRunOpen: vi.fn() }));

vi.mock("@/lib/learn/summary-refresh", () => ({
    isSummaryStale: mocks.isSummaryStale,
}));

vi.mock("@/lib/mail/auto-process", async (importOriginal) => ({
    ...(await importOriginal<typeof MailAutoProcessModule>()),
    autoLearnMail: mocks.autoLearnMail,
}));

vi.mock("@/lib/org/config", () => ({
    getOrgUserId: vi.fn().mockResolvedValue(null),
    isOrgScopeEnabled: mocks.isOrgScopeEnabled,
}));

vi.mock("@/lib/pipeline/facts", () => ({ gatherFacts: mocks.gatherFacts }));

vi.mock("@/lib/pipeline/state", () => ({
    markLearnReleasedInTx: mocks.markLearnReleasedInTx,
    readProcessing: mocks.readProcessing,
    updatePhaseInTx: mocks.updatePhaseInTx,
}));

vi.mock("@/lib/pipeline/trigger", () => ({
    PIPELINE_ADVANCE_JOB_KIND: "pipeline.advance",
    requestAdvance: mocks.requestAdvance,
    requestAdvanceInTx: mocks.requestAdvanceInTx,
}));

vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
    captureServerException: vi.fn(),
}));

vi.mock("@/lib/profiles/resolve", () => ({
    resolveItemProfile: mocks.resolveItemProfile,
}));

vi.mock("@/lib/rate-limit", () => ({
    consumeRateLimitBucket: mocks.consumeRateLimitBucket,
}));

vi.mock("@/lib/recordings/apply-generated-title", () => ({
    applyGeneratedTitle: mocks.applyGeneratedTitle,
}));

vi.mock("@/lib/recordings/title-job", () => ({
    enqueueTitleJob: mocks.enqueueTitleJob,
}));

vi.mock("@/lib/sharing/access", () => ({
    resolveRecordingAccess: mocks.resolveRecordingAccess,
}));

vi.mock("@/lib/sharing/notify", () => ({
    notifyIfShared: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/sharing/run-context", () => ({
    resolveRunContext: mocks.resolveRunContext,
}));

vi.mock("@/lib/sharing/view", () => ({
    recordingJobSubject: mocks.recordingJobSubject,
}));

vi.mock("@/lib/sharing/writer", () => ({
    contentWriterRefusal: vi.fn(),
    contentWriterRefusalNow: mocks.contentWriterRefusalNow,
    sharingOrgUserId: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: vi.fn().mockResolvedValue({
        downloadFile: vi.fn().mockResolvedValue(Buffer.from("audio")),
    }),
}));

vi.mock("@/lib/summary/auto-summary", () => ({
    queueAutoSummary: mocks.queueAutoSummary,
}));

vi.mock("@/lib/summary/summary-job", () => ({
    SUMMARY_JOB_KIND: "summary",
}));

vi.mock("@/lib/topics/topics-job", () => ({
    queueAutoTopics: mocks.queueAutoTopics,
}));

vi.mock("@/lib/transcription/almanac-terms", () => ({
    almanacTermsFor: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/transcription/audio-file", () => ({
    buildAudioFile: vi.fn().mockReturnValue({
        file: { name: "recording.mp3" },
        contentType: "audio/mpeg",
    }),
}));

vi.mock("@/lib/transcription/chat-transcribe", () => ({
    chatTranscribe: vi.fn(),
}));

vi.mock("@/lib/transcription/compress-audio", () => ({
    maybeCompressForWhisper: vi.fn(async (buffer: Buffer) => ({
        buffer,
        compressed: false,
    })),
}));

vi.mock("@/lib/transcription/elevenlabs-transcribe", () => ({
    elevenLabsTakesKeyterms: vi.fn().mockReturnValue(false),
    elevenLabsTranscribe: vi.fn(),
}));

vi.mock("@/lib/transcription/format", () => ({
    buildTranscriptionParams: vi.fn().mockReturnValue({}),
    getResponseFormat: vi.fn().mockReturnValue("verbose_json"),
    parseTranscriptionResponse: mocks.parseTranscriptionResponse,
}));

vi.mock("@/lib/transcription/gemini-transcribe", () => ({
    geminiTranscribe: vi.fn(),
}));

vi.mock("@/lib/transcription/included-provider", () => ({
    isRiffadoIncludedProviderId: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/transcription/persist", () => ({
    upsertTranscription: mocks.upsertTranscription,
}));

vi.mock("@/lib/transcription/speechmatics-transcribe", () => ({
    speechmaticsTakesVocabulary: vi.fn().mockReturnValue(false),
    speechmaticsTranscribe: vi.fn(),
}));

vi.mock("@/lib/webhooks/emit", () => ({
    emitEvent: mocks.emitEvent,
}));

import * as autoLearn from "@/lib/learn/auto-learn";
import { pipelineAdvanceJobHandler } from "@/lib/pipeline/advance-job";
import type { PipelineFacts } from "@/lib/pipeline/types";
import { transcribeRecording } from "@/lib/transcription/transcribe-recording";

const USER_ID = "user-1";
const ITEM_ID = "item-1";
const AT = "2026-10-14T12:00:00.000Z";
const DEFAULT_PROFILE: NonNullable<PipelineFacts["profile"]> = {
    revisionId: "seeded-profile-revision",
    automatic: {
        learn: false,
        summary: true,
        title: true,
        topics: true,
    },
};

function profileAutomatic(
    overrides: Partial<NonNullable<PipelineFacts["profile"]>["automatic"]>,
) {
    return {
        ...DEFAULT_PROFILE,
        automatic: { ...DEFAULT_PROFILE.automatic, ...overrides },
    };
}
let pipelineFacts: PipelineFacts;
let pipelineRequested = false;
const TRANSCRIPT_TURN = {
    speaker: "speaker_0",
    startMs: 0,
    endMs: 1_000,
    text: "Transcript text",
};

function selectWithLimit(rows: unknown[]) {
    return {
        from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue(rows),
            }),
        }),
    };
}

function selectRecording(rows: unknown[]) {
    return {
        from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue(rows),
                }),
            }),
        }),
    };
}

function baseFacts(): PipelineFacts {
    return {
        item: {
            exists: true,
            deleted: false,
            kind: "audio",
            ownerUserId: USER_ID,
        },
        view: "private",
        generation: 1,
        content: {
            contentId: "transcription-1",
            contentSourceId: "riffado",
            contentRevision: 1,
            timed: true,
        },
        summaryDueAt: null,
        profile: { ...DEFAULT_PROFILE },
        categorization: {
            placementFolderIds: ["folder-1"],
            intendedFolderIds: [],
            profileAssigned: true,
            resolution: "resolved",
        },
        hasEnhancementCredential: true,
        mail: null,
        summary: { exists: false, stale: false, jobActive: false },
        taskReview: { proposals: 0, followUps: 0 },
        phases: {
            categorize: {
                state: "done",
                reason: "categorized",
                generation: 1,
                at: AT,
            },
            transcribe: {
                state: "done",
                reason: "content-available",
                generation: 1,
                inputs: {
                    contentId: "transcription-1",
                    contentSourceId: "riffado",
                    contentRevision: 1,
                },
                at: AT,
                profileRevisionId: DEFAULT_PROFILE.revisionId,
            },
            learn: {
                state: "skipped",
                reason: "disabled",
                generation: 1,
                inputs: {
                    contentId: "transcription-1",
                    contentSourceId: "riffado",
                    contentRevision: 1,
                },
                at: AT,
                profileRevisionId: DEFAULT_PROFILE.revisionId,
            },
        },
        at: AT,
    };
}

async function runPipelineAdvance() {
    return pipelineAdvanceJobHandler.run({
        jobId: "pipeline-job-1",
        userId: USER_ID,
        payload: { itemId: ITEM_ID, view: "private", reason: "test" },
        attempt: 1,
        maxAttempts: 10,
        signal: new AbortController().signal,
        reportProgress: vi.fn(),
    } as Parameters<typeof pipelineAdvanceJobHandler.run>[0]);
}

async function transcribeAndAdvance(
    opts: Parameters<typeof transcribeRecording>[2] = {},
) {
    const result = await transcribeRecording(USER_ID, ITEM_ID, opts);
    if (opts.view === "org") return result;
    await runPipelineAdvance();
    return result;
}

async function processMailAndAdvance() {
    pipelineRequested = false;
    await mocks.requestAdvance({
        itemId: ITEM_ID,
        userId: USER_ID,
        view: "private",
        reason: "arrival",
    });
    if (pipelineRequested) await runPipelineAdvance();
}

function mountTranscription({
    autoGenerateTitle = true,
    autoSummarize = true,
    timed = true,
    transcriptText = "Transcript text",
}: {
    autoGenerateTitle?: boolean;
    autoSummarize?: boolean;
    timed?: boolean;
    transcriptText?: string;
} = {}) {
    mocks.resolveItemProfile.mockResolvedValue({
        ...resolvedAudioProfile({
            autoGenerateTitle,
            autoSummarize,
            autoSummarizePreset: "meeting-notes",
            autoDetectTopics: true,
        }),
        assigned: true,
    });
    mocks.dbSelect
        .mockReturnValueOnce(
            selectRecording([
                {
                    id: ITEM_ID,
                    userId: USER_ID,
                    plaudFileId: "plaud-1",
                    title: "Original title",
                    storagePath: "recording.mp3",
                    duration: 1_000,
                    fileMd5: "0".repeat(32),
                    audioReapedAt: null,
                    deletedAt: null,
                },
            ]),
        )
        .mockReturnValueOnce(selectWithLimit([]))
        .mockReturnValueOnce(
            selectWithLimit([
                {
                    id: "credential-1",
                    userId: USER_ID,
                    provider: "openai",
                    apiKey: "encrypted-key",
                    defaultModel: "whisper-1",
                    baseUrl: null,
                    isDefaultTranscription: true,
                    isDefaultEnhancement: false,
                    isDefaultLearn: false,
                    inputUsdPerMillion: null,
                    outputUsdPerMillion: null,
                    audioUsdPerHour: null,
                    disabledAt: null,
                    createdAt: new Date("2026-01-01T00:00:00.000Z"),
                    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
                },
            ]),
        )
        .mockReturnValueOnce(
            selectWithLimit([
                {
                    syncTitleToPlaud: false,
                    defaultTranscriptionProviderId: null,
                },
            ]),
        );
    mocks.parseTranscriptionResponse.mockReturnValue({
        text: transcriptText,
        detectedLanguage: "en",
        turns: timed ? [TRANSCRIPT_TURN] : undefined,
    });
    pipelineFacts = {
        ...baseFacts(),
        content: {
            contentId: "transcription-1",
            contentSourceId: "riffado",
            contentRevision: 1,
            timed,
        },
        profile: profileAutomatic({
            title: autoGenerateTitle,
            summary: autoSummarize,
        }),
    };
}

function mountMail({
    mailAutoProcess = true,
    autoLearn: shouldLearn = false,
    autoGenerated = false,
    unreadable = false,
    credentials = [{ id: "credential-1" }],
}: {
    mailAutoProcess?: boolean;
    autoLearn?: boolean;
    autoGenerated?: boolean;
    unreadable?: boolean;
    credentials?: unknown[];
} = {}) {
    pipelineFacts = {
        ...baseFacts(),
        item: {
            exists: true,
            deleted: false,
            kind: "mail",
            ownerUserId: USER_ID,
        },
        content: {
            contentId: "mail-content-1",
            contentSourceId: "mail",
            contentRevision: 1,
            timed: false,
        },
        profile: profileAutomatic({
            summary: mailAutoProcess,
            learn: shouldLearn,
            topics: false,
        }),
        hasEnhancementCredential: credentials.length > 0,
        mail: { autoGenerated, unreadable, shared: false },
        phases: {
            categorize: baseFacts().phases.categorize,
            transcribe: {
                state: "skipped",
                reason: "not-applicable",
                generation: 1,
                at: AT,
            },
            ...(shouldLearn
                ? {}
                : {
                      learn: {
                          state: "skipped" as const,
                          reason: "disabled",
                          generation: 1,
                          inputs: {
                              contentId: "mail-content-1",
                              contentSourceId: "mail",
                              contentRevision: 1,
                          },
                          at: AT,
                          profileRevisionId: DEFAULT_PROFILE.revisionId,
                      },
                  }),
        },
    };
}

function mountRelease({
    autoGenerateTitle = false,
    autoSummarize = true,
    madeSummary = false,
    stale = false,
    active = false,
    recording = [{ id: ITEM_ID }],
}: {
    autoGenerateTitle?: boolean;
    autoSummarize?: boolean;
    madeSummary?: boolean;
    stale?: boolean;
    active?: boolean;
    recording?: unknown[];
} = {}) {
    mocks.requestAdvanceInTx.mockResolvedValue(
        recording.length > 0
            ? { requestedGeneration: 1, enqueued: true }
            : null,
    );
    mocks.dbSelect.mockReturnValueOnce(
        selectWithLimit(recording.length > 0 ? [{ revision: 1 }] : []),
    );
    pipelineFacts = {
        ...baseFacts(),
        profile: profileAutomatic({
            title: autoGenerateTitle,
            summary: autoSummarize,
        }),
        summary: {
            exists: madeSummary,
            stale,
            jobActive: active,
        },
        phases: {
            ...baseFacts().phases,
            learn: {
                state: "done",
                reason: "released",
                generation: 1,
                inputs: {
                    contentId: "transcription-1",
                    contentSourceId: "riffado",
                    contentRevision: 1,
                },
                at: AT,
            },
        },
    };
}

async function runLearnRelease() {
    const result = await autoLearn.learnReleaseJobHandler.run({
        jobId: "release-job-1",
        userId: USER_ID,
        payload: { recordingId: ITEM_ID },
        attempt: 1,
        maxAttempts: 5,
        signal: new AbortController().signal,
        reportProgress: vi.fn(),
    } as Parameters<typeof autoLearn.learnReleaseJobHandler.run>[0]);
    if (result && "skipped" in result) return result;
    await runPipelineAdvance();
    return result;
}

beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    mocks.dbSelect.mockReset();
    pipelineFacts = baseFacts();
    pipelineRequested = false;
    mocks.dbTransaction.mockImplementation(
        async (callback: (tx: { select: typeof mocks.dbSelect }) => unknown) =>
            callback({ select: mocks.dbSelect }),
    );
    mocks.requestAdvance.mockImplementation(async () => {
        pipelineRequested = true;
        return { requestedGeneration: 1, enqueued: true };
    });
    mocks.requestAdvanceInTx.mockResolvedValue({
        requestedGeneration: 1,
        enqueued: true,
    });
    mocks.readProcessing.mockResolvedValue({ requestedGeneration: 1 });
    mocks.gatherFacts.mockImplementation(async () => pipelineFacts);
    mocks.completeProcessingGenerationInTx.mockResolvedValue("stable");
    mocks.updatePhaseInTx.mockResolvedValue(true);
    mocks.markLearnReleasedInTx.mockResolvedValue(true);
    mocks.resolveRunContext.mockImplementation(
        async (actorUserId: string, _recordingId: string, view: string) => ({
            view,
            actorUserId,
            ownerUserId: actorUserId,
            contentUserId: actorUserId,
            settingsUserId: actorUserId,
            actsForOrganization: view === "org",
        }),
    );
    mocks.contentWriterRefusalNow.mockResolvedValue(null);
    mocks.isHostedLockedOut.mockResolvedValue(false);
    mocks.isOrgScopeEnabled.mockReturnValue(true);
    mocks.openAiCreate.mockResolvedValue({ text: "unused" });
    mocks.upsertTranscription.mockResolvedValue({ committed: true });
    mocks.applyGeneratedTitle.mockResolvedValue(undefined);
    mocks.queueAutoTopics.mockResolvedValue(undefined);
    mocks.queueAutoSummary.mockResolvedValue(undefined);
    mocks.emitEvent.mockResolvedValue(undefined);
    mocks.isLearnAvailableFor.mockResolvedValue(true);
    mocks.resolveRecordingAccess.mockResolvedValue({
        recordingId: ITEM_ID,
        kind: "mail",
        ownerUserId: USER_ID,
        role: "owner",
        shared: false,
        orgUserId: null,
    });
    mocks.consumeRateLimitBucket.mockResolvedValue({ allowed: true });
    mocks.startLearnRun.mockResolvedValue(undefined);
    mocks.autoLearnMail.mockResolvedValue({ status: "started" });
    mocks.getActiveJob.mockResolvedValue(null);
    mocks.isSummaryStale.mockResolvedValue(false);
    mocks.enqueueTitleJob.mockResolvedValue(undefined);
    mocks.recordingJobSubject.mockImplementation(
        (recordingId: string, view: string) => `${recordingId}:${view}`,
    );
    mocks.resolveItemProfile.mockResolvedValue(resolvedAudioProfile());
});

describe("pipeline driver facts", () => {
    it("uses the generation from the same facts row for marks and completion", async () => {
        pipelineFacts = {
            ...baseFacts(),
            generation: 7,
            profile: profileAutomatic({ summary: false }),
            content: {
                contentId: "transcription-1",
                contentSourceId: "riffado",
                contentRevision: 1,
                timed: false,
            },
        };

        await runPipelineAdvance();

        expect(mocks.readProcessing).not.toHaveBeenCalled();
        expect(mocks.completeProcessingGenerationInTx).toHaveBeenCalledWith(
            expect.anything(),
            ITEM_ID,
            "private",
            USER_ID,
            7,
        );
    });
});

describe("transcribeRecording post-write triggers", () => {
    it("leaves the single automatic Learn start to the pipeline", async () => {
        mountTranscription();
        pipelineFacts.profile = {
            ...pipelineFacts.profile,
            revisionId: "seeded-profile-revision",
            learn: { automatic: true },
            automatic: {
                ...pipelineFacts.profile?.automatic,
                learn: true,
                summary: true,
                title: true,
                topics: true,
            },
        };
        pipelineFacts.learnAvailability = "available";
        delete pipelineFacts.phases.learn;
        const start = vi
            .spyOn(autoLearn, "startAutomaticLearn")
            .mockResolvedValue({ status: "started" });

        const result = await transcribeAndAdvance();

        expect(result.success).toBe(true);
        expect(start).toHaveBeenCalledOnce();
        expect(start).toHaveBeenCalledWith({
            userId: USER_ID,
            itemId: ITEM_ID,
            source: "riffado",
            timed: true,
        });
        expect(mocks.applyGeneratedTitle).not.toHaveBeenCalled();
        expect(mocks.emitEvent).toHaveBeenCalledWith(
            "transcription.completed",
            USER_ID,
            ITEM_ID,
        );
        expect(mocks.queueAutoTopics).not.toHaveBeenCalled();
        expect(mocks.queueAutoSummary).not.toHaveBeenCalled();
    });

    it("queues the title, then timed topics and the summary", async () => {
        mountTranscription();

        const result = await transcribeAndAdvance();

        expect(result.success).toBe(true);
        expect(mocks.applyGeneratedTitle).not.toHaveBeenCalled();
        expect(mocks.enqueueTitleJob).toHaveBeenCalledWith(USER_ID, ITEM_ID);
        expect(mocks.queueAutoTopics).toHaveBeenCalledWith(
            USER_ID,
            ITEM_ID,
            "riffado",
            { strict: true },
        );
        expect(mocks.queueAutoSummary).toHaveBeenCalledWith(
            USER_ID,
            ITEM_ID,
            null,
            { strict: true },
        );
        expect(mocks.enqueueTitleJob.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.queueAutoTopics.mock.invocationCallOrder[0] ?? 0,
        );
        expect(mocks.queueAutoTopics.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.queueAutoSummary.mock.invocationCallOrder[0] ?? 0,
        );
        expect(mocks.emitEvent.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.enqueueTitleJob.mock.invocationCallOrder[0] ?? 0,
        );
    });

    it("queues topics and summary without a title when automatic titles are off", async () => {
        mountTranscription({ autoGenerateTitle: false });

        await transcribeAndAdvance();

        expect(mocks.applyGeneratedTitle).not.toHaveBeenCalled();
        expect(mocks.queueAutoTopics).toHaveBeenCalledOnce();
        expect(mocks.queueAutoSummary).toHaveBeenCalledOnce();
    });

    it.each([
        "",
        "  \t\n",
    ])("does not generate a title for an empty or whitespace transcript", async (transcriptText) => {
        mountTranscription({ transcriptText });

        await transcribeAndAdvance();

        expect(mocks.applyGeneratedTitle).not.toHaveBeenCalled();
        expect(mocks.queueAutoTopics).toHaveBeenCalledOnce();
        expect(mocks.queueAutoSummary).toHaveBeenCalledOnce();
    });

    it("does not queue topics for an untimed transcript", async () => {
        mountTranscription({ timed: false });

        await transcribeAndAdvance();

        expect(mocks.applyGeneratedTitle).not.toHaveBeenCalled();
        expect(mocks.enqueueTitleJob).toHaveBeenCalledOnce();
        expect(mocks.queueAutoTopics).not.toHaveBeenCalled();
        expect(mocks.queueAutoSummary).toHaveBeenCalledOnce();
    });

    it("does not run private-view follow-ups on the Organization view", async () => {
        mountTranscription();

        await transcribeAndAdvance({ view: "org" });

        expect(mocks.applyGeneratedTitle).not.toHaveBeenCalled();
        expect(mocks.queueAutoTopics).not.toHaveBeenCalled();
        expect(mocks.queueAutoSummary).not.toHaveBeenCalled();
    });

    it("writes the private pipeline view but not the Organization pipeline", async () => {
        mountTranscription();

        await transcribeRecording(USER_ID, ITEM_ID);

        expect(mocks.upsertTranscription).toHaveBeenCalledWith(
            expect.objectContaining({ view: "private" }),
        );

        vi.clearAllMocks();
        mountTranscription();
        await transcribeRecording(USER_ID, ITEM_ID, { view: "org" });

        expect(mocks.upsertTranscription).toHaveBeenCalledWith(
            expect.objectContaining({ view: "org" }),
        );
    });

    it("does not queue a summary when automatic summaries are off", async () => {
        mountTranscription({ autoSummarize: false });

        await transcribeAndAdvance();

        expect(mocks.applyGeneratedTitle).not.toHaveBeenCalled();
        expect(mocks.enqueueTitleJob).toHaveBeenCalledOnce();
        expect(mocks.queueAutoTopics).toHaveBeenCalledOnce();
        expect(mocks.queueAutoSummary).not.toHaveBeenCalled();
    });
});

describe("mail arrival pipeline triggers", () => {
    it("does nothing when automatic mail processing is off", async () => {
        mountMail({ mailAutoProcess: false });

        await processMailAndAdvance();

        expect(mocks.queueAutoSummary).not.toHaveBeenCalled();
        expect(mocks.startLearnRun).not.toHaveBeenCalled();
    });

    it("does nothing for machine-sent mail", async () => {
        mountMail({ autoGenerated: true });

        await processMailAndAdvance();

        expect(mocks.queueAutoSummary).not.toHaveBeenCalled();
        expect(mocks.startLearnRun).not.toHaveBeenCalled();
    });

    it("does nothing for unreadable mail", async () => {
        mountMail({ unreadable: true });

        await processMailAndAdvance();

        expect(mocks.queueAutoSummary).not.toHaveBeenCalled();
        expect(mocks.startLearnRun).not.toHaveBeenCalled();
    });

    it("queues the summary but not Learn when Learn is unavailable", async () => {
        mountMail({ autoLearn: true });
        pipelineFacts.learnAvailability = "no_provider";

        await processMailAndAdvance();

        expect(mocks.queueAutoSummary).toHaveBeenCalledWith(
            USER_ID,
            ITEM_ID,
            null,
            { strict: true },
        );
        expect(mocks.autoLearnMail).not.toHaveBeenCalled();
    });

    it("defers the pipeline when the Learn rate limit refuses", async () => {
        mountMail({ autoLearn: true });
        mocks.autoLearnMail.mockResolvedValue({
            status: "deferred",
            delayMs: 60_000,
        });

        await expect(processMailAndAdvance()).rejects.toThrow(
            "hourly cap on automatic Learn is full",
        );

        expect(mocks.queueAutoSummary).not.toHaveBeenCalled();
        expect(mocks.updatePhaseInTx).not.toHaveBeenCalledWith(
            expect.anything(),
            ITEM_ID,
            "private",
            USER_ID,
            "learn",
            expect.objectContaining({
                state: "skipped",
                reason: "rate_limited",
            }),
        );
        expect(mocks.startLearnRun).not.toHaveBeenCalled();
    });

    it.each([
        { name: "a non-owner role", access: { role: "editor" } },
        { name: "no access", access: null },
    ])("records skipped Learn with $name", async ({ access }) => {
        mountMail({ autoLearn: true });
        mocks.autoLearnMail.mockResolvedValue({
            status: "skipped",
            reason: access ? "shared" : "gone",
        });

        await processMailAndAdvance();

        expect(mocks.queueAutoSummary).not.toHaveBeenCalled();
        expect(mocks.autoLearnMail).toHaveBeenCalledWith(USER_ID, ITEM_ID);
        expect(mocks.startLearnRun).not.toHaveBeenCalled();
    });

    it("uses the seeded mail profile without running Learn", async () => {
        mountMail();

        await processMailAndAdvance();

        expect(mocks.queueAutoSummary).toHaveBeenCalledWith(
            USER_ID,
            ITEM_ID,
            null,
            { strict: true },
        );
        expect(mocks.startLearnRun).not.toHaveBeenCalled();
    });

    it("does nothing without an enhancement credential", async () => {
        mountMail({ credentials: [] });

        await processMailAndAdvance();

        expect(mocks.queueAutoSummary).not.toHaveBeenCalled();
        expect(mocks.startLearnRun).not.toHaveBeenCalled();
    });

    it.each([
        { autoLearn: true, expectedLearnCalls: 1 },
        { autoLearn: false, expectedLearnCalls: 0 },
    ])("queues a normal mail summary and follows autoLearn=$autoLearn", async ({
        autoLearn: shouldLearn,
        expectedLearnCalls,
    }) => {
        mountMail({ autoLearn: shouldLearn });

        await processMailAndAdvance();

        if (shouldLearn) {
            expect(mocks.queueAutoSummary).not.toHaveBeenCalled();
        } else {
            expect(mocks.queueAutoSummary).toHaveBeenCalledWith(
                USER_ID,
                ITEM_ID,
                null,
                { strict: true },
            );
        }
        expect(mocks.autoLearnMail).toHaveBeenCalledTimes(expectedLearnCalls);
        if (shouldLearn) {
            expect(mocks.autoLearnMail).toHaveBeenCalledWith(USER_ID, ITEM_ID);
        }
    });

    it("does not start Learn when the item is already shared", async () => {
        mountMail({ autoLearn: true });
        mocks.resolveRecordingAccess.mockResolvedValue({
            recordingId: ITEM_ID,
            kind: "mail",
            ownerUserId: USER_ID,
            role: "owner",
            shared: true,
            orgUserId: "org-1",
        });
        mocks.autoLearnMail.mockResolvedValue({
            status: "skipped",
            reason: "shared",
        });

        await processMailAndAdvance();

        expect(mocks.queueAutoSummary).not.toHaveBeenCalled();
        expect(mocks.autoLearnMail).toHaveBeenCalledWith(USER_ID, ITEM_ID);
        expect(mocks.startLearnRun).not.toHaveBeenCalled();
    });
});

describe("learn.release triggers", () => {
    it("reports gone and queues nothing when the item is missing", async () => {
        mountRelease({ recording: [] });

        await expect(runLearnRelease()).resolves.toEqual({ skipped: "gone" });
        expect(mocks.queueAutoSummary).not.toHaveBeenCalled();
        expect(mocks.queueAutoTopics).not.toHaveBeenCalled();
        expect(mocks.enqueueTitleJob).not.toHaveBeenCalled();
    });

    it.each([
        {
            name: "missing",
            madeSummary: false,
            stale: false,
            active: false,
            expected: true,
        },
        {
            name: "stale",
            madeSummary: true,
            stale: true,
            active: false,
            expected: true,
        },
        {
            name: "fresh",
            madeSummary: true,
            stale: false,
            active: false,
            expected: false,
        },
        {
            name: "already active",
            madeSummary: false,
            stale: false,
            active: true,
            expected: false,
        },
    ])("queues a summary for $name output only when needed and inactive", async ({
        madeSummary,
        stale,
        active,
        expected,
    }) => {
        mountRelease({ madeSummary, stale, active });

        await runLearnRelease();

        expect(mocks.queueAutoSummary).toHaveBeenCalledTimes(expected ? 1 : 0);
        if (expected) {
            expect(mocks.queueAutoSummary).toHaveBeenCalledWith(
                USER_ID,
                ITEM_ID,
                null,
                { strict: true },
            );
        }
    });

    it("always queues topics in strict mode", async () => {
        mountRelease({ autoSummarize: false });

        await runLearnRelease();

        expect(mocks.queueAutoTopics).toHaveBeenCalledWith(
            USER_ID,
            ITEM_ID,
            "riffado",
            { strict: true },
        );
        expect(mocks.queueAutoSummary).not.toHaveBeenCalled();
    });

    it("uses the seeded profile's automatic title", async () => {
        mountRelease({ autoGenerateTitle: true, autoSummarize: false });

        await runLearnRelease();

        expect(mocks.enqueueTitleJob).toHaveBeenCalledWith(USER_ID, ITEM_ID);
        expect(mocks.queueAutoSummary).not.toHaveBeenCalled();
    });

    it("returns the pipeline job it queued, then the driver queues summary and title", async () => {
        mountRelease({ autoGenerateTitle: true });

        await expect(runLearnRelease()).resolves.toEqual({
            queued: ["pipeline.advance"],
        });
        expect(mocks.queueAutoSummary).toHaveBeenCalledOnce();
        expect(mocks.enqueueTitleJob).toHaveBeenCalledOnce();
    });

    it.each([
        { autoGenerateTitle: true, expectedCalls: 1 },
        { autoGenerateTitle: false, expectedCalls: 0 },
    ])("queues the title according to autoGenerateTitle=$autoGenerateTitle", async ({
        autoGenerateTitle,
        expectedCalls,
    }) => {
        mountRelease({ autoGenerateTitle, autoSummarize: false });

        await runLearnRelease();

        expect(mocks.enqueueTitleJob).toHaveBeenCalledTimes(expectedCalls);
        if (autoGenerateTitle) {
            expect(mocks.enqueueTitleJob).toHaveBeenCalledWith(
                USER_ID,
                ITEM_ID,
            );
        }
    });
});
