import { and, eq } from "drizzle-orm";
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
import {
    itemProcessing,
    recordingFolderAssignments,
    recordingFolders,
    users,
} from "@/db/schema";
import { AppError, ErrorCode } from "@/lib/errors";
import { isHeldForLearn } from "@/lib/learn/hold";
import type { PipelinePhases } from "@/lib/pipeline/types";
import { insertRecordings } from "@/tests/integration/items";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const {
    dbProxy,
    dbRef,
    transcribe,
    summaryProvider,
    topicsProvider,
    titleProvider,
} = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    return {
        dbRef: ref,
        dbProxy: new Proxy(
            {},
            {
                get: (_target, key) => {
                    if (!ref.current)
                        throw new Error("test database not ready");
                    const value = ref.current[key];
                    return typeof value === "function"
                        ? value.bind(ref.current)
                        : value;
                },
            },
        ),
        transcribe: vi.fn(),
        summaryProvider: vi.fn(),
        topicsProvider: vi.fn(),
        titleProvider: vi.fn(),
    };
});
vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({
    env: {
        IS_HOSTED: false,
        SELF_HOST_MODE: "shared",
        DATABASE_URL: "postgres://unused",
    },
}));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: async () => "shared-skip-org",
    isOrgScopeEnabled: () => true,
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/learn/hold", () => ({
    isHeldForLearn: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/lib/learn/summary-refresh", () => ({
    summaryRefreshDue: async () => null,
}));
vi.mock("@/lib/recordings/erase", () => ({
    allowManualArtifactGeneration: async () => true,
}));
vi.mock("@/lib/summary/summary-model", () => ({
    runSummary: summaryProvider,
    summaryModelFor: vi.fn(),
}));
vi.mock("openai", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    OpenAI: class {
        chat = { completions: { create: topicsProvider } };
    },
}));
vi.mock("@/lib/transcription/transcribe-recording", () => ({
    transcribeRecording: transcribe,
}));
vi.mock("@/lib/recordings/apply-generated-title", () => ({
    applyGeneratedTitle: titleProvider,
}));
vi.mock("@/lib/webhooks/emit", () => ({
    emitEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));

import {
    claimDueJobs,
    completeJob,
    enqueueJob,
    failJobAttempt,
} from "@/db/queries/async-jobs";
import type { JobContext, JobHandler } from "@/lib/jobs/types";
import {
    markAutomaticStepShared,
    markSummaryStepDoneInTx,
    readProcessing,
} from "@/lib/pipeline/state";
import * as profileResolver from "@/lib/profiles/resolve";
import * as titleAfterSummary from "@/lib/recordings/title-after-summary";
import * as generateSummary from "@/lib/summary/generate-summary";
import { summaryJobHandler as summaryHandler } from "@/lib/summary/summary-job-handler";
import * as generateTopics from "@/lib/topics/generate-topics";
import { topicsJobHandler as topicsHandler } from "@/lib/topics/topics-job-handler";
import { transcriptionJobHandler as transcriptionHandler } from "@/lib/transcription/transcription-job-handler";
import { resolvedAudioProfile } from "@/tests/profiles/seeded-profile-fixture";

async function runSettled<P>(handler: JobHandler<P>, context: JobContext<P>) {
    const payload = context.payload as Record<string, unknown>;
    const queued = await enqueueJob({
        userId: context.userId,
        kind: handler.kind,
        subjectId: String(payload.recordingId),
        payload,
    });
    const [job] = await claimDueJobs(handler.kind, 1);
    let result: Awaited<ReturnType<typeof handler.run>>;
    try {
        result = await handler.run({ ...context, jobId: queued.job.id });
    } catch (error) {
        await failJobAttempt({
            jobId: job.id,
            claimToken: job.claimToken,
            message: "Refused",
            code: "RECORDING_SHARED",
            retryable: false,
            delayMs: 0,
        });
        throw error;
    }
    await completeJob({
        jobId: job.id,
        claimToken: job.claimToken,
        result: result ?? null,
    });
    return result;
}
const summaryJobHandler = {
    run: (ctx: Parameters<typeof summaryHandler.run>[0]) =>
        runSettled(summaryHandler, ctx),
};
const topicsJobHandler = {
    run: (ctx: Parameters<typeof topicsHandler.run>[0]) =>
        runSettled(topicsHandler, ctx),
};
const transcriptionJobHandler = {
    run: (ctx: Parameters<typeof transcriptionHandler.run>[0]) =>
        runSettled(transcriptionHandler, ctx),
};

const OWNER = "shared-skip-owner";
const OTHER = "shared-skip-other";
const ORG = "shared-skip-org";
const ITEM = "shared-skip-recording";
const at = "2026-10-01T00:00:00.000Z";
const content = {
    contentId: "shared-skip-transcript",
    contentSourceId: "riffado",
    contentRevision: 1,
};
const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

function summaryPhase(): NonNullable<PipelinePhases["summary"]> {
    return {
        state: "pending",
        generation: 1,
        at,
        inputs: content,
        steps: {
            summary: { ...content, generation: 1, state: "pending" },
            topics: { ...content, generation: 1, state: "pending" },
            title: { ...content, generation: 1, state: "pending" },
        },
    };
}
function context(trigger: "auto" | "manual" = "auto") {
    return {
        userId: OWNER,
        jobId: "shared-skip-job",
        payload: { recordingId: ITEM, trigger },
        attempt: 1,
        maxAttempts: 3,
        signal: new AbortController().signal,
        reportProgress: vi.fn(),
    };
}

describeWithDatabase("settling automatic shared skips (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    function db() {
        if (!database) throw new Error("test database not ready");
        return database.db;
    }
    async function stored() {
        return (await readProcessing(ITEM, "private", OWNER))?.phases;
    }
    async function setPhases(phases: PipelinePhases) {
        await db()
            .update(itemProcessing)
            .set({ phases })
            .where(
                and(
                    eq(itemProcessing.itemId, ITEM),
                    eq(itemProcessing.userId, OWNER),
                    eq(itemProcessing.view, "private"),
                ),
            );
    }
    async function share() {
        await db().insert(recordingFolderAssignments).values({
            itemId: ITEM,
            userId: OWNER,
            folderId: "shared-skip-folder",
        });
    }
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "shared_skip",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);
    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);
    afterEach(() => vi.restoreAllMocks());
    beforeEach(async () => {
        vi.clearAllMocks();
        await db().delete(users);
        await db()
            .insert(users)
            .values([
                { id: OWNER, email: "skip-owner@example.test" },
                { id: OTHER, email: "skip-other@example.test" },
                { id: ORG, email: "skip-org@example.test", role: "org" },
            ]);
        await insertRecordings(db(), {
            id: ITEM,
            userId: OWNER,
            filename: "Shared",
            deviceSn: "device",
            plaudFileId: "shared-skip-plaud",
            duration: 1_000,
            startTime: new Date(at),
            endTime: new Date(at),
            filesize: 10,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: "shared.mp3",
            plaudVersion: "1",
        });
        await db().insert(recordingFolders).values({
            id: "shared-skip-folder",
            userId: ORG,
            name: "Organization",
            nameHash: "shared-skip-folder",
        });
        await db()
            .insert(itemProcessing)
            .values({
                itemId: ITEM,
                userId: OWNER,
                view: "private",
                requestedGeneration: 1,
                phases: { summary: summaryPhase() },
            });
    });

    it("settles refused member jobs without changing the owner's pipeline", async () => {
        await share();
        const member = {
            ...context(),
            userId: OTHER,
            payload: { ...context().payload, view: "org" as const },
        };
        await expect(summaryJobHandler.run(member)).resolves.toEqual({
            skipped: "shared",
            outcome: { kind: "skipped", reason: "shared" },
        });
        await expect(
            topicsJobHandler.run({
                ...member,
                payload: { ...member.payload, source: "riffado" },
            }),
        ).resolves.toEqual({
            skipped: "shared",
            outcome: { kind: "skipped", reason: "shared" },
        });
        expect((await stored())?.summary).toEqual(summaryPhase());
        expect(summaryProvider).not.toHaveBeenCalled();
        expect(topicsProvider).not.toHaveBeenCalled();
    });

    it.each([
        "summary",
        "topics",
    ] as const)("also settles %s when sharing changes during generation", async (step) => {
        const error = new AppError(
            ErrorCode.RECORDING_SHARED,
            "Shared during generation",
            409,
        );
        if (step === "summary") {
            vi.spyOn(
                generateSummary,
                "generateSummaryForRecording",
            ).mockRejectedValueOnce(error);
            await expect(summaryJobHandler.run(context())).resolves.toEqual({
                skipped: "shared",
                outcome: { kind: "skipped", reason: "shared" },
            });
        } else {
            vi.spyOn(
                generateTopics,
                "generateTopicsForTranscript",
            ).mockRejectedValueOnce(error);
            await expect(
                topicsJobHandler.run({
                    ...context(),
                    payload: { ...context().payload, source: "riffado" },
                }),
            ).resolves.toEqual({
                skipped: "shared",
                outcome: { kind: "skipped", reason: "shared" },
            });
        }
        expect((await stored())?.summary?.steps?.[step]).toMatchObject({
            state: "skipped",
            reason: "shared",
        });
    });

    it.each([
        "pending",
        "running",
    ] as const)("settles an automatic transcription left %s", async (state) => {
        await setPhases({
            transcribe: { state, automatic: true, generation: 1, at },
        });
        transcribe.mockResolvedValueOnce({
            success: false,
            errorCode: "RECORDING_SHARED",
        });
        await expect(
            transcriptionJobHandler.run({
                ...context(),
                payload: { recordingId: ITEM, trigger: "sync", force: false },
            }),
        ).resolves.toEqual({
            skipped: "shared",
            outcome: { kind: "skipped", reason: "shared" },
        });
        expect((await stored())?.transcribe).toMatchObject({
            state: "skipped",
            reason: "shared",
        });
    });

    it("keeps manual refusals visible and settles the automatic steps bound to those jobs", async () => {
        await share();
        vi.spyOn(
            generateSummary,
            "generateSummaryForRecording",
        ).mockRejectedValueOnce(
            new AppError(ErrorCode.RECORDING_SHARED, "Refused member", 409),
        );
        vi.spyOn(
            generateTopics,
            "generateTopicsForTranscript",
        ).mockRejectedValueOnce(
            new AppError(ErrorCode.RECORDING_SHARED, "Refused member", 409),
        );
        await expect(
            summaryJobHandler.run(context("manual")),
        ).rejects.toMatchObject({ code: ErrorCode.RECORDING_SHARED });
        await expect(
            topicsJobHandler.run({
                ...context("manual"),
                payload: { ...context("manual").payload, source: "riffado" },
            }),
        ).rejects.toMatchObject({ code: ErrorCode.RECORDING_SHARED });
        transcribe.mockResolvedValueOnce({
            success: false,
            errorCode: "RECORDING_SHARED",
        });
        await expect(
            transcriptionJobHandler.run({
                ...context("manual"),
                payload: { recordingId: ITEM, trigger: "manual", force: false },
            }),
        ).rejects.toMatchObject({ code: ErrorCode.RECORDING_SHARED });
        expect((await stored())?.summary?.steps).toMatchObject({
            summary: { state: "failed", reason: "RECORDING_SHARED" },
            topics: { state: "failed", reason: "RECORDING_SHARED" },
        });
    });

    it("allows the owner's title provider while shared", async () => {
        await share();
        vi.spyOn(profileResolver, "resolveItemProfile").mockResolvedValueOnce({
            ...resolvedAudioProfile(),
            profile: {
                ...resolvedAudioProfile().profile,
                deletedAt: null,
                version: 1,
            },
        });
        titleProvider.mockResolvedValueOnce(true);
        const phase = summaryPhase();
        if (phase.steps?.summary) phase.steps.summary.state = "done";
        if (phase.steps?.topics) phase.steps.topics.state = "done";
        await setPhases({ summary: phase });
        await titleAfterSummary.updateTitleAfterSummary({
            userId: OWNER,
            recordingId: ITEM,
            summary: "Summary",
            keyPoints: [],
        });
        expect(titleProvider).toHaveBeenCalledOnce();
        expect((await stored())?.summary?.steps?.title).toMatchObject({
            state: "pending",
        });
    });

    it("settles the pending title when a shared-skip refresh follows a committed summary", async () => {
        const phase = summaryPhase();
        if (phase.steps?.summary) phase.steps.summary.state = "done";
        if (phase.steps?.topics) phase.steps.topics.state = "done";
        await setPhases({ summary: phase });
        vi.spyOn(
            generateSummary,
            "generateSummaryForRecording",
        ).mockRejectedValueOnce(
            new AppError(
                ErrorCode.RECORDING_SHARED,
                "Shared before refresh",
                409,
            ),
        );
        await expect(summaryJobHandler.run(context())).resolves.toEqual({
            skipped: "shared",
            outcome: { kind: "skipped", reason: "shared" },
        });
        expect((await stored())?.summary).toMatchObject({
            state: "done",
            reason: "completed",
            steps: {
                summary: { state: "skipped", reason: "shared" },
                title: { state: "skipped", reason: "shared" },
            },
        });
    });

    it("permits a later summary commit after unsharing", async () => {
        await share();
        await expect(
            summaryJobHandler.run({
                ...context(),
                userId: OTHER,
                payload: { ...context().payload, view: "org" },
            }),
        ).resolves.toEqual({
            skipped: "shared",
            outcome: { kind: "skipped", reason: "shared" },
        });
        await db()
            .delete(recordingFolderAssignments)
            .where(
                and(
                    eq(recordingFolderAssignments.itemId, ITEM),
                    eq(recordingFolderAssignments.userId, OWNER),
                ),
            );
        vi.spyOn(
            titleAfterSummary,
            "updateTitleAfterSummary",
        ).mockResolvedValueOnce({ kind: "done" });
        vi.spyOn(
            generateSummary,
            "generateSummaryForRecording",
        ).mockImplementationOnce(async () => {
            await db().transaction((tx) =>
                markSummaryStepDoneInTx(tx, {
                    itemId: ITEM,
                    userId: OWNER,
                    view: "private",
                    step: "summary",
                    content,
                }),
            );
            return {
                ownerUserId: OWNER,
                summary: "Rerun",
                keyPoints: [],
                actionItems: [],
                provider: "test",
                model: "test",
                promptId: "general",
                promptFallback: false,
            };
        });
        await expect(
            summaryJobHandler.run(context("manual")),
        ).resolves.toMatchObject({ provider: "test" });
        expect((await stored())?.summary?.steps?.summary).toMatchObject({
            state: "done",
            reason: "generated",
        });
    });

    it("settles the held-then-shared summary regression without leaving a running step", async () => {
        await share();
        const phase = summaryPhase();
        if (phase.steps?.topics) phase.steps.topics.state = "done";
        await setPhases({ summary: phase });
        vi.mocked(isHeldForLearn).mockResolvedValueOnce(true);
        await expect(summaryJobHandler.run(context())).resolves.toMatchObject({
            skipped: "held",
            outcome: { kind: "skipped", reason: "held" },
        });
        expect((await stored())?.summary?.steps?.summary).toMatchObject({
            state: "skipped",
            reason: "held",
        });
        vi.spyOn(
            generateSummary,
            "generateSummaryForRecording",
        ).mockRejectedValueOnce(
            new AppError(
                ErrorCode.RECORDING_SHARED,
                "Shared after Learn release",
                409,
            ),
        );
        await expect(summaryJobHandler.run(context())).resolves.toMatchObject({
            skipped: "shared",
            outcome: { kind: "skipped", reason: "shared" },
        });
        expect((await stored())?.summary).toMatchObject({
            state: "done",
            steps: { summary: { state: "skipped", reason: "shared" } },
        });
    });

    it("does not settle another user's row or overwrite completed and outdated steps", async () => {
        expect(
            await markAutomaticStepShared({
                itemId: ITEM,
                userId: OTHER,
                view: "private",
                step: "summary",
            }),
        ).toBe(false);
        const phase = summaryPhase();
        if (phase.steps?.summary) phase.steps.summary.state = "outdated";
        if (phase.steps?.title) phase.steps.title.state = "done";
        await setPhases({ summary: phase });
        expect(
            await markAutomaticStepShared({
                itemId: ITEM,
                userId: OWNER,
                view: "private",
                step: "summary",
            }),
        ).toBe(false);
        expect((await stored())?.summary).toEqual(phase);
    });
});
