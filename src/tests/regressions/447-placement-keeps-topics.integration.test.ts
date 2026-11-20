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
    apiCredentials,
    asyncJobs,
    itemProcessing,
    learnReviewItems,
    learnRuns,
    people,
    processingProfileRevisions,
    processingProfiles,
    recordingFolderAssignments,
    recordingFolders,
    recordingTasks,
    transcriptCorrections,
    transcriptions,
    transcriptSpeakers,
    users,
} from "@/db/schema";
import { encrypt } from "@/lib/encryption";
import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import { domainLookupHash, lookupHash } from "@/lib/knowledge/lookup-hash";
import type { ContentRevisionInput } from "@/lib/pipeline/types";
import { insertRecordings } from "@/tests/integration/items";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef } = vi.hoisted(() => {
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
    return { dbProxy, dbRef: ref };
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
        BETTER_AUTH_SECRET: "placement-topics-test-secret",
        DATABASE_URL: "postgres://unused",
        AUTO_SUMMARY_RATE_LIMIT_PER_HOUR: 20,
    },
}));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async () => ({ user: { id: "topics-owner" } }),
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));

import {
    POST as file,
    PATCH as move,
    DELETE as unfile,
} from "@/app/api/recordings/[id]/folders/route";
import { POST as processAgain } from "@/app/api/recordings/[id]/process-again/route";
import { llmRendering } from "@/lib/learn/llm-input";
import { finishReview } from "@/lib/learn/review";
import { pipelineAdvanceJobHandler } from "@/lib/pipeline/advance-job";
import { gatherFacts } from "@/lib/pipeline/facts";
import {
    PIPELINE_ADVANCE_JOB_KIND,
    requestAdvance,
} from "@/lib/pipeline/trigger";
import { defaultProfileSettings } from "@/lib/profiles/settings";
import { requireRecordingView } from "@/lib/sharing/access";

const OWNER = "topics-owner";
const ORG = "topics-org";
const ITEM = "topics-recording";
const TRANSCRIPT = "topics-transcript";
const INPUT: ContentRevisionInput = {
    contentId: TRANSCRIPT,
    contentSourceId: "riffado",
    contentRevision: 0,
};
const PROFILE_REVISION = "personal-revision";
const PROCESSING_SCOPE = and(
    eq(itemProcessing.itemId, ITEM),
    eq(itemProcessing.userId, OWNER),
    eq(itemProcessing.view, "private"),
);
const dbUrl = getTestDatabaseUrl();

async function mutate(
    handler: typeof file,
    method: string,
    body: object,
    path = "folders",
) {
    const response = await handler(
        new Request(
            `http://localhost/api/recordings/${ITEM}/${path}?view=private`,
            {
                method,
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
            },
        ),
        { params: Promise.resolve({ id: ITEM }) },
    );
    expect(response.status, JSON.stringify(await response.json())).toBe(200);
}

(dbUrl ? describe : describe.skip)(
    "#447 completed Topics survive placement changes",
    () => {
        let database: TestPostgresDatabase;
        const db = () => database.db;

        beforeAll(async () => {
            database = await createMigratedTestDatabase(
                dbUrl ?? "",
                "447_placement_topics",
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
                .values([
                    { id: OWNER, email: "owner@example.test" },
                    { id: ORG, email: "org@example.test", role: "org" },
                ]);
        });

        async function seed(
            shape: "legacy" | "partial" | "modern",
            {
                folders = ["private-a"],
                learnReason = "manual_finished",
                learnGeneration = 1,
                pendingProposal = false,
                transcriptRevision = 0,
                hasTopics = true,
                automaticLearn = true,
            } = {},
        ) {
            for (const [id, userId, parentId, kind] of [
                ["private-root", OWNER, null, "private"],
                ["private-a", OWNER, "private-root", "custom"],
                ["private-b", OWNER, "private-root", "custom"],
                ["org-root", ORG, null, "public"],
                ["org-a", ORG, "org-root", "custom"],
                ["org-b", ORG, "org-root", "custom"],
            ] as const) {
                await db()
                    .insert(recordingFolders)
                    .values({
                        id,
                        userId,
                        parentId,
                        kind,
                        name: encryptText(id),
                        nameHash: lookupHash(id),
                    });
            }
            const settings = defaultProfileSettings("audio");
            settings.steps.learn.automatic = automaticLearn;
            settings.steps.learn.correctAfterLearn = false;
            settings.steps.topics.automatic = true;
            settings.steps.summary.automatic = true;
            settings.steps.trim.automatic = false;
            settings.steps.title.automatic = false;
            for (const [id, userId, scope, revision] of [
                ["personal-profile", OWNER, "personal", PROFILE_REVISION],
                ["org-profile", ORG, "organization", "org-revision"],
            ] as const) {
                await db()
                    .insert(processingProfiles)
                    .values({
                        id,
                        ownerUserId: userId,
                        scope,
                        channel: "audio",
                        name: encryptText(id),
                        currentRevisionId: revision,
                        isDefault: true,
                        createdBy: userId,
                        updatedBy: userId,
                    });
                await db()
                    .insert(processingProfileRevisions)
                    .values({
                        id: revision,
                        profileId: id,
                        createdBy: userId,
                        settings: encryptText(JSON.stringify(settings)),
                    });
            }
            await db()
                .insert(apiCredentials)
                .values({
                    userId: OWNER,
                    provider: "openai",
                    apiKey: encrypt("test-key"),
                    defaultModel: "test-model",
                    isDefaultEnhancement: true,
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
            await db()
                .insert(recordingFolderAssignments)
                .values(
                    folders.map((folderId) => ({
                        itemId: ITEM,
                        userId: OWNER,
                        folderId,
                    })),
                );
            await db()
                .insert(transcriptions)
                .values({
                    id: TRANSCRIPT,
                    recordingId: ITEM,
                    userId: OWNER,
                    source: "riffado",
                    provider: "test",
                    model: "test",
                    revision: transcriptRevision,
                    text: encryptText("Plan the next release."),
                    turns: encryptJsonField([
                        {
                            speaker: "speaker_0",
                            startMs: 0,
                            endMs: 1000,
                            text: "Plan the next release.",
                        },
                    ]),
                    topics: hasTopics
                        ? encryptJsonField({
                              topics: [
                                  {
                                      title: "Release planning",
                                      fromMs: 0,
                                      toMs: 1000,
                                  },
                              ],
                              provider: "test",
                              model: "test",
                              templateId: "default",
                              generatedAt: new Date(0).toISOString(),
                          })
                        : null,
                });
            await db().insert(transcriptSpeakers).values({
                userId: OWNER,
                transcriptionId: TRANSCRIPT,
                label: "speaker_0",
                source: "user",
                status: "confirmed",
                markedUnknown: true,
                confirmedByUserId: OWNER,
            });
            await db()
                .insert(aiEnhancements)
                .values({
                    itemId: ITEM,
                    userId: OWNER,
                    transcriptionId: TRANSCRIPT,
                    source: "riffado",
                    provider: "test",
                    model: "test",
                    summary: encryptText("Existing summary"),
                });
            if (pendingProposal) {
                await db()
                    .insert(recordingTasks)
                    .values({
                        id: "saved-proposal",
                        itemId: ITEM,
                        userId: OWNER,
                        text: encryptText("Review the draft"),
                        status: "proposed",
                        source: "riffado",
                    });
            }
            const done = {
                state: "done",
                generation: 1,
                at: new Date().toISOString(),
            } as const;
            const step = {
                ...INPUT,
                state: "done",
                generation: 1,
                profileRevisionId: PROFILE_REVISION,
            } as const;
            const shared = folders.some((folderId) =>
                folderId.startsWith("org-"),
            );
            await db()
                .insert(itemProcessing)
                .values({
                    itemId: ITEM,
                    userId: OWNER,
                    view: "private",
                    profileId: "personal-profile",
                    profileRevisionId: PROFILE_REVISION,
                    requestedGeneration: learnGeneration,
                    processedGeneration: learnGeneration,
                    phases: {
                        categorize: {
                            ...done,
                            reason: "categorized",
                            profileChoice: "placement",
                            ...(shared && {
                                placementProfile: {
                                    profileId: "org-profile",
                                    profileRevisionId: "org-revision",
                                    manualOnly: false,
                                },
                            }),
                        },
                        transcribe: {
                            ...done,
                            reason: "content-available",
                            inputs: INPUT,
                        },
                        trim: {
                            ...done,
                            state: "skipped",
                            reason: "profile_off",
                            inputs: INPUT,
                        },
                        learn: {
                            ...done,
                            generation: learnGeneration,
                            reason: learnReason,
                            inputs: INPUT,
                        },
                        summary: {
                            ...done,
                            reason: "completed",
                            inputs: INPUT,
                            ...(shape !== "legacy" && {
                                profileRevisionId: PROFILE_REVISION,
                                steps: {
                                    title: step,
                                    ...(shape === "modern" && { topics: step }),
                                    summary: step,
                                },
                            }),
                        },
                        taskReview: { ...done, reason: "reviewed" },
                        ...(shared && { share: { ...done, reason: "shared" } }),
                    },
                });
        }

        async function advance(reason = "placement") {
            const [job] = await db()
                .select()
                .from(asyncJobs)
                .where(
                    and(
                        eq(asyncJobs.userId, OWNER),
                        eq(asyncJobs.kind, PIPELINE_ADVANCE_JOB_KIND),
                    ),
                );
            expect(job?.payload).toMatchObject({
                itemId: ITEM,
                view: "private",
                reason,
            });
            await expect(
                pipelineAdvanceJobHandler.run({
                    jobId: job.id,
                    userId: OWNER,
                    attempt: 1,
                    maxAttempts: 10,
                    payload: pipelineAdvanceJobHandler.parsePayload(
                        job.payload,
                    ),
                    signal: new AbortController().signal,
                    reportProgress: vi.fn(),
                }),
            ).resolves.toMatchObject({
                outcome: { kind: "done" },
            });
        }

        async function queuedWork() {
            const jobs = await db()
                .select({
                    kind: asyncJobs.kind,
                    subjectId: asyncJobs.subjectId,
                })
                .from(asyncJobs)
                .where(
                    and(
                        eq(asyncJobs.userId, OWNER),
                        eq(asyncJobs.status, "pending"),
                    ),
                );
            return jobs
                .filter(
                    (job) =>
                        job.kind !== PIPELINE_ADVANCE_JOB_KIND &&
                        !(
                            job.kind === "pipeline.action" &&
                            job.subjectId === `executeShares:${ITEM}`
                        ),
                )
                .map((job) => job.kind);
        }

        async function readStoredTopics() {
            const [row] = await db()
                .select({
                    topics: transcriptions.topics,
                    revision: transcriptions.revision,
                })
                .from(transcriptions)
                .where(
                    and(
                        eq(transcriptions.userId, OWNER),
                        eq(transcriptions.id, TRANSCRIPT),
                    ),
                );
            return row;
        }

        async function saveCurrentReading() {
            const reading = await llmRendering(TRANSCRIPT);
            if (!reading) throw new Error("expected a timed transcript");
            await db()
                .update(aiEnhancements)
                .set({ inputFingerprint: reading.fingerprint })
                .where(
                    and(
                        eq(aiEnhancements.userId, OWNER),
                        eq(aiEnhancements.itemId, ITEM),
                    ),
                );
            await db()
                .update(transcriptions)
                .set({ topicsInputFingerprint: reading.fingerprint })
                .where(
                    and(
                        eq(transcriptions.userId, OWNER),
                        eq(transcriptions.id, TRANSCRIPT),
                    ),
                );
            return reading;
        }

        async function requestBareAdvance() {
            await requestAdvance({
                itemId: ITEM,
                userId: OWNER,
                view: "private",
                reason: "summary",
            });
            await advance("summary");
        }

        async function recordFulfilledRefresh(
            reason: "categorized" | "process_again",
        ) {
            const [saved] = await db()
                .update(aiEnhancements)
                .set({ revision: 1 })
                .where(
                    and(
                        eq(aiEnhancements.userId, OWNER),
                        eq(aiEnhancements.itemId, ITEM),
                    ),
                )
                .returning({ id: aiEnhancements.id });
            const [processing] = await db()
                .select()
                .from(itemProcessing)
                .where(PROCESSING_SCOPE);
            const categorize = processing.phases.categorize;
            if (!categorize) throw new Error("expected a categorized item");
            await db()
                .update(itemProcessing)
                .set({
                    phases: {
                        ...processing.phases,
                        categorize: {
                            ...categorize,
                            reason,
                            generation: 2,
                            summaryRefresh: {
                                id: saved.id,
                                revision: 0,
                                generation: 2,
                            },
                        },
                    },
                })
                .where(PROCESSING_SCOPE);
        }

        describe.each([
            "legacy",
            "modern",
        ] as const)("%s Summary phase", (shape) => {
            it.each([
                [
                    "filing after a fulfilled Summary refresh",
                    "categorized",
                    ["private-a"],
                    file,
                    "POST",
                    { folderId: "private-b" },
                ],
                [
                    "withdrawal after a fulfilled Process again",
                    "process_again",
                    ["private-a", "org-a"],
                    unfile,
                    "DELETE",
                    { organization: true, withdraw: true },
                ],
            ] as const)(
                "keeps stored Topics on %s",
                async (_name, reason, folders, handler, method, body) => {
                    await seed(shape, {
                        folders: [...folders],
                        learnGeneration: 2,
                    });
                    await recordFulfilledRefresh(reason);
                    const topics = await readStoredTopics();
                    expect(topics.topics).not.toBeNull();
                    await mutate(handler, method, body);
                    expect(
                        (await gatherFacts(ITEM, "private", OWNER)).summary
                            .refreshRequested,
                    ).toBe(false);
                    await advance();
                    expect(await readStoredTopics()).toEqual(topics);
                    expect(await queuedWork()).toEqual([]);
                },
                15_000,
            );

            it("keeps stored Topics on withdrawal when the correction rendering changes", async () => {
                await seed(shape, { folders: ["private-a", "org-a"] });
                await db()
                    .insert(transcriptCorrections)
                    .values({
                        userId: OWNER,
                        transcriptionId: TRANSCRIPT,
                        transcriptRevision: 0,
                        turnIndex: 0,
                        charStart: 0,
                        charEnd: 4,
                        heard: encryptText("Plan"),
                        heardHmac: domainLookupHash("correction-heard", "Plan"),
                        kind: "fix",
                        replacement: encryptText("Schedule"),
                        createdByUserId: OWNER,
                    });
                const sharedReading = await saveCurrentReading();
                expect(sharedReading.text).toContain("Plan the next release.");
                const topics = await readStoredTopics();
                expect(topics.topics).not.toBeNull();

                await mutate(unfile, "DELETE", {
                    organization: true,
                    withdraw: true,
                });

                const withdrawn = await llmRendering(TRANSCRIPT);
                expect(withdrawn?.text).toContain("Schedule the next release.");
                expect(withdrawn?.fingerprint).not.toBe(
                    sharedReading.fingerprint,
                );
                expect(
                    (await gatherFacts(ITEM, "private", OWNER)).summary,
                ).toMatchObject({
                    stale: true,
                    manualRefreshOnly: true,
                    refreshRequested: false,
                });
                await advance();

                expect(await readStoredTopics()).toEqual(topics);
                expect.soft(await queuedWork()).toEqual([]);
                const [processing] = await db()
                    .select()
                    .from(itemProcessing)
                    .where(PROCESSING_SCOPE);
                expect(processing.phases.summary?.steps?.topics?.state).toBe(
                    shape === "modern" ? "done" : undefined,
                );
            }, 15_000);

            it("keeps completed work settled on a bare advance after a newer Learn release", async () => {
                await seed(shape, {
                    learnReason: "released",
                    learnGeneration: 2,
                });
                const topics = await readStoredTopics();
                await requestBareAdvance();
                expect(await readStoredTopics()).toEqual(topics);
                expect(await queuedWork()).toEqual([]);
            }, 15_000);

            it("regenerates Topics at the same transcript revision after Learn applies a correction", async () => {
                await seed(shape);
                const before = await saveCurrentReading();
                await db()
                    .insert(people)
                    .values({
                        id: "planner",
                        userId: OWNER,
                        displayName: encryptText("Alex Example"),
                    });
                await db().insert(learnRuns).values({
                    id: "correction-review",
                    userId: OWNER,
                    scopeUserId: OWNER,
                    actorUserId: OWNER,
                    itemId: ITEM,
                    transcriptionId: TRANSCRIPT,
                    view: "private",
                    trigger: "auto",
                    transcriptRevision: 0,
                    vocabularyVersion: 1,
                    status: "ready",
                });
                const [reviewItem] = await db()
                    .insert(learnReviewItems)
                    .values({
                        runId: "correction-review",
                        userId: OWNER,
                        kind: "correction",
                        fingerprintHmac: lookupHash("correction"),
                        decision: "accepted",
                        payload: encryptJsonField({
                            kind: "correct",
                            heard: "Plan",
                            target: { personId: "planner" },
                            replacement: "Alex",
                            anchors: [
                                { turnIndex: 0, charStart: 0, charEnd: 4 },
                            ],
                        }),
                    })
                    .returning({
                        id: learnReviewItems.id,
                        version: learnReviewItems.version,
                    });

                await expect(
                    finishReview(
                        await requireRecordingView(OWNER, ITEM, "private"),
                        OWNER,
                        {
                            versions: { [reviewItem.id]: reviewItem.version },
                        },
                    ),
                ).resolves.toMatchObject({ status: "finished", applied: 1 });
                expect((await readStoredTopics()).revision).toBe(0);
                expect((await llmRendering(TRANSCRIPT))?.fingerprint).not.toBe(
                    before.fingerprint,
                );
                expect(
                    (await gatherFacts(ITEM, "private", OWNER)).summary,
                ).toMatchObject({
                    stale: true,
                    manualRefreshOnly: false,
                    refreshRequested: true,
                });
                await advance("summary-input-changed");
                expect(await queuedWork()).toContain("topics");
                expect(
                    (await gatherFacts(ITEM, "private", OWNER)).summary
                        .refreshRequested,
                ).toBe(true);
            }, 15_000);

            it.each([
                [
                    "filing into an Organization folder",
                    ["private-a"],
                    file,
                    "POST",
                    { folderId: "org-a" },
                ],
                [
                    "removing one of two private folders",
                    ["private-a", "private-b"],
                    unfile,
                    "DELETE",
                    { folderId: "private-a" },
                ],
                [
                    "removing one of two Organization folders",
                    ["private-a", "org-a", "org-b"],
                    unfile,
                    "DELETE",
                    { folderId: "org-a" },
                ],
                [
                    "withdrawing from the Organization",
                    ["private-a", "org-a"],
                    unfile,
                    "DELETE",
                    { organization: true, withdraw: true },
                ],
                [
                    "moving between private folders",
                    ["private-a"],
                    move,
                    "PATCH",
                    { fromFolderId: "private-a", toFolderId: "private-b" },
                ],
                [
                    "removing the last private folder",
                    ["private-a"],
                    unfile,
                    "DELETE",
                    { folderId: "private-a" },
                ],
            ] as const)(
                "keeps completed work settled after %s",
                async (_name, folders, handler, method, body) => {
                    const pendingProposal = folders.length === 3;
                    await seed(shape, {
                        folders: [...folders],
                        pendingProposal,
                        learnReason:
                            handler === file ? "released" : "manual_finished",
                    });
                    await mutate(handler, method, body);
                    const facts = await gatherFacts(ITEM, "private", OWNER);
                    expect(facts).toMatchObject({
                        content: { ...INPUT, timed: true },
                        profile: {
                            automatic: {
                                learn: true,
                                topics: true,
                                summary: true,
                            },
                        },
                        stepAvailability: {
                            topics: "available",
                            summary: "available",
                        },
                        learnAvailability: "available",
                        summary: { manualRefreshOnly: true, stale: false },
                    });
                    await advance();
                    const [processing] = await db()
                        .select()
                        .from(itemProcessing)
                        .where(PROCESSING_SCOPE);
                    expect(processing.profileRevisionId).toBe(PROFILE_REVISION);
                    expect(processing.processedGeneration).toBe(2);
                    expect(processing.phases.summary?.inputs).toMatchObject(
                        INPUT,
                    );
                    const [summary] = await db()
                        .select({ revision: aiEnhancements.revision })
                        .from(aiEnhancements)
                        .where(
                            and(
                                eq(aiEnhancements.itemId, ITEM),
                                eq(aiEnhancements.userId, OWNER),
                            ),
                        );
                    expect(summary.revision).toBe(0);
                    const tasks = await db()
                        .select({
                            id: recordingTasks.id,
                            status: recordingTasks.status,
                        })
                        .from(recordingTasks)
                        .where(
                            and(
                                eq(recordingTasks.itemId, ITEM),
                                eq(recordingTasks.userId, OWNER),
                            ),
                        );
                    expect(tasks).toEqual(
                        pendingProposal
                            ? [{ id: "saved-proposal", status: "proposed" }]
                            : [],
                    );
                    expect.soft(await queuedWork()).toEqual([]);
                    expect
                        .soft(processing.phases.summary)
                        .toMatchObject({ state: "done", reason: "completed" });
                },
                15_000,
            );
        });

        it.each([
            ["partial phase", "partial", {}],
            [
                "legacy phase with a newer Learn release",
                "legacy",
                { learnReason: "released", learnGeneration: 2 },
            ],
        ] as const)(
            "keeps stored Topics on private filing for a %s",
            async (_name, shape, options) => {
                await seed(shape, options);
                const topics = await readStoredTopics();
                await mutate(file, "POST", { folderId: "private-b" });
                await advance();
                expect(await readStoredTopics()).toEqual(topics);
                expect(await queuedWork()).toEqual([]);
            },
            15_000,
        );

        it("keeps stored Topics on a bare advance without persisting an inferred Topics step", async () => {
            await seed("legacy");
            await db()
                .update(aiEnhancements)
                .set({
                    inputs: {
                        ...INPUT,
                        itemProfileRevisionId: PROFILE_REVISION,
                    },
                })
                .where(
                    and(
                        eq(aiEnhancements.userId, OWNER),
                        eq(aiEnhancements.itemId, ITEM),
                    ),
                );
            await requestBareAdvance();
            const [processing] = await db()
                .select()
                .from(itemProcessing)
                .where(PROCESSING_SCOPE);
            expect(processing.phases.summary?.steps?.summary?.state).toBe(
                "done",
            );
            expect
                .soft(processing.phases.summary?.steps?.topics)
                .toBeUndefined();
            expect.soft(await queuedWork()).toEqual([]);
        }, 15_000);

        it("retries missing Topics after a newer Learn release despite an older fulfilled refresh", async () => {
            await seed("modern", {
                hasTopics: false,
                learnReason: "released",
                learnGeneration: 3,
            });
            await recordFulfilledRefresh("categorized");
            const [processing] = await db()
                .select()
                .from(itemProcessing)
                .where(PROCESSING_SCOPE);
            const summary = processing.phases.summary;
            if (!summary) throw new Error("expected a Summary phase");
            await db()
                .update(itemProcessing)
                .set({
                    phases: {
                        ...processing.phases,
                        summary: {
                            ...summary,
                            state: "failed",
                            generation: 2,
                            steps: {
                                ...summary.steps,
                                topics: {
                                    ...INPUT,
                                    generation: 2,
                                    state: "failed",
                                    reason: "provider_failed",
                                },
                            },
                        },
                    },
                })
                .where(PROCESSING_SCOPE);
            expect((await readStoredTopics()).topics).toBeNull();
            expect(
                (await gatherFacts(ITEM, "private", OWNER)).summary
                    .refreshRequested,
            ).toBe(false);
            await requestBareAdvance();
            expect(await queuedWork()).toEqual(["topics"]);
        }, 15_000);

        it.each([
            [
                "the transcript revision changed",
                { transcriptRevision: 1, automaticLearn: false },
            ],
            ["stored topics are missing", { hasTopics: false }],
        ] as const)(
            "queues Topics for a legacy phase when %s",
            async (_name, options) => {
                await seed("legacy", options);
                await mutate(file, "POST", { folderId: "private-b" });
                await advance();
                expect(await queuedWork()).toEqual(["topics"]);
            },
            15_000,
        );

        it("queues Topics for a legacy phase on explicit Process again", async () => {
            await seed("legacy", { automaticLearn: false });
            await mutate(processAgain, "POST", {}, "process-again");
            await advance("process-again");
            expect(await queuedWork()).toContain("topics");
        }, 15_000);
    },
);
