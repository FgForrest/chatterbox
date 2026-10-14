import { beforeEach, describe, expect, it, vi } from "vitest";

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
    pickEnhancementCredential: vi.fn(),
    isLearnAvailableFor: vi.fn(),
    resolveRecordingAccess: vi.fn(),
    consumeRateLimitBucket: vi.fn(),
    startLearnRun: vi.fn(),
    getActiveJob: vi.fn(),
    isSummaryStale: vi.fn(),
    enqueueTitleJob: vi.fn(),
    recordingJobSubject: vi.fn(),
}));

vi.mock("@/db", () => ({
    db: {
        select: mocks.dbSelect,
    },
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

vi.mock("@/lib/ai/enhancement-provider", () => ({
    pickEnhancementCredential: mocks.pickEnhancementCredential,
}));

vi.mock("@/lib/ai/provider-presets", () => ({
    getDefaultTranscriptionModel: vi.fn().mockReturnValue("whisper-1"),
    getTranscriptionStyle: vi.fn().mockReturnValue("whisper"),
}));

vi.mock("@/lib/ai/usage-cost", () => ({
    recordAiUsage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/encryption", () => ({
    decrypt: vi.fn().mockReturnValue("plain-key"),
}));

vi.mock("@/lib/encryption/fields", () => ({
    decryptText: vi.fn((value: string) => value),
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

vi.mock("@/lib/org/config", () => ({
    isOrgScopeEnabled: mocks.isOrgScopeEnabled,
}));

vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
    captureServerException: vi.fn(),
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
import { processNewMail } from "@/lib/mail/auto-process";
import { transcribeRecording } from "@/lib/transcription/transcribe-recording";

const USER_ID = "user-1";
const ITEM_ID = "item-1";
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

function selectWithoutLimit(rows: unknown[]) {
    return {
        from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(rows),
        }),
    };
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
                },
            ]),
        )
        .mockReturnValueOnce(
            selectWithLimit([
                {
                    autoGenerateTitle,
                    syncTitleToPlaud: false,
                    autoSummarize,
                    autoSummarizePreset: "meeting-notes",
                    defaultTranscriptionProviderId: null,
                },
            ]),
        );
    mocks.parseTranscriptionResponse.mockReturnValue({
        text: transcriptText,
        detectedLanguage: "en",
        turns: timed ? [TRANSCRIPT_TURN] : undefined,
    });
}

function mountMail({
    mailAutoProcess = true,
    autoLearn: shouldLearn = false,
    autoGenerated = false,
    unreadable = false,
    credentials = [{ id: "credential-1" }],
    settings = [{ mailAutoProcess, autoLearn: shouldLearn }],
}: {
    mailAutoProcess?: boolean;
    autoLearn?: boolean;
    autoGenerated?: boolean;
    unreadable?: boolean;
    credentials?: unknown[];
    settings?: unknown[];
} = {}) {
    mocks.dbSelect
        .mockReturnValueOnce(selectWithLimit(settings))
        .mockReturnValueOnce(selectWithLimit([{ autoGenerated, unreadable }]))
        .mockReturnValueOnce(selectWithoutLimit(credentials));
}

function mountRelease({
    autoGenerateTitle = false,
    autoSummarize = true,
    madeSummary = false,
    recording = [{ id: ITEM_ID }],
    settings = [
        {
            autoGenerateTitle,
            autoSummarize,
            autoSummarizePreset: "meeting-notes",
        },
    ],
}: {
    autoGenerateTitle?: boolean;
    autoSummarize?: boolean;
    madeSummary?: boolean;
    recording?: unknown[];
    settings?: unknown[];
} = {}) {
    mocks.dbSelect
        .mockReturnValueOnce(selectWithLimit(recording))
        .mockReturnValueOnce(selectWithLimit(settings))
        .mockReturnValueOnce(
            selectWithLimit(madeSummary ? [{ id: "summary-1" }] : []),
        );
}

async function runLearnRelease() {
    return autoLearn.learnReleaseJobHandler.run({
        jobId: "release-job-1",
        userId: USER_ID,
        payload: { recordingId: ITEM_ID },
        attempt: 1,
        maxAttempts: 5,
        signal: new AbortController().signal,
        reportProgress: vi.fn(),
    } as Parameters<typeof autoLearn.learnReleaseJobHandler.run>[0]);
}

beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    mocks.dbSelect.mockReset();
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
    mocks.pickEnhancementCredential.mockImplementation(
        (credentials: unknown[]) => credentials[0] ?? null,
    );
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
    mocks.getActiveJob.mockResolvedValue(null);
    mocks.isSummaryStale.mockResolvedValue(false);
    mocks.enqueueTitleJob.mockResolvedValue(undefined);
    mocks.recordingJobSubject.mockImplementation(
        (recordingId: string, view: string) => `${recordingId}:${view}`,
    );
    vi.spyOn(autoLearn, "holdForAutoLearn").mockResolvedValue(false);
});

describe("transcribeRecording post-write triggers", () => {
    it("queues no title, topics, or summary while automatic Learn holds", async () => {
        mountTranscription();
        vi.mocked(autoLearn.holdForAutoLearn).mockResolvedValue(true);

        const result = await transcribeRecording(USER_ID, ITEM_ID);

        expect(result.success).toBe(true);
        expect(autoLearn.holdForAutoLearn).toHaveBeenCalledWith({
            userId: USER_ID,
            recordingId: ITEM_ID,
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

    it("generates the title, then queues timed topics and the summary", async () => {
        mountTranscription();

        const result = await transcribeRecording(USER_ID, ITEM_ID);

        expect(result.success).toBe(true);
        expect(mocks.applyGeneratedTitle).toHaveBeenCalledWith({
            userId: USER_ID,
            recordingId: ITEM_ID,
            text: "Transcript text",
            plaudFileId: "plaud-1",
            syncTitleToPlaud: false,
        });
        expect(mocks.queueAutoTopics).toHaveBeenCalledWith(
            USER_ID,
            ITEM_ID,
            "riffado",
        );
        expect(mocks.queueAutoSummary).toHaveBeenCalledWith(
            USER_ID,
            ITEM_ID,
            "meeting-notes",
        );
        expect(
            mocks.applyGeneratedTitle.mock.invocationCallOrder[0],
        ).toBeLessThan(mocks.queueAutoTopics.mock.invocationCallOrder[0] ?? 0);
        expect(mocks.queueAutoTopics.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.queueAutoSummary.mock.invocationCallOrder[0] ?? 0,
        );
        expect(
            mocks.applyGeneratedTitle.mock.invocationCallOrder[0],
        ).toBeLessThan(mocks.emitEvent.mock.invocationCallOrder[0] ?? 0);
        expect(mocks.emitEvent.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.queueAutoTopics.mock.invocationCallOrder[0] ?? 0,
        );
    });

    it("queues topics and summary without a title when automatic titles are off", async () => {
        mountTranscription({ autoGenerateTitle: false });

        await transcribeRecording(USER_ID, ITEM_ID);

        expect(mocks.applyGeneratedTitle).not.toHaveBeenCalled();
        expect(mocks.queueAutoTopics).toHaveBeenCalledOnce();
        expect(mocks.queueAutoSummary).toHaveBeenCalledOnce();
    });

    it.each([
        "",
        "  \t\n",
    ])("does not generate a title for an empty or whitespace transcript", async (transcriptText) => {
        mountTranscription({ transcriptText });

        await transcribeRecording(USER_ID, ITEM_ID);

        expect(mocks.applyGeneratedTitle).not.toHaveBeenCalled();
        expect(mocks.queueAutoTopics).toHaveBeenCalledOnce();
        expect(mocks.queueAutoSummary).toHaveBeenCalledOnce();
    });

    it("does not queue topics for an untimed transcript", async () => {
        mountTranscription({ timed: false });

        await transcribeRecording(USER_ID, ITEM_ID);

        expect(autoLearn.holdForAutoLearn).toHaveBeenCalledWith({
            userId: USER_ID,
            recordingId: ITEM_ID,
            timed: false,
        });
        expect(mocks.applyGeneratedTitle).toHaveBeenCalledOnce();
        expect(mocks.queueAutoTopics).not.toHaveBeenCalled();
        expect(mocks.queueAutoSummary).toHaveBeenCalledOnce();
    });

    it("does not run private-view follow-ups on the Organization view", async () => {
        mountTranscription();

        await transcribeRecording(USER_ID, ITEM_ID, { view: "org" });

        expect(autoLearn.holdForAutoLearn).not.toHaveBeenCalled();
        expect(mocks.applyGeneratedTitle).not.toHaveBeenCalled();
        expect(mocks.queueAutoTopics).not.toHaveBeenCalled();
        expect(mocks.queueAutoSummary).not.toHaveBeenCalled();
    });

    it("does not queue a summary when automatic summaries are off", async () => {
        mountTranscription({ autoSummarize: false });

        await transcribeRecording(USER_ID, ITEM_ID);

        expect(mocks.applyGeneratedTitle).toHaveBeenCalledOnce();
        expect(mocks.queueAutoTopics).toHaveBeenCalledOnce();
        expect(mocks.queueAutoSummary).not.toHaveBeenCalled();
    });
});

describe("processNewMail triggers", () => {
    it("does nothing when automatic mail processing is off", async () => {
        mountMail({ mailAutoProcess: false });

        await processNewMail(USER_ID, ITEM_ID);

        expect(mocks.queueAutoSummary).not.toHaveBeenCalled();
        expect(mocks.startLearnRun).not.toHaveBeenCalled();
    });

    it("does nothing for machine-sent mail", async () => {
        mountMail({ autoGenerated: true });

        await processNewMail(USER_ID, ITEM_ID);

        expect(mocks.queueAutoSummary).not.toHaveBeenCalled();
        expect(mocks.startLearnRun).not.toHaveBeenCalled();
    });

    it("does nothing for unreadable mail", async () => {
        mountMail({ unreadable: true });

        await processNewMail(USER_ID, ITEM_ID);

        expect(mocks.queueAutoSummary).not.toHaveBeenCalled();
        expect(mocks.startLearnRun).not.toHaveBeenCalled();
    });

    it("queues the summary but not Learn when Learn is unavailable", async () => {
        mountMail({ autoLearn: true });
        mocks.isLearnAvailableFor.mockResolvedValue(false);

        await processNewMail(USER_ID, ITEM_ID);

        expect(mocks.queueAutoSummary).toHaveBeenCalledWith(
            USER_ID,
            ITEM_ID,
            null,
        );
        expect(mocks.startLearnRun).not.toHaveBeenCalled();
    });

    it("queues the summary but not Learn when its rate limit refuses", async () => {
        mountMail({ autoLearn: true });
        mocks.consumeRateLimitBucket.mockResolvedValue({ allowed: false });

        await processNewMail(USER_ID, ITEM_ID);

        expect(mocks.queueAutoSummary).toHaveBeenCalledWith(
            USER_ID,
            ITEM_ID,
            null,
        );
        expect(mocks.consumeRateLimitBucket).toHaveBeenCalledWith(
            "auto-learn:user:user-1",
            expect.any(Object),
        );
        expect(mocks.startLearnRun).not.toHaveBeenCalled();
    });

    it.each([
        { name: "a non-owner role", access: { role: "editor" } },
        { name: "no access", access: null },
    ])("queues the summary but not Learn with $name", async ({ access }) => {
        mountMail({ autoLearn: true });
        mocks.resolveRecordingAccess.mockResolvedValue(access);

        await processNewMail(USER_ID, ITEM_ID);

        expect(mocks.queueAutoSummary).toHaveBeenCalledWith(
            USER_ID,
            ITEM_ID,
            null,
        );
        expect(mocks.startLearnRun).not.toHaveBeenCalled();
    });

    it("processes mail without a settings row and does not run Learn", async () => {
        mountMail({ autoLearn: true, settings: [] });

        await processNewMail(USER_ID, ITEM_ID);

        expect(mocks.queueAutoSummary).toHaveBeenCalledWith(
            USER_ID,
            ITEM_ID,
            null,
        );
        expect(mocks.startLearnRun).not.toHaveBeenCalled();
    });

    it("does not let a processing error escape", async () => {
        mountMail();
        mocks.queueAutoSummary.mockRejectedValueOnce(new Error("queue failed"));
        vi.spyOn(console, "error").mockImplementation(() => undefined);

        await expect(processNewMail(USER_ID, ITEM_ID)).resolves.toBeUndefined();
    });

    it("does nothing without an enhancement credential", async () => {
        mountMail({ credentials: [] });

        await processNewMail(USER_ID, ITEM_ID);

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

        await processNewMail(USER_ID, ITEM_ID);

        expect(mocks.queueAutoSummary).toHaveBeenCalledWith(
            USER_ID,
            ITEM_ID,
            null,
        );
        expect(mocks.startLearnRun).toHaveBeenCalledTimes(expectedLearnCalls);
        if (shouldLearn) {
            expect(mocks.startLearnRun).toHaveBeenCalledWith({
                access: {
                    recordingId: ITEM_ID,
                    kind: "mail",
                    ownerUserId: USER_ID,
                    role: "owner",
                    shared: false,
                    orgUserId: null,
                    view: "private",
                    contentUserId: USER_ID,
                },
                actorUserId: USER_ID,
                source: "riffado",
                trigger: "auto",
            });
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

        await processNewMail(USER_ID, ITEM_ID);

        expect(mocks.queueAutoSummary).toHaveBeenCalledWith(
            USER_ID,
            ITEM_ID,
            null,
        );
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
        mountRelease({ madeSummary });
        mocks.getActiveJob.mockResolvedValue(active ? { id: "job-1" } : null);
        mocks.isSummaryStale.mockResolvedValue(stale);

        await runLearnRelease();

        expect(mocks.getActiveJob).toHaveBeenCalledWith(
            "summary",
            `${ITEM_ID}:private`,
        );
        expect(mocks.queueAutoSummary).toHaveBeenCalledTimes(expected ? 1 : 0);
        if (expected) {
            expect(mocks.queueAutoSummary).toHaveBeenCalledWith(
                USER_ID,
                ITEM_ID,
                "meeting-notes",
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

    it("defaults the title on when there is no settings row", async () => {
        mountRelease({ settings: [] });

        await runLearnRelease();

        expect(mocks.enqueueTitleJob).toHaveBeenCalledWith(USER_ID, ITEM_ID);
        expect(mocks.queueAutoSummary).not.toHaveBeenCalled();
    });

    it("returns the summary and title jobs it queued", async () => {
        mountRelease({ autoGenerateTitle: true });

        await expect(runLearnRelease()).resolves.toEqual({
            queued: ["summary", "title"],
        });
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
