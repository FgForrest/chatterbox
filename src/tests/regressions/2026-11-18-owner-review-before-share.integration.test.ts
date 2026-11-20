import { eq } from "drizzle-orm";
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { GET as pendingReviews } from "@/app/api/learn/pending/route";
import { POST as fileRecording } from "@/app/api/recordings/[id]/folders/route";
import { POST as skipLearn } from "@/app/api/recordings/[id]/review/skip/route";
import { claimDueJobs, completeJob } from "@/db/queries/async-jobs";
import {
    aiEnhancements,
    apiCredentials,
    asyncJobs,
    chatterItems,
    folderDefaultProfiles,
    itemProcessing,
    learnRuns,
    mailPendingShares,
    processingProfileRevisions,
    processingProfiles,
    recordingFolderAssignments,
    recordingFolders,
    taskMentions,
    taskUpdateProposals,
    transcriptions,
    transcriptSpeakers,
    users,
} from "@/db/schema";
import { encrypt } from "@/lib/encryption";
import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import {
    addRecordingToFolder,
    moveRecordingBetweenFolders,
} from "@/lib/folders/folders";
import {
    changeFolderRestriction,
    previewFolderLift,
} from "@/lib/folders/restricted-folders";
import { clearAutoLearnHoldInTx } from "@/lib/learn/hold";
import { LEARN_JOB_KIND } from "@/lib/learn/learn-job";
import {
    pendingReviewCount,
    recordingsNeedingReview,
    reviewQueue,
} from "@/lib/learn/pending";
import { finishReview, loadReview } from "@/lib/learn/review";
import { ensureOrgAccount } from "@/lib/org/account";
import { pipelineActionJobHandler } from "@/lib/pipeline/action-job";
import { pipelineAdvanceJobHandler } from "@/lib/pipeline/advance-job";
import { gatherFacts } from "@/lib/pipeline/facts";
import { legacyPhases } from "@/lib/pipeline/legacy";
import { planAdvance } from "@/lib/pipeline/plan";
import {
    executeIntendedShares,
    recordIntendedPlacementInTx,
} from "@/lib/pipeline/share-intent";
import { updatePhaseInTx } from "@/lib/pipeline/state";
import { defaultProfileSettings } from "@/lib/profiles/settings";
import { requireRecordingView } from "@/lib/sharing/access";
import { loadShareGate } from "@/lib/sharing/load-share-gate";
import { isRecordingShared } from "@/lib/sharing/shared";
import { taskViewer } from "@/lib/tasks/access";
import {
    acceptReview,
    addTask,
    listRecordingTasks,
    mergeProposals,
    mergeTaskIntoTask,
    recordingsAwaitingTaskReview,
    skipTaskReview,
    tickUpdateProposal,
    touchTaskReview,
    undoTaskMatch,
    updateTask,
} from "@/lib/tasks/tasks";
import { insertRecordings } from "@/tests/integration/items";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const OWNER = "review-owner";
const ITEM = "review-item";
const TRANSCRIPT = "review-transcript";
const FOLDER = "review-organization-folder";
const MAIL = "review-mail";
const AT = new Date("2026-11-18T12:00:00Z");
const learnProblem = { kind: "learn_unfinished" };
const taskProblem = { kind: "tasks_unreviewed", waiting: "review" };
const summaryProblem = { kind: "tasks_unreviewed", waiting: "summary" };

const { dbRef, dbProxy, mockEnv } = vi.hoisted(() => {
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
        mockEnv: {
            IS_HOSTED: false,
            SELF_HOST_MODE: "shared",
            ORG_ACCOUNT_EMAIL: "org@example.test",
            ORG_ACCOUNT_PASSWORD: "organization-password",
            AUTO_SUMMARY_RATE_LIMIT_PER_HOUR: 60,
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            DATABASE_URL: "postgres://unused",
        },
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn(async (request: Request) => {
        const id = request.headers.get("x-test-user") ?? OWNER;
        return { user: { id, email: `${id}@example.test` } };
    }),
    requireApiSessionActor: vi.fn(async (request: Request) => {
        const id = request.headers.get("x-test-user") ?? OWNER;
        const user = { id, email: `${id}@example.test` };
        return { session: { user }, actor: { kind: "user", actorId: id } };
    }),
}));
vi.mock("@/lib/knowledge/availability", () => ({
    isLearnDeploymentAvailable: () => true,
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/webhooks/emit", () => ({
    emitEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/export/document-sidecars", () => ({
    refreshExistingRecordingSidecars: vi.fn().mockResolvedValue(undefined),
    exportRecordingSidecarsIfEnabled: vi.fn().mockResolvedValue(undefined),
}));

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

describeWithDatabase("owner review before first Organization share", () => {
    let database: TestPostgresDatabase;
    let orgUserId: string;
    const owner = () =>
        taskViewer({ id: OWNER, email: `${OWNER}@example.test` });
    const curator = () =>
        taskViewer({ id: orgUserId, email: "org@example.test" });
    const gate = () => loadShareGate(database.db, ITEM, OWNER);
    const share = (itemId = ITEM, folderId = FOLDER) =>
        addRecordingToFolder({
            userId: OWNER,
            recordingId: itemId,
            folderId,
        });
    const plan = async () =>
        planAdvance(await gatherFacts(ITEM, "private", OWNER));
    const propose = async (itemId = ITEM, text = "Send the draft") =>
        addTask(await owner(), itemId, { status: "proposed", text });
    const intendedPlacement = () =>
        database.db.transaction((tx) =>
            recordIntendedPlacementInTx(tx, {
                ownerUserId: OWNER,
                itemId: ITEM,
                folderId: FOLDER,
                canCurate: false,
            }),
        );
    const shared = () => isRecordingShared(ITEM, orgUserId);
    const addProvider = () =>
        database.db.insert(apiCredentials).values({
            userId: OWNER,
            provider: "openai",
            apiKey: encrypt("test-key"),
            defaultModel: "gpt-4o-mini",
            isDefaultEnhancement: true,
        });

    async function advance() {
        const [job] = await claimDueJobs("pipeline.advance", 1);
        if (!job) throw new Error("Expected a queued pipeline advance");
        const result = await pipelineAdvanceJobHandler.run({
            ...job,
            jobId: job.id,
            attempt: job.attempts,
            payload: pipelineAdvanceJobHandler.parsePayload(job.payload),
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
        const generation = result?.processedGeneration;
        if (typeof generation !== "number")
            throw new Error("Expected the pipeline to finish an advance");
        return generation;
    }

    async function runShare() {
        const [job] = await claimDueJobs("pipeline.action", 1);
        if (!job) throw new Error("Expected a queued share action");
        const result = await pipelineActionJobHandler.run({
            ...job,
            jobId: job.id,
            attempt: job.attempts,
            payload: pipelineActionJobHandler.parsePayload(job.payload),
            signal: new AbortController().signal,
            reportProgress: vi.fn(),
        });
        return {
            result,
            settle: () =>
                completeJob({
                    jobId: job.id,
                    claimToken: job.claimToken,
                    result: result ?? null,
                }),
        };
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "owner_share_gate",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);
    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 60_000);
    beforeEach(async () => {
        mockEnv.SELF_HOST_MODE = "shared";
        const db = database.db;
        await db.delete(users);
        await db
            .insert(users)
            .values({ id: OWNER, email: `${OWNER}@example.test` });
        orgUserId = (await ensureOrgAccount()) ?? "";
        const [root] = await db
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, orgUserId));
        await db.insert(recordingFolders).values(
            [FOLDER, `${FOLDER}-other`].map((id) => ({
                id,
                userId: orgUserId,
                parentId: root?.id,
                name: encryptText(id),
                nameHash: id,
                kind: "custom" as const,
            })),
        );
        await insertRecordings(db, {
            id: ITEM,
            userId: OWNER,
            deviceSn: "test-device",
            plaudFileId: "test-file",
            filename: encryptText("Review recording"),
            duration: 1_000,
            startTime: AT,
            endTime: AT,
            filesize: 1,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: "example/review.mp3",
            plaudVersion: "1",
        });
        await db.insert(transcriptions).values({
            id: TRANSCRIPT,
            userId: OWNER,
            recordingId: ITEM,
            source: "riffado",
            provider: "test",
            model: "test",
            text: encryptText("Send the draft"),
            turns: encryptJsonField([
                {
                    speaker: "speaker_0",
                    startMs: 0,
                    endMs: 1000,
                    text: "Send the draft",
                },
            ]),
        });
        await db.insert(transcriptSpeakers).values({
            transcriptionId: TRANSCRIPT,
            userId: OWNER,
            label: "speaker_0",
            source: "user",
            status: "confirmed",
            markedUnknown: true,
        });
        await db.insert(chatterItems).values({
            id: MAIL,
            userId: OWNER,
            kind: "mail",
            title: encryptText("Review mail"),
            occurredAt: AT,
        });
    });

    async function assignProfile(
        learn: boolean,
        summary = false,
        folder = false,
    ) {
        const db = database.db;
        const settings = defaultProfileSettings("audio");
        settings.steps.trim.automatic = false;
        settings.steps.learn.automatic = learn;
        settings.steps.learn.correctAfterLearn = false;
        settings.steps.summary.automatic = summary;
        settings.steps.topics.automatic = false;
        settings.steps.title.automatic = false;
        await db.insert(processingProfiles).values({
            id: "review-profile",
            ownerUserId: folder ? orgUserId : OWNER,
            scope: folder ? "organization" : "personal",
            channel: "audio",
            name: encryptText("Review profile"),
            currentRevisionId: "review-revision",
        });
        await db.insert(processingProfileRevisions).values({
            id: "review-revision",
            profileId: "review-profile",
            settings: encryptText(JSON.stringify(settings)),
        });
        if (folder) {
            await db.insert(folderDefaultProfiles).values({
                folderId: FOLDER,
                channel: "audio",
                profileId: "review-profile",
            });
            return;
        }
        const patch = {
            profileId: "review-profile",
            profileRevisionId: "review-revision",
            phases: {
                categorize: {
                    state: "done" as const,
                    reason: "categorized",
                    generation: 1,
                    at: AT.toISOString(),
                },
            },
        };
        await db
            .insert(itemProcessing)
            .values({ itemId: ITEM, userId: OWNER, view: "private", ...patch })
            .onConflictDoUpdate({
                target: [itemProcessing.itemId, itemProcessing.view],
                set: patch,
            });
    }

    it("publishes after a blocked share settles behind a completed review advance", async () => {
        await assignProfile(false);
        await intendedPlacement();
        await advance();
        await propose();
        const blocked = await runShare();
        expect(blocked.result).toMatchObject({
            outcome: {
                kind: "waiting",
                reason: "gate_blocked",
                problems: [taskProblem],
            },
        });

        await acceptReview(await owner(), ITEM);
        const reviewAdvance = await advance();
        expect(await claimDueJobs("pipeline.advance", 1)).toEqual([]);
        expect(await shared()).toBe(false);

        expect(await blocked.settle()).toBe(true);
        const following = await advance();
        expect(following).toBeGreaterThan(reviewAdvance);
        const publish = await runShare();
        expect(publish.result).toMatchObject({
            outcome: { kind: "done", reason: "shared" },
        });
        expect(await publish.settle()).toBe(true);
        expect(await shared()).toBe(true);
    });

    it.each([
        "skipped",
        "failed",
    ] as const)("requires a %s summary to match the preferred transcript revision", async (state) => {
        const db = database.db;
        await assignProfile(false, true);
        await db.transaction((tx) =>
            updatePhaseInTx(tx, ITEM, "private", OWNER, "summary", {
                state,
                reason: "provider_error",
                generation: 1,
                at: AT.toISOString(),
                steps: {
                    summary: {
                        state,
                        reason: "provider_error",
                        generation: 1,
                        contentId: TRANSCRIPT,
                        contentSourceId: "riffado",
                        contentRevision: 0,
                    },
                },
            }),
        );
        expect(await gate()).toEqual([]);
        await db
            .update(transcriptions)
            .set({ revision: 1 })
            .where(eq(transcriptions.id, TRANSCRIPT));
        await expect(share()).rejects.toMatchObject({
            statusCode: 409,
            details: { problems: [summaryProblem] },
        });
    });

    it("waits to retry a current no-provider Summary after a provider becomes available", async () => {
        await assignProfile(false, true);
        await intendedPlacement();
        await advance();
        expect(await gate()).toEqual([]);
        await addProvider();
        expect(await gate()).toEqual([summaryProblem]);
        expect((await plan()).actions).toContainEqual(
            expect.objectContaining({ type: "queueSummary" }),
        );
    });

    it("binds an unprofiled recording to the filing profile and shares it after Learn and task review", async () => {
        const db = database.db;
        await assignProfile(true, false, true);
        await addProvider();
        const response = await fileRecording(
            new Request(`http://localhost/api/recordings/${ITEM}/folders`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ folderId: FOLDER }),
            }),
            { params: Promise.resolve({ id: ITEM }) },
        );
        expect(response.ok).toBe(true);
        expect(await shared()).toBe(false);
        expect(await db.select().from(mailPendingShares)).toMatchObject([
            { itemId: ITEM, userId: OWNER, folderId: FOLDER },
        ]);
        expect(await db.select().from(itemProcessing)).toMatchObject([
            {
                itemId: ITEM,
                userId: OWNER,
                profileId: "review-profile",
                profileRevisionId: "review-revision",
            },
        ]);
        await advance();
        const [run] = await db
            .select()
            .from(learnRuns)
            .where(eq(learnRuns.itemId, ITEM));
        expect(run).toMatchObject({
            status: "queued",
            view: "private",
            trigger: "auto",
            transcriptionId: TRANSCRIPT,
        });

        const [job] = await claimDueJobs(LEARN_JOB_KIND, 1);
        expect(job?.id).toBe(run?.jobId);
        if (!job || !run) throw new Error("Expected automatic Learn");
        await db
            .update(learnRuns)
            .set({ status: "ready" })
            .where(eq(learnRuns.id, run.id));
        expect(
            await completeJob({
                jobId: job.id,
                claimToken: job.claimToken,
                result: {
                    outcome: {
                        kind: "waiting",
                        reason: "review_pending",
                        waitingFor: { kind: "learnReview" },
                    },
                },
            }),
        ).toBe(true);
        await propose();
        expect(await gate()).toEqual([learnProblem, taskProblem]);
        await expect(
            finishReview(
                await requireRecordingView(OWNER, ITEM, "private"),
                OWNER,
            ),
        ).resolves.toMatchObject({ status: "finished" });
        expect(await gate()).toEqual([taskProblem]);
        await advance();
        expect(await shared()).toBe(false);
        await acceptReview(await owner(), ITEM);
        await advance();
        const publish = await runShare();
        expect(await publish.settle()).toBe(true);
        expect(await shared()).toBe(true);
    });

    it("keeps a blocked move in its original folder until the owner reviews tasks", async () => {
        const db = database.db;
        const fromFolderId = "personal-filing-folder";
        await db.insert(recordingFolders).values({
            id: fromFolderId,
            userId: OWNER,
            kind: "custom",
            name: encryptText("Personal"),
            nameHash: "personal-filing-folder",
        });
        await share(ITEM, fromFolderId);
        await assignProfile(false);
        await propose();
        const move = () =>
            moveRecordingBetweenFolders({
                userId: OWNER,
                recordingId: ITEM,
                fromFolderId,
                toFolderId: FOLDER,
            });
        await expect(move()).rejects.toMatchObject({
            statusCode: 409,
            details: { problems: [taskProblem] },
        });
        expect(await shared()).toBe(false);
        expect(
            await db
                .select()
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.itemId, ITEM)),
        ).toMatchObject([{ folderId: fromFolderId }]);
        await acceptReview(await owner(), ITEM);
        await expect(move()).resolves.toEqual({
            placement: "shared",
            removal: "removed",
        });
        expect(await shared()).toBe(true);
    });

    it("keeps a restricted placement withheld on lift and publishes it after review", async () => {
        await assignProfile(false);
        await changeFolderRestriction(orgUserId, FOLDER, "restrict", [OWNER]);
        await share();
        await propose();
        expect(await previewFolderLift(orgUserId, FOLDER)).toMatchObject({
            pending: [{ id: ITEM, problems: [taskProblem] }],
        });
        await changeFolderRestriction(orgUserId, FOLDER, "lift");
        expect(await shared()).toBe(false);
        expect(
            await database.db.select().from(mailPendingShares),
        ).toMatchObject([{ itemId: ITEM, folderId: FOLDER }]);
        await acceptReview(await owner(), ITEM);
        await advance();
        const publish = await runShare();
        expect(await publish.settle()).toBe(true);
        expect(await shared()).toBe(true);
    });

    it("skips failed Learn even when the phase still names its dead job", async () => {
        const db = database.db;
        await assignProfile(true);
        await intendedPlacement();
        const runId = await learnRun("failed");
        const jobId = "dead-learn-job";
        const due = new Date(Date.now() + 60_000);
        await db
            .update(chatterItems)
            .set({ summaryDueAt: due })
            .where(eq(chatterItems.id, ITEM));
        await db
            .update(learnRuns)
            .set({ jobId })
            .where(eq(learnRuns.id, runId));
        await db.transaction((tx) =>
            updatePhaseInTx(tx, ITEM, "private", OWNER, "learn", {
                jobId,
                state: "running",
                reason: "started",
                generation: 1,
                inputs: {
                    contentId: TRANSCRIPT,
                    contentSourceId: "riffado",
                    contentRevision: 0,
                },
                at: AT.toISOString(),
            }),
        );
        expect(await gate()).toEqual([learnProblem]);
        expect((await skip(runId)).status).toBe(200);
        expect((await skip(runId)).status).toBe(200);
        const facts = await gatherFacts(ITEM, "private", OWNER);
        expect(facts.phases.learn).toMatchObject({
            state: "skipped",
            reason: "owner_skipped",
        });
        expect(facts.phases.learn?.jobId).toBeUndefined();
        expect(facts.summaryDueAt).toBeNull();
        expect(await gate()).toEqual([]);
        await advance();
        const publish = await runShare();
        expect(await publish.settle()).toBe(true);
        expect(await shared()).toBe(true);
    });

    it("clears a Learn hold only for the specified owner", async () => {
        const db = database.db;
        const due = new Date(Date.now() + 60_000);
        await db
            .update(chatterItems)
            .set({ summaryDueAt: due })
            .where(eq(chatterItems.id, ITEM));
        const hold = () =>
            db
                .select({ summaryDueAt: chatterItems.summaryDueAt })
                .from(chatterItems)
                .where(eq(chatterItems.id, ITEM));
        await db.transaction((tx) =>
            clearAutoLearnHoldInTx(tx, ITEM, orgUserId),
        );
        expect(await hold()).toEqual([{ summaryDueAt: due }]);
        await db.transaction((tx) => clearAutoLearnHoldInTx(tx, ITEM, OWNER));
        expect(await hold()).toEqual([{ summaryDueAt: null }]);
    });

    it.each([
        "match",
        "follow-up",
    ] as const)("wakes a different recording's intended share when closing its last %s target", async (decision) => {
        const db = database.db;
        const viewer = await owner();
        const target = await addTask(viewer, MAIL, {
            status: "open",
            text: "Send the draft",
        });
        await assignProfile(false);
        await intendedPlacement();
        if (decision === "match") {
            await db.insert(taskMentions).values({
                itemId: ITEM,
                userId: OWNER,
                taskId: target.id,
                view: "private",
                matchDecision: "suggested",
                statementAt: AT,
            });
        } else {
            await db.insert(taskUpdateProposals).values({
                itemId: ITEM,
                userId: OWNER,
                taskId: target.id,
                kind: "done",
                state: "awaiting_source_review",
            });
        }
        expect(await gate()).toEqual([taskProblem]);
        await advance();
        expect(await claimDueJobs("pipeline.advance", 1)).toEqual([]);
        expect(await shared()).toBe(false);

        await updateTask(viewer, target.id, {
            version: target.version,
            status: "done",
        });
        expect(await gate()).toEqual([]);
        await advance();
        const publish = await runShare();
        expect(await publish.settle()).toBe(true);
        expect(await shared()).toBe(true);
    });

    it("includes task proposals on mail owned by the Organization account", async () => {
        const orgMail = "organization-owned-mail";
        await database.db.insert(chatterItems).values({
            id: orgMail,
            userId: orgUserId,
            kind: "mail",
            title: encryptText("Organization mail"),
            occurredAt: AT,
        });
        await database.db.insert(recordingFolderAssignments).values({
            itemId: orgMail,
            userId: orgUserId,
            folderId: FOLDER,
        });
        const asCurator = await curator();
        await addTask(asCurator, orgMail, {
            status: "proposed",
            text: "Send a reply",
        });
        await propose(MAIL);
        expect(await recordingsAwaitingTaskReview(asCurator)).toMatchObject([
            { recordingId: orgMail, kind: "mail", proposals: 1 },
        ]);
        const response = await pendingReviews(
            new Request("http://localhost/api/learn/pending", {
                headers: { "x-test-user": orgUserId },
            }),
        );
        await expect(response.json()).resolves.toEqual({ count: 1 });
    });

    it("uses the private review scope in local mode even when an Organization placement remains", async () => {
        await assignProfile(false);
        await share();
        await learnRun("ready", "org");
        const earlier = await addTask(await owner(), MAIL, {
            status: "open",
            text: "Send the draft",
        });
        await database.db.insert(taskMentions).values({
            itemId: ITEM,
            userId: OWNER,
            taskId: earlier.id,
            view: "private",
            matchDecision: "suggested",
            statementAt: AT,
        });
        expect(await reviewQueue(OWNER)).toMatchObject([
            { id: ITEM, view: "org" },
        ]);
        expect(await recordingsAwaitingTaskReview(await owner())).toEqual([]);

        mockEnv.SELF_HOST_MODE = "local";
        await expect(
            requireRecordingView(OWNER, ITEM, "org"),
        ).rejects.toMatchObject({ statusCode: 404 });
        expect(await reviewQueue(OWNER)).toEqual([]);
        expect(await pendingReviewCount(OWNER)).toBe(0);
        expect(await recordingsNeedingReview(OWNER)).toEqual(new Set());
        expect(await recordingsAwaitingTaskReview(await owner())).toMatchObject(
            [{ recordingId: ITEM, proposals: 1 }],
        );
    });

    async function learnRun(
        status: typeof learnRuns.$inferInsert.status,
        view: "private" | "org" = "private",
        transcriptionId = TRANSCRIPT,
    ) {
        const [row] = await database.db
            .insert(learnRuns)
            .values({
                itemId: ITEM,
                userId: OWNER,
                scopeUserId: view === "org" ? orgUserId : OWNER,
                transcriptionId,
                transcriptRevision: 0,
                vocabularyVersion: 0,
                view,
                trigger: "auto",
                status,
            })
            .returning({ id: learnRuns.id });
        if (!row) throw new Error("Learn fixture missing");
        return row.id;
    }

    function skip(runId: string, actor = OWNER, view = "private") {
        return skipLearn(
            new Request(
                `http://localhost/api/recordings/${ITEM}/review/skip?view=${view}`,
                {
                    method: "POST",
                    headers: {
                        "x-test-user": actor,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({ runId }),
                },
            ),
            { params: Promise.resolve({ id: ITEM }) },
        );
    }

    it.each([
        false,
        true,
    ])("lets only the owner skip a failed Learn run for its current revision (revised: %s)", async (revised) => {
        const db = database.db;
        await assignProfile(true);
        await db.transaction((tx) =>
            recordIntendedPlacementInTx(tx, {
                ownerUserId: OWNER,
                itemId: ITEM,
                folderId: FOLDER,
                canCurate: false,
            }),
        );
        await db
            .update(chatterItems)
            .set({ summaryDueAt: new Date(Date.now() + 60_000) })
            .where(eq(chatterItems.id, ITEM));
        const runId = await learnRun("failed");
        const access = await requireRecordingView(OWNER, ITEM, "private");
        expect(await loadReview(access, "riffado")).toMatchObject({
            run: { id: runId, status: "failed", skipAvailable: true },
        });
        expect(await gate()).toEqual([learnProblem]);
        const before = (await gatherFacts(ITEM, "private", OWNER)).generation;
        expect((await skip(runId, orgUserId)).status).toBeOneOf([403, 404]);
        expect((await skip(runId, "unrelated-user")).status).toBeOneOf([
            403, 404,
        ]);
        expect(await gate()).toEqual([learnProblem]);
        const skipped = await Promise.all([skip(runId), skip(runId)]);
        expect(skipped.map(({ status }) => status)).toEqual([200, 200]);
        expect(await loadReview(access, "riffado")).toMatchObject({
            run: {
                id: runId,
                status: "cancelled",
                skipAvailable: false,
                ownerSkipped: true,
            },
        });
        const after = await gatherFacts(ITEM, "private", OWNER);
        expect(after.generation).toBe(before + 1);
        expect(after.summaryDueAt).toBeNull();
        expect(after.phases.learn).toMatchObject({
            state: "skipped",
            reason: "owner_skipped",
            inputs: { contentId: TRANSCRIPT, contentRevision: 0 },
        });
        expect(await gate()).toEqual([]);
        const planned = planAdvance({
            ...after,
            learnAvailability: "available",
        });
        expect(planned.actions).toContainEqual({ type: "executeShares" });
        expect(planned.actions).not.toContainEqual(
            expect.objectContaining({ type: "startAutoLearn" }),
        );
        if (revised) {
            await db
                .update(transcriptions)
                .set({ revision: 1 })
                .where(eq(transcriptions.id, TRANSCRIPT));
            expect(await gate()).toEqual([learnProblem]);
            expect((await skip(runId)).status).toBe(404);
            const revisedFacts = await gatherFacts(ITEM, "private", OWNER);
            expect(
                planAdvance({ ...revisedFacts, learnAvailability: "available" })
                    .actions,
            ).toContainEqual(
                expect.objectContaining({
                    type: "startAutoLearn",
                    input: expect.objectContaining({ contentRevision: 1 }),
                }),
            );
        } else {
            expect(await executeIntendedShares(OWNER, ITEM)).toEqual([]);
            const orgRun = await learnRun("failed", "org");
            expect((await skip(orgRun, orgUserId, "org")).status).toBe(403);
            expect((await skip(orgRun)).status).toBe(403);
        }
    });

    it("publishes an intended legacy recording only after the owner resolves its task review", async () => {
        const db = database.db;
        await assignProfile(false);
        await db
            .update(itemProcessing)
            .set({
                phases: legacyPhases({
                    kind: "audio",
                    hasPlacement: true,
                    content: { id: TRANSCRIPT, revision: 0 },
                }),
            })
            .where(eq(itemProcessing.itemId, ITEM));
        await db.transaction((tx) =>
            recordIntendedPlacementInTx(tx, {
                ownerUserId: OWNER,
                itemId: ITEM,
                folderId: FOLDER,
                canCurate: false,
            }),
        );
        await propose();
        const blocked = await plan();
        expect(blocked.actions).toContainEqual(
            expect.objectContaining({
                phase: "share",
                record: expect.objectContaining({
                    state: "waiting",
                    problems: [taskProblem],
                }),
            }),
        );
        expect(blocked.actions).not.toContainEqual({ type: "executeShares" });
        expect(await executeIntendedShares(OWNER, ITEM)).toEqual([taskProblem]);
        await acceptReview(await owner(), ITEM);
        expect((await plan()).actions).toEqual([{ type: "executeShares" }]);
        expect(await executeIntendedShares(OWNER, ITEM)).toEqual([]);
    });

    it("ignores failed or ready Learn on a non-preferred transcript", async () => {
        const db = database.db;
        await assignProfile(true);
        const imported = "review-plaud-transcript";
        await db.insert(transcriptions).values({
            id: imported,
            userId: OWNER,
            recordingId: ITEM,
            source: "plaud",
            provider: "plaud",
            model: "test",
            text: encryptText("Imported words"),
        });
        const failed = await learnRun("failed", "private", imported);
        expect((await skip(failed)).status).toBe(404);
        await learnRun("finished");
        expect(await gate()).toEqual([]);
        await db
            .update(learnRuns)
            .set({ status: "ready" })
            .where(eq(learnRuns.id, failed));
        expect(await gate()).toEqual([]);
    });

    it.each([
        "finish",
        "skip",
    ] as const)("unblocks the intended share after the owner chooses %s in the reviews", async (decision) => {
        const db = database.db;
        await assignProfile(true);
        await db.transaction((tx) =>
            recordIntendedPlacementInTx(tx, {
                ownerUserId: OWNER,
                itemId: ITEM,
                folderId: FOLDER,
                canCurate: false,
            }),
        );
        expect(await gate()).toEqual([learnProblem]);
        await expect(share()).rejects.toMatchObject({
            statusCode: 409,
            details: { problems: [learnProblem] },
        });
        const runId = await learnRun("queued");
        for (const status of [
            "queued",
            "running",
            "failed",
            "ready",
        ] as const) {
            await db
                .update(learnRuns)
                .set({ status })
                .where(eq(learnRuns.id, runId));
            expect(await gate()).toEqual([learnProblem]);
        }
        await propose();
        expect(await gate()).toEqual([learnProblem, taskProblem]);
        expect(await executeIntendedShares(OWNER, ITEM)).toEqual([
            learnProblem,
            taskProblem,
        ]);
        expect((await plan()).actions).toContainEqual(
            expect.objectContaining({
                phase: "share",
                record: expect.objectContaining({
                    state: "waiting",
                    reason: "gate_blocked",
                    problems: [learnProblem, taskProblem],
                }),
            }),
        );
        const before = (await gatherFacts(ITEM, "private", OWNER)).generation;
        await expect(
            finishReview(
                await requireRecordingView(OWNER, ITEM, "private"),
                OWNER,
                {
                    quick: decision === "skip",
                },
            ),
        ).resolves.toMatchObject({ status: "finished" });
        expect(
            (await gatherFacts(ITEM, "private", OWNER)).generation,
        ).toBeGreaterThan(before);
        expect(await gate()).toEqual([taskProblem]);

        const viewer = await owner();
        const beforeTaskReview = (await gatherFacts(ITEM, "private", OWNER))
            .generation;
        if (decision === "skip") await skipTaskReview(viewer, ITEM);
        else await acceptReview(viewer, ITEM);
        expect(
            (await gatherFacts(ITEM, "private", OWNER)).generation,
        ).toBeGreaterThan(beforeTaskReview);
        expect(await gate()).toEqual([]);
        expect((await plan()).actions).toContainEqual({
            type: "executeShares",
        });
        expect(await executeIntendedShares(OWNER, ITEM)).toEqual([]);
        expect(
            (await listRecordingTasks(viewer, ITEM))?.taskReviewSkipped,
        ).toBe(decision === "skip");
    });

    it("waits for a summary expected by the effective profile, including queued and active jobs", async () => {
        const db = database.db;
        await assignProfile(false, true);
        await db.transaction((tx) =>
            recordIntendedPlacementInTx(tx, {
                ownerUserId: OWNER,
                itemId: ITEM,
                folderId: FOLDER,
                canCurate: false,
            }),
        );
        const [processing] = await db
            .select({ phases: itemProcessing.phases })
            .from(itemProcessing)
            .where(eq(itemProcessing.itemId, ITEM));
        const categorize = processing?.phases.categorize;
        if (!categorize) throw new Error("categorize fixture missing");
        await db
            .update(itemProcessing)
            .set({
                phases: {
                    ...processing.phases,
                    categorize: { ...categorize, arrivalGeneration: 1 },
                },
            })
            .where(eq(itemProcessing.itemId, ITEM));
        await db.insert(aiEnhancements).values({
            itemId: ITEM,
            userId: OWNER,
            transcriptionId: TRANSCRIPT,
            summary: encryptText("Imported summary"),
            source: "plaud",
            provider: "test",
            model: "test",
        });
        expect(await gate()).toEqual([summaryProblem]);
        await db.transaction((tx) =>
            updatePhaseInTx(tx, ITEM, "private", OWNER, "summary", {
                state: "done",
                reason: "generated",
                at: AT.toISOString(),
                generation: 3,
                steps: {
                    summary: {
                        state: "done",
                        reason: "generated",
                        generation: 3,
                        contentId: TRANSCRIPT,
                        contentSourceId: "riffado",
                        contentRevision: 0,
                    },
                },
            }),
        );
        expect(await gate()).toEqual([]);
        await db.insert(asyncJobs).values({
            id: "review-summary-job",
            kind: "summary",
            subjectId: ITEM,
            userId: OWNER,
            status: "pending",
            payload: {},
        });
        expect(await gate()).toEqual([summaryProblem]);
        await db
            .update(asyncJobs)
            .set({ status: "processing" })
            .where(eq(asyncJobs.id, "review-summary-job"));
        expect(await gate()).toEqual([summaryProblem]);
        await db
            .update(asyncJobs)
            .set({ status: "completed" })
            .where(eq(asyncJobs.id, "review-summary-job"));
        expect(await gate()).toEqual([]);
    });

    it("replans a share when the workflow skips unavailable automatic steps", async () => {
        const db = database.db;
        await assignProfile(true, true);
        await db.transaction((tx) =>
            recordIntendedPlacementInTx(tx, {
                ownerUserId: OWNER,
                itemId: ITEM,
                folderId: FOLDER,
                canCurate: false,
            }),
        );
        expect(await gate()).toEqual([learnProblem, summaryProblem]);

        await pipelineAdvanceJobHandler.run({
            jobId: "review-advance",
            userId: OWNER,
            attempt: 1,
            maxAttempts: 10,
            payload: { itemId: ITEM, view: "private", reason: "placement" },
            signal: new AbortController().signal,
            reportProgress: vi.fn(),
        });
        expect(await gate()).toEqual([]);
        expect(
            await db
                .select({ payload: asyncJobs.payload })
                .from(asyncJobs)
                .where(eq(asyncJobs.kind, "pipeline.action")),
        ).toContainEqual(
            expect.objectContaining({
                payload: expect.objectContaining({
                    action: { type: "executeShares" },
                }),
            }),
        );
    });

    it("keeps shared proposals with their owners, including mail and Organization reruns", async () => {
        const db = database.db;
        await assignProfile(true);
        await learnRun("finished");
        await share();
        const first = await propose();
        await propose(ITEM, "Prepare the notes");
        const mail = await propose(MAIL);
        const [mailRun] = await db
            .insert(learnRuns)
            .values({
                itemId: MAIL,
                userId: OWNER,
                scopeUserId: OWNER,
                view: "private",
                transcriptRevision: 0,
                vocabularyVersion: 0,
                trigger: "auto",
                status: "ready",
            })
            .returning({ id: learnRuns.id });
        await expect(share(MAIL)).resolves.toBe("shared");
        expect(
            await db
                .select({ status: learnRuns.status })
                .from(learnRuns)
                .where(eq(learnRuns.id, mailRun.id)),
        ).toEqual([{ status: "cancelled" }]);
        await learnRun("ready", "org");

        const asOwner = await owner();
        const asCurator = await curator();
        expect(await gate()).toEqual([]);
        await expect(share(ITEM, `${FOLDER}-other`)).resolves.toBe("filed");
        expect(await loadShareGate(db, MAIL, OWNER)).toEqual([]);
        expect(await pendingReviewCount(OWNER)).toBe(1);
        expect(await pendingReviewCount(orgUserId)).toBe(0);
        expect(await recordingsNeedingReview(OWNER)).toEqual(new Set([ITEM]));
        expect(await recordingsNeedingReview(orgUserId)).toEqual(new Set());
        expect(await reviewQueue(OWNER)).toMatchObject([
            { id: ITEM, view: "org" },
        ]);
        expect(await reviewQueue(orgUserId)).toEqual([]);
        expect(
            (await recordingsAwaitingTaskReview(asOwner))
                .map(({ recordingId }) => recordingId)
                .sort(),
        ).toEqual([ITEM, MAIL].sort());
        expect(await recordingsAwaitingTaskReview(asCurator)).toEqual([]);
        for (const [userId, count] of [
            [OWNER, 3],
            [orgUserId, 0],
        ] as const) {
            const response = await pendingReviews(
                new Request("http://localhost/api/learn/pending", {
                    headers: { "x-test-user": userId },
                }),
            );
            await expect(response.json()).resolves.toEqual({ count });
        }

        const accepted = await addTask(asOwner, ITEM, {
            status: "open",
            text: "Confirm the date",
        });
        const [followUp] = await db
            .insert(taskUpdateProposals)
            .values({
                itemId: ITEM,
                userId: OWNER,
                taskId: accepted.id,
                kind: "done",
            })
            .returning({
                id: taskUpdateProposals.id,
                version: taskUpdateProposals.version,
            });
        const [match] = await db
            .insert(taskMentions)
            .values({
                itemId: ITEM,
                userId: OWNER,
                taskId: accepted.id,
                view: "org",
                matchDecision: "suggested",
                statementAt: AT,
            })
            .returning({ id: taskMentions.id });
        const linked = await addTask(asOwner, MAIL, {
            status: "open",
            text: "Reserve a room",
        });
        await db.insert(taskMentions).values({
            itemId: ITEM,
            userId: OWNER,
            taskId: linked.id,
            view: "org",
            matchDecision: "accepted",
            statementAt: AT,
        });

        expect(await listRecordingTasks(asCurator, ITEM)).toMatchObject({
            canEdit: true,
            tasks: expect.arrayContaining([
                expect.objectContaining({ id: linked.id, canUndoMatch: false }),
            ]),
            proposals: [],
            updates: [],
            matches: [],
        });
        expect(await listRecordingTasks(asOwner, ITEM)).toMatchObject({
            tasks: expect.arrayContaining([
                expect.objectContaining({ id: linked.id, canUndoMatch: true }),
            ]),
        });
        expect(await listRecordingTasks(asCurator, MAIL)).toMatchObject({
            proposals: [],
        });
        for (const action of [
            () => acceptReview(asCurator, ITEM),
            () => acceptReview(asCurator, MAIL),
            () =>
                updateTask(asCurator, first.id, {
                    version: first.version,
                    ticked: false,
                }),
            () =>
                updateTask(asCurator, mail.id, {
                    version: mail.version,
                    ticked: false,
                }),
            () =>
                tickUpdateProposal(
                    asCurator,
                    ITEM,
                    followUp?.id ?? "",
                    true,
                    followUp?.version ?? 0,
                ),
            () =>
                tickUpdateProposal(
                    asCurator,
                    ITEM,
                    match?.id ?? "",
                    true,
                    accepted.version,
                ),
            async () =>
                mergeProposals(
                    asCurator,
                    ITEM,
                    (await listRecordingTasks(asOwner, ITEM))?.proposals.map(
                        ({ id }) => id,
                    ) ?? [],
                ),
            () =>
                mergeTaskIntoTask(asCurator, first.id, accepted.id, {
                    reviewItemId: ITEM,
                }),
            () => skipTaskReview(asCurator, ITEM),
            () => touchTaskReview(asCurator, ITEM),
            () => undoTaskMatch(asCurator, ITEM, linked.id),
        ]) {
            await expect(action()).rejects.toMatchObject({
                statusCode: expect.toBeOneOf([403, 404]),
            });
        }
        await expect(
            updateTask(asCurator, accepted.id, {
                version: accepted.version,
                text: "Confirm the new date",
            }),
        ).resolves.toMatchObject({
            text: "Confirm the new date",
            canEdit: true,
        });
        await expect(acceptReview(asOwner, ITEM)).resolves.toMatchObject({
            accepted: 2,
        });
    });
});
