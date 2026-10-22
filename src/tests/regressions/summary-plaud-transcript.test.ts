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
import { claimDueJobs, completeJob, enqueueJob } from "@/db/queries/async-jobs";
import {
    aiEnhancements,
    apiCredentials,
    chatterItems,
    itemProcessing,
    processingProfileRevisions,
    processingProfiles,
    recordingFolderAssignments,
    recordingFolders,
    transcriptCorrectionPasses,
    transcriptCorrections,
    transcriptions,
    userSettings,
    users,
} from "@/db/schema";
import { encrypt } from "@/lib/encryption";
import {
    decryptText,
    encryptJsonField,
    encryptText,
} from "@/lib/encryption/fields";
import { LEARN_CORRECT_JOB_KIND } from "@/lib/learn/correction-pass-queue";
import { isSummaryStale } from "@/lib/learn/summary-refresh";
import { gatherFacts } from "@/lib/pipeline/facts";
import { pipelineMayQueue } from "@/lib/pipeline/pending";
import { planAdvance } from "@/lib/pipeline/plan";
import { loadPrivateItemProcessing } from "@/lib/pipeline/presentation";
import { markLearnReleasedInTx, readProcessing } from "@/lib/pipeline/state";
import type { PipelinePhases } from "@/lib/pipeline/types";
import { defaultProfileSettings } from "@/lib/profiles/settings";
import { readTitleInput } from "@/lib/recordings/title-input";
import { generateSummaryForRecording } from "@/lib/summary/generate-summary";
import { enqueueSummaryJob, SUMMARY_JOB_KIND } from "@/lib/summary/summary-job";
import { summaryJobHandler } from "@/lib/summary/summary-job-handler";
import { insertRecordings } from "@/tests/integration/items";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef, createCompletion } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    return {
        dbRef: ref,
        createCompletion: vi.fn(),
        dbProxy: new Proxy(
            {},
            {
                get: (_target, property: string | symbol) => {
                    if (!ref.current)
                        throw new Error("test database not ready");
                    const value = ref.current[property];
                    return typeof value === "function"
                        ? value.bind(ref.current)
                        : value;
                },
            },
        ),
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({
    env: {
        IS_HOSTED: false,
        SELF_HOST_MODE: "local",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        BETTER_AUTH_SECRET: "mira-summary-test-secret",
        DATABASE_URL: "postgres://unused",
        MAIL_FORMER_ORG_NICKNAMES: [],
    },
}));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: async () => null,
    isOrgScopeEnabled: () => false,
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/export/document-sidecars", () => ({
    exportRecordingSidecarsIfEnabled: vi.fn(),
    refreshExistingRecordingSidecars: vi.fn(),
}));
vi.mock("@/lib/sharing/notify", () => ({ notifyIfShared: vi.fn() }));
vi.mock("@/lib/webhooks/emit", () => ({
    emitEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("openai", () => ({
    OpenAI: class {
        chat = { completions: { create: createCompletion } };
    },
}));

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const USER = "mira-owner";
const ITEM = "mira-recording";
const PLAUD = "mira-plaud-transcript";
const PROFILE = "mira-profile";
const REVISION = "mira-profile-revision";
const NOW = "2026-10-21T00:00:00.000Z";
const plaudInput = {
    contentId: PLAUD,
    contentSourceId: "plaud",
    contentRevision: 0,
};

function reply(content: string) {
    return {
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
    };
}

describeWithDatabase(
    "summary and title from imported transcripts (PostgreSQL)",
    () => {
        let database: TestPostgresDatabase | null = null;
        function db() {
            if (!database) throw new Error("test database not ready");
            return database.db;
        }
        const processingWhere = and(
            eq(itemProcessing.itemId, ITEM),
            eq(itemProcessing.userId, USER),
            eq(itemProcessing.view, "private"),
        );

        beforeAll(async () => {
            database = await createMigratedTestDatabase(
                testDatabaseUrl ?? "",
                "mira_summary_plaud",
            );
            dbRef.current = database.db as unknown as Record<
                PropertyKey,
                unknown
            >;
        }, 120_000);
        afterAll(async () => {
            dbRef.current = null;
            await database?.dispose();
        }, 30_000);
        beforeEach(async () => {
            await db().delete(users);
            await db()
                .insert(users)
                .values({ id: USER, email: "mira@example.test" });
            await db()
                .insert(apiCredentials)
                .values({
                    id: "mira-provider",
                    userId: USER,
                    provider: "openai",
                    apiKey: encrypt("invented-key"),
                    defaultModel: "mira-model",
                });
            const settings = defaultProfileSettings("audio");
            settings.steps.transcribe.plaudTranscript = "use";
            settings.steps.learn.automatic = false;
            settings.steps.summary.automatic = true;
            settings.steps.title.automatic = true;
            settings.steps.topics.automatic = true;
            settings.steps.tasks.enabled = false;
            settings.steps.summary.provider = {
                credentialId: "mira-provider",
                scope: "personal",
            };
            settings.steps.title.provider = settings.steps.summary.provider;
            settings.steps.topics.provider = settings.steps.summary.provider;
            await db()
                .insert(processingProfiles)
                .values({
                    id: PROFILE,
                    ownerUserId: USER,
                    scope: "personal",
                    channel: "audio",
                    name: encryptText("Mira notes"),
                    currentRevisionId: REVISION,
                    isDefault: true,
                });
            await db()
                .insert(processingProfileRevisions)
                .values({
                    id: REVISION,
                    profileId: PROFILE,
                    settings: encryptText(JSON.stringify(settings)),
                });
            await db()
                .insert(userSettings)
                .values({ userId: USER, defaultAudioProfileId: PROFILE });
            await insertRecordings(db(), {
                id: ITEM,
                userId: USER,
                filename: encryptText("Original title"),
                deviceSn: "mira-device",
                plaudFileId: ITEM,
                duration: 1000,
                startTime: new Date(NOW),
                endTime: new Date(NOW),
                filesize: 10,
                fileMd5: "0".repeat(32),
                storageType: "local",
                storagePath: "mira.mp3",
                plaudVersion: "1",
            });
            await db()
                .insert(transcriptions)
                .values({
                    id: PLAUD,
                    recordingId: ITEM,
                    userId: USER,
                    source: "plaud",
                    text: encryptText("Plan the Oryon launch."),
                    turns: encryptJsonField([
                        {
                            speaker: "speaker_0",
                            startMs: 0,
                            endMs: 1000,
                            text: "Plan the Oryon launch.",
                        },
                    ]),
                    detectedLanguage: "en",
                    revision: 0,
                    provider: "plaud",
                    model: "plaud",
                });
            await db()
                .insert(itemProcessing)
                .values({
                    itemId: ITEM,
                    userId: USER,
                    view: "private",
                    profileId: PROFILE,
                    profileRevisionId: REVISION,
                    requestedGeneration: 1,
                    phases: {
                        categorize: {
                            state: "done",
                            reason: "categorized",
                            generation: 1,
                            at: NOW,
                        },
                    },
                });
            await db()
                .insert(recordingFolders)
                .values([
                    {
                        id: "mira-root",
                        userId: USER,
                        name: encryptText("Mira root"),
                        nameHash: "mira-root",
                        kind: "private",
                    },
                    {
                        id: "mira-folder",
                        userId: USER,
                        parentId: "mira-root",
                        name: encryptText("Mira launch"),
                        nameHash: "mira-launch",
                        kind: "custom",
                    },
                ]);
            await db().insert(recordingFolderAssignments).values({
                itemId: ITEM,
                userId: USER,
                folderId: "mira-folder",
            });
            createCompletion.mockReset();
            createCompletion
                .mockResolvedValueOnce(
                    reply(
                        JSON.stringify({
                            summary: "The Orion launch is planned.",
                            keyPoints: ["Prepare the launch."],
                            actionItems: [],
                        }),
                    ),
                )
                .mockResolvedValueOnce(reply("Orion launch planning"));
        });

        async function addTranscript(source: "riffado" | "mixed") {
            await db()
                .insert(transcriptions)
                .values({
                    id: `mira-${source}`,
                    recordingId: ITEM,
                    userId: USER,
                    source,
                    text: encryptText(`${source} launch plan`),
                    detectedLanguage: "en",
                    provider: "mira",
                    model: "mira",
                });
        }
        async function storedSummary() {
            return (
                await db()
                    .select()
                    .from(aiEnhancements)
                    .where(
                        and(
                            eq(aiEnhancements.itemId, ITEM),
                            eq(aiEnhancements.userId, USER),
                            eq(aiEnhancements.source, "riffado"),
                        ),
                    )
            )[0];
        }
        async function runJob(trigger: "manual" | "auto") {
            const queued = await enqueueSummaryJob({
                userId: USER,
                ownerUserId: USER,
                recordingId: ITEM,
                trigger,
            });
            const [job] = await claimDueJobs(SUMMARY_JOB_KIND, 1);
            if (!job || job.id !== queued.job.id)
                throw new Error("summary job was not claimed");
            const result = await summaryJobHandler.run({
                jobId: job.id,
                userId: USER,
                attempt: 1,
                maxAttempts: 3,
                payload: { recordingId: ITEM, trigger },
                signal: new AbortController().signal,
                reportProgress: vi.fn(),
            });
            await completeJob({
                jobId: job.id,
                claimToken: job.claimToken,
                result: result ?? null,
            });
            return result;
        }

        it("automatically summarizes corrected Plaud content, titles it, and replans when an own transcript arrives", async () => {
            await db()
                .insert(transcriptCorrections)
                .values({
                    userId: USER,
                    transcriptionId: PLAUD,
                    transcriptRevision: 0,
                    turnIndex: 0,
                    charStart: 9,
                    charEnd: 14,
                    heard: encryptText("Oryon"),
                    heardHmac: "mira-heard",
                    kind: "fix",
                    replacement: encryptText("Orion"),
                });
            const facts = await gatherFacts(ITEM, "private", USER);
            const plan = planAdvance(facts);
            expect(plan.actions).toContainEqual(
                expect.objectContaining({ type: "queueSummary" }),
            );
            expect(plan.actions).toContainEqual(
                expect.objectContaining({
                    type: "markPhase",
                    phase: "transcribe",
                    record: expect.objectContaining({
                        state: "done",
                        reason: "plaud-transcript",
                    }),
                }),
            );
            const summaryPhase = plan.actions.find(
                (action) =>
                    action.type === "markPhase" && action.phase === "summary",
            );
            if (summaryPhase?.type !== "markPhase")
                throw new Error("summary phase was not planned");
            await db()
                .update(itemProcessing)
                .set({
                    phases: { ...facts.phases, summary: summaryPhase.record },
                })
                .where(processingWhere);
            expect(await runJob("auto")).toMatchObject({
                outcome: { kind: "done" },
                titleOutcome: { kind: "done" },
            });
            const stored = await storedSummary();
            expect(stored).toMatchObject({
                source: "riffado",
                transcriptionId: PLAUD,
                inputs: plaudInput,
            });
            expect(stored?.inputFingerprint).toBeTruthy();
            expect(
                createCompletion.mock.calls[0]?.[0].messages[1].content,
            ).toContain("Orion");
            expect(
                createCompletion.mock.calls[0]?.[0].messages[1].content,
            ).not.toContain("Oryon");
            const [item] = await db()
                .select()
                .from(chatterItems)
                .where(
                    and(
                        eq(chatterItems.id, ITEM),
                        eq(chatterItems.userId, USER),
                    ),
                );
            expect(decryptText(item?.title)).toBe("Orion launch planning");
            expect(
                (await gatherFacts(ITEM, "private", USER)).summary,
            ).toMatchObject({ current: true, stale: false });
            expect(await readTitleInput(USER, ITEM)).toMatchObject({
                source: "summary",
                fence: plaudInput,
            });
            await addTranscript("riffado");
            const later = await gatherFacts(ITEM, "private", USER);
            expect(later.summary).toMatchObject({
                current: true,
                stale: false,
            });
            expect(planAdvance(later).actions).toContainEqual(
                expect.objectContaining({ type: "queueSummary" }),
            );
        });

        it.each([
            "plaud",
            "mixed",
        ])("manually summarizes and titles %s content without an existing summary phase", async (source) => {
            if (source === "mixed") await addTranscript("mixed");
            expect(await runJob("manual")).toMatchObject({
                outcome: { kind: "done" },
                titleOutcome: { kind: "done" },
            });
            expect(await storedSummary()).toMatchObject({
                source: "riffado",
                inputs: { contentSourceId: source },
            });
        });

        it("recovers failed summary and title steps through a normal manual job", async () => {
            const phases: PipelinePhases = {
                categorize: {
                    state: "done",
                    reason: "categorized",
                    generation: 1,
                    at: NOW,
                },
                transcribe: {
                    state: "done",
                    reason: "plaud-transcript",
                    generation: 1,
                    inputs: plaudInput,
                    at: NOW,
                },
                learn: {
                    state: "done",
                    generation: 1,
                    inputs: plaudInput,
                    at: NOW,
                },
                summary: {
                    state: "failed",
                    reason: "INVALID_INPUT",
                    generation: 1,
                    inputs: plaudInput,
                    at: NOW,
                    steps: {
                        summary: {
                            ...plaudInput,
                            generation: 1,
                            state: "failed",
                            reason: "INVALID_INPUT",
                        },
                        title: {
                            ...plaudInput,
                            generation: 1,
                            state: "failed",
                            reason: "INVALID_INPUT",
                        },
                        topics: { ...plaudInput, generation: 1, state: "done" },
                    },
                },
            };
            await db()
                .update(itemProcessing)
                .set({ phases })
                .where(processingWhere);
            expect(await runJob("manual")).toMatchObject({
                outcome: { kind: "done" },
                titleOutcome: { kind: "done" },
            });
            expect(
                (await readProcessing(ITEM, "private", USER))?.phases.summary,
            ).toMatchObject({
                state: "done",
                steps: {
                    summary: { state: "done" },
                    title: { state: "done" },
                    topics: { state: "done" },
                },
            });
            expect(await storedSummary()).toMatchObject({ inputs: plaudInput });
        });

        it("keeps the existing no-transcript error", async () => {
            await db()
                .delete(transcriptions)
                .where(
                    and(
                        eq(transcriptions.recordingId, ITEM),
                        eq(transcriptions.userId, USER),
                    ),
                );
            await expect(
                generateSummaryForRecording(USER, ITEM, { trigger: "manual" }),
            ).rejects.toMatchObject({
                code: "INVALID_INPUT",
                message:
                    "No custom transcription available. Transcribe the recording with your provider first.",
            });
            expect(createCompletion).not.toHaveBeenCalled();
        });

        it.each([
            "mixed",
            "riffado",
        ] as const)("uses %s ahead of Plaud for manual summary and transcript title input", async (source) => {
            await addTranscript("mixed");
            if (source === "riffado") await addTranscript("riffado");
            expect(await readTitleInput(USER, ITEM)).toMatchObject({
                text: `${source} launch plan`,
                source: "transcript",
                fence: { contentId: `mira-${source}`, contentSourceId: source },
            });
            const result = await generateSummaryForRecording(USER, ITEM, {
                trigger: "manual",
            });
            expect(result.committed).toBe(true);
            expect(await storedSummary()).toMatchObject({
                source: "riffado",
                transcriptionId: `mira-${source}`,
                inputs: { contentSourceId: source },
            });
        });

        it("reads Plaud text and fence for a transcript-only title", async () => {
            expect(await readTitleInput(USER, ITEM)).toMatchObject({
                text: "Plan the Oryon launch.",
                source: "transcript",
                fence: plaudInput,
            });
        });

        it("makes a Plaud summary stale when Learn's reading changes", async () => {
            await generateSummaryForRecording(USER, ITEM, {
                trigger: "manual",
            });
            expect(await isSummaryStale(USER, ITEM)).toBe(false);
            await db()
                .insert(transcriptCorrections)
                .values({
                    userId: USER,
                    transcriptionId: PLAUD,
                    transcriptRevision: 0,
                    turnIndex: 0,
                    charStart: 9,
                    charEnd: 14,
                    heard: encryptText("Oryon"),
                    heardHmac: "mira-heard",
                    kind: "fix",
                    replacement: encryptText("Orion"),
                });
            expect(await isSummaryStale(USER, ITEM)).toBe(true);
            expect(
                (await gatherFacts(ITEM, "private", USER)).summary,
            ).toMatchObject({ current: false, stale: true });
        });

        it("releases Learn without stored inputs using the Plaud fence and offers timed topics", async () => {
            expect(await pipelineMayQueue(USER, ITEM, "topics")).toBe(true);
            await db().transaction((tx) =>
                markLearnReleasedInTx(tx, {
                    itemId: ITEM,
                    userId: USER,
                    generation: 1,
                }),
            );
            expect(
                (await readProcessing(ITEM, "private", USER))?.phases.learn,
            ).toMatchObject({ state: "done", inputs: plaudInput });
        });

        it.each([
            "plaud",
            "mixed",
        ])("recognizes the custom summary for task review with a %s transcript", async (source) => {
            if (source === "mixed") await addTranscript("mixed");
            await generateSummaryForRecording(USER, ITEM, {
                trigger: "manual",
            });
            expect(await loadPrivateItemProcessing(USER, ITEM)).toMatchObject({
                outputs: { transcript: true, summary: true },
            });
        });

        it("tracks an active Learn correction pass on the selected Plaud content", async () => {
            await db().insert(transcriptCorrectionPasses).values({
                id: "mira-pass",
                userId: USER,
                scopeUserId: USER,
                recordingId: ITEM,
                transcriptionId: PLAUD,
                transcriptRevision: 0,
                view: "private",
            });
            await enqueueJob({
                userId: USER,
                kind: LEARN_CORRECT_JOB_KIND,
                subjectId: ITEM,
                payload: { passId: "mira-pass" },
                maxAttempts: 3,
            });
            expect(
                (await gatherFacts(ITEM, "private", USER))
                    .learnCorrectionInFlight,
            ).toBe(true);
            await addTranscript("riffado");
            expect(
                (await gatherFacts(ITEM, "private", USER))
                    .learnCorrectionInFlight,
            ).toBe(false);
        });

        it("still waits for own transcription in also_transcribe mode", async () => {
            const settings = defaultProfileSettings("audio");
            settings.steps.transcribe.plaudTranscript = "also_transcribe";
            await db()
                .update(processingProfileRevisions)
                .set({ settings: encryptText(JSON.stringify(settings)) })
                .where(
                    and(
                        eq(processingProfileRevisions.id, REVISION),
                        eq(processingProfileRevisions.profileId, PROFILE),
                    ),
                );
            const plan = planAdvance(await gatherFacts(ITEM, "private", USER));
            expect(
                plan.actions.some((action) => action.type === "queueSummary"),
            ).toBe(false);
            expect(plan.actions).toContainEqual(
                expect.objectContaining({
                    type: "markPhase",
                    phase: "transcribe",
                    record: expect.objectContaining({
                        state: "waiting",
                        reason: "needs_transcript",
                    }),
                }),
            );
            expect(await pipelineMayQueue(USER, ITEM, "topics")).toBe(false);
        });
    },
);
