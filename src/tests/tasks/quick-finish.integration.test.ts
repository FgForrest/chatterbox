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
    itemProcessing,
    knowledgeFactEvidence,
    learnDismissals,
    learnReviewItems,
    learnRuns,
    people,
    processingProfileRevisions,
    processingProfiles,
    recordingFolderAssignments,
    recordingFolders,
    recordingTaskRejections,
    recordingTasks,
    transcriptCorrectionPasses,
    transcriptCorrections,
    transcriptions,
    transcriptSpeakers,
    users,
} from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef, mockEnv } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    return {
        dbRef: ref,
        dbProxy: new Proxy(
            {},
            {
                get: (_target, key) => {
                    const value = ref.current?.[key];
                    return typeof value === "function"
                        ? value.bind(ref.current)
                        : value;
                },
            },
        ),
        mockEnv: {
            IS_HOSTED: false,
            SELF_HOST_MODE: "shared",
            AUTHZ_MODE: "local",
            ORG_ACCOUNT_EMAIL: "org@example.test",
            ORG_ACCOUNT_PASSWORD: "test-password",
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            DATABASE_URL: "postgres://unused",
        },
    };
});
vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/export/document-sidecars", () => ({
    refreshExistingRecordingSidecars: vi.fn(),
    exportRecordingSidecarsIfEnabled: vi.fn(),
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/webhooks/emit", () => ({ emitEvent: vi.fn() }));

import { encrypt } from "@/lib/encryption";
import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import { addRecordingToFolder, unshareRecording } from "@/lib/folders/folders";
import { createEntity } from "@/lib/knowledge/entities";
import { confirmManualFact } from "@/lib/knowledge/facts";
import { knowledgeStore } from "@/lib/knowledge/knowledge-loader";
import { seedCoreVocabulary } from "@/lib/knowledge/vocabulary";
import { learnJobHandler } from "@/lib/learn/learn-job-handler";
import {
    decideReviewItem,
    finishKnownFactsOnly,
    finishReview,
    learnQuickFinishPolicy,
    loadReview,
} from "@/lib/learn/review";
import { ensureOrgAccount } from "@/lib/org/account";
import { defaultProfileSettings } from "@/lib/profiles/settings";
import { requireRecordingView } from "@/lib/sharing/access";
import { type TaskViewer, taskViewer } from "@/lib/tasks/access";
import { taskReviewsForArchive } from "@/lib/tasks/archive";
import { taskFingerprint } from "@/lib/tasks/proposals";
import { restoreTaskArchive } from "@/lib/tasks/restore";
import { markTaskReviewInTx } from "@/lib/tasks/review-state";
import { type ProposedTask, writeTaskProposalsInTx } from "@/lib/tasks/store";
import {
    acceptReview,
    addTask,
    listRecordingTasks,
    mergeProposals,
    mergeTaskIntoTask,
    recordingsAwaitingTaskReview,
    skipTaskReview,
    touchTaskReview,
    updateTask,
} from "@/lib/tasks/tasks";
import { waitingTaskDecisions } from "@/lib/tasks/waiting-review";
import { insertRecordings } from "@/tests/integration/items";

const url = getTestDatabaseUrl();
const OWNER = "quick-owner";
const ITEM = "quick-item";
const turns = [
    {
        speaker: "speaker_0",
        startMs: 0,
        endMs: 5000,
        text: "Path finder is ready.",
    },
    {
        speaker: "speaker_1",
        startMs: 5000,
        endMs: 10000,
        text: "The project is ready.",
    },
];

(url ? describe : describe.skip)("quick finish (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    let viewer: TaskViewer;
    let transcriptId = "";
    const db = () => database.db;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(url ?? "", "quick_finish");
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120000);
    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30000);
    beforeEach(async () => {
        knowledgeStore().invalidateAll();
        await db().delete(users);
        await db()
            .insert(users)
            .values([
                { id: OWNER, email: "owner@example.test" },
                { id: "stranger", email: "stranger@example.test" },
            ]);
        await seedCoreVocabulary();
        await db()
            .insert(apiCredentials)
            .values({
                userId: OWNER,
                provider: "openai",
                apiKey: encrypt("test-key"),
                defaultModel: "gpt-4o-mini",
                isDefaultEnhancement: true,
            });
        await insertRecordings(db(), {
            id: ITEM,
            userId: OWNER,
            deviceSn: "test",
            plaudFileId: "test",
            filename: encryptText("A meeting"),
            duration: 10000,
            startTime: new Date("2026-10-01T10:00:00Z"),
            endTime: new Date("2026-10-01T10:00:10Z"),
            filesize: 1,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: "example.mp3",
            plaudVersion: "1",
        });
        const [transcript] = await db()
            .insert(transcriptions)
            .values({
                recordingId: ITEM,
                userId: OWNER,
                source: "riffado",
                text: encryptText("Path finder is ready."),
                turns: encryptJsonField(turns),
                provider: "openai",
                model: "test",
                revision: 0,
            })
            .returning();
        transcriptId = transcript.id;
        const settings = defaultProfileSettings("audio");
        settings.steps.summary.automatic = true;
        await db()
            .insert(processingProfiles)
            .values({
                id: "quick-profile",
                ownerUserId: OWNER,
                scope: "personal",
                channel: "audio",
                name: encryptText("Test"),
                currentRevisionId: "quick-revision",
            });
        await db()
            .insert(processingProfileRevisions)
            .values({
                id: "quick-revision",
                profileId: "quick-profile",
                settings: encryptText(JSON.stringify(settings)),
            });
        await db()
            .insert(itemProcessing)
            .values({
                itemId: ITEM,
                userId: OWNER,
                view: "private",
                profileId: "quick-profile",
                profileRevisionId: "quick-revision",
                phases: {
                    categorize: {
                        state: "done",
                        reason: "categorized",
                        generation: 0,
                        at: new Date().toISOString(),
                    },
                },
            });
        await db()
            .insert(recordingFolders)
            .values([
                {
                    id: "quick-root",
                    userId: OWNER,
                    name: encryptText("Private"),
                    nameHash: "quick-root",
                    kind: "private",
                },
                {
                    id: "quick-folder",
                    userId: OWNER,
                    parentId: "quick-root",
                    name: encryptText("Meetings"),
                    nameHash: "quick-folder",
                    kind: "custom",
                },
            ]);
        await db().insert(recordingFolderAssignments).values({
            itemId: ITEM,
            userId: OWNER,
            folderId: "quick-folder",
        });
        viewer = await taskViewer({ id: OWNER, email: "owner@example.test" });
    });
    const proposal = (
        text: string,
        extra: Partial<ProposedTask> = {},
    ): ProposedTask => ({
        text,
        fingerprint: taskFingerprint(text),
        assigneePersonId: null,
        assigneeHint: null,
        assigneeCheck: false,
        dueDate: null,
        duePhrase: null,
        quote: null,
        evidenceStartMs: null,
        ...extra,
    });
    const store = (tasks: ProposedTask[]) =>
        db().transaction((tx) =>
            writeTaskProposalsInTx(tx, {
                recordingId: ITEM,
                ownerUserId: OWNER,
                actorUserId: OWNER,
                proposals: {
                    source: "riffado",
                    tasks,
                    updates: [],
                    reviewer: viewer,
                    fingerprintOf: taskFingerprint,
                },
            }),
        );
    const state = async () =>
        (
            await db()
                .select()
                .from(itemProcessing)
                .where(
                    and(
                        eq(itemProcessing.itemId, ITEM),
                        eq(itemProcessing.view, "private"),
                    ),
                )
        )[0];

    it("skips retrievable proposals without rejections or waiting decisions and is idempotent", async () => {
        await store([proposal("Send a draft")]);
        await skipTaskReview(viewer, ITEM);
        const at = (await state()).taskReviewSkippedAt;
        await skipTaskReview(viewer, ITEM);
        expect((await state()).taskReviewSkippedAt).toEqual(at);
        expect(await listRecordingTasks(viewer, ITEM)).toMatchObject({
            taskReviewSkipped: true,
            proposals: [{ text: "Send a draft" }],
        });
        expect(
            (await waitingTaskDecisions(db(), ITEM, OWNER, "private")).total,
        ).toBe(0);
        expect(await recordingsAwaitingTaskReview(viewer)).toEqual([]);
        expect(await db().select().from(recordingTaskRejections)).toEqual([]);
    });
    it("keeps later replacement proposals skipped", async () => {
        await store([proposal("First draft")]);
        await skipTaskReview(viewer, ITEM);
        await store([proposal("Second draft")]);
        expect(await listRecordingTasks(viewer, ITEM)).toMatchObject({
            taskReviewSkipped: true,
            proposals: [{ text: "Second draft" }],
        });
    });
    it("finishes skipped proposals finally, clears both markers, and ignores a late skip", async () => {
        await store([proposal("Check a name")]);
        const task = (await listRecordingTasks(viewer, ITEM))?.proposals[0];
        await updateTask(viewer, task?.id ?? "", { version: 0, ticked: false });
        await skipTaskReview(viewer, ITEM);
        await touchTaskReview(viewer, ITEM);
        expect((await acceptReview(viewer, ITEM)).rejected).toBe(1);
        await skipTaskReview(viewer, ITEM);
        expect(await state()).toMatchObject({
            taskReviewSkippedAt: null,
            taskReviewChangedAt: null,
        });
        expect(await db().select().from(recordingTaskRejections)).toHaveLength(
            1,
        );
        await store([proposal("Check a name")]);
        expect((await listRecordingTasks(viewer, ITEM))?.proposals).toEqual([]);
    });
    it("a partial Finish never creates skipped proposals", async () => {
        await store([proposal("Keep this"), proposal("Reject this")]);
        const task = (await listRecordingTasks(viewer, ITEM))?.proposals.find(
            (row) => row.text === "Reject this",
        );
        await updateTask(viewer, task?.id ?? "", { version: 0, ticked: false });
        expect(await acceptReview(viewer, ITEM)).toMatchObject({
            accepted: 1,
            rejected: 1,
        });
        expect(
            (await listRecordingTasks(viewer, ITEM))?.taskReviewSkipped,
        ).toBe(false);
        expect(await db().select().from(recordingTaskRejections)).toHaveLength(
            1,
        );
    });
    it.each([
        "tick",
        "text",
        "due",
        "add",
        "merge",
        "begin edit",
    ])("persists the changed marker for %s", async (kind) => {
        await store([proposal("First"), proposal("Second")]);
        const tasks = (await listRecordingTasks(viewer, ITEM))?.proposals ?? [];
        const task = tasks[0];
        if (kind === "tick")
            await updateTask(viewer, task.id, {
                version: task.version,
                ticked: false,
            });
        if (kind === "text")
            await updateTask(viewer, task.id, {
                version: task.version,
                text: "Changed",
            });
        if (kind === "due")
            await updateTask(viewer, task.id, {
                version: task.version,
                dueDate: "2026-11-10",
            });
        if (kind === "add")
            await addTask(viewer, ITEM, {
                text: "Another",
                status: "proposed",
            });
        if (kind === "merge")
            await mergeProposals(
                viewer,
                ITEM,
                tasks.map((row) => row.id),
            );
        if (kind === "begin edit") await touchTaskReview(viewer, ITEM);
        expect(
            (await listRecordingTasks(viewer, ITEM))?.taskReviewChanged,
        ).toBe(true);
    });
    it("round-trips skipped and changed markers, including an empty pending summary", async () => {
        await store([proposal("Draft")]);
        await skipTaskReview(viewer, ITEM);
        await touchTaskReview(viewer, ITEM);
        const reviews = await taskReviewsForArchive(
            { kind: "personal", userId: OWNER },
            [ITEM],
        );
        expect(reviews).toEqual([
            {
                itemId: ITEM,
                view: "private",
                taskReviewSkipped: true,
                taskReviewChanged: true,
            },
        ]);
        await db()
            .update(itemProcessing)
            .set({ taskReviewSkippedAt: null, taskReviewChangedAt: null })
            .where(eq(itemProcessing.itemId, ITEM));
        await restoreTaskArchive(viewer, { reviews });
        expect(
            (await listRecordingTasks(viewer, ITEM))?.taskReviewSkipped,
        ).toBe(true);
        expect(
            (await listRecordingTasks(viewer, ITEM))?.taskReviewChanged,
        ).toBe(true);
        await db()
            .delete(recordingTasks)
            .where(eq(recordingTasks.itemId, ITEM));
        expect(
            await taskReviewsForArchive({ kind: "personal", userId: OWNER }, [
                ITEM,
            ]),
        ).toHaveLength(1);
    });
    it("refuses another user's skip, touch and restore", async () => {
        await store([proposal("Private")]);
        const stranger = await taskViewer({
            id: "stranger",
            email: "stranger@example.test",
        });
        await expect(skipTaskReview(stranger, ITEM)).rejects.toMatchObject({
            statusCode: 404,
        });
        await expect(touchTaskReview(stranger, ITEM)).rejects.toMatchObject({
            statusCode: 404,
        });
        await expect(
            restoreTaskArchive(stranger, {
                reviews: [
                    { itemId: ITEM, view: "private", taskReviewSkipped: true },
                ],
            }),
        ).rejects.toMatchObject({ statusCode: 403 });
    });

    it("carries a skip into the Organization, restricts it to reviewers, and keeps Finish settled after withdrawal", async () => {
        const orgUserId = await ensureOrgAccount();
        if (!orgUserId) throw new Error("No Organization fixture");
        await db()
            .insert(transcriptSpeakers)
            .values(
                turns.map((turn) => ({
                    userId: OWNER,
                    transcriptionId: transcriptId,
                    label: turn.speaker,
                    source: "user" as const,
                    status: "confirmed" as const,
                    markedUnknown: true,
                })),
            );
        await store([proposal("Shared draft")]);
        await skipTaskReview(viewer, ITEM);
        const [folder] = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, orgUserId));
        await addRecordingToFolder({
            userId: OWNER,
            recordingId: ITEM,
            folderId: folder.id,
        });
        expect(
            (await listRecordingTasks(viewer, ITEM))?.taskReviewSkipped,
        ).toBe(true);
        expect(
            (await waitingTaskDecisions(db(), ITEM, OWNER, "org")).total,
        ).toBe(0);
        const colleague = await taskViewer({
            id: "stranger",
            email: "stranger@example.test",
        });
        expect((await listRecordingTasks(colleague, ITEM))?.proposals).toEqual(
            [],
        );
        await expect(skipTaskReview(colleague, ITEM)).rejects.toMatchObject({
            statusCode: 403,
        });
        const org = await taskViewer({
            id: orgUserId,
            email: "org@example.test",
        });
        await acceptReview(org, ITEM);
        await unshareRecording(OWNER, ITEM, { withdraw: true });
        expect(
            (await listRecordingTasks(viewer, ITEM))?.taskReviewSkipped,
        ).toBe(false);
    });

    async function ready(
        items: {
            kind: typeof learnReviewItems.$inferInsert.kind;
            payload: object;
            preTicked?: boolean;
            decision?: "accepted" | "rejected";
            choice?: object;
        }[],
        options: Partial<
            Pick<
                typeof learnRuns.$inferInsert,
                "actorUserId" | "scopeUserId" | "view"
            >
        > = {},
    ) {
        const [run] = await db()
            .insert(learnRuns)
            .values({
                userId: OWNER,
                scopeUserId: OWNER,
                itemId: ITEM,
                transcriptionId: transcriptId,
                view: "private",
                actorUserId: OWNER,
                trigger: "auto",
                transcriptRevision: 0,
                vocabularyVersion: 0,
                status: "ready",
                profileRevisionId: "quick-revision",
                ...options,
            })
            .returning();
        for (const [index, item] of items.entries())
            await db()
                .insert(learnReviewItems)
                .values({
                    runId: run.id,
                    userId: options.scopeUserId ?? OWNER,
                    kind: item.kind,
                    payload: encryptJsonField(item.payload),
                    fingerprintHmac: `fp-${index}`,
                    preTicked: item.preTicked,
                    decision: item.decision,
                    choice: item.choice ? encryptJsonField(item.choice) : null,
                });
        await db()
            .update(chatterItems)
            .set({ summaryDueAt: new Date(Date.now() + 100000) })
            .where(eq(chatterItems.id, ITEM));
        const access = await requireRecordingView(
            OWNER,
            ITEM,
            options.view ?? "private",
        );
        const review = await loadReview(access);
        return {
            run,
            access,
            versions: Object.fromEntries(
                review.items.map((row) => [row.id, row.version]),
            ),
        };
    }
    async function knownFactItem(scopeUserId = OWNER) {
        const entity = await createEntity(scopeUserId, {
            name: "Pathfinder",
            typeKey: "term",
        });
        const fact = await confirmManualFact(scopeUserId, {
            subject: { entityId: entity.id },
            relationKey: "means",
            object: { literal: "A test project" },
        });
        return { entity, fact };
    }
    async function correctAfterLearn(enabled: boolean) {
        const settings = defaultProfileSettings("audio");
        settings.steps.summary.automatic = true;
        settings.steps.learn.correctAfterLearn = enabled;
        await db()
            .update(processingProfileRevisions)
            .set({ settings: encryptText(JSON.stringify(settings)) })
            .where(eq(processingProfileRevisions.id, "quick-revision"));
    }
    async function knownReady(
        options: Partial<
            Pick<
                typeof learnRuns.$inferInsert,
                "actorUserId" | "scopeUserId" | "view"
            >
        > = {},
    ) {
        const { entity, fact } = await knownFactItem(
            options.scopeUserId ?? OWNER,
        );
        return ready(
            [
                {
                    kind: "known_fact",
                    payload: {
                        subject: { entityId: entity.id },
                        relationKey: "means",
                        object: { literal: "A test project" },
                        factId: fact,
                        startMs: 0,
                        endMs: 5000,
                        speakerLabel: null,
                    },
                },
            ],
            options,
        );
    }
    async function share() {
        const orgUserId = await ensureOrgAccount();
        if (!orgUserId) throw new Error("No Organization fixture");
        await db()
            .insert(transcriptSpeakers)
            .values(
                turns.map((turn) => ({
                    userId: OWNER,
                    transcriptionId: transcriptId,
                    label: turn.speaker,
                    source: "user" as const,
                    status: "confirmed" as const,
                    markedUnknown: true,
                })),
            );
        const [folder] = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, orgUserId));
        await addRecordingToFolder({
            userId: OWNER,
            recordingId: ITEM,
            folderId: folder.id,
        });
        return orgUserId;
    }
    const runReadyJob = (runId: string, userId: string) =>
        learnJobHandler.run({
            payload: { runId },
            userId,
            jobId: "learn-job",
            attempt: 1,
            maxAttempts: 2,
            signal: new AbortController().signal,
            reportProgress: () => {},
        });
    const held = async () =>
        (
            await db()
                .select({ dueAt: chatterItems.summaryDueAt })
                .from(chatterItems)
                .where(eq(chatterItems.id, ITEM))
        )[0].dueAt;

    it.each([
        OWNER,
        "stranger",
    ])("an open-task merge does not mark or advance an unrelated item owned by %s", async (ownerUserId) => {
        await db()
            .insert(chatterItems)
            .values({
                id: "unrelated",
                userId: ownerUserId,
                kind: "audio",
                title: encryptText("Unrelated"),
                occurredAt: new Date(),
            });
        if (ownerUserId === OWNER)
            await db().insert(itemProcessing).values({
                itemId: "unrelated",
                userId: OWNER,
                view: "private",
            });
        const source = await addTask(viewer, ITEM, {
            text: "Source",
            status: "open",
        });
        const target = await addTask(viewer, ITEM, {
            text: "Target",
            status: "open",
        });
        await mergeTaskIntoTask(viewer, source.id, target.id, {
            reviewItemId: "unrelated",
        });
        const rows = await db()
            .select()
            .from(itemProcessing)
            .where(eq(itemProcessing.itemId, "unrelated"));
        expect(rows).toMatchObject(
            ownerUserId === OWNER
                ? [
                      {
                          userId: OWNER,
                          taskReviewChangedAt: null,
                          requestedGeneration: 0,
                      },
                  ]
                : [],
        );
        expect(
            await db()
                .select()
                .from(asyncJobs)
                .where(eq(asyncJobs.subjectId, "unrelated")),
        ).toEqual([]);
    });
    it.each([
        "changed",
        "skipped",
    ] as const)("refuses a %s marker for an item another user owns", async (marker) => {
        await db()
            .insert(chatterItems)
            .values({
                id: "unrelated",
                userId: "stranger",
                kind: "audio",
                title: encryptText("Unrelated"),
                occurredAt: new Date(),
            });
        await db().transaction((tx) =>
            markTaskReviewInTx(
                tx,
                { itemId: "unrelated", userId: OWNER, view: "org" },
                marker,
            ),
        );
        expect(
            await db()
                .select()
                .from(itemProcessing)
                .where(eq(itemProcessing.itemId, "unrelated")),
        ).toEqual([]);
        await db().transaction((tx) =>
            markTaskReviewInTx(
                tx,
                { itemId: ITEM, userId: "stranger", view: "private" },
                marker,
            ),
        );
        expect(await state()).toMatchObject({
            userId: OWNER,
            taskReviewChangedAt: null,
            taskReviewSkippedAt: null,
        });
    });
    it.each([
        "private",
        "org",
    ] as const)("creates a missing %s processing row for the item's owner", async (view) => {
        await db()
            .delete(itemProcessing)
            .where(eq(itemProcessing.itemId, ITEM));
        await db().transaction((tx) =>
            markTaskReviewInTx(
                tx,
                { itemId: ITEM, userId: OWNER, view },
                "skipped",
            ),
        );
        expect(
            await db()
                .select()
                .from(itemProcessing)
                .where(eq(itemProcessing.itemId, ITEM)),
        ).toMatchObject([
            { userId: OWNER, view, taskReviewSkippedAt: expect.any(Date) },
        ]);
    });
    it("drops untouched assignee checks at Finish without remembering a rejection", async () => {
        await store([proposal("Check an assignee", { assigneeCheck: true })]);
        await skipTaskReview(viewer, ITEM);
        await acceptReview(viewer, ITEM);
        expect((await listRecordingTasks(viewer, ITEM))?.proposals).toEqual([]);
        expect(await state()).toMatchObject({
            taskReviewSkippedAt: null,
            taskReviewChangedAt: null,
        });
        expect(await db().select().from(recordingTaskRejections)).toEqual([]);
    });
    it("remembers a rejection when an assignee check was touched", async () => {
        await store([proposal("Checked assignee", { assigneeCheck: true })]);
        const task = (await listRecordingTasks(viewer, ITEM))?.proposals[0];
        await updateTask(viewer, task?.id ?? "", { version: 0, ticked: false });
        await acceptReview(viewer, ITEM);
        expect(await db().select().from(recordingTaskRejections)).toHaveLength(
            1,
        );
    });
    it("auto-finishes a curator-started known-only run on a shared recording and releases its hold", async () => {
        await correctAfterLearn(false);
        const actorUserId = await share();
        const { run, access } = await knownReady({
            actorUserId,
            scopeUserId: actorUserId,
            view: "org",
        });
        await expect(runReadyJob(run.id, actorUserId)).resolves.toMatchObject({
            status: "finished",
        });
        expect((await loadReview(access)).run?.status).toBe("finished");
        expect(await db().select().from(knowledgeFactEvidence)).toHaveLength(1);
        expect(await held()).toBeNull();
    });
    it.each([
        "gone",
        "lost curator",
    ])("leaves a successful known-only run ready when its actor's access is %s", async (reason) => {
        const orgUserId = await share();
        const actorUserId = reason === "gone" ? OWNER : "stranger";
        const { run } = await knownReady({
            actorUserId,
            scopeUserId: orgUserId,
            view: "org",
        });
        if (reason === "gone")
            await db()
                .update(chatterItems)
                .set({ deletedAt: new Date() })
                .where(eq(chatterItems.id, ITEM));
        await expect(runReadyJob(run.id, actorUserId)).resolves.toMatchObject({
            skipped: "ready",
        });
        expect(
            (
                await db()
                    .select()
                    .from(learnRuns)
                    .where(eq(learnRuns.id, run.id))
            )[0].status,
        ).toBe("ready");
        expect(await db().select().from(knowledgeFactEvidence)).toEqual([]);
    });
    it("auto-finishes a legacy known-only run with no actor as its owner", async () => {
        await correctAfterLearn(false);
        const { run } = await knownReady({ actorUserId: null });
        expect(await finishKnownFactsOnly(run.id, OWNER)).toBe(true);
        expect(await held()).toBeNull();
    });
    it("keeps the correction pass and hold for a known-only run", async () => {
        const { run } = await knownReady();
        expect(await finishKnownFactsOnly(run.id, OWNER)).toBe(true);
        expect(
            await db().select().from(transcriptCorrectionPasses),
        ).toMatchObject([{ learnRunId: run.id, status: "queued" }]);
        expect(await held()).not.toBeNull();
    });
    it.each([
        "first",
        "current",
        "active job",
        "edited",
        "Plaud import",
    ])("promises a summary and skips tasks only when the planner queues one (%s summary)", async (mode) => {
        if (mode === "current" || mode === "edited")
            await db()
                .insert(aiEnhancements)
                .values({
                    itemId: ITEM,
                    userId: OWNER,
                    transcriptionId: transcriptId,
                    provider: "openai",
                    model: "test",
                    summary: encryptText("Current summary"),
                    inputs: {
                        contentId: transcriptId,
                        contentSourceId: "riffado",
                        contentRevision: 0,
                        itemProfileRevisionId: "quick-revision",
                    },
                    editedAt: mode === "edited" ? new Date() : null,
                });
        if (mode === "active job")
            await db().insert(asyncJobs).values({
                userId: OWNER,
                kind: "summary",
                subjectId: ITEM,
                status: "pending",
                payload: {},
            });
        if (mode === "Plaud import") {
            await db().delete(apiCredentials);
            await db()
                .insert(aiEnhancements)
                .values({
                    itemId: ITEM,
                    userId: OWNER,
                    source: "plaud",
                    provider: "plaud",
                    model: "native",
                    actionItems: encryptJsonField([{ text: "Imported task" }]),
                });
        }
        const { access, versions } = await ready([
            {
                kind: "speaker",
                payload: {
                    label: "speaker_0",
                    personId: null,
                    reason: "Unknown",
                    evidenceMs: [],
                },
            },
        ]);
        const expected = mode === "first";
        expect(await learnQuickFinishPolicy(access)).toEqual({
            automaticSummary: expected,
            skipTasks: expected,
        });
        await finishReview(access, OWNER, { versions, quick: true });
        expect((await state()).taskReviewSkippedAt !== null).toBe(expected);
    });
    it("lets a person finish an older known-only ready run without a write on read", async () => {
        await correctAfterLearn(false);
        const { access, run } = await knownReady();
        const review = await loadReview(access);
        expect(review).toMatchObject({ run: { status: "ready" }, items: [] });
        expect(await db().select().from(knowledgeFactEvidence)).toEqual([]);
        await expect(
            finishReview(access, OWNER, { versions: {} }),
        ).resolves.toMatchObject({ status: "finished", applied: 1 });
        expect(
            (
                await db()
                    .select()
                    .from(learnRuns)
                    .where(eq(learnRuns.id, run.id))
            )[0].status,
        ).toBe("finished");
    });
    it("quick finish applies confirmed speakers and preselected corrections and language, skips everything else without rejection, and releases the hold", async () => {
        await db()
            .insert(people)
            .values([
                {
                    id: "speaker-a",
                    userId: OWNER,
                    displayName: encryptText("Ada Example"),
                },
                {
                    id: "speaker-b",
                    userId: OWNER,
                    displayName: encryptText("Bea Example"),
                },
            ]);
        const entity = await createEntity(OWNER, {
            name: "Pathfinder",
            typeKey: "term",
        });
        const factId = await confirmManualFact(OWNER, {
            subject: { entityId: entity.id },
            relationKey: "means",
            object: { literal: "A test project" },
        });
        const { run, access, versions } = await ready([
            {
                kind: "known_fact",
                payload: {
                    subject: { entityId: entity.id },
                    relationKey: "means",
                    object: { literal: "A test project" },
                    factId,
                    startMs: 0,
                    endMs: 5000,
                    speakerLabel: null,
                },
            },
            {
                kind: "speaker",
                decision: "accepted",
                payload: {
                    label: "speaker_0",
                    personId: "speaker-a",
                    reason: "Confirmed",
                    evidenceMs: [0],
                },
            },
            {
                kind: "speaker",
                payload: {
                    label: "speaker_1",
                    personId: "speaker-b",
                    reason: "Guess",
                    evidenceMs: [5000],
                    guess: { confidence: 0.4 },
                    source: "calendar",
                },
            },
            {
                kind: "correction",
                preTicked: true,
                payload: {
                    kind: "correct",
                    heard: "Path finder",
                    replacement: "Pathfinder",
                    target: { entityId: entity.id },
                    anchors: [{ turnIndex: 0, charStart: 0, charEnd: 11 }],
                },
            },
            {
                kind: "language",
                preTicked: true,
                payload: { language: "en", detectedLanguage: "cs" },
            },
            {
                kind: "fact",
                payload: {
                    subject: { personId: "speaker-a" },
                    relationKey: "leads",
                    object: { entityId: entity.id },
                    startMs: 0,
                    endMs: 5000,
                    speakerLabel: null,
                },
            },
        ]);
        const result = await finishReview(access, OWNER, {
            versions,
            runId: run.id,
            quick: true,
        });
        expect(result).toMatchObject({
            status: "finished",
            applied: 4,
            dismissed: 0,
            correcting: false,
        });
        expect(result.skipped).toHaveLength(2);
        expect(result.skipped.every((item) => item.code === "not_now")).toBe(
            true,
        );
        expect(
            (
                await db()
                    .select()
                    .from(learnRuns)
                    .where(eq(learnRuns.id, run.id))
            )[0].stats,
        ).toMatchObject({ applied: 4, skipped: 2, dismissed: 0 });
        expect(await db().select().from(learnDismissals)).toEqual([]);
        expect(await db().select().from(knowledgeFactEvidence)).toHaveLength(1);
        expect(await db().select().from(transcriptCorrections)).toHaveLength(1);
        const speakers = await db().select().from(transcriptSpeakers);
        expect(
            speakers
                .filter((row) => row.status === "confirmed")
                .map((row) => row.personId),
        ).toEqual(["speaker-a"]);
        expect((await state()).taskReviewSkippedAt).not.toBeNull();
        expect((await state()).phases.learn).toMatchObject({
            state: "done",
            reason: "released",
        });
        expect(
            (
                await db()
                    .select()
                    .from(chatterItems)
                    .where(eq(chatterItems.id, ITEM))
            )[0].summaryDueAt,
        ).toBeNull();
        const skipped = await db()
            .select()
            .from(learnReviewItems)
            .where(eq(learnReviewItems.outcome, "not_now"));
        expect(skipped).toHaveLength(2);
        expect(
            await finishReview(access, OWNER, {
                versions,
                runId: run.id,
                quick: true,
            }),
        ).toMatchObject({ applied: 4, dismissed: 0 });
        await store([proposal("From the released summary")]);
        expect(
            (await waitingTaskDecisions(db(), ITEM, OWNER, "private")).total,
        ).toBe(0);
    });
    it.each([
        "manual",
        "tasks off",
        "manual placement",
        "no provider",
    ])("does not pre-skip tasks when %s", async (mode) => {
        const settings = defaultProfileSettings("audio");
        settings.steps.summary.automatic = mode !== "manual";
        settings.steps.tasks.enabled = mode !== "tasks off";
        await db()
            .update(processingProfileRevisions)
            .set({ settings: encryptText(JSON.stringify(settings)) })
            .where(eq(processingProfileRevisions.id, "quick-revision"));
        if (mode === "no provider") await db().delete(apiCredentials);
        if (mode === "manual placement")
            await db()
                .update(itemProcessing)
                .set({ manualOnly: true })
                .where(eq(itemProcessing.itemId, ITEM));
        const { access, versions } = await ready([
            {
                kind: "speaker",
                payload: {
                    label: "speaker_0",
                    personId: null,
                    reason: "Unknown",
                    evidenceMs: [],
                },
            },
        ]);
        await finishReview(access, OWNER, { versions, quick: true });
        expect((await state()).taskReviewSkippedAt).toBeNull();
    });
    it("remembers non-speaker edits across reloads, excluding speaker answers", async () => {
        const { access } = await ready([
            {
                kind: "speaker",
                payload: {
                    label: "speaker_0",
                    personId: null,
                    evidenceMs: [],
                    reason: "Unknown",
                },
            },
            {
                kind: "language",
                preTicked: true,
                payload: { language: "en", detectedLanguage: "cs" },
            },
        ]);
        let review = await loadReview(access);
        const speaker = review.items.find((row) => row.kind === "speaker");
        await decideReviewItem(access, speaker?.id ?? "", {
            decision: "accepted",
            choice: { unknown: true },
            version: 0,
        });
        expect((await loadReview(access)).run?.reviewChanged).toBe(false);
        review = await loadReview(access);
        const language = review.items.find((row) => row.kind === "language");
        await decideReviewItem(access, language?.id ?? "", {
            decision: "accepted",
            choice: { language: "en" },
            version: 0,
        });
        expect((await loadReview(access)).run?.reviewChanged).toBe(true);
    });
    it("refuses quick finish from a different caller under the writer lock", async () => {
        const { access, versions } = await ready([
            {
                kind: "speaker",
                payload: {
                    label: "speaker_0",
                    personId: null,
                    evidenceMs: [],
                    reason: "Unknown",
                },
            },
        ]);
        await expect(
            finishReview(access, "stranger", { versions, quick: true }),
        ).rejects.toMatchObject({ statusCode: 403 });
        expect((await state()).taskReviewSkippedAt).toBeNull();
    });
    it("automatically applies a run containing only known facts, hides them from review, and releases its hold", async () => {
        await correctAfterLearn(false);
        const { entity, fact } = await knownFactItem();
        const { run, access } = await ready([
            {
                kind: "known_fact",
                preTicked: false,
                payload: {
                    subject: { entityId: entity.id },
                    relationKey: "means",
                    object: { literal: "A test project" },
                    factId: fact,
                    startMs: 0,
                    endMs: 5000,
                    speakerLabel: null,
                },
            },
        ]);
        expect((await loadReview(access)).items).toEqual([]);
        expect(await finishKnownFactsOnly(run.id, "stranger")).toBe(false);
        expect(await finishKnownFactsOnly(run.id, OWNER)).toBe(true);
        expect((await loadReview(access)).run?.status).toBe("finished");
        expect(await db().select().from(knowledgeFactEvidence)).toHaveLength(1);
        expect(
            (
                await db()
                    .select()
                    .from(chatterItems)
                    .where(eq(chatterItems.id, ITEM))
            )[0].summaryDueAt,
        ).toBeNull();
        expect(await finishKnownFactsOnly(run.id, OWNER)).toBe(false);
    });
});
