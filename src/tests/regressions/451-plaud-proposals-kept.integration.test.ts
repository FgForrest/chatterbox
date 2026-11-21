import { and, asc, eq } from "drizzle-orm";
import { OpenAI } from "openai";
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
    POST as file,
    DELETE as unfile,
} from "@/app/api/recordings/[id]/folders/route";
import { POST as processAgain } from "@/app/api/recordings/[id]/process-again/route";
import { POST as accept } from "@/app/api/recordings/[id]/tasks/accept/route";
import { GET as listTasks } from "@/app/api/recordings/[id]/tasks/route";
import { PATCH as editTask } from "@/app/api/tasks/[taskId]/route";
import {
    claimDueJobs,
    completeJob,
    prepareClaimedPipelineJob,
} from "@/db/queries/async-jobs";
import {
    aiEnhancements,
    aiUsageEvents,
    asyncJobs,
    itemProcessing,
    people,
    processingProfileRevisions,
    processingProfiles,
    recordingFolderAssignments,
    recordingFolders,
    recordingTaskRejections,
    recordingTasks,
    taskMentions,
    transcriptCorrections,
    transcriptions,
    transcriptSpeakers,
    users,
} from "@/db/schema";
import {
    decryptText,
    encryptJsonField,
    encryptText,
} from "@/lib/encryption/fields";
import type { JobHandler } from "@/lib/jobs/types";
import { domainLookupHash, lookupHash } from "@/lib/knowledge/lookup-hash";
import { llmRendering } from "@/lib/learn/llm-input";
import {
    PIPELINE_ACTION_JOB_KIND,
    pipelineActionJobHandler,
} from "@/lib/pipeline/action-job";
import { pipelineAdvanceJobHandler } from "@/lib/pipeline/advance-job";
import { gatherFacts } from "@/lib/pipeline/facts";
import { planAdvance } from "@/lib/pipeline/plan";
import {
    PIPELINE_ADVANCE_JOB_KIND,
    type RequestAdvanceInput,
    requestAdvance,
} from "@/lib/pipeline/trigger";
import type { ContentRevisionInput, PhaseRecord } from "@/lib/pipeline/types";
import { defaultProfileSettings } from "@/lib/profiles/settings";
import { taskViewerById } from "@/lib/tasks/access";
import { tasksForArchive } from "@/lib/tasks/archive";
import { plaudActionItemsFingerprint } from "@/lib/tasks/plaud-proposals";
import { taskFingerprint } from "@/lib/tasks/proposals";
import { restoreTaskArchive } from "@/lib/tasks/restore";
import type { RecordingTasks } from "@/lib/tasks/tasks";
import { upsertTranscription } from "@/lib/transcription/persist";
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
                get: (_target, property) => {
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
        SELF_HOST_MODE: "shared",
        ORG_ACCOUNT_EMAIL: "org@example.test",
        ORG_ACCOUNT_PASSWORD: "test-password",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        BETTER_AUTH_SECRET: "plaud-rebuild-test-secret",
        DATABASE_URL: "postgres://unused",
        AUTO_SUMMARY_RATE_LIMIT_PER_HOUR: 20,
    },
}));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async (request: Request) => ({
        user: { id: caller(request), email: email(caller(request)) },
    }),
    requireApiSessionActor: async (request: Request) => {
        const id = caller(request);
        return {
            session: { user: { id, email: email(id) } },
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
vi.mock("openai", { spy: true });

const OWNER = "plaud-rebuild-owner";
const ORG = "plaud-rebuild-org";
const ITEM = "plaud-rebuild-recording";
const TRANSCRIPT = "plaud-rebuild-transcript";
const SUMMARY = "plaud-rebuild-summary";
const PROFILE = "personal-profile";
const REVISION = "personal-revision";
const INPUT = {
    contentId: TRANSCRIPT,
    contentSourceId: "riffado",
    contentRevision: 0,
} as const;
const ACTION_ITEMS = ["Draft the release notes", "Check the release calendar"];
const CHANGED_ITEMS = ["Send the release notes", ACTION_ITEMS[1]];
const DUPLICATE_ITEMS = [...ACTION_ITEMS, ACTION_ITEMS[0]];
const FINGERPRINT = plaudActionItemsFingerprint(ACTION_ITEMS);
const CREATED_AT = new Date("2020-01-01T12:00:00Z");
const ASSIGNEE = "private-speaker";
const ASSIGNEE_NAME = "Velnira Quorlen";
const SPEAKER_ITEM = "[Speaker 0](#speaker-0) to draft the release notes";
const PROCESSING_SCOPE = and(
    eq(itemProcessing.itemId, ITEM),
    eq(itemProcessing.userId, OWNER),
    eq(itemProcessing.view, "private"),
);
const TASK_SCOPE = and(
    eq(recordingTasks.itemId, ITEM),
    eq(recordingTasks.userId, OWNER),
    eq(recordingTasks.source, "plaud"),
    eq(recordingTasks.status, "proposed"),
);
const dbUrl = getTestDatabaseUrl();

type SummaryShape =
    | "missing"
    | "legacy"
    | "topics only"
    | "no_provider"
    | "modern";

function email(userId: string) {
    return userId === ORG ? "org@example.test" : "owner@example.test";
}

function caller(request: Request) {
    return request.headers.get("x-test-user") ?? OWNER;
}

function request(path: string, method = "GET", body?: object, userId = OWNER) {
    return new Request(`http://localhost/api/${path}`, {
        method,
        headers: {
            "content-type": "application/json",
            "x-test-user": userId,
        },
        ...(body && { body: JSON.stringify(body) }),
    });
}

function context() {
    return { params: Promise.resolve({ id: ITEM }) };
}

async function mutate(
    handler: typeof file,
    method: string,
    body: object,
    path = "folders?view=private",
) {
    const response = await handler(
        request(`recordings/${ITEM}/${path}`, method, body),
        context(),
    );
    const payload = await response.json();
    expect(response.status, JSON.stringify(payload)).toBe(200);
    return payload;
}

(dbUrl ? describe : describe.skip)(
    "#451 Plaud proposals survive a legacy advance",
    () => {
        let database: TestPostgresDatabase;
        const db = () => database.db;
        const fetchProvider = vi.fn<typeof fetch>();

        beforeAll(async () => {
            database = await createMigratedTestDatabase(
                dbUrl ?? "",
                "plaud_rebuild",
            );
            dbRef.current = database.db as unknown as Record<
                PropertyKey,
                unknown
            >;
        }, 120_000);

        beforeEach(async () => {
            vi.clearAllMocks();
            fetchProvider.mockRejectedValue(
                new Error("unexpected HTTP request"),
            );
            vi.stubGlobal("fetch", fetchProvider);
            await db().delete(users);
            await db()
                .insert(users)
                .values([
                    { id: OWNER, email: email(OWNER) },
                    { id: ORG, email: email(ORG), role: "org" },
                ]);
        });

        afterEach(async () => {
            vi.unstubAllGlobals();
            const jobs = await db()
                .select({ kind: asyncJobs.kind })
                .from(asyncJobs)
                .where(eq(asyncJobs.userId, OWNER));
            expect
                .soft(
                    jobs
                        .map((job) => job.kind)
                        .filter(
                            (kind) =>
                                kind !== PIPELINE_ADVANCE_JOB_KIND &&
                                kind !== PIPELINE_ACTION_JOB_KIND,
                        ),
                )
                .toEqual([]);
            expect.soft(await db().select().from(aiUsageEvents)).toEqual([]);
            expect.soft(OpenAI).not.toHaveBeenCalled();
            expect.soft(fetchProvider).not.toHaveBeenCalled();
        });

        afterAll(async () => {
            dbRef.current = null;
            await database?.dispose();
        }, 30_000);

        async function seed(
            shape: SummaryShape,
            {
                shared = false,
                hasProposals = true,
                namedSpeaker = false,
                reviewSkipped = false,
                plaudOnly = false,
                importedActionItems = namedSpeaker
                    ? [SPEAKER_ITEM]
                    : ACTION_ITEMS,
            }: {
                shared?: boolean;
                hasProposals?: boolean;
                namedSpeaker?: boolean;
                reviewSkipped?: boolean;
                plaudOnly?: boolean;
                importedActionItems?: string[];
            } = {},
        ) {
            await db()
                .insert(recordingFolders)
                .values(
                    (
                        [
                            ["private-root", OWNER, null, "private"],
                            ["private-a", OWNER, "private-root", "custom"],
                            ["private-b", OWNER, "private-root", "custom"],
                            ["org-root", ORG, null, "public"],
                            ["org-a", ORG, "org-root", "custom"],
                        ] as const
                    ).map(([id, userId, parentId, kind]) => ({
                        id,
                        userId,
                        parentId,
                        kind,
                        name: encryptText(id),
                        nameHash: lookupHash(id),
                    })),
                );
            const settings = defaultProfileSettings("audio");
            settings.steps.learn.automatic = false;
            settings.steps.trim.automatic = false;
            settings.steps.title.automatic = false;
            settings.steps.summary.automatic = true;
            await db()
                .insert(processingProfiles)
                .values({
                    id: PROFILE,
                    ownerUserId: OWNER,
                    scope: "personal",
                    channel: "audio",
                    name: encryptText("Personal profile"),
                    currentRevisionId: REVISION,
                    isDefault: true,
                    createdBy: OWNER,
                    updatedBy: OWNER,
                });
            await db()
                .insert(processingProfileRevisions)
                .values({
                    id: REVISION,
                    profileId: PROFILE,
                    createdBy: OWNER,
                    settings: encryptText(JSON.stringify(settings)),
                });
            await insertRecordings(db(), {
                id: ITEM,
                userId: OWNER,
                filename: encryptText("Release planning"),
                deviceSn: "device",
                plaudFileId: ITEM,
                duration: 1000,
                startTime: CREATED_AT,
                endTime: new Date(CREATED_AT.getTime() + 1000),
                filesize: 10,
                fileMd5: "0".repeat(32),
                storageType: "local",
                storagePath: "test.mp3",
                plaudVersion: "1",
            });
            await db()
                .insert(recordingFolderAssignments)
                .values(
                    (shared ? ["private-a", "org-a"] : ["private-a"]).map(
                        (folderId) => ({
                            itemId: ITEM,
                            userId: OWNER,
                            folderId,
                        }),
                    ),
                );
            const contentSourceId = plaudOnly ? "plaud" : "riffado";
            const content = { ...INPUT, contentSourceId };
            await db()
                .insert(transcriptions)
                .values({
                    id: TRANSCRIPT,
                    recordingId: ITEM,
                    userId: OWNER,
                    source: contentSourceId,
                    provider: "test",
                    model: "test",
                    text: encryptText("Plan the next release."),
                    turns: encryptJsonField([
                        {
                            speaker: "speaker_0",
                            startMs: 0,
                            endMs: 1000,
                            text: "Plan the next release.",
                        },
                    ]),
                    topics: encryptJsonField({
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
                        generatedAt: CREATED_AT.toISOString(),
                    }),
                });
            if (namedSpeaker) {
                await db()
                    .insert(people)
                    .values({
                        id: ASSIGNEE,
                        userId: OWNER,
                        displayName: encryptText(ASSIGNEE_NAME),
                    });
            }
            await db()
                .insert(transcriptSpeakers)
                .values({
                    userId: OWNER,
                    transcriptionId: TRANSCRIPT,
                    label: "speaker_0",
                    source: "user",
                    status: "confirmed",
                    personId: namedSpeaker ? ASSIGNEE : null,
                    markedUnknown: !namedSpeaker,
                    confirmedByUserId: OWNER,
                });
            const items = namedSpeaker ? [SPEAKER_ITEM] : ACTION_ITEMS;
            await db()
                .insert(aiEnhancements)
                .values({
                    id: SUMMARY,
                    itemId: ITEM,
                    userId: OWNER,
                    transcriptionId: TRANSCRIPT,
                    source: "plaud",
                    provider: "plaud",
                    model: "plaud-native",
                    summary: encryptText("Imported release summary"),
                    actionItems: encryptJsonField(importedActionItems),
                });
            const done = {
                state: "done",
                generation: 1,
                at: CREATED_AT.toISOString(),
            } as const;
            const step = {
                ...content,
                state: "done",
                generation: 1,
                profileRevisionId: REVISION,
            } as const;
            const summary: PhaseRecord = {
                ...done,
                reason: "completed",
                inputs: content,
            };
            if (shape !== "missing" && shape !== "legacy") {
                summary.profileRevisionId = REVISION;
                summary.steps = { topics: step };
                if (shape === "no_provider") {
                    summary.steps.summary = {
                        ...step,
                        state: "skipped",
                        reason: "no_provider",
                    };
                } else if (shape === "modern") {
                    summary.steps.summary = {
                        ...step,
                        reason: "plaud_tasks",
                        sourceFingerprint:
                            plaudActionItemsFingerprint(importedActionItems),
                    };
                }
            }
            await db()
                .insert(itemProcessing)
                .values({
                    itemId: ITEM,
                    userId: OWNER,
                    view: "private",
                    profileId: PROFILE,
                    profileRevisionId: REVISION,
                    requestedGeneration: 1,
                    processedGeneration: 1,
                    taskReviewSkippedAt: reviewSkipped ? CREATED_AT : null,
                    phases: {
                        categorize: {
                            ...done,
                            reason: "categorized",
                            profileChoice: "placement",
                        },
                        transcribe: {
                            ...done,
                            reason: "content-available",
                            inputs: content,
                        },
                        trim: {
                            ...done,
                            state: "skipped",
                            reason: "profile_off",
                            inputs: content,
                        },
                        learn: {
                            ...done,
                            reason: "manual_finished",
                            inputs: content,
                        },
                        ...(shape !== "missing" && { summary }),
                        taskReview: { ...done, reason: "reviewed" },
                        ...(shared && { share: { ...done, reason: "shared" } }),
                    },
                });
            if (!hasProposals) return;
            const rows = await db()
                .insert(recordingTasks)
                .values(
                    items.map((text, position) => ({
                        id: `legacy-proposal-${position}`,
                        itemId: ITEM,
                        userId: OWNER,
                        status: "proposed" as const,
                        source: "plaud" as const,
                        text: encryptText(
                            namedSpeaker
                                ? `${ASSIGNEE_NAME} to draft the release notes`
                                : text,
                        ),
                        assigneePersonId: namedSpeaker ? ASSIGNEE : null,
                        position,
                        createdAt: CREATED_AT,
                        updatedAt: CREATED_AT,
                        createdByUserId: OWNER,
                        originItemId: ITEM,
                    })),
                )
                .returning({ id: recordingTasks.id });
            await db()
                .insert(taskMentions)
                .values(
                    rows.map(({ id }) => ({
                        taskId: id,
                        itemId: ITEM,
                        userId: OWNER,
                        view: shared ? ("org" as const) : ("private" as const),
                        contentSourceId: "plaud",
                        statementAt: CREATED_AT,
                        matchDecision: "home" as const,
                        createdAt: CREATED_AT,
                        updatedAt: CREATED_AT,
                    })),
                );
        }

        async function processing() {
            const [row] = await db()
                .select()
                .from(itemProcessing)
                .where(PROCESSING_SCOPE);
            return row;
        }

        async function proposals() {
            const rows = await db()
                .select({
                    id: recordingTasks.id,
                    text: recordingTasks.text,
                    createdAt: recordingTasks.createdAt,
                    position: recordingTasks.position,
                    version: recordingTasks.version,
                    assignee: recordingTasks.assigneePersonId,
                })
                .from(recordingTasks)
                .where(TASK_SCOPE)
                .orderBy(
                    asc(recordingTasks.position),
                    asc(recordingTasks.createdAt),
                    asc(recordingTasks.id),
                );
            return rows.map((row) => ({ ...row, text: decryptText(row.text) }));
        }

        async function mentions() {
            return db()
                .select({
                    id: taskMentions.id,
                    taskId: taskMentions.taskId,
                    view: taskMentions.view,
                })
                .from(taskMentions)
                .where(
                    and(
                        eq(taskMentions.itemId, ITEM),
                        eq(taskMentions.userId, OWNER),
                    ),
                )
                .orderBy(asc(taskMentions.taskId));
        }

        async function actionJobs() {
            return db()
                .select({
                    subject: asyncJobs.subjectId,
                    status: asyncJobs.status,
                    result: asyncJobs.result,
                })
                .from(asyncJobs)
                .where(
                    and(
                        eq(asyncJobs.userId, OWNER),
                        eq(asyncJobs.kind, PIPELINE_ACTION_JOB_KIND),
                    ),
                )
                .orderBy(asc(asyncJobs.createdAt), asc(asyncJobs.id));
        }

        async function setActionItems(items: string[]) {
            await db()
                .update(aiEnhancements)
                .set({ actionItems: encryptJsonField(items) })
                .where(
                    and(
                        eq(aiEnhancements.id, SUMMARY),
                        eq(aiEnhancements.userId, OWNER),
                    ),
                );
        }

        async function runNext<Payload>(handler: JobHandler<Payload>) {
            const [job] = await claimDueJobs(handler.kind, 1);
            if (!job) return null;
            expect(
                await prepareClaimedPipelineJob(job.id, job.claimToken),
            ).toBe(true);
            const payload = handler.parsePayload(job.payload);
            const result = await handler.run({
                jobId: job.id,
                userId: job.userId,
                claimToken: job.claimToken,
                attempt: job.attempts,
                maxAttempts: job.maxAttempts,
                payload,
                signal: new AbortController().signal,
                reportProgress: vi.fn(),
            });
            const beforeSettlement = (await processing()).phases.summary;
            expect(
                await completeJob({
                    jobId: job.id,
                    claimToken: job.claimToken,
                    result: result ?? null,
                }),
            ).toBe(true);
            return { payload, result, beforeSettlement };
        }

        async function runAdvance(reason?: string) {
            const run = await runNext(pipelineAdvanceJobHandler);
            expect(run?.payload).toMatchObject({
                itemId: ITEM,
                view: "private",
                ...(reason && { reason }),
            });
            expect(run?.result).toMatchObject({ outcome: { kind: "done" } });
        }

        async function wake(reason: RequestAdvanceInput["reason"] = "title") {
            const advance = await requestAdvance({
                itemId: ITEM,
                userId: OWNER,
                view: "private",
                reason,
            });
            if (!advance) throw new Error("expected an advance request");
            return advance.requestedGeneration;
        }

        async function drainActions() {
            for (let i = 0; i < 4; i++) {
                if (!(await runNext(pipelineActionJobHandler))) return;
            }
            throw new Error("pipeline actions did not settle");
        }

        async function expectRecorded(
            items: string[],
            content: ContentRevisionInput = INPUT,
        ) {
            expect.soft(await actionJobs()).toEqual([
                {
                    subject: `applyPlaudTasks:${ITEM}`,
                    status: "completed",
                    result: {
                        outcome: { kind: "done", reason: "plaud_tasks" },
                    },
                },
            ]);
            expect.soft((await processing()).phases.summary).toMatchObject({
                inputs: content,
                steps: {
                    summary: {
                        ...content,
                        state: "done",
                        reason: "plaud_tasks",
                        sourceFingerprint: plaudActionItemsFingerprint(items),
                    },
                },
            });
        }

        async function expectRewrittenProposals(
            items: string[],
            firstPosition = 0,
        ) {
            const applied = await proposals();
            expect.soft(applied).toEqual(
                items.map((text, index) =>
                    expect.objectContaining({
                        id: expect.not.stringMatching(/^legacy-proposal-/),
                        text,
                        position: firstPosition + index,
                        version: 0,
                        createdAt: expect.any(Date),
                    }),
                ),
            );
            expect
                .soft(applied.every(({ createdAt }) => createdAt > CREATED_AT))
                .toBe(true);
        }

        async function expectApplied(items: string[]) {
            await expectRecorded(items);
            await expectRewrittenProposals(items);
        }

        async function expectOpenReviewPreserved(items: string[]) {
            const before = await proposals();
            const beforeMentions = await mentions();
            const shown = await listTasks(
                request(`recordings/${ITEM}/tasks`),
                context(),
            );
            expect(shown.status).toBe(200);
            const review = (await shown.json()) as RecordingTasks;
            const shownIds = review.proposals.map(({ id }) => id);
            expect(shownIds).toEqual(before.map(({ id }) => id));
            expect(review.updates).toEqual([]);
            expect(review.matches).toEqual([]);

            await wake();
            await runAdvance("title");
            await drainActions();
            await expectRecorded(items);
            expect.soft(await proposals()).toEqual(before);
            expect.soft(await mentions()).toEqual(beforeMentions);

            const response = await accept(
                request(`recordings/${ITEM}/tasks/accept`, "POST", {
                    proposals: shownIds,
                    updates: [],
                    matches: [],
                }),
                context(),
            );
            expect
                .soft(response.status, JSON.stringify(await response.json()))
                .toBe(200);
            expect.soft(await proposals()).toEqual([]);
        }

        it("A1 preserves legacy proposals through filing and unfiling", async () => {
            await seed("legacy");
            const before = await proposals();
            await mutate(file, "POST", { folderId: "private-b" });
            await runAdvance("placement");
            await drainActions();
            const filed = await proposals();
            const filedJobs = await actionJobs();
            await expectRecorded(ACTION_ITEMS);
            expect.soft(filed).toEqual(before);

            await runNext(pipelineAdvanceJobHandler);
            await mutate(unfile, "DELETE", { folderId: "private-b" });
            await runAdvance("placement");
            await drainActions();
            expect.soft(await actionJobs()).toEqual(filedJobs);
            expect.soft(await proposals()).toEqual(before);
            const { phases } = await processing();
            expect
                .soft(phases.summary)
                .toMatchObject({ state: "done", inputs: INPUT });
        }, 15_000);

        it.each([
            "legacy",
            "topics only",
            "no_provider",
        ] as const)("A2/A3 preserves %s proposals on a neutral advance", async (shape) => {
            await seed(shape);
            const before = await proposals();
            const summary = (await processing()).phases.summary;
            await wake();
            await runAdvance("title");
            await drainActions();
            await expectRecorded(ACTION_ITEMS);
            expect.soft(await proposals()).toEqual(before);
            const after = (await processing()).phases.summary;
            expect.soft(after).toMatchObject({ state: "done", inputs: INPUT });
            if (summary?.steps?.topics) {
                expect.soft(after?.steps?.topics).toEqual(summary.steps.topics);
            }
            await wake();
            await runAdvance();
            await drainActions();
            expect.soft(await actionJobs()).toHaveLength(1);
            expect.soft(await proposals()).toEqual(before);
        });

        it("A4 retains the modern source fingerprint on withdrawal with a new correction rendering", async () => {
            await seed("modern", { shared: true });
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
            const shared = await llmRendering(TRANSCRIPT);
            expect(shared?.text).toContain("Plan the next release.");
            await db()
                .update(aiEnhancements)
                .set({ inputFingerprint: shared?.fingerprint })
                .where(
                    and(
                        eq(aiEnhancements.id, SUMMARY),
                        eq(aiEnhancements.userId, OWNER),
                    ),
                );
            const before = await proposals();
            await mutate(unfile, "DELETE", {
                organization: true,
                withdraw: true,
            });
            const withdrawn = await llmRendering(TRANSCRIPT);
            expect(withdrawn?.text).toContain("Schedule the next release.");
            expect(withdrawn?.fingerprint).not.toBe(shared?.fingerprint);
            expect(
                (await gatherFacts(ITEM, "private", OWNER)).summary,
            ).toMatchObject({
                stale: true,
                manualRefreshOnly: true,
                refreshRequested: false,
            });
            await runAdvance("placement");
            await drainActions();
            expect.soft(await actionJobs()).toHaveLength(0);
            expect.soft(await proposals()).toEqual(before);
            expect.soft((await processing()).phases.summary).toMatchObject({
                reason: "learn_changed",
                staleFingerprint: withdrawn?.fingerprint,
                steps: {
                    summary: { ...INPUT, sourceFingerprint: FINGERPRINT },
                },
            });
        }, 15_000);

        it("A5 stores a successful rebuild's fingerprint and queues nothing on the next advance", async () => {
            await seed("modern");
            await setActionItems(CHANGED_ITEMS);
            await wake();
            await runAdvance("title");
            const run = await runNext(pipelineActionJobHandler);
            const fingerprint = plaudActionItemsFingerprint(CHANGED_ITEMS);
            expect(run?.result).toEqual({
                outcome: { kind: "done", reason: "plaud_tasks" },
            });
            expect(run?.beforeSettlement?.steps?.summary).toMatchObject({
                state: "running",
                sourceFingerprint: fingerprint,
            });
            await expectApplied(CHANGED_ITEMS);
            const rebuilt = await proposals();
            const summary = (await processing()).phases.summary;
            await runAdvance();
            await wake();
            await runAdvance("title");
            await drainActions();
            expect.soft(await actionJobs()).toHaveLength(1);
            expect.soft(await proposals()).toEqual(rebuilt);
            expect.soft((await processing()).phases.summary).toEqual(summary);
        });

        it("A5 settles an obsolete job without writing and can apply the newer import", async () => {
            await seed("legacy", { hasProposals: false });
            await wake();
            await runAdvance("title");
            await setActionItems(CHANGED_ITEMS);
            const skipped = await runNext(pipelineActionJobHandler);
            expect(skipped?.result).toEqual({
                outcome: { kind: "skipped", reason: "source_changed" },
            });
            expect(await proposals()).toEqual([]);
            expect(
                (await processing()).phases.summary?.steps?.summary,
            ).toMatchObject({
                state: "skipped",
                reason: "source_changed",
                sourceFingerprint: FINGERPRINT,
            });
            await runAdvance();
            const applied = await runNext(pipelineActionJobHandler);
            expect(applied?.result).toEqual({
                outcome: { kind: "done", reason: "plaud_tasks" },
            });
            const rebuilt = await proposals();
            expect(rebuilt.map((row) => row.text)).toEqual(CHANGED_ITEMS);
            expect(
                (await processing()).phases.summary?.steps?.summary
                    ?.sourceFingerprint,
            ).toBe(plaudActionItemsFingerprint(CHANGED_ITEMS));
            await runAdvance();
            expect.soft(await actionJobs()).toHaveLength(2);
            expect.soft(await proposals()).toEqual(rebuilt);
        });

        describe("effects on existing proposals", () => {
            it("B6 preserves proposal identities, creation times, positions and mentions", async () => {
                await seed("legacy");
                const before = await proposals();
                const beforeMentions = await mentions();
                await wake();
                await runAdvance("title");
                await drainActions();
                await expectRecorded(ACTION_ITEMS);
                expect.soft(await proposals()).toEqual(before);
                expect.soft(await mentions()).toEqual(beforeMentions);
            });

            it("B7 preserves the edited and untouched proposals when a rejection covers the original text", async () => {
                await seed("legacy");
                const [before] = await proposals();
                const text = "Draft the release notes and circulate them";
                const response = await editTask(
                    request(`tasks/${before.id}`, "PATCH", {
                        version: before.version,
                        text,
                    }),
                    { params: Promise.resolve({ taskId: before.id }) },
                );
                expect(
                    response.status,
                    JSON.stringify(await response.json()),
                ).toBe(200);
                const edited = await proposals();
                expect(edited[0]).toMatchObject({
                    id: before.id,
                    text,
                    version: 1,
                });
                expect(
                    await db()
                        .select({
                            fingerprint:
                                recordingTaskRejections.fingerprintHmac,
                        })
                        .from(recordingTaskRejections)
                        .where(
                            and(
                                eq(recordingTaskRejections.itemId, ITEM),
                                eq(recordingTaskRejections.userId, OWNER),
                            ),
                        ),
                ).toEqual([{ fingerprint: taskFingerprint(before.text) }]);
                await wake();
                await runAdvance();
                await drainActions();
                await expectRecorded(ACTION_ITEMS);
                expect(await proposals()).toEqual(edited);
            });

            it("B8 accepts the same proposal IDs displayed before the advance", async () => {
                await seed("legacy");
                await expectOpenReviewPreserved(ACTION_ITEMS);
            });

            it("B9 preserves the assignee and scope on an already shared item", async () => {
                await seed("legacy", { shared: true, namedSpeaker: true });
                const [before] = await proposals();
                expect(before.assignee).toBe(ASSIGNEE);
                const beforeMentions = await mentions();
                expect(beforeMentions).toMatchObject([
                    { taskId: before.id, view: "org" },
                ]);
                await wake();
                await runAdvance("title");
                await drainActions();
                await expectRecorded([SPEAKER_ITEM]);
                expect.soft(await proposals()).toEqual([before]);
                expect.soft(await mentions()).toEqual(beforeMentions);
            });

            it("B9 publishes an assignee and re-scopes the same proposal's mention during first publication", async () => {
                await seed("modern", {
                    namedSpeaker: true,
                    reviewSkipped: true,
                });
                const [before] = await proposals();
                const [mention] = await mentions();
                expect(mention.view).toBe("private");
                const placement = await mutate(file, "POST", {
                    folderId: "org-a",
                });
                expect(placement).toMatchObject({ placement: "shared" });
                const [published] = await proposals();
                const [person] = await db()
                    .select({ userId: people.userId })
                    .from(people)
                    .where(eq(people.id, published.assignee ?? ""));
                expect(person?.userId).toBe(ORG);
                expect(published).toMatchObject({
                    id: before.id,
                    position: before.position,
                    createdAt: before.createdAt,
                    assignee: before.assignee,
                });
                expect(await mentions()).toEqual([{ ...mention, view: "org" }]);
                expect(await actionJobs()).toHaveLength(0);
                await runAdvance("placement");
                await drainActions();
                expect(await actionJobs()).toHaveLength(0);
                expect(await proposals()).toEqual([published]);
            }, 15_000);
        });

        it.each([
            { shape: "modern", change: "replaced", items: CHANGED_ITEMS },
            {
                shape: "legacy",
                change: "added",
                items: [...ACTION_ITEMS, "Update the schedule"],
            },
            { shape: "legacy", change: "removed", items: [ACTION_ITEMS[0]] },
        ] as const)("C10 rebuilds when action items are $change with a $shape phase", async ({
            shape,
            items,
        }) => {
            await seed(shape);
            await setActionItems([...items]);
            await wake();
            await runAdvance("title");
            await drainActions();
            await expectApplied([...items]);
        });

        it.each([
            "legacy",
            "modern",
        ] as const)("C11 honors Process again with a %s phase", async (shape) => {
            await seed(shape);
            await mutate(processAgain, "POST", {}, "process-again");
            expect((await processing()).phases.categorize?.reason).toBe(
                "process_again",
            );
            await runAdvance("process-again");
            await drainActions();
            await expectApplied(ACTION_ITEMS);
        });

        it.each([
            "legacy",
            "modern",
        ] as const)("C12 honors a pending summary refresh with a %s phase", async (shape) => {
            await seed(shape);
            const generation = await wake("summary-input-changed");
            expect((await processing()).phases.categorize).toMatchObject({
                reason: "categorized",
                summaryRefresh: { id: SUMMARY, revision: 0, generation },
            });
            expect(
                (await gatherFacts(ITEM, "private", OWNER)).summary
                    .refreshRequested,
            ).toBe(true);
            await runAdvance("summary-input-changed");
            await drainActions();
            await expectApplied(ACTION_ITEMS);
        });

        it.each([
            "legacy",
            "modern",
        ] as const)("C13 preserves Plaud proposals across transcript revisions with a %s phase", async (shape) => {
            await seed(shape);
            const before = await proposals();
            expect(
                await upsertTranscription({
                    recordingId: ITEM,
                    userId: OWNER,
                    text: "Review the revised release plan.",
                    turns: [
                        {
                            speaker: "speaker_0",
                            startMs: 0,
                            endMs: 1000,
                            text: "Review the revised release plan.",
                        },
                    ],
                    detectedLanguage: null,
                    source: "riffado",
                    provider: "test",
                    model: "test",
                }),
            ).toEqual({ committed: true });
            expect(
                (await gatherFacts(ITEM, "private", OWNER)).content,
            ).toMatchObject({ ...INPUT, contentRevision: 1 });
            await runAdvance();
            await drainActions();
            expect.soft(await proposals()).toEqual(before);
            if (shape === "legacy") {
                await expectRecorded(ACTION_ITEMS, {
                    ...INPUT,
                    contentRevision: 1,
                });
            } else {
                expect(await actionJobs()).toHaveLength(0);
            }
        });

        it.each([
            "missing",
            "legacy",
        ] as const)("C14 applies the first set of proposals with a %s Summary phase", async (shape) => {
            await seed(shape, { hasProposals: false });
            expect(await proposals()).toEqual([]);
            await wake();
            await runAdvance("title");
            await drainActions();
            await expectApplied(ACTION_ITEMS);
        });

        describe("cross-review cases", () => {
            it.each([
                "summary-input-changed",
                "process-again",
            ] as const)("R1 honors %s after writing a Topics no_timings marker", async (reason) => {
                await seed("topics only");
                await db()
                    .update(transcriptions)
                    .set({ turns: null })
                    .where(
                        and(
                            eq(transcriptions.id, TRANSCRIPT),
                            eq(transcriptions.userId, OWNER),
                        ),
                    );
                if (reason === "process-again") {
                    await mutate(processAgain, "POST", {}, "process-again");
                } else {
                    await wake(reason);
                }
                expect(
                    (await gatherFacts(ITEM, "private", OWNER)).summary
                        .refreshRequested,
                ).toBe(true);
                await runAdvance(reason);
                expect(
                    (await processing()).phases.summary?.steps?.topics,
                ).toMatchObject({
                    state: "skipped",
                    reason: "no_timings",
                });
                await drainActions();
                await expectApplied(ACTION_ITEMS);
            });

            it.each([
                { change: "order", items: [...ACTION_ITEMS].reverse() },
                {
                    change: "punctuation",
                    items: ["Draft the release notes!", ACTION_ITEMS[1]],
                },
            ])("R2 rewrites a legacy import after a change in $change", async ({
                items,
            }) => {
                await seed("legacy");
                expect(items.map(taskFingerprint).sort()).toEqual(
                    ACTION_ITEMS.map(taskFingerprint).sort(),
                );
                expect(plaudActionItemsFingerprint(items)).not.toBe(
                    FINGERPRINT,
                );
                await setActionItems(items);
                await wake();
                await runAdvance("title");
                await drainActions();
                await expectApplied(items);
            });

            it("R2 rewrites proposals when import-derived fields differ", async () => {
                await seed("legacy");
                await db()
                    .update(recordingTasks)
                    .set({
                        dueDate: "2026-12-02",
                        duePhrase: encryptText("December 2"),
                        assigneeHint: encryptText("An earlier assignee"),
                    })
                    .where(TASK_SCOPE);
                await wake();
                await runAdvance("title");
                await drainActions();
                await expectApplied(ACTION_ITEMS);
                const rows = await db()
                    .select({
                        dueDate: recordingTasks.dueDate,
                        duePhrase: recordingTasks.duePhrase,
                        assigneeHint: recordingTasks.assigneeHint,
                    })
                    .from(recordingTasks)
                    .where(TASK_SCOPE);
                expect(rows).toEqual(
                    ACTION_ITEMS.map(() => ({
                        dueDate: null,
                        duePhrase: null,
                        assigneeHint: null,
                    })),
                );
            });

            it("R3 keeps legacy proposals when a newly added duplicate produces the same rows", async () => {
                await seed("legacy");
                const before = await proposals();
                const items = [...ACTION_ITEMS, `${ACTION_ITEMS[0]}!`];
                expect(taskFingerprint(items[2])).toBe(
                    taskFingerprint(items[0]),
                );
                await setActionItems(items);
                await wake();
                await runAdvance("title");
                await drainActions();
                await expectRecorded(items);
                expect(await proposals()).toEqual(before);
            });

            it("R3 rewrites modern proposals when a newly added duplicate changes the import fingerprint", async () => {
                await seed("modern");
                const items = [...ACTION_ITEMS, `${ACTION_ITEMS[0]}!`];
                expect(plaudActionItemsFingerprint(items)).not.toBe(
                    FINGERPRINT,
                );
                await setActionItems(items);
                await wake();
                await runAdvance("title");
                await drainActions();
                await expectRecorded(items);
                await expectRewrittenProposals(ACTION_ITEMS);
            });

            it("keeps an unchanged duplicate import and accepts the open review", async () => {
                await seed("legacy", { importedActionItems: DUPLICATE_ITEMS });
                expect((await proposals()).map(({ text }) => text)).toEqual(
                    ACTION_ITEMS,
                );
                await expectOpenReviewPreserved(DUPLICATE_ITEMS);
            });

            it("keeps archive-restored proposals with tied positions and accepts the open review", async () => {
                await seed("legacy");
                const archive = await tasksForArchive(
                    { kind: "owner", userId: OWNER },
                    [ITEM],
                    { proposals: true },
                );
                const [first, second] = archive.get(ITEM) ?? [];
                if (!first || !second)
                    throw new Error("expected two archived tasks");
                const later = "2020-01-02T12:00:00.000Z";
                await db().delete(recordingTasks).where(TASK_SCOPE);
                expect(
                    await restoreTaskArchive(await taskViewerById(OWNER), {
                        items: [
                            {
                                itemId: ITEM,
                                tasks: [{ ...second, createdAt: later }, first],
                            },
                        ],
                    }),
                ).toMatchObject({ tasks: 2 });
                expect(await proposals()).toMatchObject([
                    { id: first.id, position: 0, createdAt: CREATED_AT },
                    { id: second.id, position: 0, createdAt: new Date(later) },
                ]);
                await expectOpenReviewPreserved(ACTION_ITEMS);
            });

            it("keeps proposals interleaved with an accepted task and accepts the open review", async () => {
                await seed("legacy");
                const [first, second] = await proposals();
                const reviewedId = "legacy-reviewed-middle";
                const text = "Check the commissioning report";
                await db()
                    .update(recordingTasks)
                    .set({ position: 8 })
                    .where(and(TASK_SCOPE, eq(recordingTasks.id, second.id)));
                await db()
                    .insert(recordingTasks)
                    .values({
                        id: reviewedId,
                        itemId: ITEM,
                        userId: OWNER,
                        source: "plaud",
                        status: "open",
                        text: encryptText(text),
                        version: 1,
                        position: 4,
                        createdAt: CREATED_AT,
                        acceptedAt: CREATED_AT,
                        acceptedByUserId: OWNER,
                    });
                await db().insert(taskMentions).values({
                    taskId: reviewedId,
                    itemId: ITEM,
                    userId: OWNER,
                    view: "private",
                    contentSourceId: "plaud",
                    statementAt: CREATED_AT,
                    matchDecision: "home",
                });
                const items = [first.text, text, second.text];
                await setActionItems(items);
                await expectOpenReviewPreserved(items);
                const accepted = await db()
                    .select({
                        id: recordingTasks.id,
                        status: recordingTasks.status,
                        position: recordingTasks.position,
                        version: recordingTasks.version,
                    })
                    .from(recordingTasks)
                    .where(
                        and(
                            eq(recordingTasks.itemId, ITEM),
                            eq(recordingTasks.userId, OWNER),
                        ),
                    )
                    .orderBy(asc(recordingTasks.position));
                expect(accepted).toEqual([
                    { id: first.id, status: "open", position: 0, version: 1 },
                    { id: reviewedId, status: "open", position: 4, version: 1 },
                    { id: second.id, status: "open", position: 8, version: 1 },
                ]);
            });

            it("R3 removes the untouched duplicate created by a task edit", async () => {
                await seed("legacy");
                const [first, second] = await proposals();
                const response = await editTask(
                    request(`tasks/${second.id}`, "PATCH", {
                        version: second.version,
                        text: first.text,
                    }),
                    { params: Promise.resolve({ taskId: second.id }) },
                );
                expect(
                    response.status,
                    JSON.stringify(await response.json()),
                ).toBe(200);
                const [, edited] = await proposals();
                expect(edited).toMatchObject({
                    id: second.id,
                    text: first.text,
                    version: 1,
                });
                await wake();
                await runAdvance();
                await drainActions();
                await expectRecorded(ACTION_ITEMS);
                expect(await proposals()).toEqual([edited]);
            });

            it.each([
                "open",
                "done",
                "riffado",
                "rejected",
            ] as const)("R3 removes a duplicate when %s already covers its fingerprint", async (coveredBy) => {
                await seed("legacy");
                const [first, second] = await proposals();
                if (coveredBy === "rejected") {
                    await db()
                        .insert(recordingTaskRejections)
                        .values({
                            itemId: ITEM,
                            userId: OWNER,
                            fingerprintHmac: taskFingerprint(first.text),
                        });
                } else {
                    await db()
                        .insert(recordingTasks)
                        .values({
                            id: "alternate-task",
                            itemId: ITEM,
                            userId: OWNER,
                            status:
                                coveredBy === "riffado"
                                    ? "proposed"
                                    : coveredBy,
                            source:
                                coveredBy === "riffado" ? "riffado" : "plaud",
                            text: encryptText(first.text),
                            position: 2,
                            createdAt: CREATED_AT,
                        });
                }
                const coverage = and(
                    eq(recordingTasks.id, "alternate-task"),
                    eq(recordingTasks.userId, OWNER),
                );
                const before = await db()
                    .select()
                    .from(recordingTasks)
                    .where(coverage);
                await wake();
                await runAdvance("title");
                await drainActions();
                await expectRecorded(ACTION_ITEMS);
                await expectRewrittenProposals(
                    [second.text],
                    coveredBy === "rejected" ? 0 : 3,
                );
                expect(
                    await db().select().from(recordingTasks).where(coverage),
                ).toEqual(before);
            });

            it.each([
                "open",
                "done",
                "riffado",
            ] as const)("R3 keeps proposals when %s is the only row covering an item", async (coveredBy) => {
                await seed("legacy");
                const [first, second] = await proposals();
                await db()
                    .update(recordingTasks)
                    .set(
                        coveredBy === "riffado"
                            ? { source: "riffado" }
                            : { status: coveredBy, version: 1 },
                    )
                    .where(
                        and(
                            eq(recordingTasks.id, first.id),
                            eq(recordingTasks.userId, OWNER),
                        ),
                    );
                const beforeMentions = await mentions();
                await wake();
                await runAdvance("title");
                await drainActions();
                await expectRecorded(ACTION_ITEMS);
                expect.soft(await proposals()).toEqual([second]);
                expect.soft(await mentions()).toEqual(beforeMentions);
            });

            it("R4 applies the first proposals for an unbound Plaud-only job", async () => {
                await seed("missing", { hasProposals: false, plaudOnly: true });
                const facts = await gatherFacts(ITEM, "private", OWNER);
                const action = planAdvance(facts).actions.find(
                    (action) => action.type === "applyPlaudTasks",
                );
                if (!action) throw new Error("expected a Plaud action");
                delete action.keepMatchingProposals;
                await db()
                    .insert(asyncJobs)
                    .values({
                        userId: OWNER,
                        kind: PIPELINE_ACTION_JOB_KIND,
                        subjectId: `applyPlaudTasks:${ITEM}`,
                        payload: { itemId: ITEM, action },
                    });
                const run = await runNext(pipelineActionJobHandler);
                expect(run?.beforeSettlement).toBeUndefined();
                expect.soft(run?.result).toEqual({
                    outcome: { kind: "done", reason: "plaud_tasks" },
                });
                await expectRewrittenProposals(ACTION_ITEMS);
            });

            it("R4 records the fingerprint when an already-shared Plaud-only item gets its first proposals", async () => {
                await seed("missing", {
                    hasProposals: false,
                    plaudOnly: true,
                    shared: true,
                });
                await wake();
                await runAdvance("title");
                await drainActions();
                await expectRecorded(ACTION_ITEMS, {
                    ...INPUT,
                    contentSourceId: "plaud",
                });
                await expectRewrittenProposals(ACTION_ITEMS);
                expect((await mentions()).map(({ view }) => view)).toEqual([
                    "org",
                    "org",
                ]);
            });

            it("R5 finishes a pre-deploy bound job with one rewrite", async () => {
                await seed("legacy");
                await wake();
                await runAdvance("title");
                const [job] = await db()
                    .select()
                    .from(asyncJobs)
                    .where(
                        and(
                            eq(asyncJobs.kind, PIPELINE_ACTION_JOB_KIND),
                            eq(asyncJobs.userId, OWNER),
                        ),
                    );
                const { action } = pipelineActionJobHandler.parsePayload(
                    job.payload,
                );
                if (action.type !== "applyPlaudTasks")
                    throw new Error("expected a Plaud action");
                delete action.keepMatchingProposals;
                await db()
                    .update(asyncJobs)
                    .set({ payload: { ...job.payload, action } })
                    .where(
                        and(
                            eq(asyncJobs.id, job.id),
                            eq(asyncJobs.userId, OWNER),
                        ),
                    );
                await drainActions();
                await expectApplied(ACTION_ITEMS);
                const rewritten = await proposals();
                await runAdvance();
                await drainActions();
                expect(await actionJobs()).toHaveLength(1);
                expect(await proposals()).toEqual(rewritten);
            });

            it.each([
                "pending",
                "failed",
            ] as const)("R1 refreshes a %s legacy Summary step", async (state) => {
                await seed("topics only");
                const { phases } = await processing();
                if (!phases.summary?.steps)
                    throw new Error("expected Topics step");
                phases.summary.steps.summary = {
                    ...INPUT,
                    state,
                    generation: 1,
                };
                await db()
                    .update(itemProcessing)
                    .set({ phases })
                    .where(PROCESSING_SCOPE);
                await wake("summary-input-changed");
                await runAdvance("summary-input-changed");
                await drainActions();
                await expectApplied(ACTION_ITEMS);
            });

            it.each([
                "summary-input-changed",
                "process-again",
            ] as const)("R1 honors %s requested after the action was queued", async (reason) => {
                await seed("legacy");
                await wake();
                await runAdvance("title");
                if (reason === "process-again") {
                    await mutate(processAgain, "POST", {}, "process-again");
                    await runAdvance("process-again");
                } else {
                    await wake(reason);
                }
                await drainActions();
                await expectApplied(ACTION_ITEMS);
            });
        });
    },
);
