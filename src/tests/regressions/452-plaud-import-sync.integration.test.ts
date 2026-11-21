import { and, asc, eq, ne } from "drizzle-orm";
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
    claimDueJobs,
    completeJob,
    prepareClaimedPipelineJob,
} from "@/db/queries/async-jobs";
import {
    aiEnhancements,
    aiUsageEvents,
    apiCredentials,
    asyncJobs,
    itemProcessing,
    processingProfileRevisions,
    processingProfiles,
    recordingFolderAssignments,
    recordingFolders,
    recordingTaskRejections,
    recordingTasks,
    transcriptions,
    users,
} from "@/db/schema";
import { encrypt } from "@/lib/encryption";
import {
    decryptText,
    encryptJsonField,
    encryptText,
} from "@/lib/encryption/fields";
import type { JobHandler } from "@/lib/jobs/types";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { pipelineActionJobHandler } from "@/lib/pipeline/action-job";
import { pipelineAdvanceJobHandler } from "@/lib/pipeline/advance-job";
import { gatherFacts } from "@/lib/pipeline/facts";
import {
    PIPELINE_ADVANCE_JOB_KIND,
    requestAdvance,
} from "@/lib/pipeline/trigger";
import { defaultProfileSettings } from "@/lib/profiles/settings";
import { plaudActionItemsFingerprint } from "@/lib/tasks/plaud-proposals";
import { taskFingerprint } from "@/lib/tasks/proposals";
import { upsertEnhancement } from "@/lib/transcription/persist";
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
        BETTER_AUTH_SECRET: "plaud-import-test-secret",
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

const OWNER = "import-owner";
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
const TASK_SCOPE = and(
    eq(recordingTasks.userId, OWNER),
    eq(recordingTasks.itemId, ITEM),
);
const dbUrl = getTestDatabaseUrl();

(dbUrl ? describe : describe.skip)(
    "#452 Plaud action item import (PostgreSQL)",
    () => {
        let database: TestPostgresDatabase;
        const db = () => database.db;

        beforeAll(async () => {
            database = await createMigratedTestDatabase(
                dbUrl ?? "",
                "452_plaud_import",
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
                        id: "import-org",
                        email: "org@example.test",
                        role: "org",
                    },
                ]);
        });
        afterEach(async () => {
            expect(providerCall).not.toHaveBeenCalled();
            expect(
                await db()
                    .select()
                    .from(aiUsageEvents)
                    .where(eq(aiUsageEvents.userId, OWNER)),
            ).toEqual([]);
        });

        function profileSettings(tasksEnabled = true) {
            const settings = defaultProfileSettings("audio");
            settings.steps.learn.automatic = false;
            settings.steps.trim.automatic = false;
            settings.steps.topics.automatic = false;
            settings.steps.title.automatic = false;
            settings.steps.summary.automatic = true;
            settings.steps.tasks.enabled = tasksEnabled;
            return encryptText(JSON.stringify(settings));
        }

        async function seed(summaryShape?: "legacy" | "stuck") {
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
            const generation = summaryShape === "stuck" ? 2 : 1;
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
                        ...(summaryShape && {
                            summary: {
                                ...done,
                                generation,
                                reason: "completed",
                                inputs: CONTENT,
                                ...(summaryShape === "stuck" && {
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
                                }),
                            },
                        }),
                    },
                });
        }

        async function importSummary(actionItems: string[]) {
            await expect(
                upsertEnhancement({
                    userId: OWNER,
                    recordingId: ITEM,
                    transcriptionId: CONTENT.contentId,
                    summary: "Imported meeting summary",
                    keyPoints: [],
                    actionItems,
                    source: "plaud",
                    provider: "plaud",
                    model: "plaud-native",
                }),
            ).resolves.toMatchObject({ committed: true });
        }

        async function runNext<P>(handler: JobHandler<P>) {
            const [job] = await claimDueJobs(handler.kind, 1);
            if (!job) throw new Error(`No queued ${handler.kind} job`);
            expect(
                await prepareClaimedPipelineJob(job.id, job.claimToken),
            ).toBe(true);
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

        async function workJobs() {
            return db()
                .select()
                .from(asyncJobs)
                .where(
                    and(
                        eq(asyncJobs.userId, OWNER),
                        ne(asyncJobs.kind, PIPELINE_ADVANCE_JOB_KIND),
                    ),
                )
                .orderBy(asc(asyncJobs.id));
        }

        async function tasks() {
            const rows = await db()
                .select({
                    id: recordingTasks.id,
                    text: recordingTasks.text,
                    source: recordingTasks.source,
                    status: recordingTasks.status,
                    version: recordingTasks.version,
                })
                .from(recordingTasks)
                .where(TASK_SCOPE)
                .orderBy(asc(recordingTasks.position));
            return rows.map((row) => ({ ...row, text: decryptText(row.text) }));
        }

        async function summaryPhase() {
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
            return row.phases.summary;
        }

        async function applyImport(items: string[]) {
            const fingerprint = plaudActionItemsFingerprint(items);
            await runNext(pipelineAdvanceJobHandler);
            expect(await workJobs()).toContainEqual(
                expect.objectContaining({
                    kind: "pipeline.action",
                    status: "pending",
                    subjectId: `applyPlaudTasks:${ITEM}`,
                    payload: expect.objectContaining({
                        action: expect.objectContaining({
                            type: "applyPlaudTasks",
                            sourceFingerprint: fingerprint,
                        }),
                    }),
                }),
            );
            const jobId = await runNext(pipelineActionJobHandler);
            expect(await workJobs()).toContainEqual(
                expect.objectContaining({
                    id: jobId,
                    status: "completed",
                    result: {
                        outcome: { kind: "done", reason: "plaud_tasks" },
                    },
                }),
            );
            expect(await summaryPhase()).toMatchObject({
                state: "done",
                inputs: CONTENT,
                steps: {
                    summary: {
                        ...CONTENT,
                        state: "done",
                        reason: "plaud_tasks",
                        sourceFingerprint: fingerprint,
                    },
                },
            });
        }

        async function expectQuietAdvance() {
            const jobs = await workJobs();
            const phase = await summaryPhase();
            await requestAdvance({
                itemId: ITEM,
                userId: OWNER,
                view: "private",
                reason: "summary",
            });
            await runNext(pipelineAdvanceJobHandler);
            expect(await workJobs()).toEqual(jobs);
            expect(await summaryPhase()).toEqual(phase);
        }

        it.each([
            ["a first Summary", false],
            ["a legacy done Summary without steps", true],
        ] as const)("applies a padded import with %s once", async (_label, legacy) => {
            await seed(legacy ? "legacy" : undefined);
            await importSummary(PADDED_ITEMS);
            await applyImport([OFFER, ROOM]);
            const proposals = await tasks();
            expect(proposals).toEqual(
                [OFFER, ROOM].map((text) => ({
                    id: expect.any(String),
                    text,
                    source: "plaud",
                    status: "proposed",
                    version: 0,
                })),
            );
            expect(new Set(proposals.map(({ id }) => id)).size).toBe(2);
            await expectQuietAdvance();
            expect(await tasks()).toEqual(proposals);
        });

        it("retries a padded import stuck with the old skipped outcome once", async () => {
            await seed("stuck");
            await importSummary(PADDED_ITEMS);
            expect(await tasks()).toEqual([]);
            await applyImport([OFFER, ROOM]);
            expect(await workJobs()).toHaveLength(1);
            const proposals = await tasks();
            expect(proposals.map(({ text }) => text)).toEqual([OFFER, ROOM]);
            await expectQuietAdvance();
            expect(await tasks()).toEqual(proposals);
        });

        it("leaves a clean import with the same skipped outcome alone", async () => {
            await seed("stuck");
            await importSummary([OFFER, ROOM]);
            await expectQuietAdvance();
            await expectQuietAdvance();
            expect(await workJobs()).toEqual([]);
            expect(await tasks()).toEqual([]);
        });

        it("does not repeat a recovery skipped by the writer", async () => {
            await seed("stuck");
            await importSummary(PADDED_ITEMS);
            await runNext(pipelineAdvanceJobHandler);
            expect(await workJobs()).toHaveLength(1);

            const [custom] = await db()
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
            const jobId = await runNext(pipelineActionJobHandler);
            expect(await workJobs()).toMatchObject([
                {
                    id: jobId,
                    status: "completed",
                    result: { outcome: SKIPPED_OUTDATED },
                },
            ]);
            expect((await summaryPhase())?.steps?.summary).toMatchObject({
                state: "skipped",
                reason: "outdated",
                outcome: SKIPPED_OUTDATED,
                sourceFingerprint: plaudActionItemsFingerprint([OFFER, ROOM]),
            });
            expect(await tasks()).toEqual([]);
            await expectQuietAdvance();

            await db()
                .delete(aiEnhancements)
                .where(
                    and(
                        eq(aiEnhancements.id, custom.id),
                        eq(aiEnhancements.userId, OWNER),
                    ),
                );
            await expectQuietAdvance();
            await expectQuietAdvance();
            expect(await tasks()).toEqual([]);
        });

        it.each([
            { label: "an empty list", items: [] },
            { label: "only blank entries", items: ["", "  ", "\t"] },
        ])("removes only untouched Plaud proposals after importing $label", async ({
            items,
        }) => {
            await seed();
            await importSummary([OFFER, ROOM, "Share the agenda"]);
            await applyImport([OFFER, ROOM, "Share the agenda"]);
            const [untouched, accepted, edited] = await tasks();
            await db()
                .update(recordingTasks)
                .set({ status: "open", acceptedAt: new Date() })
                .where(and(TASK_SCOPE, eq(recordingTasks.id, accepted.id)));
            await db()
                .update(recordingTasks)
                .set({
                    text: encryptText("Share the updated agenda"),
                    version: 1,
                })
                .where(and(TASK_SCOPE, eq(recordingTasks.id, edited.id)));
            const [rejection] = await db()
                .insert(recordingTaskRejections)
                .values({
                    itemId: ITEM,
                    userId: OWNER,
                    fingerprintHmac: taskFingerprint("Order lunch"),
                })
                .returning();
            const kept = (await tasks()).filter(
                ({ id }) => id !== untouched.id,
            );

            await importSummary(items);
            await applyImport([]);
            expect(await tasks()).toEqual(kept);
            expect(
                await db()
                    .select()
                    .from(recordingTaskRejections)
                    .where(
                        and(
                            eq(recordingTaskRejections.itemId, ITEM),
                            eq(recordingTaskRejections.userId, OWNER),
                        ),
                    ),
            ).toEqual([rejection]);
            await expectQuietAdvance();
            expect(await tasks()).toEqual(kept);
        });

        it("queues no action when the Plaud summary never carried action items", async () => {
            await seed();
            await importSummary([]);
            await runNext(pipelineAdvanceJobHandler);
            expect(await workJobs()).toEqual([]);
            expect(await tasks()).toEqual([]);
            expect(await summaryPhase()).toBeUndefined();
            await expectQuietAdvance();
        });

        it.each([
            "no proposals remain",
            "Tasks are off",
            "a summary provider is available",
            "the summary was edited",
        ])("queues no cleanup when %s", async (gate) => {
            await seed();
            await importSummary([OFFER]);
            await applyImport([OFFER]);
            if (gate === "no proposals remain") {
                await db()
                    .update(recordingTasks)
                    .set({ status: "open", acceptedAt: new Date() })
                    .where(TASK_SCOPE);
            } else if (gate === "Tasks are off") {
                await db()
                    .update(processingProfileRevisions)
                    .set({ settings: profileSettings(false) })
                    .where(
                        and(
                            eq(processingProfileRevisions.id, REVISION),
                            eq(processingProfileRevisions.createdBy, OWNER),
                        ),
                    );
            } else if (gate === "a summary provider is available") {
                await db()
                    .insert(apiCredentials)
                    .values({
                        userId: OWNER,
                        provider: "openai",
                        apiKey: encrypt("test-key"),
                        defaultModel: "test-model",
                        isDefaultEnhancement: true,
                    });
            }

            await importSummary([]);
            if (gate === "the summary was edited") {
                await db()
                    .update(aiEnhancements)
                    .set({ editedAt: new Date(), editedByUserId: OWNER })
                    .where(
                        and(
                            eq(aiEnhancements.itemId, ITEM),
                            eq(aiEnhancements.userId, OWNER),
                            eq(aiEnhancements.source, "plaud"),
                        ),
                    );
            }
            const facts = await gatherFacts(ITEM, "private", OWNER);
            if (gate === "Tasks are off")
                expect(facts.profile?.tasksEnabled).toBe(false);
            if (gate === "a summary provider is available")
                expect(facts.stepAvailability?.summary).toBe("available");
            if (gate === "the summary was edited")
                expect(facts.summary.edited).toBe(true);
            const before = await tasks();
            await expectQuietAdvance();
            await expectQuietAdvance();
            expect(await tasks()).toEqual(before);
        });
    },
);
