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
    chatterItems,
    folderShares,
    itemProcessing,
    learnReviewItems,
    learnRuns,
    mailContents,
    mailMessages,
    people,
    processingProfileRevisions,
    processingProfiles,
    recordingFolders,
    recordingTasks,
    restrictedFolderMembers,
    taskMentions,
    transcriptCorrectionPasses,
    transcriptCorrections,
    transcriptions,
    transcriptSpeakers,
    users,
} from "@/db/schema";
import { encrypt } from "@/lib/encryption";
import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { localActor } from "@/tests/helpers/session-actor";
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
    return {
        dbRef: ref,
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
const modelHooks = vi.hoisted(() => ({ beforeReply: vi.fn(), reply: vi.fn() }));

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({
    env: {
        IS_HOSTED: false,
        SELF_HOST_MODE: "shared",
        ORG_ACCOUNT_EMAIL: "org@example.test",
        ORG_ACCOUNT_PASSWORD: "test-password",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        BETTER_AUTH_SECRET: "filing-summary-test-secret",
        DATABASE_URL: "postgres://unused",
        AUTO_SUMMARY_RATE_LIMIT_PER_HOUR: 20,
    },
}));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async (request: Request) => ({
        user: { id: request.headers.get("x-test-user") ?? "filing-owner" },
    }),
    requireApiSessionActor: async (request: Request) => {
        const id = request.headers.get("x-test-user") ?? "filing-owner";
        return {
            session: { user: { id } },
            actor: localActor(id),
            authTime: null,
        };
    },
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));

import { POST as categorize } from "@/app/api/recordings/[id]/categorize/route";
import {
    POST as file,
    PATCH as move,
    DELETE as unfile,
} from "@/app/api/recordings/[id]/folders/route";
import { POST as processAgain } from "@/app/api/recordings/[id]/process-again/route";
import { GET as getSummary } from "@/app/api/recordings/[id]/summary/route";
import { enqueueJob } from "@/db/queries/async-jobs";
import { acceptCorrection } from "@/lib/knowledge/corrections";
import { correctionPassJobHandler } from "@/lib/learn/correction-pass-job";
import { llmRendering } from "@/lib/learn/llm-input";
import { finishReview } from "@/lib/learn/review";
import { summaryRefreshDue } from "@/lib/learn/summary-refresh";
import { pipelineAdvanceJobHandler } from "@/lib/pipeline/advance-job";
import { requestArrivalInTx } from "@/lib/pipeline/arrival";
import { executePipelineAction } from "@/lib/pipeline/execute";
import { gatherFacts } from "@/lib/pipeline/facts";
import { planAdvance } from "@/lib/pipeline/plan";
import { loadPrivateItemProcessing } from "@/lib/pipeline/presentation";
import { itemScopeFingerprint } from "@/lib/pipeline/scope-fingerprint";
import { markLearnReleasedInTx, updatePhaseInTx } from "@/lib/pipeline/state";
import { requestAdvanceInTx } from "@/lib/pipeline/trigger";
import type { PhaseRecord } from "@/lib/pipeline/types";
import { deriveWorkflowWidgets } from "@/lib/pipeline/workflow-widgets";
import { defaultProfileSettings } from "@/lib/profiles/settings";
import { requireRecordingView } from "@/lib/sharing/access";
import { queueAutoSummary } from "@/lib/summary/auto-summary";
import { generateSummaryForRecording } from "@/lib/summary/generate-summary";
import {
    authorizeSummaryReplacementInTx,
    mayAutomaticallyReplaceSummary,
} from "@/lib/summary/replacement";
import { summaryJobHandler } from "@/lib/summary/summary-job-handler";
import {
    applyPlaudActionItemProposals,
    plaudActionItemsFingerprint,
} from "@/lib/tasks/plaud-proposals";
import { taskFingerprint } from "@/lib/tasks/proposals";
import { writeTaskProposalsInTx } from "@/lib/tasks/store";
import { listRecordingTasks } from "@/lib/tasks/tasks";
import {
    upsertEnhancement,
    upsertTranscription,
} from "@/lib/transcription/persist";

vi.mock("openai", () => ({
    OpenAI: class {
        chat = {
            completions: {
                create: vi.fn(async () => {
                    await modelHooks.beforeReply();
                    return {
                        choices: [
                            {
                                message: {
                                    content: JSON.stringify(modelHooks.reply()),
                                },
                            },
                        ],
                        usage: { prompt_tokens: 1, completion_tokens: 1 },
                    };
                }),
            },
        };
    },
}));

const OWNER = "filing-owner";
const MEMBER = "filing-member";
const ORG = "filing-org";
const ITEM = "filing-item";
const CONTENT = "filing-content";
const testDatabaseUrl = getTestDatabaseUrl();

function request(
    path: string,
    method = "GET",
    body?: object,
    userId = OWNER,
    view = "private",
) {
    return new Request(
        `http://localhost/api/recordings/${ITEM}/${path}${path.includes("?") ? "&" : "?"}view=${view}`,
        {
            method,
            headers: {
                "content-type": "application/json",
                "x-test-user": userId,
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
        },
    );
}

function context() {
    return { params: Promise.resolve({ id: ITEM }) };
}

async function mutate(
    handler: typeof file,
    method: string,
    body: object,
    path = "folders",
) {
    const response = await handler(request(path, method, body), context());
    expect(response.status, JSON.stringify(await response.json())).toBe(200);
}

(testDatabaseUrl ? describe : describe.skip)(
    "#395 saved results survive filing (PostgreSQL)",
    () => {
        let database: TestPostgresDatabase;
        function db() {
            return database.db;
        }

        beforeAll(async () => {
            database = await createMigratedTestDatabase(
                testDatabaseUrl ?? "",
                "395_summary_filing",
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

        describe.each(["audio", "mail"] as const)("%s", (kind) => {
            beforeEach(async () => {
                modelHooks.beforeReply.mockReset();
                modelHooks.reply.mockReset().mockReturnValue({
                    summary: "Unwanted replacement",
                    keyPoints: [],
                    actionItems: [],
                });
                await db().delete(users);
                await db()
                    .insert(users)
                    .values([
                        { id: OWNER, email: "owner@example.test" },
                        { id: MEMBER, email: "member@example.test" },
                        { id: ORG, email: "org@example.test", role: "org" },
                    ]);
                for (const [id, userId, parentId, folderKind] of [
                    ["private-root", OWNER, null, "private"],
                    ["private-a", OWNER, "private-root", "custom"],
                    ["private-b", OWNER, "private-root", "custom"],
                    ["org-root", ORG, null, "public"],
                    ["org-a", ORG, "org-root", "custom"],
                    ["org-b", ORG, "org-root", "custom"],
                    ["restricted", ORG, "org-root", "custom"],
                ] as const) {
                    await db()
                        .insert(recordingFolders)
                        .values({
                            id,
                            userId,
                            parentId,
                            kind: folderKind,
                            name: encryptText(id),
                            nameHash: lookupHash(id),
                            ...(id === "restricted"
                                ? { restrictedAt: new Date() }
                                : {}),
                        });
                }
                await db().insert(restrictedFolderMembers).values({
                    folderId: "restricted",
                    userId: OWNER,
                    role: "manager",
                    addedByUserId: OWNER,
                });
                await db()
                    .insert(apiCredentials)
                    .values({
                        userId: OWNER,
                        provider: "openai",
                        apiKey: encrypt("test-key"),
                        defaultModel: "test-model",
                        isDefaultEnhancement: true,
                    });
                const settings = defaultProfileSettings(kind);
                settings.steps.learn.automatic = false;
                settings.steps.summary.automatic = true;
                settings.steps.title.automatic = false;
                if ("trim" in settings.steps) {
                    settings.steps.trim.automatic = false;
                    settings.steps.topics.automatic = false;
                }
                await db()
                    .insert(processingProfiles)
                    .values({
                        id: "profile",
                        ownerUserId: OWNER,
                        scope: "personal",
                        channel: kind,
                        name: encryptText("Notes"),
                        currentRevisionId: "profile-revision",
                        isDefault: true,
                        createdBy: OWNER,
                        updatedBy: OWNER,
                    });
                await db()
                    .insert(processingProfileRevisions)
                    .values({
                        id: "profile-revision",
                        profileId: "profile",
                        createdBy: OWNER,
                        settings: encryptText(JSON.stringify(settings)),
                    });
                await db()
                    .insert(processingProfiles)
                    .values({
                        id: "org-profile",
                        ownerUserId: ORG,
                        scope: "organization",
                        channel: kind,
                        name: encryptText("Organization notes"),
                        currentRevisionId: "org-revision",
                        isDefault: true,
                        createdBy: ORG,
                        updatedBy: ORG,
                    });
                await db()
                    .insert(processingProfileRevisions)
                    .values({
                        id: "org-revision",
                        profileId: "org-profile",
                        createdBy: ORG,
                        settings: encryptText(JSON.stringify(settings)),
                    });
                if (kind === "audio") {
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
                        .insert(transcriptions)
                        .values({
                            id: CONTENT,
                            recordingId: ITEM,
                            userId: OWNER,
                            text: encryptText("Plan the next release."),
                            source: "riffado",
                            provider: "test",
                            model: "test",
                        });
                } else {
                    await db()
                        .insert(chatterItems)
                        .values({
                            id: ITEM,
                            userId: OWNER,
                            kind,
                            title: encryptText("Planning"),
                            occurredAt: new Date(0),
                        });
                    await db()
                        .insert(mailMessages)
                        .values({
                            id: ITEM,
                            userId: OWNER,
                            rawHash: "0".repeat(64),
                            receivedAt: new Date(0),
                            sizeBytes: 10,
                            auth: {},
                            senderVerified: true,
                        });
                    await db()
                        .insert(mailContents)
                        .values({
                            id: CONTENT,
                            itemId: ITEM,
                            userId: OWNER,
                            parserVersion: 1,
                            segments: encryptJsonField([
                                {
                                    index: 0,
                                    role: "body",
                                    depth: 0,
                                    participantRef: null,
                                    at: null,
                                    knownItemId: null,
                                    text: "Plan the next release.",
                                },
                            ]),
                        });
                }
                await mutate(
                    categorize,
                    "POST",
                    {
                        folderIds: ["private-a"],
                    },
                    "categorize",
                );
                const inputs = {
                    contentId: CONTENT,
                    contentSourceId: kind === "mail" ? "mail" : "riffado",
                    contentRevision: 0,
                };
                await db()
                    .insert(aiEnhancements)
                    .values({
                        id: "saved-summary",
                        itemId: ITEM,
                        userId: OWNER,
                        transcriptionId: kind === "audio" ? CONTENT : null,
                        source: "riffado",
                        provider: "test",
                        model: "test",
                        summary: encryptText("Existing summary"),
                        keyPoints: encryptJsonField(["Keep the release small"]),
                        actionItems: encryptJsonField([
                            "Prepare release notes",
                        ]),
                        inputs: {
                            ...inputs,
                            itemProfileRevisionId: "profile-revision",
                            scopeFingerprint: await itemScopeFingerprint(
                                ITEM,
                                "private",
                                OWNER,
                            ),
                        },
                    });
                await db()
                    .update(itemProcessing)
                    .set({
                        phases: {
                            categorize: {
                                state: "done",
                                reason: "categorized",
                                generation: 1,
                                at: new Date().toISOString(),
                                profileChoice: "placement",
                            },
                            learn: {
                                state: "skipped",
                                reason: "profile_off",
                                generation: 1,
                                at: new Date().toISOString(),
                                inputs,
                            },
                            summary: {
                                state: "done",
                                reason: "completed",
                                generation: 1,
                                at: new Date().toISOString(),
                                inputs,
                                steps: {
                                    summary: {
                                        ...inputs,
                                        state: "done",
                                        generation: 1,
                                    },
                                },
                            },
                        },
                    })
                    .where(
                        and(
                            eq(itemProcessing.itemId, ITEM),
                            eq(itemProcessing.userId, OWNER),
                        ),
                    );
                await db()
                    .insert(recordingTasks)
                    .values({
                        id: "saved-task",
                        itemId: ITEM,
                        userId: OWNER,
                        text: encryptText("Prepare release notes"),
                        status: "open",
                        source: "riffado",
                        acceptedAt: new Date(),
                    });
            });

            async function advance() {
                await pipelineAdvanceJobHandler.run({
                    jobId: "test-driver",
                    userId: OWNER,
                    attempt: 1,
                    maxAttempts: 10,
                    payload: {
                        itemId: ITEM,
                        view: "private",
                        reason: "placement",
                    },
                    signal: new AbortController().signal,
                    reportProgress: vi.fn(),
                });
            }

            async function assertVisible(
                userId = OWNER,
                view: "private" | "org" | "received" = "private",
                source: "riffado" | "plaud" = "riffado",
            ) {
                const response = await getSummary(
                    request(
                        `summary?source=${source}`,
                        "GET",
                        undefined,
                        userId,
                        view,
                    ),
                    context(),
                );
                expect(response.status).toBe(200);
                expect(await response.json()).toMatchObject({
                    summary: "Existing summary",
                    keyPoints: ["Keep the release small"],
                    actionItems: ["Prepare release notes"],
                });
                const tasks = await listRecordingTasks(
                    {
                        userId,
                        emailHash: lookupHash(
                            userId === OWNER
                                ? "owner@example.test"
                                : "member@example.test",
                        ),
                        orgUserId: ORG,
                        isOrg: false,
                        isCurator: false,
                        includeReceived: true,
                    },
                    ITEM,
                );
                expect(tasks?.tasks).toEqual(
                    expect.arrayContaining([
                        expect.objectContaining({
                            id: "saved-task",
                            text: "Prepare release notes",
                        }),
                    ]),
                );
                const processing = await loadPrivateItemProcessing(
                    OWNER,
                    ITEM,
                    userId,
                    "en",
                    view === "org" ? "org" : "private",
                );
                expect(processing).not.toBeNull();
                if (processing) {
                    expect(
                        deriveWorkflowWidgets(processing).summary.visible,
                    ).toBe(true);
                    expect(processing.outputs.summary).toBe(true);
                }
                expect(
                    await db()
                        .select()
                        .from(aiEnhancements)
                        .where(eq(aiEnhancements.itemId, ITEM)),
                ).toHaveLength(1);
                expect(
                    await db()
                        .select()
                        .from(asyncJobs)
                        .where(
                            and(
                                eq(asyncJobs.userId, OWNER),
                                eq(asyncJobs.kind, "summary"),
                            ),
                        ),
                ).toHaveLength(0);
            }

            const reviewer = {
                userId: OWNER,
                emailHash: lookupHash("owner@example.test"),
                orgUserId: ORG,
                isOrg: false,
                isCurator: false,
            };

            function lateResult() {
                return {
                    recordingId: ITEM,
                    userId: OWNER,
                    kind,
                    source: "riffado" as const,
                    summary: "Unwanted replacement",
                    keyPoints: [],
                    actionItems: [],
                    provider: "test",
                    model: "test",
                    transcriptionId: kind === "audio" ? CONTENT : null,
                    expectedSummaryId: "saved-summary",
                    expectedSummaryRevision: 0,
                    inputs: {
                        contentId: CONTENT,
                        contentRevision: 0,
                        contentSourceId: kind === "audio" ? "riffado" : "mail",
                        itemProfileRevisionId: "profile-revision",
                    },
                    tasks: {
                        reviewer,
                        fingerprintOf: taskFingerprint,
                        source: "riffado" as const,
                        tasks: [],
                        matches: [],
                        updates: [],
                    },
                };
            }

            async function pendingTask(
                source: "riffado" | "plaud" = "riffado",
            ) {
                await db().transaction((tx) =>
                    writeTaskProposalsInTx(tx, {
                        recordingId: ITEM,
                        ownerUserId: OWNER,
                        actorUserId: OWNER,
                        view: "private",
                        contentSourceId: kind === "audio" ? "riffado" : "mail",
                        contentRevision: 0,
                        proposals: {
                            reviewer,
                            fingerprintOf: taskFingerprint,
                            source,
                            matches: [],
                            updates: [],
                            tasks: [
                                {
                                    text: "Review the draft",
                                    fingerprint:
                                        taskFingerprint("Review the draft"),
                                    assigneePersonId: null,
                                    assigneeHint: null,
                                    assigneeCheck: false,
                                    dueDate: null,
                                    duePhrase: null,
                                    quote: null,
                                    evidenceStartMs: null,
                                },
                            ],
                        },
                    }),
                );
                return db()
                    .select()
                    .from(recordingTasks)
                    .where(eq(recordingTasks.itemId, ITEM));
            }

            async function settleTrim() {
                const [row] = await db()
                    .select()
                    .from(itemProcessing)
                    .where(eq(itemProcessing.itemId, ITEM));
                await db()
                    .update(itemProcessing)
                    .set({
                        phases: {
                            ...row.phases,
                            trim: {
                                state: "skipped",
                                reason: "profile_off",
                                generation: row.requestedGeneration,
                                at: new Date().toISOString(),
                            },
                        },
                    })
                    .where(eq(itemProcessing.itemId, ITEM));
            }

            it("refuses automatic enqueue after filing, including a resumed planner action", async () => {
                await mutate(file, "POST", { folderId: "private-b" });
                await queueAutoSummary(OWNER, ITEM, null, { strict: true });
                await executePipelineAction({
                    itemId: ITEM,
                    userId: OWNER,
                    view: "private",
                    generation: 1,
                    action: {
                        type: "queueSummary",
                        presetId: null,
                        strict: true,
                    },
                });
                await assertVisible();
            }, 15_000);

            it.each([
                "pending",
                "processing",
            ] as const)("rejects an automatic job %s across filing and preserves pending proposals", async (status) => {
                const tasks = await pendingTask();
                const { job } = await enqueueJob({
                    userId: OWNER,
                    kind: "summary",
                    subjectId: ITEM,
                    payload: { recordingId: ITEM, trigger: "auto" },
                });
                await db()
                    .update(asyncJobs)
                    .set({ status })
                    .where(eq(asyncJobs.id, job.id));
                await mutate(file, "POST", { folderId: "private-b" });
                await expect(
                    summaryJobHandler.run({
                        jobId: job.id,
                        userId: OWNER,
                        attempt: 1,
                        maxAttempts: 3,
                        payload: { recordingId: ITEM, trigger: "auto" },
                        signal: new AbortController().signal,
                        reportProgress: vi.fn(),
                    }),
                ).resolves.toMatchObject({ skipped: "outdated" });
                await db()
                    .update(asyncJobs)
                    .set({ status: "processing" })
                    .where(eq(asyncJobs.id, job.id));
                await expect(
                    upsertEnhancement({ ...lateResult(), jobId: job.id }),
                ).resolves.toMatchObject({
                    committed: false,
                    reason: "outdated",
                });
                expect(
                    await db()
                        .select()
                        .from(recordingTasks)
                        .where(eq(recordingTasks.itemId, ITEM)),
                ).toEqual(tasks);
                await db().delete(asyncJobs).where(eq(asyncJobs.id, job.id));
                await advance();
                await assertVisible();
            }, 15_000);

            it("fences a late automatic commit without a job binding", async () => {
                const tasks = await pendingTask();
                await mutate(file, "POST", { folderId: "private-b" });
                await expect(
                    upsertEnhancement(lateResult()),
                ).resolves.toMatchObject({
                    committed: false,
                    reason: "outdated",
                });
                expect(
                    await db()
                        .select()
                        .from(recordingTasks)
                        .where(eq(recordingTasks.itemId, ITEM)),
                ).toEqual(tasks);
                await assertVisible();
            }, 15_000);

            it.runIf(kind === "audio")(
                "refuses correction refresh after publication cancels pending Learn",
                async () => {
                    const rendering = await pendingRendering();
                    await db()
                        .update(aiEnhancements)
                        .set({ inputFingerprint: rendering?.fingerprint })
                        .where(eq(aiEnhancements.id, "saved-summary"));
                    await mutate(file, "POST", { folderId: "org-a" });
                    await mutate(unfile, "DELETE", {
                        organization: true,
                        withdraw: true,
                    });
                    await expect(
                        summaryRefreshDue({
                            ownerUserId: OWNER,
                            recordingId: ITEM,
                            view: "private",
                        }),
                    ).resolves.toBeNull();
                    await assertVisible();
                },
                15_000,
            );

            it.runIf(kind === "audio").each([false, true])(
                "keeps a correction accepted during generation pending until a fresh run succeeds (saved summary: %s)",
                async (savedSummary) => {
                    const tasks = await pendingTask();
                    await db()
                        .update(transcriptions)
                        .set({
                            turns: encryptJsonField([
                                {
                                    speaker: "speaker_0",
                                    startMs: 0,
                                    endMs: 1000,
                                    text: "Plan the next release.",
                                },
                            ]),
                        })
                        .where(eq(transcriptions.id, CONTENT));
                    await db()
                        .insert(people)
                        .values({
                            id: "planner",
                            userId: OWNER,
                            displayName: encryptText("Alex Example"),
                        });
                    if (!savedSummary) await db().delete(aiEnhancements);
                    modelHooks.beforeReply.mockImplementationOnce(() =>
                        acceptCorrection({
                            userId: OWNER,
                            actorUserId: OWNER,
                            orgUserId: ORG,
                            transcriptionId: CONTENT,
                            revision: 0,
                            kind: "correct",
                            target: { personId: "planner" },
                            replacement: "Alex",
                            anchor: {
                                turnIndex: 0,
                                charStart: 0,
                                charEnd: 4,
                                heard: "Plan",
                            },
                        }),
                    );
                    await expect(
                        generateSummaryForRecording(OWNER, ITEM, {
                            trigger: "manual",
                        }),
                    ).resolves.toMatchObject({ committed: false });
                    expect(
                        await db()
                            .select()
                            .from(recordingTasks)
                            .where(eq(recordingTasks.itemId, ITEM)),
                    ).toEqual(tasks);
                    const [unchanged] = await db()
                        .select()
                        .from(aiEnhancements);
                    expect(unchanged?.revision).toBe(
                        savedSummary ? 0 : undefined,
                    );
                    await expect(
                        generateSummaryForRecording(OWNER, ITEM, {
                            trigger: "auto",
                        }),
                    ).resolves.toMatchObject({ committed: true });
                    const [replacement] = await db()
                        .select()
                        .from(aiEnhancements);
                    expect(replacement.revision).toBe(savedSummary ? 1 : 0);
                    expect(replacement.inputFingerprint).toBe(
                        (await llmRendering(CONTENT))?.fingerprint,
                    );
                    expect(
                        (await gatherFacts(ITEM, "private", OWNER)).summary
                            .manualRefreshOnly,
                    ).toBe(true);
                },
                15_000,
            );

            it("retains a newer Process again request made during generation", async () => {
                await mutate(file, "POST", { folderId: "private-b" });
                await settleTrim();
                await mutate(processAgain, "POST", {}, "process-again");
                modelHooks.beforeReply.mockImplementationOnce(() =>
                    mutate(processAgain, "POST", {}, "process-again"),
                );
                await expect(
                    generateSummaryForRecording(OWNER, ITEM, {
                        trigger: "auto",
                    }),
                ).resolves.toMatchObject({ committed: false });
                expect(
                    (await gatherFacts(ITEM, "private", OWNER)).summary
                        .refreshRequested,
                ).toBe(true);
                await expect(
                    generateSummaryForRecording(OWNER, ITEM, {
                        trigger: "auto",
                    }),
                ).resolves.toMatchObject({ committed: true });
                expect(
                    (await gatherFacts(ITEM, "private", OWNER)).summary
                        .manualRefreshOnly,
                ).toBe(true);
            }, 15_000);

            it.runIf(kind === "audio").each([false, true])(
                "retains legacy incomplete inputs with transcript provenance across pending Learn cancellation (partial: %s)",
                async (partial) => {
                    const rendering = await pendingRendering();
                    await db()
                        .update(aiEnhancements)
                        .set({
                            inputs: partial
                                ? { scopeFingerprint: "legacy" }
                                : null,
                            inputFingerprint: rendering?.fingerprint,
                        })
                        .where(eq(aiEnhancements.id, "saved-summary"));
                    await mutate(file, "POST", { folderId: "org-a" });
                    await advance();
                    await advance();
                    await assertVisible();
                },
                15_000,
            );

            it.runIf(kind === "audio")(
                "retains a pre-upgrade summary with the same scope fingerprint and no placement marker",
                async () => {
                    const rendering = await pendingRendering();
                    await mutate(
                        categorize,
                        "POST",
                        { folderIds: ["org-a"] },
                        "categorize",
                    );
                    const [saved] = await db()
                        .select()
                        .from(aiEnhancements)
                        .where(eq(aiEnhancements.id, "saved-summary"));
                    await db()
                        .update(aiEnhancements)
                        .set({
                            inputFingerprint: rendering?.fingerprint,
                            inputs: {
                                ...saved.inputs,
                                scopeFingerprint: await itemScopeFingerprint(
                                    ITEM,
                                    "private",
                                    OWNER,
                                ),
                            },
                        })
                        .where(eq(aiEnhancements.id, "saved-summary"));
                    await mutate(file, "POST", { folderId: "org-a" });
                    const [row] = await db()
                        .select()
                        .from(itemProcessing)
                        .where(eq(itemProcessing.itemId, ITEM));
                    const categorizePhase = { ...row.phases.categorize };
                    Reflect.deleteProperty(categorizePhase, "placementSummary");
                    await db()
                        .update(itemProcessing)
                        .set({
                            phases: {
                                ...row.phases,
                                categorize: categorizePhase as PhaseRecord,
                            },
                        })
                        .where(eq(itemProcessing.itemId, ITEM));
                    await advance();
                    await advance();
                    await assertVisible();
                    expect(
                        (
                            await (
                                await getSummary(request("summary"), context())
                            ).json()
                        ).scopeChanged,
                    ).toBe(false);
                },
                15_000,
            );

            it.each([
                false,
                true,
            ])("keeps Process again authorization through provider recovery (return to original scope: %s)", async (returnToOriginal) => {
                await mutate(file, "POST", { folderId: "private-b" });
                if (returnToOriginal)
                    await mutate(unfile, "DELETE", { folderId: "private-b" });
                await settleTrim();
                await mutate(processAgain, "POST", {}, "process-again");
                const [credential] = await db()
                    .select()
                    .from(apiCredentials)
                    .where(eq(apiCredentials.userId, OWNER));
                await db()
                    .delete(apiCredentials)
                    .where(eq(apiCredentials.userId, OWNER));
                await advance();
                await advance();
                const skipped = await gatherFacts(ITEM, "private", OWNER);
                expect(skipped.phases.summary?.steps?.summary).toMatchObject({
                    state: "skipped",
                    reason: "no_provider",
                });
                await db().insert(apiCredentials).values(credential);
                await advance();
                const jobs = await db()
                    .select()
                    .from(asyncJobs)
                    .where(
                        and(
                            eq(asyncJobs.kind, "summary"),
                            eq(asyncJobs.userId, OWNER),
                        ),
                    );
                expect(jobs).toHaveLength(1);
                await db()
                    .update(asyncJobs)
                    .set({ status: "processing" })
                    .where(eq(asyncJobs.id, jobs[0].id));
                await expect(
                    upsertEnhancement({
                        ...lateResult(),
                        jobId: jobs[0].id,
                        summary: "Existing summary",
                        keyPoints: ["Keep the release small"],
                        actionItems: ["Prepare release notes"],
                        tasks: undefined,
                    }),
                ).resolves.toMatchObject({
                    committed: true,
                    summaryVersion: { id: "saved-summary", revision: 1 },
                });
                await db()
                    .delete(asyncJobs)
                    .where(eq(asyncJobs.id, jobs[0].id));
                expect(
                    (await gatherFacts(ITEM, "private", OWNER)).summary
                        .manualRefreshOnly,
                ).toBe(true);
                await queueAutoSummary(OWNER, ITEM, null, { strict: true });
                await assertVisible();
            }, 15_000);

            it.each([
                "lost",
                "provider_failed",
            ])("retains explicit refresh authorization after a %s job", async (reason) => {
                await mutate(file, "POST", { folderId: "private-b" });
                await settleTrim();
                await mutate(processAgain, "POST", {}, "process-again");
                await advance();
                const [job] = await db()
                    .select()
                    .from(asyncJobs)
                    .where(
                        and(
                            eq(asyncJobs.kind, "summary"),
                            eq(asyncJobs.userId, OWNER),
                        ),
                    );
                expect(job).toBeDefined();
                await db()
                    .update(asyncJobs)
                    .set({
                        status: "failed",
                        errorCode: reason,
                        completedAt: new Date(),
                    })
                    .where(eq(asyncJobs.id, job.id));
                const [row] = await db()
                    .select()
                    .from(itemProcessing)
                    .where(eq(itemProcessing.itemId, ITEM));
                const summaryPhase = row.phases.summary;
                if (!summaryPhase?.steps?.summary)
                    throw new Error("expected queued summary step");
                await db()
                    .update(itemProcessing)
                    .set({
                        phases: {
                            ...row.phases,
                            summary: {
                                ...summaryPhase,
                                state: "failed",
                                steps: {
                                    ...summaryPhase.steps,
                                    summary: {
                                        ...summaryPhase.steps.summary,
                                        jobId: undefined,
                                        state: "failed",
                                        reason,
                                    },
                                },
                            },
                        },
                    })
                    .where(eq(itemProcessing.itemId, ITEM));
                expect(
                    (await gatherFacts(ITEM, "private", OWNER)).summary
                        .manualRefreshOnly,
                ).toBe(false);
                await mutate(processAgain, "POST", {}, "process-again");
                await advance();
                expect(
                    await db()
                        .select()
                        .from(asyncJobs)
                        .where(
                            and(
                                eq(asyncJobs.kind, "summary"),
                                eq(asyncJobs.status, "pending"),
                            ),
                        ),
                ).toHaveLength(1);
            }, 15_000);

            it.runIf(kind === "audio")(
                "preserves results across a planner/phase-write barrier and return to the original scope",
                async () => {
                    const rendering = await pendingRendering();
                    await db()
                        .update(aiEnhancements)
                        .set({ inputFingerprint: rendering?.fingerprint })
                        .where(eq(aiEnhancements.id, "saved-summary"));
                    await mutate(unfile, "DELETE", { folderId: "private-a" });
                    const [before] = await db()
                        .select()
                        .from(itemProcessing)
                        .where(eq(itemProcessing.itemId, ITEM));
                    const unplaced = { ...before.phases.categorize };
                    Reflect.deleteProperty(unplaced, "placementSummary");
                    await db()
                        .update(itemProcessing)
                        .set({
                            phases: {
                                ...before.phases,
                                categorize: unplaced as PhaseRecord,
                            },
                        })
                        .where(eq(itemProcessing.itemId, ITEM));
                    let release: () => void = () => {};
                    let planned: () => void = () => {};
                    const barrier = new Promise<void>((resolve) => {
                        release = resolve;
                    });
                    const ready = new Promise<void>((resolve) => {
                        planned = resolve;
                    });
                    const worker = (async () => {
                        const facts = await gatherFacts(ITEM, "private", OWNER);
                        const action = planAdvance(facts).actions.find(
                            (a) =>
                                a.type === "markPhase" &&
                                a.phase === "categorize",
                        );
                        if (!action)
                            throw new Error(
                                "expected pending categorization action",
                            );
                        planned();
                        await barrier;
                        await executePipelineAction({
                            itemId: ITEM,
                            userId: OWNER,
                            view: "private",
                            generation: facts.generation,
                            action,
                        });
                    })();
                    await ready;
                    try {
                        await mutate(file, "POST", { folderId: "org-a" });
                        await mutate(unfile, "DELETE", {
                            organization: true,
                            withdraw: true,
                        });
                        await mutate(file, "POST", { folderId: "private-a" });
                    } finally {
                        release();
                        await worker;
                    }
                    await advance();
                    await advance();
                    await assertVisible();
                },
                15_000,
            );

            async function summaryJobs() {
                return db()
                    .select()
                    .from(asyncJobs)
                    .where(
                        and(
                            eq(asyncJobs.kind, "summary"),
                            eq(asyncJobs.userId, OWNER),
                        ),
                    );
            }

            async function runAutomaticSummary() {
                await advance();
                const jobs = await summaryJobs();
                expect(jobs).toHaveLength(1);
                const job = jobs[0];
                await db()
                    .update(asyncJobs)
                    .set({ status: "processing" })
                    .where(eq(asyncJobs.id, job.id));
                await expect(
                    summaryJobHandler.run({
                        jobId: job.id,
                        userId: OWNER,
                        attempt: 1,
                        maxAttempts: 3,
                        payload: summaryJobHandler.parsePayload(job.payload),
                        signal: new AbortController().signal,
                        reportProgress: vi.fn(),
                    }),
                ).resolves.toMatchObject({ outcome: { kind: "done" } });
                await db().delete(asyncJobs).where(eq(asyncJobs.id, job.id));
            }

            async function finishPendingReview(quick: boolean) {
                const rows = await db()
                    .select()
                    .from(learnReviewItems)
                    .where(eq(learnReviewItems.runId, "private-review"));
                return finishReview(
                    await requireRecordingView(OWNER, ITEM, "private"),
                    OWNER,
                    {
                        quick,
                        versions: Object.fromEntries(
                            rows.map((row) => [row.id, row.version]),
                        ),
                    },
                );
            }

            it("preserves newer refresh authorization across a stale categorize write", async () => {
                expect(await mayAutomaticallyReplaceSummary(OWNER, ITEM)).toBe(
                    false,
                );
                const [before] = await db()
                    .select()
                    .from(itemProcessing)
                    .where(eq(itemProcessing.itemId, ITEM));
                const stale = before.phases.categorize;
                if (!stale) throw new Error("expected categorize phase");
                await db().transaction(async (tx) => {
                    await authorizeSummaryReplacementInTx(tx, {
                        itemId: ITEM,
                        userId: OWNER,
                        generation: 99,
                    });
                    await updatePhaseInTx(
                        tx,
                        ITEM,
                        "private",
                        OWNER,
                        "categorize",
                        stale,
                    );
                    expect(
                        await mayAutomaticallyReplaceSummary(OWNER, ITEM, tx),
                    ).toBe(true);
                    expect(
                        await mayAutomaticallyReplaceSummary(OWNER, ITEM),
                    ).toBe(false);
                });
                expect(await mayAutomaticallyReplaceSummary(OWNER, ITEM)).toBe(
                    true,
                );
                const [after] = await db()
                    .select()
                    .from(itemProcessing)
                    .where(eq(itemProcessing.itemId, ITEM));
                expect(after.phases.categorize?.summaryRefresh).toEqual({
                    id: "saved-summary",
                    revision: 0,
                    generation: 99,
                });
            });

            it.runIf(kind === "audio").each([false, true])(
                "generates the first custom summary and task proposals for an imported Plaud arrival (Learn released: %s)",
                async (released) => {
                    await db().delete(aiEnhancements);
                    await db()
                        .delete(itemProcessing)
                        .where(eq(itemProcessing.itemId, ITEM));
                    await db()
                        .update(transcriptions)
                        .set({ source: "plaud" })
                        .where(eq(transcriptions.id, CONTENT));
                    await db().transaction((tx) =>
                        requestArrivalInTx(tx, {
                            itemId: ITEM,
                            userId: OWNER,
                            canCurate: false,
                        }),
                    );
                    await upsertEnhancement({
                        userId: OWNER,
                        recordingId: ITEM,
                        transcriptionId: CONTENT,
                        source: "plaud",
                        provider: "plaud",
                        model: "plaud-native",
                        summary: "Imported Plaud summary",
                        keyPoints: [],
                        actionItems: [],
                    });
                    await mutate(
                        categorize,
                        "POST",
                        { folderIds: ["private-a"] },
                        "categorize",
                    );
                    if (released)
                        await db().transaction(async (tx) => {
                            const advance = await requestAdvanceInTx(tx, {
                                itemId: ITEM,
                                userId: OWNER,
                                view: "private",
                                reason: "learn-released",
                            });
                            if (!advance)
                                throw new Error("expected arrival processing");
                            await markLearnReleasedInTx(tx, {
                                itemId: ITEM,
                                userId: OWNER,
                                generation: advance.requestedGeneration,
                            });
                        });
                    modelHooks.reply.mockReturnValue({
                        summary: "First custom summary",
                        keyPoints: [],
                        actionItems: [
                            {
                                text: "Plan the next release",
                                speaker: null,
                                assignee: null,
                                due: null,
                                quote: "Plan the next release.",
                                candidates: null,
                            },
                        ],
                        taskUpdates: [],
                    });
                    await runAutomaticSummary();
                    const summaries = await db()
                        .select()
                        .from(aiEnhancements)
                        .where(eq(aiEnhancements.itemId, ITEM));
                    expect(summaries).toHaveLength(2);
                    expect(
                        summaries.find((row) => row.source === "riffado"),
                    ).toMatchObject({ transcriptionId: CONTENT, revision: 0 });
                    const response = await getSummary(
                        request("summary"),
                        context(),
                    );
                    expect(await response.json()).toMatchObject({
                        summary: "First custom summary",
                    });
                    const tasks = await db()
                        .select()
                        .from(recordingTasks)
                        .where(eq(recordingTasks.itemId, ITEM));
                    expect(tasks).toContainEqual(
                        expect.objectContaining({
                            source: "riffado",
                            status: "proposed",
                        }),
                    );
                    expect(
                        (await gatherFacts(ITEM, "private", OWNER)).summary
                            .manualRefreshOnly,
                    ).toBe(true);
                    await mutate(file, "POST", { folderId: "private-b" });
                    await advance();
                    expect(await summaryJobs()).toHaveLength(0);
                },
            );

            it.runIf(kind === "audio").each([false, true])(
                "preserves an unchanged summary after rejecting an unapplied correction (quick: %s)",
                async (quick) => {
                    await pendingRendering();
                    await db()
                        .update(learnReviewItems)
                        .set({ decision: "rejected" })
                        .where(eq(learnReviewItems.runId, "private-review"));
                    await mutate(file, "POST", { folderId: "private-b" });
                    const unchanged = await llmRendering(CONTENT);
                    await db()
                        .update(aiEnhancements)
                        .set({ inputFingerprint: unchanged?.fingerprint })
                        .where(eq(aiEnhancements.id, "saved-summary"));
                    expect(await finishPendingReview(quick)).toMatchObject({
                        status: "finished",
                        applied: 0,
                    });
                    expect((await llmRendering(CONTENT))?.fingerprint).toBe(
                        unchanged?.fingerprint,
                    );
                    await advance();
                    expect(
                        (await gatherFacts(ITEM, "private", OWNER)).summary
                            .refreshRequested,
                    ).toBe(false);
                    await assertVisible();
                },
            );

            it.runIf(kind === "audio").each([false, true])(
                "refreshes when rejecting a correction included in the saved rendering (quick: %s)",
                async (quick) => {
                    const included = await pendingRendering();
                    await db()
                        .update(aiEnhancements)
                        .set({ inputFingerprint: included?.fingerprint })
                        .where(eq(aiEnhancements.id, "saved-summary"));
                    await db()
                        .update(learnReviewItems)
                        .set({ decision: "rejected" })
                        .where(eq(learnReviewItems.runId, "private-review"));
                    expect((await llmRendering(CONTENT))?.fingerprint).not.toBe(
                        included?.fingerprint,
                    );
                    expect(await finishPendingReview(quick)).toMatchObject({
                        status: "finished",
                        applied: 0,
                    });
                    await runAutomaticSummary();
                    const [summary] = await db()
                        .select()
                        .from(aiEnhancements)
                        .where(eq(aiEnhancements.id, "saved-summary"));
                    expect(summary.revision).toBe(1);
                    expect(summary.inputFingerprint).toBe(
                        (await llmRendering(CONTENT))?.fingerprint,
                    );
                },
            );

            it
                .runIf(kind === "audio")
                .each(["no_op", "skipped", "empty"] as const)(
                "preserves unchanged rendering after a %s correction application",
                async (mode) => {
                    await pendingRendering();
                    await db()
                        .update(learnReviewItems)
                        .set({
                            payload: encryptJsonField({
                                kind: "correct",
                                heard: "Plan",
                                target: { personId: "planner" },
                                replacement: mode === "no_op" ? "Plan" : "Alex",
                                anchors:
                                    mode === "empty"
                                        ? []
                                        : mode === "no_op"
                                          ? [
                                                {
                                                    turnIndex: 0,
                                                    charStart: 0,
                                                    charEnd: 4,
                                                },
                                            ]
                                          : [
                                                {
                                                    turnIndex: 0,
                                                    charStart: 50,
                                                    charEnd: 54,
                                                },
                                            ],
                            }),
                        })
                        .where(eq(learnReviewItems.runId, "private-review"));
                    const unchanged = await llmRendering(CONTENT);
                    await db()
                        .update(aiEnhancements)
                        .set({ inputFingerprint: unchanged?.fingerprint })
                        .where(eq(aiEnhancements.id, "saved-summary"));
                    expect(await finishPendingReview(false)).toMatchObject({
                        status: "finished",
                        applied: mode === "empty" ? 1 : 0,
                        skipped:
                            mode === "empty"
                                ? []
                                : [
                                      expect.objectContaining({
                                          code: "no_longer_fits",
                                      }),
                                  ],
                    });
                    expect(
                        await db().select().from(transcriptCorrections),
                    ).toHaveLength(0);
                    expect((await llmRendering(CONTENT))?.fingerprint).toBe(
                        unchanged?.fingerprint,
                    );
                    await advance();
                    await assertVisible();
                },
            );

            it.runIf(kind === "audio")(
                "preserves output after ordinary finish and a correction pass with no fixes",
                async () => {
                    await pendingRendering();
                    await db()
                        .update(learnRuns)
                        .set({ actorUserId: OWNER })
                        .where(eq(learnRuns.id, "private-review"));
                    await db()
                        .delete(learnReviewItems)
                        .where(eq(learnReviewItems.runId, "private-review"));
                    const unchanged = await llmRendering(CONTENT);
                    await db()
                        .update(aiEnhancements)
                        .set({ inputFingerprint: unchanged?.fingerprint })
                        .where(eq(aiEnhancements.id, "saved-summary"));
                    expect(await finishPendingReview(false)).toMatchObject({
                        status: "finished",
                        applied: 0,
                        correcting: true,
                    });
                    const [pass] = await db()
                        .select()
                        .from(transcriptCorrectionPasses);
                    modelHooks.reply.mockReturnValueOnce({ fixes: [] });
                    await expect(
                        correctionPassJobHandler.run({
                            jobId: "correction-test",
                            userId: OWNER,
                            attempt: 1,
                            maxAttempts: 3,
                            payload: { passId: pass.id },
                            signal: new AbortController().signal,
                            reportProgress: vi.fn(),
                        }),
                    ).resolves.toMatchObject({ written: 0 });
                    await advance();
                    await assertVisible();
                },
            );

            it.runIf(kind === "audio")(
                "automatically refreshes an existing summary after a real correction-pass write",
                async () => {
                    await pendingRendering();
                    await db()
                        .update(learnRuns)
                        .set({ actorUserId: OWNER })
                        .where(eq(learnRuns.id, "private-review"));
                    await db()
                        .delete(learnReviewItems)
                        .where(eq(learnReviewItems.runId, "private-review"));
                    const before = await llmRendering(CONTENT);
                    await db()
                        .update(aiEnhancements)
                        .set({ inputFingerprint: before?.fingerprint })
                        .where(eq(aiEnhancements.id, "saved-summary"));
                    expect(await finishPendingReview(false)).toMatchObject({
                        status: "finished",
                        correcting: true,
                    });
                    const [pass] = await db()
                        .select()
                        .from(transcriptCorrectionPasses);
                    modelHooks.reply.mockReturnValueOnce({
                        fixes: [
                            {
                                turn: 0,
                                heard: "release",
                                replacement: "milestone",
                                context: "",
                                target: null,
                            },
                        ],
                    });
                    await expect(
                        correctionPassJobHandler.run({
                            jobId: "correction-test",
                            userId: OWNER,
                            attempt: 1,
                            maxAttempts: 3,
                            payload: { passId: pass.id },
                            signal: new AbortController().signal,
                            reportProgress: vi.fn(),
                        }),
                    ).resolves.toMatchObject({ written: 1 });
                    expect(
                        await db().select().from(transcriptCorrections),
                    ).toHaveLength(1);
                    expect((await llmRendering(CONTENT))?.fingerprint).not.toBe(
                        before?.fingerprint,
                    );
                    await runAutomaticSummary();
                    const [summary] = await db()
                        .select()
                        .from(aiEnhancements)
                        .where(eq(aiEnhancements.id, "saved-summary"));
                    expect(summary.revision).toBe(1);
                    expect(summary.inputFingerprint).toBe(
                        (await llmRendering(CONTENT))?.fingerprint,
                    );
                    expect(
                        (await gatherFacts(ITEM, "private", OWNER)).summary
                            .manualRefreshOnly,
                    ).toBe(true);
                },
            );

            it("keeps results when categorized into an additional Organization folder", async () => {
                await assertVisible();
                await mutate(
                    categorize,
                    "POST",
                    {
                        folderIds: ["private-a", "org-a"],
                    },
                    "categorize",
                );
                await assertVisible();
                await advance();
                await assertVisible();
            }, 15_000);

            it("keeps results when filed, moved and withdrawn from the Organization", async () => {
                await mutate(file, "POST", { folderId: "org-a" });
                await advance();
                await assertVisible();
                await assertVisible(MEMBER, "org");
                await mutate(move, "PATCH", {
                    fromFolderId: "org-a",
                    toFolderId: "org-b",
                });
                await advance();
                await assertVisible(MEMBER, "org");
                await mutate(unfile, "DELETE", {
                    organization: true,
                    withdraw: true,
                });
                await advance();
                await assertVisible();
                expect(
                    (
                        await getSummary(
                            request("summary", "GET", undefined, MEMBER, "org"),
                            context(),
                        )
                    ).status,
                ).toBe(404);
            }, 15_000);

            it("keeps results when moved privately and unfiled from the last folder", async () => {
                await mutate(move, "PATCH", {
                    fromFolderId: "private-a",
                    toFolderId: "private-b",
                });
                await advance();
                await assertVisible();
                await mutate(unfile, "DELETE", {
                    folderId: "private-b",
                });
                await advance();
                await assertVisible();
            }, 15_000);

            it("keeps a legacy summary without content provenance when filed", async () => {
                await db()
                    .insert(learnRuns)
                    .values({
                        userId: OWNER,
                        scopeUserId: OWNER,
                        itemId: ITEM,
                        transcriptionId: kind === "audio" ? CONTENT : null,
                        view: "private",
                        trigger: "auto",
                        transcriptRevision: 0,
                        vocabularyVersion: 1,
                        status: "ready",
                    });
                const before = await loadPrivateItemProcessing(OWNER, ITEM);
                expect(
                    before && deriveWorkflowWidgets(before).summary.visible,
                ).toBe(true);
                await db()
                    .update(aiEnhancements)
                    .set({ transcriptionId: null, inputs: null })
                    .where(eq(aiEnhancements.id, "saved-summary"));
                await mutate(file, "POST", { folderId: "org-a" });
                await assertVisible();
                await advance();
                await assertVisible();
                await assertVisible(MEMBER, "org");
            }, 15_000);

            it("keeps completed results when an Organization profile takes over pending work", async () => {
                await mutate(file, "POST", { folderId: "org-a" });
                await advance();
                await advance();
                expect(
                    (await loadPrivateItemProcessing(OWNER, ITEM))?.profile?.id,
                ).toBe("org-profile");
                await assertVisible();
                await assertVisible(MEMBER, "org");
            }, 15_000);

            it.runIf(kind === "audio")(
                "keeps an imported Plaud summary visible when filed",
                async () => {
                    await db()
                        .update(aiEnhancements)
                        .set({
                            source: "plaud",
                            inputs: null,
                            transcriptionId: null,
                        })
                        .where(eq(aiEnhancements.id, "saved-summary"));
                    await db().insert(learnRuns).values({
                        userId: OWNER,
                        scopeUserId: OWNER,
                        itemId: ITEM,
                        transcriptionId: CONTENT,
                        view: "private",
                        trigger: "auto",
                        transcriptRevision: 0,
                        vocabularyVersion: 1,
                        status: "ready",
                    });
                    const before = await loadPrivateItemProcessing(OWNER, ITEM);
                    expect(
                        before && deriveWorkflowWidgets(before).summary.visible,
                    ).toBe(true);
                    await mutate(file, "POST", { folderId: "org-a" });
                    await assertVisible(OWNER, "private", "plaud");
                    await advance();
                    await assertVisible(MEMBER, "org", "plaud");
                },
                15_000,
            );

            it.runIf(kind === "audio").each(["plaud", "mixed"] as const)(
                "keeps completed %s inputs when the Organization profile prefers re-transcription",
                async (source) => {
                    await db()
                        .update(transcriptions)
                        .set({ source })
                        .where(eq(transcriptions.id, CONTENT));
                    if (source === "mixed")
                        await db()
                            .insert(transcriptions)
                            .values({
                                id: "underlying-plaud",
                                recordingId: ITEM,
                                userId: OWNER,
                                source: "plaud",
                                provider: "test",
                                model: "test",
                                text: encryptText("Earlier Plaud text"),
                            });
                    const inputs = {
                        contentId: CONTENT,
                        contentSourceId: source,
                        contentRevision: 0,
                    };
                    await db()
                        .update(aiEnhancements)
                        .set({
                            inputs: {
                                ...inputs,
                                itemProfileRevisionId: "profile-revision",
                                scopeFingerprint: await itemScopeFingerprint(
                                    ITEM,
                                    "private",
                                    OWNER,
                                ),
                            },
                        })
                        .where(eq(aiEnhancements.id, "saved-summary"));
                    const [processing] = await db()
                        .select()
                        .from(itemProcessing)
                        .where(eq(itemProcessing.itemId, ITEM));
                    await db()
                        .update(itemProcessing)
                        .set({
                            phases: {
                                ...processing.phases,
                                transcribe: {
                                    state: "done",
                                    reason: "plaud-transcript",
                                    generation: 1,
                                    at: new Date().toISOString(),
                                    inputs,
                                },
                                learn: {
                                    state: "skipped",
                                    reason: "profile_off",
                                    generation: 1,
                                    at: new Date().toISOString(),
                                    inputs,
                                },
                                summary: {
                                    state: "done",
                                    reason: "completed",
                                    generation: 1,
                                    at: new Date().toISOString(),
                                    inputs,
                                    steps: {
                                        summary: {
                                            ...inputs,
                                            state: "done",
                                            generation: 1,
                                        },
                                    },
                                },
                            },
                        })
                        .where(eq(itemProcessing.itemId, ITEM));
                    const settings = defaultProfileSettings("audio");
                    settings.steps.transcribe.automatic = true;
                    settings.steps.transcribe.plaudTranscript =
                        "also_transcribe";
                    settings.steps.trim.automatic = false;
                    settings.steps.learn.automatic = false;
                    settings.steps.summary.automatic = true;
                    settings.steps.title.automatic = false;
                    await db()
                        .update(processingProfileRevisions)
                        .set({
                            settings: encryptText(JSON.stringify(settings)),
                        })
                        .where(
                            eq(processingProfileRevisions.id, "org-revision"),
                        );
                    await mutate(file, "POST", { folderId: "org-a" });
                    await advance();
                    await assertVisible();
                    await assertVisible(MEMBER, "org");
                    expect(
                        await db()
                            .select()
                            .from(asyncJobs)
                            .where(
                                and(
                                    eq(asyncJobs.userId, OWNER),
                                    eq(asyncJobs.kind, "transcription"),
                                ),
                            ),
                    ).toHaveLength(0);
                    await mutate(
                        categorize,
                        "POST",
                        {
                            folderIds: ["private-a", "org-a"],
                            profileId: "org-profile",
                        },
                        "categorize",
                    );
                    await mutate(processAgain, "POST", {}, "process-again");
                    await advance();
                    expect(
                        await db()
                            .select()
                            .from(asyncJobs)
                            .where(
                                and(
                                    eq(asyncJobs.userId, OWNER),
                                    eq(asyncJobs.kind, "transcription"),
                                ),
                            ),
                    ).toHaveLength(1);
                    await assertVisible();
                    await expect(
                        upsertTranscription({
                            userId: OWNER,
                            recordingId: ITEM,
                            source: "riffado",
                            text: "A genuine new preferred transcript",
                            detectedLanguage: "en",
                            provider: "test",
                            model: "test",
                        }),
                    ).resolves.toMatchObject({ committed: true });
                    const fresh = await gatherFacts(ITEM, "private", OWNER);
                    expect(fresh.trimContent?.contentSourceId).toBe("riffado");
                    expect(fresh.summary.manualRefreshOnly).toBe(false);
                    expect(planAdvance(fresh).actions).toContainEqual(
                        expect.objectContaining({ type: "queueSummary" }),
                    );
                    await expect(
                        upsertEnhancement({
                            ...lateResult(),
                            inputs: {
                                ...inputs,
                                itemProfileRevisionId: "org-revision",
                            },
                        }),
                    ).resolves.toMatchObject({
                        committed: false,
                        reason: "outdated",
                    });
                    if (!fresh.content)
                        throw new Error("expected new preferred content");
                    await expect(
                        upsertEnhancement({
                            ...lateResult(),
                            transcriptionId: fresh.content.contentId,
                            inputs: {
                                ...fresh.content,
                                itemProfileRevisionId: "org-revision",
                            },
                        }),
                    ).resolves.toMatchObject({
                        committed: true,
                        summaryVersion: { revision: 1 },
                    });
                },
                15_000,
            );

            it.runIf(kind === "audio")(
                "refuses delayed Plaud processing over a saved custom summary and pending proposals",
                async () => {
                    const tasks = await pendingTask();
                    await db()
                        .insert(aiEnhancements)
                        .values({
                            id: "imported-summary",
                            itemId: ITEM,
                            userId: OWNER,
                            source: "plaud",
                            provider: "test",
                            model: "test",
                            summary: encryptText("Imported summary"),
                            actionItems: encryptJsonField([
                                "An unwanted proposal",
                            ]),
                        });
                    const fingerprint = plaudActionItemsFingerprint([
                        "An unwanted proposal",
                    ]);
                    const record: PhaseRecord = {
                        state: "done",
                        generation: 1,
                        at: new Date().toISOString(),
                        inputs: {
                            contentId: CONTENT,
                            contentSourceId: "riffado",
                            contentRevision: 0,
                        },
                    };
                    await mutate(file, "POST", { folderId: "private-b" });
                    await expect(
                        applyPlaudActionItemProposals({
                            itemId: ITEM,
                            userId: OWNER,
                            view: "private",
                            expectedFingerprint: fingerprint,
                            record,
                        }),
                    ).resolves.toBe(false);
                    expect(
                        await db()
                            .select()
                            .from(recordingTasks)
                            .where(eq(recordingTasks.itemId, ITEM)),
                    ).toEqual(tasks);
                },
                15_000,
            );

            it.runIf(kind === "audio")(
                "keeps real pending Plaud proposals and review settlement across filing",
                async () => {
                    await db()
                        .update(aiEnhancements)
                        .set({
                            source: "plaud",
                            inputs: null,
                            actionItems: encryptJsonField(["Review the draft"]),
                        })
                        .where(eq(aiEnhancements.id, "saved-summary"));
                    const fingerprint = plaudActionItemsFingerprint([
                        "Review the draft",
                    ]);
                    const facts = await gatherFacts(ITEM, "private", OWNER);
                    const record: PhaseRecord = {
                        state: "done",
                        generation: facts.generation,
                        at: facts.at,
                        inputs: facts.content ?? undefined,
                        steps: {
                            summary: {
                                contentId: CONTENT,
                                contentSourceId: "riffado",
                                contentRevision: 0,
                                generation: facts.generation,
                                state: "done",
                                reason: "plaud_tasks",
                                sourceFingerprint: fingerprint,
                            },
                        },
                    };
                    await expect(
                        applyPlaudActionItemProposals({
                            itemId: ITEM,
                            userId: OWNER,
                            view: "private",
                            expectedFingerprint: fingerprint,
                            record,
                        }),
                    ).resolves.toBe(true);
                    const tasks = await db()
                        .select()
                        .from(recordingTasks)
                        .where(eq(recordingTasks.itemId, ITEM));
                    expect(
                        tasks.some(
                            (task) =>
                                task.source === "plaud" &&
                                task.status === "proposed",
                        ),
                    ).toBe(true);
                    const mentions = await db()
                        .select()
                        .from(taskMentions)
                        .where(eq(taskMentions.itemId, ITEM));
                    expect(mentions.length).toBeGreaterThan(0);
                    await mutate(file, "POST", { folderId: "org-a" });
                    await advance();
                    await advance();
                    expect(
                        await db()
                            .select()
                            .from(recordingTasks)
                            .where(eq(recordingTasks.itemId, ITEM)),
                    ).toEqual(tasks);
                    const afterMentions = await db()
                        .select()
                        .from(taskMentions)
                        .where(eq(taskMentions.itemId, ITEM));
                    expect(
                        afterMentions.map(
                            ({
                                view: _view,
                                updatedAt: _updatedAt,
                                ...mention
                            }) => mention,
                        ),
                    ).toEqual(
                        mentions.map(
                            ({
                                view: _view,
                                updatedAt: _updatedAt,
                                ...mention
                            }) => mention,
                        ),
                    );
                    await expect(
                        applyPlaudActionItemProposals({
                            itemId: ITEM,
                            userId: OWNER,
                            view: "private",
                            expectedFingerprint: fingerprint,
                            record,
                        }),
                    ).resolves.toBe(false);
                    expect(
                        planAdvance(
                            await gatherFacts(ITEM, "private", OWNER),
                        ).actions.some(
                            (action) => action.type === "applyPlaudTasks",
                        ),
                    ).toBe(false);
                    const response = await getSummary(
                        request("summary?source=plaud"),
                        context(),
                    );
                    expect(await response.json()).toMatchObject({
                        summary: "Existing summary",
                        actionItems: ["Review the draft"],
                    });
                },
                15_000,
            );

            it("still detects new content after a placement change", async () => {
                await mutate(file, "POST", {
                    folderId: "private-b",
                });
                const contentTable =
                    kind === "audio" ? transcriptions : mailContents;
                await db()
                    .update(contentTable)
                    .set({ revision: 1 })
                    .where(
                        and(
                            eq(contentTable.id, CONTENT),
                            eq(contentTable.userId, OWNER),
                        ),
                    );
                const facts = await gatherFacts(ITEM, "private", OWNER);
                const actions = planAdvance(facts).actions;
                expect(actions).toContainEqual(
                    expect.objectContaining({ type: "queueSummary" }),
                );
                expect(actions).toContainEqual(
                    expect.objectContaining({
                        type: "markPhase",
                        phase: "summary",
                        record: expect.objectContaining({
                            reason: "content_changed",
                        }),
                    }),
                );
                const response = await getSummary(
                    request("summary"),
                    context(),
                );
                expect(await response.json()).toMatchObject({
                    summary: "Existing summary",
                    olderContent: true,
                });
                await assertVisible();
            }, 15_000);

            it("keeps results and fences a late job after an explicit profile change", async () => {
                const [profile] = await db()
                    .select()
                    .from(processingProfiles)
                    .where(eq(processingProfiles.id, "profile"));
                const [revision] = await db()
                    .select()
                    .from(processingProfileRevisions)
                    .where(
                        eq(processingProfileRevisions.id, "profile-revision"),
                    );
                await db()
                    .insert(processingProfiles)
                    .values({
                        ...profile,
                        id: "other-profile",
                        currentRevisionId: "other-revision",
                        isDefault: false,
                    });
                await db()
                    .insert(processingProfileRevisions)
                    .values({
                        ...revision,
                        id: "other-revision",
                        profileId: "other-profile",
                    });
                await mutate(
                    categorize,
                    "POST",
                    {
                        folderIds: ["private-b"],
                        profileId: "other-profile",
                    },
                    "categorize",
                );
                await advance();
                expect(
                    (await loadPrivateItemProcessing(OWNER, ITEM))
                        ?.processAgain,
                ).toBe(true);
                await expect(
                    upsertEnhancement({
                        recordingId: ITEM,
                        userId: OWNER,
                        kind,
                        source: "riffado",
                        summary: "Late result",
                        keyPoints: [],
                        actionItems: [],
                        provider: "test",
                        model: "test",
                        transcriptionId: kind === "audio" ? CONTENT : null,
                        inputs: {
                            contentId: CONTENT,
                            contentRevision: 0,
                            contentSourceId:
                                kind === "audio" ? "riffado" : "mail",
                            itemProfileRevisionId: "profile-revision",
                        },
                    }),
                ).resolves.toEqual({ committed: false, reason: "outdated" });
                await assertVisible();
            }, 15_000);

            async function pendingRendering() {
                await db()
                    .update(transcriptions)
                    .set({
                        turns: encryptJsonField([
                            {
                                speaker: "speaker_0",
                                startMs: 0,
                                endMs: 1000,
                                text: "Plan the next release.",
                            },
                        ]),
                    })
                    .where(
                        and(
                            eq(transcriptions.id, CONTENT),
                            eq(transcriptions.userId, OWNER),
                        ),
                    );
                await db().insert(transcriptSpeakers).values({
                    userId: OWNER,
                    transcriptionId: CONTENT,
                    label: "speaker_0",
                    source: "user",
                    status: "confirmed",
                    markedUnknown: true,
                    confirmedByUserId: OWNER,
                });
                await db()
                    .insert(people)
                    .values({
                        id: "planner",
                        userId: OWNER,
                        displayName: encryptText("Alex Example"),
                    });
                await db().insert(learnRuns).values({
                    id: "private-review",
                    userId: OWNER,
                    scopeUserId: OWNER,
                    itemId: ITEM,
                    transcriptionId: CONTENT,
                    view: "private",
                    trigger: "auto",
                    transcriptRevision: 0,
                    vocabularyVersion: 1,
                    status: "ready",
                });
                await db()
                    .insert(learnReviewItems)
                    .values({
                        runId: "private-review",
                        userId: OWNER,
                        kind: "correction",
                        fingerprintHmac: lookupHash("correction"),
                        preTicked: true,
                        payload: encryptJsonField({
                            kind: "correct",
                            heard: "Plan",
                            target: { personId: "planner" },
                            replacement: "Alex",
                            anchors: [
                                { turnIndex: 0, charStart: 0, charEnd: 4 },
                            ],
                        }),
                    });
                const rendering = await llmRendering(CONTENT);
                expect(rendering?.text).toContain("Alex");
                return rendering;
            }

            it.runIf(kind === "audio")(
                "keeps the summary when publication changes rendering but not the folder fingerprint",
                async () => {
                    const rendering = await pendingRendering();
                    await mutate(
                        categorize,
                        "POST",
                        { folderIds: ["org-a"] },
                        "categorize",
                    );
                    await expect(
                        upsertEnhancement({
                            userId: OWNER,
                            recordingId: ITEM,
                            transcriptionId: CONTENT,
                            summary: "Existing summary",
                            keyPoints: ["Keep the release small"],
                            actionItems: ["Prepare release notes"],
                            source: "riffado",
                            provider: "test",
                            model: "test",
                            summaryWriteMode: "regenerate",
                            inputFingerprint: rendering?.fingerprint,
                            inputs: {
                                contentId: CONTENT,
                                contentSourceId: "riffado",
                                contentRevision: 0,
                                itemProfileRevisionId: "profile-revision",
                                scopeFingerprint: await itemScopeFingerprint(
                                    ITEM,
                                    "private",
                                    OWNER,
                                ),
                            },
                        }),
                    ).resolves.toMatchObject({ committed: true });
                    await mutate(file, "POST", { folderId: "org-a" });
                    await advance();
                    await advance();
                    await assertVisible();
                    await assertVisible(MEMBER, "org");
                    const response = await getSummary(
                        request("summary"),
                        context(),
                    );
                    expect(await response.json()).toMatchObject({
                        scopeChanged: false,
                        stale: true,
                    });
                },
                15_000,
            );

            it.runIf(kind === "audio").each([false, true])(
                "keeps results after filing and withdrawal change the correction rendering (advance before withdrawal: %s)",
                async (advanceBeforeWithdrawal) => {
                    const rendering = await pendingRendering();
                    await db()
                        .update(aiEnhancements)
                        .set({ inputFingerprint: rendering?.fingerprint })
                        .where(eq(aiEnhancements.id, "saved-summary"));
                    await mutate(file, "POST", {
                        folderId: "org-a",
                    });
                    expect((await llmRendering(CONTENT))?.fingerprint).not.toBe(
                        rendering?.fingerprint,
                    );
                    const facts = await gatherFacts(ITEM, "private", OWNER);
                    expect(facts.stepAvailability?.summary).toBe("available");
                    expect(facts.summary.stale).toBe(true);
                    if (advanceBeforeWithdrawal) {
                        await advance();
                        await advance();
                    }
                    await assertVisible();
                    await assertVisible(MEMBER, "org");
                    const response = await getSummary(
                        request("summary"),
                        context(),
                    );
                    expect(await response.json()).toMatchObject({
                        scopeChanged: true,
                        stale: true,
                    });
                    await mutate(unfile, "DELETE", {
                        organization: true,
                        withdraw: true,
                    });
                    await advance();
                    await advance();
                    await assertVisible();
                    const withdrawn = await getSummary(
                        request("summary"),
                        context(),
                    );
                    expect(await withdrawn.json()).toMatchObject({
                        scopeChanged: false,
                        stale: true,
                    });
                },
                15_000,
            );

            it("keeps results in a person-shared folder and after unfiling", async () => {
                await db().insert(folderShares).values({
                    userId: OWNER,
                    receiverUserId: MEMBER,
                    folderId: "private-b",
                    state: "accepted",
                    invitedByUserId: OWNER,
                });
                await mutate(file, "POST", {
                    folderId: "private-b",
                });
                await advance();
                await assertVisible(MEMBER, "received");
                await mutate(unfile, "DELETE", {
                    folderId: "private-b",
                });
                await advance();
                await assertVisible();
                expect(
                    (
                        await getSummary(
                            request(
                                "summary",
                                "GET",
                                undefined,
                                MEMBER,
                                "received",
                            ),
                            context(),
                        )
                    ).status,
                ).toBe(404);
            }, 15_000);

            it("keeps results when filed into a restricted Organization folder", async () => {
                await mutate(file, "POST", {
                    folderId: "restricted",
                });
                await db().insert(restrictedFolderMembers).values({
                    folderId: "restricted",
                    userId: MEMBER,
                    role: "member",
                    addedByUserId: OWNER,
                });
                await advance();
                await assertVisible();
                await assertVisible(MEMBER, "received");
                await mutate(move, "PATCH", {
                    fromFolderId: "restricted",
                    toFolderId: "org-a",
                });
                await advance();
                await assertVisible(MEMBER, "org");
                await mutate(move, "PATCH", {
                    fromFolderId: "org-a",
                    toFolderId: "restricted",
                    withdraw: true,
                });
                await advance();
                await assertVisible();
                await assertVisible(MEMBER, "received");
                await mutate(unfile, "DELETE", { folderId: "restricted" });
                await advance();
                await assertVisible();
                expect(
                    (
                        await getSummary(
                            request(
                                "summary",
                                "GET",
                                undefined,
                                MEMBER,
                                "received",
                            ),
                            context(),
                        )
                    ).status,
                ).toBe(404);
            }, 15_000);
        });
    },
);
