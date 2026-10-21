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
    asyncJobs,
    chatterItems,
    itemProcessing,
    recordingFolderAssignments,
    recordingFolders,
    users,
} from "@/db/schema";
import { AppError, ErrorCode } from "@/lib/errors";
import type { PipelinePhases, SummaryStepName } from "@/lib/pipeline/types";
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
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/learn/hold", () => ({ isHeldForLearn: async () => false }));
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

import * as pipelineQueries from "@/db/queries/pipeline";
import { processingFailures } from "@/lib/pipeline/presentation";
import {
    markAutomaticStepShared,
    markSummaryStepDoneInTx,
    readProcessing,
} from "@/lib/pipeline/state";
import { sweepOrphanedPipelineSteps } from "@/lib/pipeline/sweep";
import * as titleAfterSummary from "@/lib/recordings/title-after-summary";
import * as generateSummary from "@/lib/summary/generate-summary";
import { summaryJobHandler } from "@/lib/summary/summary-job-handler";
import * as generateTopics from "@/lib/topics/generate-topics";
import { topicsJobHandler } from "@/lib/topics/topics-job-handler";
import { transcriptionJobHandler } from "@/lib/transcription/transcription-job-handler";

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
    async function job(
        kind: string,
        status: "completed" | "failed" | "pending" = "completed",
        overrides: Partial<typeof asyncJobs.$inferInsert> = {},
    ) {
        await db()
            .insert(asyncJobs)
            .values({
                userId: OWNER,
                kind,
                subjectId: ITEM,
                status,
                payload: { recordingId: ITEM, trigger: "auto" },
                createdAt: new Date("2026-10-02T00:00:00Z"),
                completedAt:
                    status === "pending"
                        ? null
                        : new Date("2026-10-02T00:01:00Z"),
                ...overrides,
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

    it("settles summary, its dependent title, and topics without calling either provider when already shared", async () => {
        await share();
        await expect(summaryJobHandler.run(context())).resolves.toEqual({
            skipped: "shared",
        });
        expect((await stored())?.summary?.steps?.summary).toMatchObject({
            state: "skipped",
            reason: "shared",
        });
        expect((await stored())?.summary?.steps?.title).toMatchObject({
            state: "skipped",
            reason: "shared",
        });
        await expect(
            topicsJobHandler.run({
                ...context(),
                payload: { ...context().payload, source: "riffado" },
            }),
        ).resolves.toEqual({ skipped: "shared" });
        expect((await stored())?.summary).toMatchObject({
            state: "skipped",
            reason: "shared",
            steps: { topics: { state: "skipped", reason: "shared" } },
        });
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
            ).resolves.toEqual({ skipped: "shared" });
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
        ).resolves.toEqual({ skipped: "shared" });
        expect((await stored())?.transcribe).toMatchObject({
            state: "skipped",
            reason: "shared",
        });
    });

    it("keeps manual summary, topics and transcription refusals visible without settling their pipeline steps", async () => {
        await share();
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
        expect((await stored())?.summary).toEqual(summaryPhase());
    });

    it("settles a title skipped before its provider call", async () => {
        await share();
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
        expect(titleProvider).not.toHaveBeenCalled();
        expect((await stored())?.summary).toMatchObject({
            state: "skipped",
            reason: "shared",
            steps: { title: { state: "skipped", reason: "shared" } },
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
        });
        expect((await stored())?.summary).toMatchObject({
            state: "skipped",
            reason: "shared",
            steps: {
                summary: { state: "done" },
                title: { state: "skipped", reason: "shared" },
            },
        });
    });

    it("permits a later summary commit after unsharing", async () => {
        await share();
        await summaryJobHandler.run(context());
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
        ).mockResolvedValueOnce(undefined);
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

    it.each([
        "summary",
        "topics",
        "title",
    ] as const)("reconciles a completed %s job with an unsettled step as a retryable failure", async (step: SummaryStepName) => {
        await job(step === "title" ? "title.generate" : step);
        expect(await sweepOrphanedPipelineSteps()).toBe(1);
        expect((await stored())?.summary?.steps?.[step]).toMatchObject({
            state: "failed",
            reason: "JOB_COMPLETED_WITHOUT_SETTLEMENT",
        });
        expect(processingFailures((await stored()) ?? {})).toContainEqual({
            phase: "summary",
            step,
            reasonCode: "JOB_COMPLETED_WITHOUT_SETTLEMENT",
            retryAvailable: true,
        });
        expect(await sweepOrphanedPipelineSteps()).toBe(0);
    });

    it("ignores active, manual, older, wrong-owner and already settled jobs", async () => {
        await job("summary");
        await job("summary", "pending", {
            createdAt: new Date("2026-10-03T00:00:00Z"),
        });
        await job("topics", "completed", {
            payload: { recordingId: ITEM, trigger: "manual" },
        });
        await job("title.generate", "completed", { userId: OTHER });
        expect(await sweepOrphanedPipelineSteps()).toBe(0);
        await db().delete(asyncJobs);
        await job("summary", "failed", {
            completedAt: new Date("2026-09-30T00:00:00Z"),
        });
        expect(await sweepOrphanedPipelineSteps()).toBe(0);
        await db().delete(asyncJobs);
        await job("summary");
        await markAutomaticStepShared({
            itemId: ITEM,
            userId: OWNER,
            view: "private",
            step: "summary",
        });
        expect(await sweepOrphanedPipelineSteps()).toBe(0);
    });

    it("uses the latest job rather than an older failure or an older automatic completion", async () => {
        await job("summary", "failed", { errorCode: "OLD_FAILURE" });
        await job("summary", "completed", {
            createdAt: new Date("2026-10-03T00:00:00Z"),
            completedAt: new Date("2026-10-03T00:01:00Z"),
            payload: { recordingId: ITEM, trigger: "manual" },
        });
        expect(await sweepOrphanedPipelineSteps()).toBe(0);
    });

    it("bounds reconciliation and preserves org view and owner scoping", async () => {
        await db()
            .insert(itemProcessing)
            .values({
                itemId: ITEM,
                userId: OWNER,
                view: "org",
                requestedGeneration: 1,
                phases: { summary: summaryPhase() },
            });
        await job("summary", "completed", { subjectId: `org:${ITEM}` });
        await job("topics", "completed", { subjectId: `org:${ITEM}` });
        expect(
            await pipelineQueries.listOrphanedPipelineStepRows(1),
        ).toHaveLength(1);
        expect(await sweepOrphanedPipelineSteps(1)).toBe(1);
        expect((await stored())?.summary).toEqual(summaryPhase());
        const org = await readProcessing(ITEM, "org", OWNER);
        expect(
            Object.values(org?.phases.summary?.steps ?? {}).filter(
                (step) => step.state === "failed",
            ),
        ).toHaveLength(1);
        expect(await sweepOrphanedPipelineSteps(1)).toBe(0);
        const settledSummary = org?.phases.summary;
        if (!settledSummary) throw new Error("org summary phase missing");
        await db()
            .update(itemProcessing)
            .set({
                phases: {
                    summary: {
                        ...settledSummary,
                        at: new Date(Date.now() - 180_000).toISOString(),
                    },
                },
            })
            .where(
                and(
                    eq(itemProcessing.itemId, ITEM),
                    eq(itemProcessing.userId, OWNER),
                    eq(itemProcessing.view, "org"),
                ),
            );
        expect(await sweepOrphanedPipelineSteps(1)).toBe(1);
        expect(await sweepOrphanedPipelineSteps(1)).toBe(0);
    });

    it("reconciles a completed step even when another step moved the phase timestamp", async () => {
        const phase = summaryPhase();
        phase.at = "2026-10-03T00:00:00Z";
        await setPhases({ summary: phase });
        await job("summary");
        expect(await sweepOrphanedPipelineSteps()).toBe(1);
        expect((await stored())?.summary?.steps?.summary).toMatchObject({
            state: "failed",
            reason: "JOB_COMPLETED_WITHOUT_SETTLEMENT",
        });
    });

    it("leaves a step planned in the last two minutes to its driver", async () => {
        const phase = { ...summaryPhase(), at: new Date().toISOString() };
        await setPhases({ summary: phase });
        await job("summary");
        expect(await sweepOrphanedPipelineSteps()).toBe(0);
        expect((await stored())?.summary).toEqual(phase);
    });

    it("leaves a held item's steps alone after an earlier run completed", async () => {
        await db()
            .update(chatterItems)
            .set({ summaryDueAt: new Date(Date.now() + 3_600_000) })
            .where(
                and(eq(chatterItems.id, ITEM), eq(chatterItems.userId, OWNER)),
            );
        await job("summary");
        expect(await sweepOrphanedPipelineSteps()).toBe(0);
        expect((await stored())?.summary).toEqual(summaryPhase());
    });

    it("does not settle a newer phase requested after the sweep selected its candidates", async () => {
        await job("summary");
        const list = pipelineQueries.listOrphanedPipelineStepRows;
        vi.spyOn(
            pipelineQueries,
            "listOrphanedPipelineStepRows",
        ).mockImplementationOnce(async (limit) => {
            const rows = await list(limit);
            await setPhases({ summary: { ...summaryPhase(), generation: 2 } });
            return rows;
        });
        expect(await sweepOrphanedPipelineSteps()).toBe(0);
        expect((await stored())?.summary).toEqual({
            ...summaryPhase(),
            generation: 2,
        });
    });

    it("leaves a held skip to Learn and its release driver", async () => {
        const where = and(
            eq(chatterItems.id, ITEM),
            eq(chatterItems.userId, OWNER),
        );
        await db()
            .update(chatterItems)
            .set({ summaryDueAt: new Date() })
            .where(where);
        await job("summary", "completed", { result: { skipped: "held" } });
        expect(await sweepOrphanedPipelineSteps()).toBe(0);
        await db()
            .update(chatterItems)
            .set({ summaryDueAt: null })
            .where(where);
        expect(await sweepOrphanedPipelineSteps()).toBe(0);
    });
});
