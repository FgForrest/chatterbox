import { and, eq } from "drizzle-orm";
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
    apiRateLimitBuckets,
    asyncJobs,
    chatterItems,
    itemProcessing,
    processingProfileRevisions,
    processingProfiles,
    recordingFolderAssignments,
    recordingFolders,
    recordings,
    transcriptions,
    users,
} from "@/db/schema";
import { gatherFacts } from "@/lib/pipeline/facts";
import { planAdvance } from "@/lib/pipeline/plan";
import { loadPrivateItemProcessing } from "@/lib/pipeline/presentation";
import {
    markSummaryStepDoneInTx,
    readProcessing,
    updatePhaseInTx,
} from "@/lib/pipeline/state";
import type { PipelineFacts, SummaryStepName } from "@/lib/pipeline/types";
import { generateTopicsForTranscript } from "@/lib/topics/generate-topics";
import { queueAutoTopics } from "@/lib/topics/topics-job";
import { topicsJobHandler } from "@/lib/topics/topics-job-handler";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";
import { resolvedAudioProfile } from "@/tests/profiles/seeded-profile-fixture";

const { dbProxy, dbRef } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    return {
        dbProxy: new Proxy(
            {},
            {
                get: (_target, property) => {
                    const current = ref.current;
                    if (!current)
                        throw new Error("test database was not initialized");
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
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
const mocks = vi.hoisted(() => ({
    create: vi.fn(),
    profile: vi.fn(),
    fingerprint: { value: "reading-1" },
}));
vi.mock("@/lib/env", () => ({
    env: {
        IS_HOSTED: false,
        AUTO_SUMMARY_RATE_LIMIT_PER_HOUR: 3,
        BETTER_AUTH_SECRET: "topics-loop-test-secret",
    },
}));
vi.mock("@/lib/profiles/resolve", () => ({
    resolveItemProfile: mocks.profile,
}));
vi.mock("@/lib/profiles/providers", () => ({
    resolveStepProviderSelection: async () => ({}),
    resolveStepProvider: async () => ({
        kind: "credential",
        credential: {
            id: "provider",
            provider: "test",
            apiKey: "test-key",
            defaultModel: "test-model",
        },
        reserveCall: async () => {},
    }),
}));
vi.mock("@/lib/learn/llm-input", () => ({
    llmRendering: async () => ({ fingerprint: mocks.fingerprint.value }),
    modelInput: async (row: { text: string }) => ({
        text: row.text,
        turns: null,
        fingerprint: mocks.fingerprint.value,
    }),
}));
vi.mock("@/lib/encryption/fields", () => ({
    encryptJsonField: (value: unknown) => value,
    decryptJsonField: (value: unknown) => value,
    decryptText: (value: string) => value,
}));
vi.mock("@/lib/sharing/run-context", () => ({
    resolveRunContext: async (userId: string) => ({
        ownerUserId: userId,
        actorUserId: userId,
        view: "private",
        actsForOrganization: false,
    }),
}));
vi.mock("@/lib/sharing/writer", () => ({
    contentWriterRefusalNow: async () => null,
    contentWriterRefusal: async () => null,
    sharingOrgUserId: async () => null,
}));
vi.mock("@/lib/ai/usage-cost", () => ({ recordChatCompletionUsage: vi.fn() }));
vi.mock("@/lib/posthog-server", () => ({ captureServerEvent: vi.fn() }));
vi.mock("openai", () => ({
    OpenAI: class {
        chat = { completions: { create: mocks.create } };
    },
}));

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const USER = "topics-loop-user";
const ITEM = "topics-loop-item";
const CONTENT = {
    contentId: "topics-loop-content",
    contentSourceId: "riffado",
    contentRevision: 0,
};

describeWithDatabase("pipeline topics loop (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "topics_loop",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);
    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    });
    beforeEach(async () => {
        vi.clearAllMocks();
        mocks.fingerprint.value = "reading-1";
        mocks.profile.mockResolvedValue(
            resolvedAudioProfile({ autoDetectTopics: true }),
        );
        mocks.create.mockResolvedValue({
            choices: [
                {
                    message: {
                        content: JSON.stringify({
                            topics: [
                                { start: "00:00", title: "Opening" },
                                { start: "00:20", title: "Next steps" },
                            ],
                        }),
                    },
                },
            ],
        });
        await database.db.delete(users);
        await database.db.delete(apiRateLimitBuckets);
        await database.db
            .insert(users)
            .values({ id: USER, email: "topics-loop@example.test" });
        await database.db.insert(chatterItems).values({
            id: ITEM,
            userId: USER,
            kind: "audio",
            title: "Regression",
            occurredAt: new Date(),
        });
        await database.db.insert(recordings).values({
            id: ITEM,
            userId: USER,
            deviceSn: "device",
            plaudFileId: "file",
            duration: 30_000,
            endTime: new Date(),
            filesize: 10,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: "test.mp3",
            plaudVersion: "1",
        });
        await database.db.insert(transcriptions).values({
            id: CONTENT.contentId,
            recordingId: ITEM,
            userId: USER,
            text: "Opening. Next steps.",
            turns: [
                {
                    speaker: "speaker_0",
                    startMs: 0,
                    endMs: 20_000,
                    text: "Opening.",
                },
                {
                    speaker: "speaker_0",
                    startMs: 20_000,
                    endMs: 30_000,
                    text: "Next steps.",
                },
            ],
            source: "riffado",
            provider: "test",
            model: "test",
            revision: 0,
        });
        await database.db.insert(itemProcessing).values({
            itemId: ITEM,
            userId: USER,
            view: "private",
            requestedGeneration: 2,
            phases: {
                categorize: {
                    state: "done",
                    reason: "categorized",
                    generation: 1,
                    at: new Date().toISOString(),
                },
                learn: {
                    state: "done",
                    reason: "released",
                    generation: 2,
                    inputs: CONTENT,
                    at: new Date().toISOString(),
                },
                summary: {
                    state: "done",
                    generation: 1,
                    inputs: CONTENT,
                    at: new Date().toISOString(),
                    steps: {
                        topics: { ...CONTENT, generation: 1, state: "done" },
                        summary: { ...CONTENT, generation: 1, state: "done" },
                        title: {
                            ...CONTENT,
                            generation: 1,
                            state: "done",
                            reason: "generated",
                        },
                    },
                },
            },
        });
    });

    async function facts(stale = true): Promise<PipelineFacts> {
        const row = await readProcessing(ITEM, "private", USER);
        if (!row) throw new Error("missing processing row");
        return {
            item: {
                exists: true,
                deleted: false,
                kind: "audio",
                ownerUserId: USER,
            },
            view: "private",
            generation: row.requestedGeneration,
            content: { ...CONTENT, timed: true },
            summaryDueAt: null,
            profile: {
                revisionId: "profile-1",
                automatic: {
                    learn: true,
                    topics: true,
                    summary: true,
                    title: true,
                },
            },
            categorization: {
                placementFolderIds: ["folder"],
                intendedFolderIds: [],
                profileAssigned: true,
                resolution: null,
            },
            hasEnhancementCredential: true,
            mail: null,
            summary: {
                exists: true,
                stale,
                staleFingerprint: mocks.fingerprint.value,
                jobActive: true,
            },
            taskReview: { proposals: 0, followUps: 0 },
            phases: row.phases,
            at: new Date().toISOString(),
        };
    }

    async function advance(stale = true) {
        const plan = planAdvance(await facts(stale));
        for (const action of plan.actions) {
            if (action.type !== "markPhase") continue;
            await database.db.transaction((tx) =>
                updatePhaseInTx(
                    tx,
                    ITEM,
                    "private",
                    USER,
                    action.phase,
                    action.record,
                ),
            );
        }
        return plan;
    }

    async function complete(step: SummaryStepName) {
        return database.db.transaction((tx) =>
            markSummaryStepDoneInTx(tx, {
                itemId: ITEM,
                userId: USER,
                view: "private",
                step,
                content: CONTENT,
                inputFingerprint: mocks.fingerprint.value,
            }),
        );
    }

    it("does not requeue completed topics while the summary is still stale", async () => {
        expect(
            (await advance()).actions.some(
                (action) => action.type === "queueTopics",
            ),
        ).toBe(true);
        expect(await complete("topics")).toBe(true);
        expect(
            (await readProcessing(ITEM, "private", USER))?.phases.summary?.steps
                ?.topics?.state,
        ).toBe("done");
        for (let index = 0; index < 5; index++) {
            expect(
                (await advance()).actions.some(
                    (action) => action.type === "queueTopics",
                ),
            ).toBe(false);
        }
    });

    it.each([
        "summary",
        "topics",
        "title",
    ] as const)("records %s completion before its queue marker is written", async (step) => {
        await database.db
            .update(itemProcessing)
            .set({ phases: {} })
            .where(
                and(
                    eq(itemProcessing.itemId, ITEM),
                    eq(itemProcessing.userId, USER),
                ),
            );
        expect(await complete(step)).toBe(true);
        expect(
            await database.db.transaction((tx) =>
                updatePhaseInTx(tx, ITEM, "private", USER, "summary", {
                    state: "pending",
                    generation: 2,
                    inputs: CONTENT,
                    at: new Date().toISOString(),
                    steps: {
                        [step]: { ...CONTENT, generation: 2, state: "pending" },
                    },
                }),
            ),
        ).toBe(false);
        expect(
            (await readProcessing(ITEM, "private", USER))?.phases.summary
                ?.steps?.[step]?.state,
        ).toBe("done");
        const generation = (await readProcessing(ITEM, "private", USER))
            ?.requestedGeneration;
        expect(await complete(step)).toBe(false);
        expect(
            (await readProcessing(ITEM, "private", USER))?.requestedGeneration,
        ).toBe(generation);
    });

    it("reuses stored topics without paying for another model call", async () => {
        await advance();
        await generateTopicsForTranscript(USER, ITEM, "riffado", {
            trigger: "auto",
        });
        expect(mocks.create).toHaveBeenCalledOnce();
        await generateTopicsForTranscript(USER, ITEM, "riffado", {
            trigger: "auto",
        });
        expect(mocks.create).toHaveBeenCalledOnce();
        expect(
            (await readProcessing(ITEM, "private", USER))?.phases.summary?.steps
                ?.topics,
        ).toMatchObject({ state: "done", inputFingerprint: "reading-1" });
        expect(
            (await advance()).actions.some(
                (action) => action.type === "queueTopics",
            ),
        ).toBe(false);
    });

    it("admits other recordings after a completed automatic run and repeated advances", async () => {
        await advance();
        await queueAutoTopics(USER, ITEM, "riffado", { strict: true });
        const [job] = await database.db
            .select()
            .from(asyncJobs)
            .where(
                and(eq(asyncJobs.userId, USER), eq(asyncJobs.kind, "topics")),
            );
        await topicsJobHandler.run({
            jobId: job.id,
            userId: USER,
            attempt: 1,
            maxAttempts: 3,
            payload: { recordingId: ITEM, source: "riffado", trigger: "auto" },
            signal: new AbortController().signal,
            reportProgress: vi.fn(),
        });
        await database.db
            .update(asyncJobs)
            .set({ status: "completed", completedAt: new Date() })
            .where(and(eq(asyncJobs.id, job.id), eq(asyncJobs.userId, USER)));
        for (let index = 0; index < 65; index++) {
            const plan = await advance();
            for (const action of plan.actions) {
                if (action.type === "queueTopics")
                    await queueAutoTopics(USER, ITEM, "riffado", {
                        strict: true,
                    });
            }
        }
        await queueAutoTopics(USER, "second-recording", "riffado", {
            strict: true,
        });
        const jobs = await database.db
            .select()
            .from(asyncJobs)
            .where(
                and(eq(asyncJobs.userId, USER), eq(asyncJobs.kind, "topics")),
            );
        expect(jobs).toHaveLength(2);
        expect(
            jobs.find((row) => row.subjectId === "second-recording")?.payload
                .rateLimited,
        ).toBeUndefined();
        expect(
            (await database.db.select().from(apiRateLimitBuckets)).map(
                (row) => row.count,
            ),
        ).toEqual([2]);
        expect(mocks.create).toHaveBeenCalledOnce();
    });

    it("recovers a legacy marker when its rate-limited pending job runs", async () => {
        const row = await readProcessing(ITEM, "private", USER);
        if (!row?.phases.summary) throw new Error("missing summary phase");
        await database.db
            .update(itemProcessing)
            .set({
                phases: {
                    ...row.phases,
                    summary: {
                        ...row.phases.summary,
                        state: "pending",
                        steps: {
                            ...row.phases.summary.steps,
                            topics: { ...CONTENT, generation: 1 },
                        },
                    },
                },
            })
            .where(
                and(
                    eq(itemProcessing.itemId, ITEM),
                    eq(itemProcessing.userId, USER),
                ),
            );
        await database.db.insert(asyncJobs).values({
            id: "delayed-topics",
            userId: USER,
            subjectId: ITEM,
            kind: "topics",
            nextAttemptAt: new Date(Date.now() + 3_600_000),
            payload: {
                recordingId: ITEM,
                source: "riffado",
                trigger: "auto",
                rateLimited: true,
            },
        });
        await topicsJobHandler.run({
            jobId: "delayed-topics",
            userId: USER,
            attempt: 1,
            maxAttempts: 3,
            payload: {
                recordingId: ITEM,
                source: "riffado",
                trigger: "auto",
                rateLimited: true,
            },
            signal: new AbortController().signal,
            reportProgress: vi.fn(),
        });
        expect(
            (await readProcessing(ITEM, "private", USER))?.phases.summary
                ?.state,
        ).toBe("done");
        expect(
            (await advance(false)).actions.some(
                (action) => action.type === "queueTopics",
            ),
        ).toBe(false);
    });

    it("recovers an outdated summary marker from a current stored summary", async () => {
        await advance();
        await complete("topics");
        const current = await facts(false);
        current.summary = {
            exists: true,
            stale: false,
            current: true,
            jobActive: false,
        };
        const recovered = planAdvance(current);
        const marker = recovered.actions.find(
            (action) =>
                action.type === "markPhase" && action.phase === "summary",
        );
        expect(marker).toMatchObject({
            record: {
                state: "done",
                steps: {
                    summary: { state: "done" },
                    topics: { state: "done" },
                    title: { state: "done" },
                },
            },
        });
        expect(
            recovered.actions.some(
                (action) =>
                    action.type === "queueSummary" ||
                    action.type === "queueTopics",
            ),
        ).toBe(false);
    });

    it("recovers from persisted artifacts through the real fact loader", async () => {
        const profile = resolvedAudioProfile({
            autoDetectTopics: true,
            autoSummarize: true,
        });
        mocks.profile.mockResolvedValue(profile);
        await database.db.insert(processingProfiles).values({
            id: profile.profile.id,
            ownerUserId: USER,
            scope: "personal",
            channel: "audio",
            name: "Recordings",
            currentRevisionId: profile.revisionId,
        });
        await database.db.insert(processingProfileRevisions).values({
            id: profile.revisionId,
            profileId: profile.profile.id,
            settings: JSON.stringify(profile.settings),
        });
        await database.db.insert(recordingFolders).values([
            {
                id: "root",
                userId: USER,
                name: "Private",
                nameHash: "root",
                kind: "private",
            },
            {
                id: "folder",
                userId: USER,
                name: "Notes",
                nameHash: "folder",
                parentId: "root",
                kind: "custom",
            },
        ]);
        await database.db
            .insert(recordingFolderAssignments)
            .values({ itemId: ITEM, userId: USER, folderId: "folder" });
        await database.db
            .update(itemProcessing)
            .set({
                profileId: profile.profile.id,
                profileRevisionId: profile.revisionId,
            })
            .where(
                and(
                    eq(itemProcessing.itemId, ITEM),
                    eq(itemProcessing.userId, USER),
                ),
            );
        await database.db.insert(aiEnhancements).values({
            itemId: ITEM,
            userId: USER,
            transcriptionId: CONTENT.contentId,
            source: "riffado",
            summary: "Stored summary",
            provider: "test",
            model: "test",
            inputFingerprint: "older-reading",
            inputs: {
                ...CONTENT,
                itemProfileRevisionId: profile.revisionId,
            },
        });
        const stale = await gatherFacts(ITEM, "private", USER);
        expect(stale.summary).toMatchObject({
            stale: true,
            staleFingerprint: "reading-1",
            current: false,
        });
        await advance();
        await generateTopicsForTranscript(USER, ITEM, "riffado", {
            trigger: "auto",
        });
        expect(
            planAdvance(await gatherFacts(ITEM, "private", USER)).actions.some(
                (action) => action.type === "queueTopics",
            ),
        ).toBe(false);
        await database.db
            .update(aiEnhancements)
            .set({ inputFingerprint: "reading-1" })
            .where(
                and(
                    eq(aiEnhancements.itemId, ITEM),
                    eq(aiEnhancements.userId, USER),
                ),
            );
        const fresh = await gatherFacts(ITEM, "private", USER);
        expect(fresh.summary).toMatchObject({ stale: false, current: true });
        const recovered = planAdvance(fresh);
        expect(recovered.actions).toContainEqual(
            expect.objectContaining({
                type: "markPhase",
                phase: "summary",
                record: expect.objectContaining({ state: "done" }),
            }),
        );
        expect(
            recovered.actions.some(
                (action) =>
                    action.type === "queueTopics" ||
                    action.type === "queueSummary",
            ),
        ).toBe(false);
        await database.db
            .update(transcriptions)
            .set({ source: "plaud" })
            .where(
                and(
                    eq(transcriptions.id, CONTENT.contentId),
                    eq(transcriptions.userId, USER),
                ),
            );
        await database.db
            .update(aiEnhancements)
            .set({
                inputs: {
                    ...CONTENT,
                    contentSourceId: "plaud",
                    itemProfileRevisionId: profile.revisionId,
                },
            })
            .where(
                and(
                    eq(aiEnhancements.itemId, ITEM),
                    eq(aiEnhancements.userId, USER),
                ),
            );
        expect((await gatherFacts(ITEM, "private", USER)).summary.current).toBe(
            true,
        );
        await database.db
            .update(aiEnhancements)
            .set({ inputFingerprint: "older-reading" })
            .where(
                and(
                    eq(aiEnhancements.itemId, ITEM),
                    eq(aiEnhancements.userId, USER),
                ),
            );
        expect(
            (await gatherFacts(ITEM, "private", USER)).summary,
        ).toMatchObject({ stale: true, staleFingerprint: "reading-1" });
    });

    it("invalidates once more when the corrected reading actually changes", async () => {
        await advance();
        await complete("topics");
        mocks.fingerprint.value = "reading-2";
        expect(
            (await advance()).actions.some(
                (action) => action.type === "queueTopics",
            ),
        ).toBe(true);
        await complete("topics");
        expect(
            (await advance()).actions.some(
                (action) => action.type === "queueTopics",
            ),
        ).toBe(false);
    });

    it("accepts the current reading during invalidation but refuses an older completion", async () => {
        const current = await facts();
        const invalidation = planAdvance(current).actions.find(
            (action) =>
                action.type === "markPhase" &&
                action.phase === "summary" &&
                action.record.state === "outdated",
        );
        if (!invalidation || invalidation.type !== "markPhase")
            throw new Error("missing invalidation");
        await database.db.transaction((tx) =>
            updatePhaseInTx(
                tx,
                ITEM,
                "private",
                USER,
                "summary",
                invalidation.record,
            ),
        );
        expect(
            await database.db.transaction((tx) =>
                markSummaryStepDoneInTx(tx, {
                    itemId: ITEM,
                    userId: USER,
                    view: "private",
                    step: "topics",
                    content: CONTENT,
                    inputFingerprint: "older-reading",
                }),
            ),
        ).toBe(false);
        expect(
            await database.db.transaction((tx) =>
                markSummaryStepDoneInTx(tx, {
                    itemId: ITEM,
                    userId: USER,
                    view: "private",
                    step: "topics",
                    content: CONTENT,
                    inputFingerprint: mocks.fingerprint.value,
                }),
            ),
        ).toBe(true);
    });

    it("refreshes a late stale summary without repeating already-current topics", async () => {
        await advance();
        await generateTopicsForTranscript(USER, ITEM, "riffado", {
            trigger: "auto",
        });
        await database.db.transaction((tx) =>
            markSummaryStepDoneInTx(tx, {
                itemId: ITEM,
                userId: USER,
                view: "private",
                step: "summary",
                content: CONTENT,
                inputFingerprint: "older-reading",
            }),
        );
        const current = await facts();
        current.summary.jobActive = false;
        const plan = planAdvance(current);
        expect(
            plan.actions.some((action) => action.type === "queueSummary"),
        ).toBe(true);
        expect(
            plan.actions.some((action) => action.type === "queueTopics"),
        ).toBe(false);
    });

    it("keeps completed sibling steps when completions advance different generations", async () => {
        await advance();
        await complete("topics");
        await complete("summary");
        expect(
            (await readProcessing(ITEM, "private", USER))?.phases.summary,
        ).toMatchObject({
            state: "done",
            steps: {
                topics: { state: "done" },
                summary: { state: "done" },
                title: { state: "done" },
            },
        });
        expect(
            (await advance(false)).actions.some(
                (action) =>
                    action.type === "queueSummary" ||
                    action.type === "queueTopics",
            ),
        ).toBe(false);
    });

    it("does not settle another owner's processing state", async () => {
        expect(
            await database.db.transaction((tx) =>
                markSummaryStepDoneInTx(tx, {
                    itemId: ITEM,
                    userId: "other-user",
                    view: "private",
                    step: "topics",
                    content: CONTENT,
                }),
            ),
        ).toBe(false);
        expect(
            (await readProcessing(ITEM, "private", USER))?.requestedGeneration,
        ).toBe(2);
    });

    it.each([
        "topics",
        "title",
    ] as const)("does not report an active %s job as a summary job", async (step) => {
        await database.db.insert(asyncJobs).values({
            userId: USER,
            kind: step === "title" ? "title.generate" : "topics",
            subjectId: ITEM,
            payload: {},
            status: "processing",
        });
        const data = await loadPrivateItemProcessing(USER, ITEM);
        expect(data?.jobs.summary).toBeNull();
        expect(data?.jobs[step]).toBe("running");
    });
});
