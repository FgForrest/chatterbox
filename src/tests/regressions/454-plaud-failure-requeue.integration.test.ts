import { and, asc, eq } from "drizzle-orm";
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
import { POST as processAgain } from "@/app/api/recordings/[id]/process-again/route";
import {
    type ClaimedAsyncJob,
    claimDueJobs,
    completeJob,
    enqueueJob,
    failJobAttempt,
    prepareClaimedPipelineJob,
    pruneFinishedJobs,
    settleTerminalJobInTx,
} from "@/db/queries/async-jobs";
import {
    aiEnhancements,
    asyncJobs,
    chatterItems,
    itemProcessing,
    processingProfileRevisions,
    processingProfiles,
    recordingFolderAssignments,
    recordingFolders,
    transcriptions,
    users,
} from "@/db/schema";
import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import type { JobHandler } from "@/lib/jobs/types";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { releaseAutoLearnHold } from "@/lib/learn/auto-learn";
import { pipelineActionJobHandler } from "@/lib/pipeline/action-job";
import { pipelineAdvanceJobHandler } from "@/lib/pipeline/advance-job";
import { executePipelineAction } from "@/lib/pipeline/execute";
import { gatherFacts } from "@/lib/pipeline/facts";
import { planAdvance } from "@/lib/pipeline/plan";
import {
    PIPELINE_ADVANCE_JOB_KIND,
    requestAdvance,
} from "@/lib/pipeline/trigger";
import { defaultProfileSettings } from "@/lib/profiles/settings";
import { enqueueSummaryJob } from "@/lib/summary/summary-job";
import { summaryJobHandler } from "@/lib/summary/summary-job-handler";
import { plaudActionItemsFingerprint } from "@/lib/tasks/plaud-proposals";
import {
    upsertEnhancement,
    upsertTranscription,
} from "@/lib/transcription/persist";
import { insertRecordings } from "@/tests/integration/items";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef, providerCall } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    const dbProxy = new Proxy(
        {},
        {
            get: (_target, property) => {
                if (!ref.current) throw new Error("test database not ready");
                const value = ref.current[property];
                return typeof value === "function"
                    ? value.bind(ref.current)
                    : value;
            },
        },
    );
    return { dbProxy, dbRef: ref, providerCall: vi.fn() };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({
    env: {
        IS_HOSTED: false,
        SELF_HOST_MODE: "shared",
        ORG_ACCOUNT_EMAIL: "org@example.test",
        ORG_ACCOUNT_PASSWORD: "test-password",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        BETTER_AUTH_SECRET: "plaud-failure-test-secret",
        DATABASE_URL: "postgres://unused",
        AUTO_SUMMARY_RATE_LIMIT_PER_HOUR: 20,
    },
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("openai", () => ({
    OpenAI: class {
        chat = { completions: { create: providerCall } };
        embeddings = { create: providerCall };
    },
}));

vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async () => ({ user: { id: OWNER } }),
}));

const OWNER = "import-owner";
const ORG = "import-org";
const ITEM = "import-recording";
const PROFILE = "import-profile";
const REVISION = "import-revision";
const CONTENT = {
    contentId: "import-transcript",
    contentSourceId: "plaud",
    contentRevision: 0,
} as const;
const OFFER = "Send the offer";
const ROOM = "Book the room";
const PADDED_ITEMS = [`  ${OFFER} `, "", ROOM];
const SKIPPED_OUTDATED = { kind: "skipped", reason: "outdated" } as const;
const ERROR_CODE = "TEST_FAILURE";
const REQUESTS = ["summary refresh", "Process again"] as const;
type RequestKind = (typeof REQUESTS)[number];
const dbUrl = getTestDatabaseUrl();

describe.skipIf(!dbUrl)(
    "#454 Plaud action terminal results (PostgreSQL)",
    () => {
        let database: TestPostgresDatabase;
        const db = () => database.db;

        beforeAll(async () => {
            database = await createMigratedTestDatabase(
                dbUrl ?? "",
                "454_plaud_failure",
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
            providerCall.mockReset();
            providerCall.mockRejectedValue(
                new Error("Unexpected provider call"),
            );
            await db().delete(users);
            await db()
                .insert(users)
                .values([
                    { id: OWNER, email: "owner@example.test" },
                    {
                        id: ORG,
                        email: "org@example.test",
                        role: "org",
                    },
                ]);
        });
        afterEach(() => {
            expect(providerCall).not.toHaveBeenCalled();
        });

        function profileSettings(automaticTopics = false) {
            const settings = defaultProfileSettings("audio");
            settings.steps.learn.automatic = false;
            settings.steps.trim.automatic = false;
            settings.steps.topics.automatic = automaticTopics;
            settings.steps.title.automatic = false;
            settings.steps.summary.automatic = true;
            settings.steps.tasks.enabled = true;
            return encryptText(JSON.stringify(settings));
        }

        async function seed(paddedHeal = false) {
            await db()
                .insert(recordingFolders)
                .values({
                    id: "private-root",
                    userId: OWNER,
                    kind: "private",
                    name: encryptText("Private"),
                    nameHash: lookupHash("Private"),
                });
            await db()
                .insert(recordingFolders)
                .values({
                    id: "private-notes",
                    userId: OWNER,
                    parentId: "private-root",
                    kind: "custom",
                    name: encryptText("Notes"),
                    nameHash: lookupHash("Notes"),
                });
            await db()
                .insert(processingProfiles)
                .values({
                    id: PROFILE,
                    ownerUserId: OWNER,
                    scope: "personal",
                    channel: "audio",
                    name: encryptText("Notes"),
                    currentRevisionId: REVISION,
                    isDefault: true,
                    createdBy: OWNER,
                    updatedBy: OWNER,
                });
            await db().insert(processingProfileRevisions).values({
                id: REVISION,
                profileId: PROFILE,
                createdBy: OWNER,
                settings: profileSettings(),
            });
            await insertRecordings(db(), {
                id: ITEM,
                userId: OWNER,
                filename: encryptText("Planning"),
                deviceSn: "device",
                plaudFileId: ITEM,
                duration: 1000,
                startTime: new Date(0),
                endTime: new Date(1000),
                filesize: 10,
                fileMd5: "0".repeat(32),
                storageType: "local",
                storagePath: "test.mp3",
                plaudVersion: "1",
            });
            await db().insert(recordingFolderAssignments).values({
                itemId: ITEM,
                userId: OWNER,
                folderId: "private-notes",
            });
            await db()
                .insert(transcriptions)
                .values({
                    id: CONTENT.contentId,
                    recordingId: ITEM,
                    userId: OWNER,
                    source: "plaud",
                    provider: "plaud",
                    model: "plaud-native",
                    text: encryptText("Plan the next meeting."),
                    turns: encryptJsonField([
                        {
                            speaker: "speaker_0",
                            startMs: 0,
                            endMs: 1000,
                            text: "Plan the next meeting.",
                        },
                    ]),
                });
            const done = {
                state: "done",
                generation: 1,
                at: new Date(0).toISOString(),
            } as const;
            const generation = paddedHeal ? 2 : 1;
            await db()
                .insert(itemProcessing)
                .values({
                    itemId: ITEM,
                    userId: OWNER,
                    view: "private",
                    profileId: PROFILE,
                    profileRevisionId: REVISION,
                    requestedGeneration: generation,
                    processedGeneration: generation,
                    phases: {
                        categorize: {
                            ...done,
                            reason: "categorized",
                            profileChoice: "placement",
                        },
                        transcribe: {
                            ...done,
                            reason: "content-available",
                            inputs: CONTENT,
                        },
                        trim: {
                            ...done,
                            state: "skipped",
                            reason: "profile_off",
                            inputs: CONTENT,
                        },
                        learn: {
                            ...done,
                            reason: "manual_finished",
                            inputs: CONTENT,
                        },
                        ...(paddedHeal && {
                            summary: {
                                ...done,
                                generation,
                                reason: "completed",
                                inputs: CONTENT,
                                profileRevisionId: REVISION,
                                steps: {
                                    summary: {
                                        ...CONTENT,
                                        at: done.at,
                                        generation,
                                        profileRevisionId: REVISION,
                                        state: "skipped",
                                        reason: "outdated",
                                        outcome: SKIPPED_OUTDATED,
                                        sourceFingerprint:
                                            plaudActionItemsFingerprint([
                                                OFFER,
                                                ROOM,
                                            ]),
                                    },
                                },
                            },
                        }),
                    },
                });
        }

        async function importSummary(
            actionItems: string[],
            summary = "Imported meeting summary",
        ) {
            await expect(
                upsertEnhancement({
                    userId: OWNER,
                    recordingId: ITEM,
                    transcriptionId: CONTENT.contentId,
                    summary,
                    keyPoints: [],
                    actionItems,
                    source: "plaud",
                    provider: "plaud",
                    model: "plaud-native",
                }),
            ).resolves.toMatchObject({ committed: true });
        }

        async function claim(kind: string) {
            const [job] = await claimDueJobs(kind, 1);
            if (!job) throw new Error(`No queued ${kind} job`);
            expect(
                await prepareClaimedPipelineJob(job.id, job.claimToken),
            ).toBe(true);
            return job;
        }

        async function runNext<P>(handler: JobHandler<P>) {
            const job = await claim(handler.kind);
            const result = await handler.run({
                jobId: job.id,
                userId: job.userId,
                claimToken: job.claimToken,
                attempt: job.attempts,
                maxAttempts: job.maxAttempts,
                payload: handler.parsePayload(job.payload),
                signal: new AbortController().signal,
                reportProgress: vi.fn(),
            });
            expect(
                await completeJob({
                    jobId: job.id,
                    claimToken: job.claimToken,
                    result: result ?? null,
                }),
            ).toBe(true);
            return job.id;
        }

        const advance = () => runNext(pipelineAdvanceJobHandler);
        const runPlaud = () => runNext(pipelineActionJobHandler);
        const claimPlaud = () => claim(pipelineActionJobHandler.kind);

        async function jobs(kind: string) {
            return db()
                .select()
                .from(asyncJobs)
                .where(
                    and(eq(asyncJobs.userId, OWNER), eq(asyncJobs.kind, kind)),
                )
                .orderBy(asc(asyncJobs.id));
        }

        const plaudJobs = () => jobs(pipelineActionJobHandler.kind);
        const pendingAdvances = async () =>
            (await jobs(PIPELINE_ADVANCE_JOB_KIND)).filter(
                ({ status }) => status === "pending",
            );

        async function phases() {
            const [row] = await db()
                .select({ phases: itemProcessing.phases })
                .from(itemProcessing)
                .where(
                    and(
                        eq(itemProcessing.itemId, ITEM),
                        eq(itemProcessing.userId, OWNER),
                        eq(itemProcessing.view, "private"),
                    ),
                );
            return row.phases;
        }

        const summaryStep = async () =>
            (await phases()).summary?.steps?.summary;
        const importScope = and(
            eq(aiEnhancements.itemId, ITEM),
            eq(aiEnhancements.userId, OWNER),
            eq(aiEnhancements.source, "plaud"),
        );

        async function request(kind: RequestKind) {
            if (kind === "Process again") {
                const response = await processAgain(
                    new Request(
                        `http://example.test/api/recordings/${ITEM}/process-again`,
                        {
                            method: "POST",
                        },
                    ),
                    { params: Promise.resolve({ id: ITEM }) },
                );
                const body: { requestedGeneration: number } =
                    await response.json();
                expect(response.status, JSON.stringify(body)).toBe(200);
                return body.requestedGeneration;
            }
            const request = await requestAdvance({
                itemId: ITEM,
                userId: OWNER,
                view: "private",
                reason: "summary-input-changed",
            });
            if (!request) throw new Error("Missing summary refresh");
            return request.requestedGeneration;
        }

        async function externalAdvance() {
            await requestAdvance({
                itemId: ITEM,
                userId: OWNER,
                view: "private",
                reason: "summary",
            });
            await advance();
        }

        async function seedAppliedImport() {
            await seed();
            await importSummary([OFFER]);
            await advance();
            const initialJob = await runPlaud();
            await advance();
            expect(await plaudJobs()).toMatchObject([
                { id: initialJob, status: "completed" },
            ]);
            return initialJob;
        }

        async function queuePlaud(kind: RequestKind) {
            const generation = await request(kind);
            expect(
                (await phases()).categorize?.summaryRefresh?.generation,
            ).toBe(generation);
            if (kind === "Process again")
                expect((await phases()).categorize).toMatchObject({
                    reason: "process_again",
                    generation,
                });
            await advance();
            const step = await summaryStep();
            expect(step).toMatchObject({
                state: "running",
                jobId: expect.any(String),
                sourceFingerprint: plaudActionItemsFingerprint([OFFER]),
            });
            expect(step?.generation).toBeGreaterThanOrEqual(generation);
            expect(await pendingAdvances()).toEqual([]);
        }

        function fail(
            job: ClaimedAsyncJob,
            retryable = false,
            code = ERROR_CODE,
        ) {
            return failJobAttempt({
                jobId: job.id,
                claimToken: job.claimToken,
                message: "Test failure",
                code,
                retryable,
                delayMs: 0,
            });
        }

        async function terminalFailure() {
            const job = await claimPlaud();
            const running = await summaryStep();
            expect(running).toMatchObject({ state: "running", jobId: job.id });
            expect(await fail(job)).toEqual({ status: "failed", attempts: 1 });
            const outcome = {
                kind: "failed",
                code: ERROR_CODE,
                retryable: false,
            };
            expect(
                (await plaudJobs()).find(({ id }) => id === job.id),
            ).toMatchObject({
                status: "failed",
                attempts: 1,
                result: { outcome },
            });
            const step = await summaryStep();
            expect(step).toMatchObject({
                state: "failed",
                reason: ERROR_CODE,
                outcome,
                generation: running?.generation,
                sourceFingerprint: plaudActionItemsFingerprint([OFFER]),
            });
            expect(step?.jobId).toBeUndefined();
            return job.id;
        }

        async function expectPendingPlaud(
            items = [OFFER],
            contentRevision = 0,
        ) {
            const step = await summaryStep();
            const outcome = {
                sourceFingerprint: plaudActionItemsFingerprint(items),
            };
            expect(step).toMatchObject({
                ...CONTENT,
                contentRevision,
                ...outcome,
                state: "running",
                jobId: expect.any(String),
            });
            expect(
                (await plaudJobs()).filter(
                    ({ status }) => status === "pending",
                ),
            ).toMatchObject([
                {
                    id: step?.jobId,
                    subjectId: `applyPlaudTasks:${ITEM}`,
                    payload: {
                        action: { type: "applyPlaudTasks", ...outcome },
                    },
                },
            ]);
            return step;
        }

        it("settlement requests an advance without recreating its failed job", async () => {
            const initialJob = await seedAppliedImport();
            await queuePlaud("summary refresh");
            const jobCounts = [];
            for (let failures = 1; failures <= 3; failures++) {
                if (
                    !(await plaudJobs()).some(
                        ({ status }) => status === "pending",
                    )
                )
                    break;
                await terminalFailure();
                expect(await pendingAdvances()).toMatchObject([
                    { payload: { reason: "step-settled" } },
                ]);
                await advance();
                const jobs = (await plaudJobs()).filter(
                    ({ id }) => id !== initialJob,
                );
                jobCounts.push({
                    failures,
                    failed: jobs.filter(({ status }) => status === "failed")
                        .length,
                    pending: jobs.filter(({ status }) => status === "pending")
                        .length,
                });
            }
            expect(await pendingAdvances()).toEqual([]);
            expect(jobCounts).toEqual([{ failures: 1, failed: 1, pending: 0 }]);
        });

        it.each(
            REQUESTS,
        )("keeps a terminal failure across two external advances during %s", async (kind) => {
            await seedAppliedImport();
            await queuePlaud(kind);
            await terminalFailure();
            const step = await summaryStep();
            const rows = await plaudJobs();
            for (const attempt of [1, 2]) {
                await externalAdvance();
                expect
                    .soft(
                        await plaudJobs(),
                        `Plaud jobs after external advance ${attempt}`,
                    )
                    .toEqual(rows);
                expect
                    .soft(
                        await summaryStep(),
                        `Summary step after external advance ${attempt}`,
                    )
                    .toEqual(step);
            }
        });

        it.each(
            REQUESTS,
        )("keeps a refused write across two external advances during %s", async (kind) => {
            await seedAppliedImport();
            await queuePlaud(kind);
            const [protectedSummary] = await db()
                .insert(aiEnhancements)
                .values({
                    itemId: ITEM,
                    userId: OWNER,
                    transcriptionId: CONTENT.contentId,
                    source: "riffado",
                    summary: encryptText("Saved meeting summary"),
                    provider: "test",
                    model: "test",
                })
                .returning({ id: aiEnhancements.id });
            const running = await summaryStep();
            const id = await runPlaud();
            const rows = await plaudJobs();
            expect(rows.find((job) => job.id === id)).toMatchObject({
                status: "completed",
                result: { outcome: SKIPPED_OUTDATED },
            });
            const step = await summaryStep();
            expect(step).toMatchObject({
                state: "skipped",
                reason: "outdated",
                outcome: SKIPPED_OUTDATED,
                generation: running?.generation,
                sourceFingerprint: plaudActionItemsFingerprint([OFFER]),
            });
            expect(step?.jobId).toBeUndefined();
            await db()
                .delete(aiEnhancements)
                .where(
                    and(
                        eq(aiEnhancements.id, protectedSummary.id),
                        eq(aiEnhancements.userId, OWNER),
                    ),
                );
            for (const attempt of [1, 2]) {
                await externalAdvance();
                expect
                    .soft(
                        await plaudJobs(),
                        `Plaud jobs after external advance ${attempt}`,
                    )
                    .toEqual(rows);
                expect
                    .soft(
                        await summaryStep(),
                        `Summary step after external advance ${attempt}`,
                    )
                    .toEqual(step);
            }
        });

        it("retries on the same job while attempts remain", async () => {
            await seedAppliedImport();
            await queuePlaud("summary refresh");
            const first = await claimPlaud();
            expect(first.maxAttempts).toBe(3);
            for (const attempts of [1, 2]) {
                const job = attempts === 1 ? first : await claimPlaud();
                expect(job.id).toBe(first.id);
                expect(await fail(job, true)).toEqual({
                    status: "pending",
                    attempts,
                });
                expect(
                    (await plaudJobs()).find(({ id }) => id === job.id),
                ).toMatchObject({
                    status: "pending",
                    attempts,
                });
                expect(await summaryStep()).toMatchObject({
                    state: "running",
                    jobId: first.id,
                });
                expect(await pendingAdvances()).toEqual([]);
            }
            expect(await runPlaud()).toBe(first.id);
            expect(
                (await plaudJobs()).find(({ id }) => id === first.id),
            ).toMatchObject({
                status: "completed",
                attempts: 3,
                result: { outcome: { kind: "done", reason: "plaud_tasks" } },
            });
        });

        it("queues a new import fingerprint after a terminal failure", async () => {
            await seedAppliedImport();
            await queuePlaud("summary refresh");
            await terminalFailure();
            await importSummary([ROOM]);
            await advance();
            await expectPendingPlaud([ROOM]);
        });

        it.each(
            REQUESTS,
        )("honors a new %s generation after a terminal failure", async (kind) => {
            await seedAppliedImport();
            await queuePlaud(kind);
            await terminalFailure();
            const failed = await summaryStep();
            const generation = await request(kind);
            expect(generation).toBeGreaterThan(failed?.generation ?? 0);
            await advance();
            expect(
                (await expectPendingPlaud())?.generation,
            ).toBeGreaterThanOrEqual(generation);
        });

        it("queues the same import for a new transcript revision after a terminal failure", async () => {
            await seedAppliedImport();
            await queuePlaud("summary refresh");
            await terminalFailure();
            expect(
                await upsertTranscription({
                    recordingId: ITEM,
                    userId: OWNER,
                    text: "Revised meeting plan.",
                    detectedLanguage: null,
                    source: "plaud",
                    provider: "plaud",
                    model: "plaud-native",
                }),
            ).toEqual({ committed: true });
            await advance();
            await expectPendingPlaud([OFFER], 1);
        });

        it.each([
            "held",
            "failed",
            "outdated",
        ] as const)("runs the fallback after a regular Summary job settles as %s", async (reason) => {
            await seedAppliedImport();
            const generation = await request("summary refresh");
            if (reason === "held")
                await db()
                    .update(chatterItems)
                    .set({
                        summaryDueAt: new Date("2099-01-01T00:00:00Z"),
                    })
                    .where(
                        and(
                            eq(chatterItems.id, ITEM),
                            eq(chatterItems.userId, OWNER),
                        ),
                    );
            await enqueueJob({
                userId: OWNER,
                kind: summaryJobHandler.kind,
                subjectId: ITEM,
                payload: { recordingId: ITEM, trigger: "auto" },
                pipeline: {
                    itemId: ITEM,
                    userId: OWNER,
                    phase: "summary",
                    step: "summary",
                },
            });
            let outcome: Record<string, unknown>;
            let jobId: string;
            if (reason === "held") {
                jobId = await runNext(summaryJobHandler);
                outcome = { kind: "skipped", reason };
            } else {
                const job = await claim(summaryJobHandler.kind);
                jobId = job.id;
                if (reason === "failed") {
                    await fail(job);
                    outcome = {
                        kind: "failed",
                        code: ERROR_CODE,
                        retryable: false,
                    };
                } else {
                    outcome = SKIPPED_OUTDATED;
                    expect(
                        await completeJob({
                            jobId,
                            claimToken: job.claimToken,
                            result: { outcome },
                        }),
                    ).toBe(true);
                }
            }
            expect(await jobs(summaryJobHandler.kind)).toMatchObject([
                { id: jobId, result: { outcome } },
            ]);
            const step = await summaryStep();
            expect(step).toMatchObject({
                state: outcome.kind,
                reason: reason === "failed" ? ERROR_CODE : reason,
                outcome,
                sourceFingerprint: plaudActionItemsFingerprint([OFFER]),
            });
            expect(step?.generation).toBeGreaterThanOrEqual(generation);
            expect(step?.jobId).toBeUndefined();
            if (reason === "held")
                await expect(releaseAutoLearnHold(ITEM)).resolves.toBe(true);
            expect(
                (await gatherFacts(ITEM, "private", OWNER)).stepAvailability
                    ?.summary,
            ).toBe("no_provider");
            await advance();
            await expectPendingPlaud();
        });

        it("retries source_changed when the original fingerprint returns during a refresh", async () => {
            await seedAppliedImport();
            await queuePlaud("summary refresh");
            await importSummary([ROOM]);
            const skipped = await runPlaud();
            const outcome = { kind: "skipped", reason: "source_changed" };
            const job = (await plaudJobs()).find(({ id }) => id === skipped);
            expect(job).toMatchObject({
                status: "completed",
            });
            expect(job?.result).toEqual({ outcome });
            expect(await summaryStep()).toMatchObject({
                state: "skipped",
                reason: "source_changed",
                outcome,
                sourceFingerprint: plaudActionItemsFingerprint([OFFER]),
            });
            await importSummary([OFFER]);
            await advance();
            await expectPendingPlaud();
        });

        it("documents the stale phase write that can restore an older Plaud failure over a Summary failure", async () => {
            await seedAppliedImport();
            await queuePlaud("summary refresh");
            await terminalFailure();
            await db()
                .update(processingProfileRevisions)
                .set({ settings: profileSettings(true) })
                .where(
                    and(
                        eq(processingProfileRevisions.id, REVISION),
                        eq(processingProfileRevisions.createdBy, OWNER),
                    ),
                );

            const driver = await claim(PIPELINE_ADVANCE_JOB_KIND);
            const snapshot = await gatherFacts(ITEM, "private", OWNER);
            const mark = planAdvance(snapshot).actions.find(
                (action) =>
                    action.type === "markPhase" &&
                    action.phase === "summary" &&
                    action.record.steps?.topics?.reason === "no_provider",
            );
            if (mark?.type !== "markPhase")
                throw new Error("Expected a Topics mark");
            expect(mark.record.steps?.summary).toMatchObject({
                reason: ERROR_CODE,
            });
            await enqueueJob({
                userId: OWNER,
                kind: summaryJobHandler.kind,
                subjectId: ITEM,
                payload: { recordingId: ITEM, trigger: "auto" },
                pipeline: {
                    itemId: ITEM,
                    userId: OWNER,
                    phase: "summary",
                    step: "summary",
                },
            });
            const regular = await claim(summaryJobHandler.kind);
            expect(
                await failJobAttempt({
                    jobId: regular.id,
                    claimToken: regular.claimToken,
                    code: "NO_PROVIDER",
                    message: "No provider",
                    retryable: false,
                    delayMs: 0,
                }),
            ).toEqual({ status: "failed", attempts: 1 });
            expect(await summaryStep()).toMatchObject({
                reason: "NO_PROVIDER",
            });
            expect(
                planAdvance(await gatherFacts(ITEM, "private", OWNER)).actions,
            ).toContainEqual(
                expect.objectContaining({ type: "applyPlaudTasks" }),
            );

            await executePipelineAction({
                action: mark,
                itemId: ITEM,
                userId: OWNER,
                view: "private",
                generation: snapshot.generation,
            });
            expect(await summaryStep()).toMatchObject({ reason: ERROR_CODE });
            expect(
                await completeJob({
                    jobId: driver.id,
                    claimToken: driver.claimToken,
                }),
            ).toBe(true);
        });

        it("queues a fresh Plaud import with the same normalized items during Process again", async () => {
            await seedAppliedImport();
            await queuePlaud("Process again");
            await terminalFailure();
            const generation = (await phases()).categorize?.generation;
            const [previous] = await db()
                .delete(aiEnhancements)
                .where(importScope)
                .returning({
                    id: aiEnhancements.id,
                });
            await importSummary(
                [`  ${OFFER} `, ""],
                "A freshly imported summary",
            );
            const [replacement] = await db()
                .select({ id: aiEnhancements.id })
                .from(aiEnhancements)
                .where(importScope);
            expect(replacement.id).not.toBe(previous.id);
            expect((await phases()).categorize?.generation).toBe(generation);
            await advance();
            await expectPendingPlaud();
        });

        it("allows only one replacement after a Learn release overwrites the terminal step", async () => {
            await seedAppliedImport();
            await queuePlaud("summary refresh");
            await terminalFailure();
            const rows = await plaudJobs();
            await db()
                .update(chatterItems)
                .set({
                    summaryDueAt: new Date("2099-01-01T00:00:00Z"),
                })
                .where(
                    and(
                        eq(chatterItems.id, ITEM),
                        eq(chatterItems.userId, OWNER),
                    ),
                );
            await expect(releaseAutoLearnHold(ITEM)).resolves.toBe(true);
            await advance();
            expect
                .soft(await summaryStep())
                .toMatchObject({ state: "skipped", reason: "no_provider" });
            await externalAdvance();
            await expectPendingPlaud();
            const replacement = await terminalFailure();
            await advance();
            await externalAdvance();
            expect(await plaudJobs()).toEqual(
                expect.arrayContaining([
                    ...rows,
                    expect.objectContaining({
                        id: replacement,
                        status: "failed",
                    }),
                ]),
            );
            expect(await plaudJobs()).toHaveLength(rows.length + 1);
        });

        it("retains the cancellation retryability fallback for an unrecognized outcome", async () => {
            const kind = "test.cancel";
            const { job } = await enqueueJob({ userId: OWNER, kind });
            expect(
                await db().transaction((tx) =>
                    settleTerminalJobInTx(tx, {
                        jobId: job.id,
                        cancelForUserId: OWNER,
                        status: "failed",
                        code: ERROR_CODE,
                        retryable: false,
                        result: { outcome: { kind: "unknown" } },
                    }),
                ),
            ).toBe(true);
            expect(await jobs(kind)).toMatchObject([
                {
                    id: job.id,
                    status: "failed",
                    result: {
                        outcome: {
                            kind: "failed",
                            code: ERROR_CODE,
                            retryable: true,
                        },
                    },
                },
            ]);
        });

        it("retains the ordinary non-Plaud worker failure outcome", async () => {
            const kind = pipelineActionJobHandler.kind;
            const { job } = await enqueueJob({
                userId: OWNER,
                kind,
                payload: { itemId: ITEM, action: { type: "executeShares" } },
            });
            const claimed = await claim(kind);
            expect(claimed.id).toBe(job.id);
            expect(
                await db().transaction((tx) =>
                    settleTerminalJobInTx(tx, {
                        jobId: job.id,
                        claimToken: claimed.claimToken,
                        status: "failed",
                        code: ERROR_CODE,
                        retryable: false,
                        result: { outcome: SKIPPED_OUTDATED },
                    }),
                ),
            ).toBe(true);
            expect((await jobs(kind))[0]?.result).toEqual({
                outcome: { kind: "failed", code: ERROR_CODE, retryable: false },
            });
        });

        it("allows only one replacement for a terminal step from before deployment", async () => {
            await seedAppliedImport();
            await queuePlaud("summary refresh");
            await terminalFailure();
            const processing = await phases();
            const step = processing.summary?.steps?.summary;
            if (!step) throw new Error("Expected a Summary step");
            step.outcome = {
                kind: "failed",
                code: ERROR_CODE,
                retryable: false,
            };
            delete step.sourceRevision;
            await db()
                .update(itemProcessing)
                .set({ phases: processing })
                .where(
                    and(
                        eq(itemProcessing.itemId, ITEM),
                        eq(itemProcessing.userId, OWNER),
                        eq(itemProcessing.view, "private"),
                    ),
                );
            await advance();
            await expectPendingPlaud();
            await terminalFailure();
            const rows = await plaudJobs();
            await advance();
            await externalAdvance();
            expect(await plaudJobs()).toEqual(rows);
        });

        it.each(
            REQUESTS,
        )("queues a same-items Plaud import revised in place during %s", async (kind) => {
            await seedAppliedImport();
            await queuePlaud(kind);
            await terminalFailure();
            const [before] = await db()
                .select({
                    id: aiEnhancements.id,
                    revision: aiEnhancements.revision,
                })
                .from(aiEnhancements)
                .where(importScope);
            await importSummary([OFFER], "A revised Plaud summary");
            const [after] = await db()
                .select({
                    id: aiEnhancements.id,
                    revision: aiEnhancements.revision,
                })
                .from(aiEnhancements)
                .where(importScope);
            expect(after).toEqual({ ...before, revision: before.revision + 1 });
            const facts = await gatherFacts(ITEM, "private", OWNER);
            expect(facts.summary.refreshRequested).toBe(false);
            await advance();
            await expectPendingPlaud();
        });

        it.each([
            OWNER,
            ORG,
        ])("allows fallback after an Organization-view Summary by %s settles the private step", async (actor) => {
            await seedAppliedImport();
            await queuePlaud("summary refresh");
            await terminalFailure();
            const { job } = await enqueueSummaryJob({
                userId: actor,
                ownerUserId: OWNER,
                recordingId: ITEM,
                trigger: "manual",
                view: "org",
            });
            expect(job.subjectId).toBe(`org:${ITEM}`);
            const regular = await claim(summaryJobHandler.kind);
            expect(regular.id).toBe(job.id);
            expect(regular.payload.pipelineSteps).toContainEqual(
                expect.objectContaining({
                    userId: OWNER,
                    itemId: ITEM,
                    phase: "summary",
                    step: "summary",
                }),
            );
            expect(await fail(regular, false, "NO_PROVIDER")).toEqual({
                status: "failed",
                attempts: 1,
            });
            expect(await summaryStep()).toMatchObject({
                state: "failed",
                reason: "NO_PROVIDER",
            });
            await advance();
            await expectPendingPlaud();
        });

        it("allows fallback when a superseded Plaud claim fails after the newer Summary failure", async () => {
            await seedAppliedImport();
            await queuePlaud("summary refresh");
            const plaud = await claimPlaud();
            await enqueueSummaryJob({
                userId: OWNER,
                ownerUserId: OWNER,
                recordingId: ITEM,
                trigger: "manual",
                view: "private",
            });
            const regular = await claim(summaryJobHandler.kind);
            expect(await summaryStep()).toMatchObject({ jobId: regular.id });
            expect(await fail(regular, false, "NO_PROVIDER")).toEqual({
                status: "failed",
                attempts: 1,
            });
            const settled = await summaryStep();
            expect(settled).toMatchObject({
                state: "failed",
                reason: "NO_PROVIDER",
            });
            expect(await fail(plaud)).toEqual({
                status: "failed",
                attempts: 1,
            });
            expect(await summaryStep()).toEqual(settled);
            await advance();
            await expectPendingPlaud();
        });

        it("retries a restored import after a pre-#452 skipped/outdated outcome", async () => {
            await seedAppliedImport();
            await queuePlaud("Process again");
            await importSummary([ROOM]);
            const plaud = await claimPlaud();
            expect(
                await completeJob({
                    jobId: plaud.id,
                    claimToken: plaud.claimToken,
                    result: { outcome: SKIPPED_OUTDATED },
                }),
            ).toBe(true);
            expect((await summaryStep())?.outcome).toEqual(SKIPPED_OUTDATED);
            await importSummary([OFFER]);
            await advance();
            await expectPendingPlaud();
        });

        it("keeps a failure handled across clock skew and pruning of its job row", async () => {
            const initial = await seedAppliedImport();
            await queuePlaud("summary refresh");
            const failed = await terminalFailure();
            const settled = await summaryStep();
            await db()
                .update(aiEnhancements)
                .set({
                    createdAt: new Date("2099-01-01T00:00:00Z"),
                })
                .where(importScope);
            await advance();
            expect(await summaryStep()).toEqual(settled);

            await db()
                .update(asyncJobs)
                .set({
                    completedAt: new Date(0),
                })
                .where(
                    and(eq(asyncJobs.id, failed), eq(asyncJobs.userId, OWNER)),
                );
            expect(await pruneFinishedJobs(24 * 60 * 60 * 1000, 100)).toBe(1);
            await externalAdvance();
            expect(await summaryStep()).toEqual(settled);
            expect(await plaudJobs()).toMatchObject([
                { id: initial, status: "completed" },
            ]);
        });

        it("heals a legacy padded import once", async () => {
            await seed(true);
            await importSummary(PADDED_ITEMS);
            await advance();
            await expectPendingPlaud([OFFER, ROOM]);
            const id = await runPlaud();
            await advance();
            await externalAdvance();
            expect(await plaudJobs()).toMatchObject([
                { id, status: "completed" },
            ]);
            expect(await summaryStep()).toMatchObject({
                state: "done",
                reason: "plaud_tasks",
                sourceFingerprint: plaudActionItemsFingerprint([OFFER, ROOM]),
            });
        });
    },
);
