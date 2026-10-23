/**
 * Task review and task lists against a real PostgreSQL: proposals stored
 * with a summary, the review (accept, reject, merge, follow-ups), and who
 * sees and changes a task on a private and on a shared recording.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { and, eq, inArray } from "drizzle-orm";
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
    chatterItems,
    itemProcessing,
    mailMessages,
    people,
    recordingFolders,
    recordingTaskRejections,
    recordingTasks,
    taskContentVectors,
    taskHomeMoves,
    taskMentions,
    taskUpdateProposals,
    transcriptions,
    transcriptSpeakers,
    userSettings,
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
    const proxy = new Proxy(
        {},
        {
            get: (_target, property: string | symbol) => {
                const current = ref.current;
                if (!current) {
                    throw new Error("test database was not initialized");
                }
                const value = current[property];
                return typeof value === "function"
                    ? value.bind(current)
                    : value;
            },
        },
    );
    return {
        dbProxy: proxy,
        dbRef: ref,
        mockEnv: {
            IS_HOSTED: false,
            SELF_HOST_MODE: "shared",
            AUTHZ_MODE: "local" as "local" | "idp",
            ORG_ACCOUNT_EMAIL: "org@example.test",
            ORG_ACCOUNT_PASSWORD: "organization-password",
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            DATABASE_URL: "postgres://unused",
        },
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/export/document-sidecars", () => ({
    removeRecordingSidecar: vi.fn().mockResolvedValue(undefined),
    refreshExistingRecordingSidecars: vi.fn().mockResolvedValue(undefined),
    exportRecordingSidecarsIfEnabled: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/webhooks/emit", () => ({
    emitEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: vi.fn().mockResolvedValue({
        deleteFile: vi.fn().mockResolvedValue(undefined),
    }),
}));

import { markRecordingDeleted } from "@/db/items";
import { deleteSummaryForRecording } from "@/db/queries/retention";
import type { ActorContext } from "@/lib/authz/model";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { addRecordingToFolder, unshareRecording } from "@/lib/folders/folders";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { createPerson, mergePeople } from "@/lib/knowledge/people";
import { ensureOrgAccount } from "@/lib/org/account";
import { gatherFacts } from "@/lib/pipeline/facts";
import { eraseLocalArtifact } from "@/lib/recordings/erase";
import { loadShareGate } from "@/lib/sharing/load-share-gate";
import { type TaskViewer, taskViewer } from "@/lib/tasks/access";
import {
    type TaskArchiveScope,
    tasksForArchive,
    taskUpdatesForArchive,
} from "@/lib/tasks/archive";
import { deleteItemTaskDataInTx } from "@/lib/tasks/mentions";
import {
    loadTasksPromptContext,
    resolveTaskProposals,
    taskFingerprint,
} from "@/lib/tasks/proposals";
import {
    applyRoutedTaskProposal,
    listRoutedTaskProposals,
    rejectRoutedTaskProposal,
} from "@/lib/tasks/routing";
import type {
    ProposedTask,
    ProposedTaskMatch,
    TaskProposals,
} from "@/lib/tasks/store";
import {
    acceptReview,
    addTask,
    countNewTasks,
    listCallerTasks,
    listRecordingTasks,
    listTasks,
    markTasksSeen,
    mergeProposals,
    mergeTaskIntoTask,
    recordingsAwaitingTaskReview,
    tickUpdateProposal,
    undoTaskMatch,
    updateTask,
} from "@/lib/tasks/tasks";
import {
    type UpsertEnhancementArgs,
    upsertEnhancement,
    upsertTranscription,
} from "@/lib/transcription/persist";
import { storeBrowserTranscription } from "@/lib/transcription/transcribe-recording";
import { insertRecordings } from "@/tests/integration/items";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const ALICE = "user-alice";
const BOB = "user-bob";
const CAROL = "user-carol";
const REC = "rec-launch";
const LATER = "rec-later";

function proposal(
    text: string,
    extra: Partial<ProposedTask> = {},
): ProposedTask {
    return {
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
    };
}

function match(
    taskId: string,
    extra: Partial<ProposedTaskMatch> = {},
): ProposedTaskMatch {
    return {
        taskId,
        quote: null,
        evidenceStartMs: null,
        ...extra,
    };
}

describeWithDatabase("tasks (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";
    let transcriptId = "";
    let alice: TaskViewer;
    let bob: TaskViewer;
    let carol: TaskViewer;
    let org: TaskViewer;
    let bobPrivate = "";
    let bobOrg = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "tasks",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    async function addRecording(id: string, startTime: string, userId = ALICE) {
        await insertRecordings(db(), {
            id,
            userId,
            deviceSn: "SN-1",
            plaudFileId: `plaud-${id}`,
            filename: encryptText(`Recording ${id}`),
            duration: 60_000,
            startTime: new Date(startTime),
            endTime: new Date(startTime),
            filesize: 11,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: `${userId}/${id}.mp3`,
            storageFilename: `${id}.mp3`,
            plaudVersion: "1",
        });
        const [transcript] = await db()
            .insert(transcriptions)
            .values({
                recordingId: id,
                userId,
                text: encryptText("What was said."),
                provider: "openai",
                model: "whisper-1",
                source: "riffado",
            })
            .returning({ id: transcriptions.id });
        return transcript?.id ?? "";
    }

    async function addMail(id: string, userId = ALICE) {
        const occurredAt = new Date("2026-10-07T10:00:00Z");
        await db()
            .insert(chatterItems)
            .values({
                id,
                userId,
                kind: "mail",
                title: encryptText(`Mail ${id}`),
                occurredAt,
            });
        await db()
            .insert(mailMessages)
            .values({
                id,
                userId,
                rawHash: `raw-${id}`,
                receivedAt: occurredAt,
                sizeBytes: 1,
                auth: {},
                senderVerified: true,
            });
    }

    beforeEach(async () => {
        await db().delete(users);
        await db()
            .insert(users)
            .values([
                { id: ALICE, email: "alice@example.test" },
                { id: BOB, email: "bob@example.test" },
                { id: CAROL, email: "carol@example.test" },
            ]);
        await db()
            .insert(userSettings)
            .values([{ userId: ALICE }, { userId: BOB }, { userId: CAROL }]);
        orgUserId = (await ensureOrgAccount()) ?? "";
        transcriptId = await addRecording(REC, "2026-10-06T10:00:00Z");
        await addRecording(LATER, "2026-10-08T10:00:00Z");
        const [privatePerson, orgPerson] = await db()
            .insert(people)
            .values([
                {
                    userId: ALICE,
                    displayName: encryptText("Bob"),
                    primaryEmail: encryptText("bob@example.test"),
                    primaryEmailHash: lookupHash("bob@example.test"),
                },
                {
                    userId: orgUserId,
                    displayName: encryptText("Bob B."),
                    primaryEmail: encryptText("bob@example.test"),
                    primaryEmailHash: lookupHash("bob@example.test"),
                },
            ])
            .returning({ id: people.id });
        bobPrivate = privatePerson?.id ?? "";
        bobOrg = orgPerson?.id ?? "";
        alice = await taskViewer({ id: ALICE, email: "alice@example.test" });
        bob = await taskViewer({ id: BOB, email: "bob@example.test" });
        carol = await taskViewer({ id: CAROL, email: "carol@example.test" });
        org = await taskViewer({ id: orgUserId, email: "org@example.test" });
    });

    async function summarize(
        recordingId: string,
        tasks: ProposedTask[],
        extra: Partial<TaskProposals> = {},
        inputs?: UpsertEnhancementArgs["inputs"],
    ) {
        const result = await upsertEnhancement({
            userId: ALICE,
            recordingId,
            kind: recordingId.startsWith("mail-") ? "mail" : "audio",
            transcriptionId: recordingId.startsWith("mail-")
                ? null
                : transcriptId,
            summary: "Summary.",
            keyPoints: [],
            actionItems: tasks.map((task) => task.text),
            source: "riffado",
            provider: "openai",
            model: "gpt",
            allowReaped: true,
            inputs,
            tasks: {
                source: "riffado",
                tasks,
                updates: [],
                reviewer: alice,
                fingerprintOf: taskFingerprint,
                ...extra,
            },
        });
        expect(result.committed).toBe(true);
    }

    async function share(recordingId = REC, userId = ALICE) {
        const [root] = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, orgUserId));
        await addRecordingToFolder({
            userId,
            recordingId,
            folderId: root?.id ?? "",
        });
    }

    async function review(viewer: TaskViewer, recordingId = REC) {
        const tasks = await listRecordingTasks(viewer, recordingId);
        if (!tasks) throw new Error("recording not visible");
        return tasks;
    }

    it("stores a summary's proposals, ticked unless the assignee needs a check", async () => {
        await summarize(REC, [
            proposal("Draft the pricing page", {
                assigneePersonId: bobPrivate,
                dueDate: "2026-10-16",
                duePhrase: "by next Friday",
            }),
            proposal("Write the press release", {
                assigneePersonId: bobPrivate,
                assigneeCheck: true,
            }),
            proposal("Book the venue", { assigneeHint: "Dana" }),
        ]);
        const { proposals, tasks, canEdit } = await review(alice);
        expect(canEdit).toBe(true);
        expect(tasks).toEqual([]);
        expect(
            proposals.map((row) => [row.text, row.ticked, row.assignee?.name]),
        ).toEqual([
            ["Draft the pricing page", true, "Bob"],
            ["Write the press release", false, "Bob"],
            ["Book the venue", true, undefined],
        ]);
        expect(proposals[0]).toMatchObject({
            dueDate: "2026-10-16",
            duePhrase: "by next Friday",
        });
        expect(proposals[2]?.assigneeHint).toBe("Dana");
    });

    it("offers a first-name match for checking with its heard name", async () => {
        await createPerson({ userId: ALICE, displayName: "Dana Rivers" });
        const resolved = await resolveTaskProposals({
            source: "riffado",
            items: [
                {
                    text: "Send the notes",
                    assignee: "Dana",
                    speaker: null,
                    due: null,
                    quote: null,
                    candidates: null,
                },
            ],
            updates: [],
            refs: new Map(),
            ownerUserId: ALICE,
            transcriptionId: null,
            turns: null,
            language: "en",
            orgView: false,
            reviewer: alice,
            summaryText: "Dana will send the notes.",
        });
        expect(resolved.tasks[0]).toMatchObject({
            assigneeCheck: true,
            assigneeHint: "Dana",
        });
        await summarize(REC, resolved.tasks);
        expect((await review(alice)).proposals[0]).toMatchObject({
            status: "proposed",
            assignee: { name: "Dana Rivers" },
            ticked: false,
            assigneeHint: "Dana",
            assigneeCheck: true,
        });
    });

    it("stores a mention for every proposed task and follow-up", async () => {
        const target = await addTask(alice, LATER, {
            text: "Send the partner email",
            status: "open",
        });
        const [manualMention] = await db()
            .select({
                quote: taskMentions.quote,
                decision: taskMentions.matchDecision,
            })
            .from(taskMentions)
            .where(eq(taskMentions.taskId, target.id));
        expect(manualMention).toEqual({ quote: null, decision: "home" });
        await summarize(
            REC,
            [
                proposal("Draft the pricing page", {
                    quote: "draft the pricing page",
                    evidenceText: {
                        segmentIndex: 2,
                        charStart: 4,
                        charEnd: 26,
                    },
                    evidenceProvenance: "quoted",
                }),
            ],
            {
                updates: [
                    {
                        taskId: target.id,
                        kind: "done",
                        dueDate: null,
                        duePhrase: null,
                        quote: "the partner email is sent",
                        evidenceStartMs: 8_000,
                        evidenceProvenance: "unverified",
                    },
                ],
            },
            {
                contentId: transcriptId,
                contentSourceId: "riffado",
                contentRevision: 0,
            },
        );

        const rows = await db()
            .select({
                taskId: taskMentions.taskId,
                itemId: taskMentions.itemId,
                view: taskMentions.view,
                quote: taskMentions.quote,
                start: taskMentions.evidenceStartMs,
                segment: taskMentions.evidenceSegmentIndex,
                charStart: taskMentions.evidenceCharStart,
                charEnd: taskMentions.evidenceCharEnd,
                provenance: taskMentions.provenance,
                contentSourceId: taskMentions.contentSourceId,
                contentRevision: taskMentions.contentRevision,
                decision: taskMentions.matchDecision,
                statementAt: taskMentions.statementAt,
            })
            .from(taskMentions)
            .where(eq(taskMentions.itemId, REC));
        expect(rows).toHaveLength(2);
        expect(
            rows.map((row) => ({
                ...row,
                quote: row.quote ? decryptText(row.quote) : null,
            })),
        ).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    itemId: REC,
                    view: "private",
                    quote: "draft the pricing page",
                    start: null,
                    segment: 2,
                    charStart: 4,
                    charEnd: 26,
                    provenance: "quoted",
                    contentSourceId: "riffado",
                    contentRevision: 0,
                    decision: "home",
                    statementAt: new Date("2026-10-06T10:00:00Z"),
                }),
                expect.objectContaining({
                    taskId: target.id,
                    itemId: REC,
                    view: "private",
                    quote: "the partner email is sent",
                    start: 8_000,
                    provenance: "unverified",
                    contentSourceId: "riffado",
                    contentRevision: 0,
                    decision: "suggested",
                    statementAt: new Date("2026-10-06T10:00:00Z"),
                }),
            ]),
        );
    });

    it("stores ambiguous candidates beside a Keep as new proposal", async () => {
        const first = await addTask(alice, REC, {
            text: "Send the signed contract",
            status: "open",
        });
        const second = await addTask(alice, REC, {
            text: "Send the supplier contract",
            status: "open",
        });

        await summarize(LATER, [
            proposal("Send the contract", {
                quote: "I will send the contract",
                evidenceStartMs: 2_000,
                candidateTaskIds: [first.id, second.id],
            }),
        ]);

        const review = await listRecordingTasks(alice, LATER);
        expect(
            review?.proposals.map((row) => ({
                text: row.text,
                ticked: row.ticked,
            })),
        ).toEqual([{ text: "Send the contract", ticked: false }]);
        const candidates = await db()
            .select({
                taskId: taskMentions.taskId,
                decision: taskMentions.matchDecision,
                quote: taskMentions.quote,
                ticked: taskMentions.ticked,
            })
            .from(taskMentions)
            .where(eq(taskMentions.itemId, LATER));
        expect(
            candidates
                .filter((row) => row.decision === "suggested")
                .map((row) => ({
                    taskId: row.taskId,
                    quote: row.quote ? decryptText(row.quote) : null,
                    ticked: row.ticked,
                })),
        ).toEqual(
            expect.arrayContaining([
                {
                    taskId: first.id,
                    quote: "I will send the contract",
                    ticked: false,
                },
                {
                    taskId: second.id,
                    quote: "I will send the contract",
                    ticked: false,
                },
            ]),
        );
        expect(review?.matches).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    ticked: false,
                    ambiguous: true,
                    candidate: expect.objectContaining({
                        id: first.id,
                        text: "Send the signed contract",
                        assignee: null,
                        dueDate: null,
                        duePhrase: null,
                        homeItem: expect.objectContaining({ id: REC }),
                    }),
                }),
                expect.objectContaining({
                    ticked: false,
                    ambiguous: true,
                    candidate: expect.objectContaining({ id: second.id }),
                }),
            ]),
        );
        expect(
            await db()
                .select()
                .from(taskUpdateProposals)
                .where(eq(taskUpdateProposals.itemId, LATER)),
        ).toEqual([]);
    });

    it("stores one match mention separately from its field proposal", async () => {
        const task = await addTask(alice, REC, {
            text: "Send the partner email",
            status: "open",
        });
        await summarize(LATER, [], {
            matches: [
                match(task.id, {
                    quote: "the same partner email",
                    evidenceStartMs: 1_000,
                }),
            ],
            updates: [
                {
                    taskId: task.id,
                    kind: "due",
                    dueDate: "2026-10-20",
                    duePhrase: "by next Tuesday",
                    quote: "by next Tuesday",
                    evidenceStartMs: 2_000,
                },
            ],
        });

        const [mention] = await db()
            .select({
                id: taskMentions.id,
                quote: taskMentions.quote,
                decision: taskMentions.matchDecision,
            })
            .from(taskMentions)
            .where(
                and(
                    eq(taskMentions.itemId, LATER),
                    eq(taskMentions.taskId, task.id),
                ),
            );
        const [field] = await db()
            .select({
                id: taskUpdateProposals.id,
                kind: taskUpdateProposals.kind,
                dueDate: taskUpdateProposals.dueDate,
                ticked: taskUpdateProposals.ticked,
            })
            .from(taskUpdateProposals)
            .where(eq(taskUpdateProposals.itemId, LATER));
        expect(mention).toMatchObject({ decision: "suggested" });
        expect(mention?.quote ? decryptText(mention.quote) : null).toBe(
            "the same partner email",
        );
        expect(field).toMatchObject({
            kind: "due",
            dueDate: "2026-10-20",
            ticked: false,
        });
        expect(field?.id).not.toBe(mention?.id);
    });

    it("stores a pure match unticked and accepts it only after review", async () => {
        const task = await addTask(alice, REC, {
            text: "Send the partner email",
            status: "open",
        });
        await db()
            .update(recordingTasks)
            .set({
                quote: encryptText("I will send the partner email"),
                evidenceStartMs: 7_000,
            })
            .where(
                and(
                    eq(recordingTasks.id, task.id),
                    eq(recordingTasks.userId, ALICE),
                ),
            );
        await summarize(LATER, [], {
            matches: [match(task.id, { quote: "the same partner email" })],
        });

        const listed = await review(alice, LATER);
        expect(listed.matches).toEqual([
            expect.objectContaining({
                ticked: false,
                ambiguous: false,
                evidenceProvenance: null,
                candidate: expect.objectContaining({
                    id: task.id,
                    text: "Send the partner email",
                    homeItem: expect.objectContaining({ id: REC }),
                    quote: "I will send the partner email",
                    evidenceStartMs: 7_000,
                    evidenceText: null,
                }),
            }),
        ]);

        const [suggestion] = listed.matches;
        if (!suggestion) throw new Error("missing suggested match");
        await tickUpdateProposal(
            alice,
            LATER,
            suggestion.id,
            true,
            suggestion.version,
        );

        await acceptReview(alice, LATER);
        const [mention] = await db()
            .select({ decision: taskMentions.matchDecision })
            .from(taskMentions)
            .where(
                and(
                    eq(taskMentions.itemId, LATER),
                    eq(taskMentions.taskId, task.id),
                ),
            );
        expect(mention?.decision).toBe("accepted");
    });

    it("rejects a pure match unticked before Apply", async () => {
        const task = await addTask(alice, REC, {
            text: "Send the partner email",
            status: "open",
        });
        await summarize(LATER, [], { matches: [match(task.id)] });
        const [suggestion] = (await review(alice, LATER)).matches;
        if (!suggestion) throw new Error("missing suggested match");

        await tickUpdateProposal(
            alice,
            LATER,
            suggestion.id,
            false,
            suggestion.version,
        );
        await acceptReview(alice, LATER);

        const [mention] = await db()
            .select({ decision: taskMentions.matchDecision })
            .from(taskMentions)
            .where(eq(taskMentions.id, suggestion.id));
        expect(mention?.decision).toBe("rejected");
    });

    it("accepts one ambiguous candidate and rejects the alternatives", async () => {
        const first = await addTask(alice, REC, {
            text: "Send the signed contract",
            status: "open",
        });
        const second = await addTask(alice, REC, {
            text: "Send the supplier contract",
            status: "open",
        });
        await summarize(LATER, [
            proposal("Send the contract", {
                quote: "I will send the contract",
                candidateTaskIds: [first.id, second.id],
            }),
        ]);
        const listed = await review(alice, LATER);
        const chosen = listed.matches.find(
            (candidate) => candidate.candidate.id === first.id,
        );
        if (!chosen) throw new Error("missing ambiguous candidate");
        await tickUpdateProposal(alice, LATER, chosen.id, true, chosen.version);

        expect(await acceptReview(alice, LATER)).toMatchObject({
            accepted: 0,
            rejected: 1,
        });
        const decisions = await db()
            .select({
                taskId: taskMentions.taskId,
                decision: taskMentions.matchDecision,
            })
            .from(taskMentions)
            .where(
                and(
                    eq(taskMentions.itemId, LATER),
                    inArray(taskMentions.taskId, [first.id, second.id]),
                ),
            );
        expect(decisions).toEqual(
            expect.arrayContaining([
                { taskId: first.id, decision: "accepted" },
                { taskId: second.id, decision: "rejected" },
            ]),
        );
        expect((await review(alice, LATER)).proposals).toEqual([]);
    });

    it("accepts an unticked match when its field proposal applies", async () => {
        const task = await addTask(alice, REC, {
            text: "Send the partner email",
            status: "open",
        });
        await summarize(LATER, [], {
            matches: [
                match(task.id, {
                    evidenceProvenance: "quoted",
                }),
            ],
            updates: [
                {
                    taskId: task.id,
                    kind: "due",
                    dueDate: "2026-10-20",
                    duePhrase: null,
                    quote: "by October 20",
                    evidenceStartMs: null,
                    ticked: false,
                },
            ],
        });
        const listed = await review(alice, LATER);
        expect(listed.matches[0]?.ticked).toBe(false);
        const [update] = listed.updates;
        if (!update) throw new Error("missing field proposal");
        await tickUpdateProposal(alice, LATER, update.id, true, update.version);

        await acceptReview(alice, LATER);
        const [mention] = await db()
            .select({ decision: taskMentions.matchDecision })
            .from(taskMentions)
            .where(
                and(
                    eq(taskMentions.itemId, LATER),
                    eq(taskMentions.taskId, task.id),
                ),
            );
        expect(mention?.decision).toBe("accepted");
    });

    it("skips and rejects a selected match whose task closed meanwhile", async () => {
        const task = await addTask(alice, REC, {
            text: "Send the partner email",
            status: "open",
        });
        await summarize(LATER, [], { matches: [match(task.id)] });
        const [suggestion] = (await review(alice, LATER)).matches;
        if (!suggestion) throw new Error("missing suggested match");
        await tickUpdateProposal(
            alice,
            LATER,
            suggestion.id,
            true,
            suggestion.version,
        );
        await updateTask(alice, task.id, {
            version: task.version,
            status: "done",
        });

        expect(await acceptReview(alice, LATER)).toMatchObject({
            updatesSkipped: 1,
        });
        const [mention] = await db()
            .select({ decision: taskMentions.matchDecision })
            .from(taskMentions)
            .where(
                and(
                    eq(taskMentions.itemId, LATER),
                    eq(taskMentions.taskId, task.id),
                ),
            );
        expect(mention?.decision).toBe("rejected");
    });

    it("counts one source-review decision for a match and its field proposal", async () => {
        const task = await addTask(alice, REC, {
            text: "Send the partner email",
            status: "open",
        });
        await summarize(LATER, [], {
            matches: [match(task.id)],
            updates: [
                {
                    taskId: task.id,
                    kind: "done",
                    dueDate: null,
                    duePhrase: null,
                    quote: "the partner email was sent",
                    evidenceStartMs: 1_000,
                },
            ],
        });

        await expect(share(LATER)).resolves.toBeUndefined();
        expect((await gatherFacts(LATER, "private", ALICE)).taskReview).toEqual(
            {
                proposals: 0,
                followUps: 1,
            },
        );
    });

    it("drops a task that is no longer visible to the proposal reviewer", async () => {
        const task = await addTask(alice, REC, {
            text: "Private task",
            status: "open",
        });
        const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            await summarize(LATER, [], {
                reviewer: bob,
                matches: [match(task.id)],
                updates: [
                    {
                        taskId: task.id,
                        kind: "done",
                        dueDate: null,
                        duePhrase: null,
                        quote: "done",
                        evidenceStartMs: 1_000,
                    },
                ],
            });
            expect(warning).toHaveBeenCalledOnce();
        } finally {
            warning.mockRestore();
        }

        expect(
            await db()
                .select()
                .from(taskMentions)
                .where(eq(taskMentions.itemId, LATER)),
        ).toEqual([]);
        expect(
            await db()
                .select()
                .from(taskUpdateProposals)
                .where(eq(taskUpdateProposals.itemId, LATER)),
        ).toEqual([]);
    });

    it("shows an earlier completion as informational after a manual status edit", async () => {
        await db()
            .update(chatterItems)
            .set({ occurredAt: new Date("2026-10-08T08:00:00.000Z") })
            .where(eq(chatterItems.id, REC));
        await db()
            .update(chatterItems)
            .set({ occurredAt: new Date("2026-10-08T09:00:00.000Z") })
            .where(eq(chatterItems.id, LATER));
        await summarize(REC, [proposal("Send the partner email")]);
        await acceptReview(alice, REC);
        const [task] = (await review(alice, REC)).tasks;
        if (!task) throw new Error("missing accepted task");

        const completion = {
            taskId: task.id,
            kind: "done" as const,
            dueDate: null,
            duePhrase: null,
            quote: "the partner email is sent",
            evidenceStartMs: 3_000,
        };
        await summarize(LATER, [], { updates: [completion] });
        expect((await review(alice, LATER)).updates).toHaveLength(1);

        const done = await updateTask(alice, task.id, {
            version: task.version,
            status: "done",
        });
        await updateTask(alice, task.id, {
            version: done.version,
            status: "open",
        });

        await summarize(LATER, [], { updates: [completion] });
        expect((await review(alice, LATER)).updates).toEqual([
            expect.objectContaining({
                kind: "done",
                earlierMention: true,
                ticked: false,
            }),
        ]);
        expect(await loadShareGate(db(), LATER, ALICE)).toEqual([]);
        expect((await gatherFacts(LATER, "private", ALICE)).taskReview).toEqual(
            {
                proposals: 0,
                followUps: 0,
            },
        );
        const [stored] = await db()
            .select({
                statusEffectiveAt: recordingTasks.statusEffectiveAt,
            })
            .from(recordingTasks)
            .where(eq(recordingTasks.id, task.id));
        expect(stored?.statusEffectiveAt?.getTime()).toBeGreaterThan(
            new Date("2026-10-08T09:00:00.000Z").getTime(),
        );
        expect(
            await db()
                .select()
                .from(taskMentions)
                .where(
                    and(
                        eq(taskMentions.itemId, LATER),
                        eq(taskMentions.taskId, task.id),
                    ),
                ),
        ).toHaveLength(1);
    });

    it("replaces the same view's proposed and follow-up mentions on re-summary", async () => {
        const target = await addTask(alice, LATER, {
            text: "Send the partner email",
            status: "open",
        });
        await summarize(REC, [proposal("Draft the pricing page")], {
            updates: [
                {
                    taskId: target.id,
                    kind: "done",
                    dueDate: null,
                    duePhrase: null,
                    quote: "the partner email is sent",
                    evidenceStartMs: 8_000,
                },
            ],
        });
        await summarize(REC, [proposal("Book the venue")]);

        const mentions = await db()
            .select({
                quote: taskMentions.quote,
                decision: taskMentions.matchDecision,
            })
            .from(taskMentions)
            .where(eq(taskMentions.itemId, REC));
        expect(
            mentions.map((mention) => ({
                ...mention,
                quote: mention.quote ? decryptText(mention.quote) : null,
            })),
        ).toEqual([{ quote: null, decision: "home" }]);
    });

    it("keeps a suggested match the reviewer ticked through a re-summary", async () => {
        const target = await addTask(alice, LATER, {
            text: "Send the partner email",
            status: "open",
        });
        await summarize(REC, [], {
            matches: [
                match(target.id, {
                    evidenceProvenance: "unverified",
                }),
            ],
        });
        const [suggested] = (await review(alice)).matches;
        if (!suggested) throw new Error("missing suggested match");
        await tickUpdateProposal(
            alice,
            REC,
            suggested.id,
            true,
            suggested.version,
        );

        await summarize(REC, []);

        expect((await review(alice)).matches).toMatchObject([
            { id: suggested.id, ticked: true },
        ]);
    });

    it("finishes parallel re-summaries and merges without deadlocks", async () => {
        for (let iteration = 0; iteration < 8; iteration++) {
            const source = await addTask(alice, REC, {
                text: `Concurrent source ${iteration}`,
                status: "open",
            });
            const target = await addTask(alice, LATER, {
                text: `Concurrent target ${iteration}`,
                status: "open",
            });
            await Promise.all([
                summarize(REC, [], { matches: [match(target.id)] }),
                mergeTaskIntoTask(alice, source.id, target.id),
            ]);
        }
    });

    it("settles untouched task review when a summary runs with Tasks off", async () => {
        const target = await addTask(alice, LATER, {
            text: "Send the partner email",
            status: "open",
        });
        await summarize(REC, [proposal("Draft the pricing page")], {
            matches: [match(target.id)],
        });
        const result = await upsertEnhancement({
            userId: ALICE,
            recordingId: REC,
            transcriptionId: transcriptId,
            summary: "Summary without tasks.",
            keyPoints: [],
            actionItems: [],
            source: "riffado",
            provider: "openai",
            model: "gpt",
            allowReaped: true,
            tasks: null,
        });
        expect(result.committed).toBe(true);
        expect(await review(alice)).toMatchObject({
            proposals: [],
            updates: [],
            matches: [],
        });
    });

    it("undoes an accepted match for the item owner without reverting fields", async () => {
        const target = await addTask(alice, REC, {
            text: "Send the partner email",
            status: "open",
        });
        await summarize(LATER, [], {
            matches: [match(target.id)],
            updates: [
                {
                    taskId: target.id,
                    kind: "due",
                    dueDate: "2026-10-30",
                    duePhrase: null,
                    quote: "send it by October 30",
                    evidenceStartMs: 2_000,
                },
            ],
        });
        const before = await review(alice, LATER);
        const update = before.updates[0];
        if (!update) throw new Error("missing update");
        await tickUpdateProposal(alice, LATER, update.id, true, update.version);
        await acceptReview(alice, LATER);
        expect((await review(alice, LATER)).tasks).toMatchObject([
            { id: target.id, canUndoMatch: true },
        ]);

        await expect(
            undoTaskMatch(bob, LATER, target.id),
        ).rejects.toMatchObject({
            statusCode: 404,
        });
        await undoTaskMatch(alice, LATER, target.id);

        const [mention] = await db()
            .select({ decision: taskMentions.matchDecision })
            .from(taskMentions)
            .where(
                and(
                    eq(taskMentions.itemId, LATER),
                    eq(taskMentions.taskId, target.id),
                ),
            );
        expect(mention?.decision).toBe("undone");
        const [stored] = await db()
            .select({ dueDate: recordingTasks.dueDate })
            .from(recordingTasks)
            .where(eq(recordingTasks.id, target.id));
        expect(stored?.dueDate).toBe("2026-10-30");
        expect((await review(alice, LATER)).tasks).toEqual([]);
        await expect(
            undoTaskMatch(alice, REC, target.id),
        ).rejects.toMatchObject({
            statusCode: 409,
        });
    });

    it("lets an Organization curator undo a match on a shared item", async () => {
        const target = await addTask(alice, REC, {
            text: "Publish the launch brief",
            status: "open",
        });
        await summarize(LATER, [], { matches: [match(target.id)] });
        const [suggestion] = (await review(alice, LATER)).matches;
        if (!suggestion) throw new Error("missing suggested match");
        await tickUpdateProposal(
            alice,
            LATER,
            suggestion.id,
            true,
            suggestion.version,
        );
        await acceptReview(alice, LATER);
        await share(REC);
        await share(LATER);

        await undoTaskMatch(org, LATER, target.id);

        const [mention] = await db()
            .select({ decision: taskMentions.matchDecision })
            .from(taskMentions)
            .where(
                and(
                    eq(taskMentions.itemId, LATER),
                    eq(taskMentions.taskId, target.id),
                ),
            );
        expect(mention?.decision).toBe("undone");
    });

    it("accepts the ticked, rejects the rest for good, and keeps tasks over a re-summarize", async () => {
        await summarize(REC, [
            proposal("Draft the pricing page"),
            proposal("Share the draft"),
        ]);
        const { proposals } = await review(alice);
        const share = proposals[1];
        if (!share) throw new Error("missing proposal");
        await updateTask(alice, share.id, {
            version: share.version,
            ticked: false,
        });
        expect(await acceptReview(alice, REC)).toMatchObject({
            accepted: 1,
            rejected: 1,
        });

        const after = await review(alice);
        expect(after.proposals).toEqual([]);
        expect(after.tasks.map((task) => [task.text, task.status])).toEqual([
            ["Draft the pricing page", "open"],
        ]);

        // The next summary says both again, plus something new.
        await summarize(REC, [
            proposal("Draft the pricing page"),
            proposal("share the draft!"),
            proposal("Send the partner email"),
        ]);
        const again = await review(alice);
        expect(again.tasks.map((task) => task.text)).toEqual([
            "Draft the pricing page",
        ]);
        expect(again.proposals.map((task) => task.text)).toEqual([
            "Send the partner email",
        ]);
    });

    it("keeps a proposal the reviewer touched over a re-summarize", async () => {
        await summarize(REC, [
            proposal("Draft the pricing page"),
            proposal("Book the venue"),
        ]);
        const [draft] = (await review(alice)).proposals;
        if (!draft) throw new Error("missing proposal");
        await updateTask(alice, draft.id, {
            version: draft.version,
            dueDate: "2026-10-20",
        });
        await summarize(REC, [
            proposal("Draft the pricing page"),
            proposal("Send the partner email"),
        ]);
        const after = (await review(alice)).proposals;
        expect(after.map((row) => [row.text, row.dueDate])).toEqual([
            ["Draft the pricing page", "2026-10-20"],
            ["Send the partner email", null],
        ]);
    });

    it("shares while follow-up changes still wait for review", async () => {
        const task = await addTask(alice, LATER, {
            text: "Send the partner email",
            status: "open",
        });
        await db().insert(taskUpdateProposals).values({
            taskId: task.id,
            itemId: REC,
            userId: ALICE,
            kind: "done",
        });
        await expect(share(REC)).resolves.toBeUndefined();
    });

    it("merges proposals into the first and remembers the others as rejected", async () => {
        await summarize(REC, [
            proposal("Draft the pricing page", {
                dueDate: "2026-10-20",
                evidenceStartMs: 100,
            }),
            proposal("Share the pricing page draft", {
                assigneePersonId: bobPrivate,
                dueDate: "2026-10-16",
                quote: "share the pricing page draft",
                evidenceStartMs: 200,
            }),
        ]);
        const { proposals } = await review(alice);
        const merged = await mergeProposals(
            alice,
            REC,
            proposals.map((row) => row.id),
        );
        expect(merged).toMatchObject({
            text: "Draft the pricing page; Share the pricing page draft",
            dueDate: "2026-10-16",
            assignee: { personId: bobPrivate, name: "Bob" },
            quote: "share the pricing page draft",
            evidenceStartMs: 200,
            evidenceText: null,
            evidenceProvenance: null,
        });
        const rejections = await db()
            .select()
            .from(recordingTaskRejections)
            .where(eq(recordingTaskRejections.itemId, REC));
        expect(rejections.map((row) => row.fingerprintHmac).sort()).toEqual(
            [
                taskFingerprint("Draft the pricing page"),
                taskFingerprint("Share the pricing page draft"),
            ].sort(),
        );
    });

    it("requests workflow advancement after proposal merges and review-item merges", async () => {
        await summarize(REC, [
            proposal("Draft the pricing page"),
            proposal("Share the pricing page draft"),
        ]);
        const beforeProposalMerge = (
            await db()
                .select({ generation: itemProcessing.requestedGeneration })
                .from(itemProcessing)
                .where(
                    and(
                        eq(itemProcessing.itemId, REC),
                        eq(itemProcessing.userId, ALICE),
                        eq(itemProcessing.view, "private"),
                    ),
                )
        )[0]?.generation;
        const proposals = (await review(alice)).proposals;
        const merged = await mergeProposals(
            alice,
            REC,
            proposals.map((row) => row.id),
        );
        expect(
            (
                await db()
                    .select({ generation: itemProcessing.requestedGeneration })
                    .from(itemProcessing)
                    .where(
                        and(
                            eq(itemProcessing.itemId, REC),
                            eq(itemProcessing.userId, ALICE),
                            eq(itemProcessing.view, "private"),
                        ),
                    )
            )[0]?.generation,
        ).toBe((beforeProposalMerge ?? 0) + 1);

        const target = await addTask(alice, LATER, {
            text: "Publish the pricing page",
            status: "open",
        });
        await mergeTaskIntoTask(alice, merged.id, target.id, {
            reviewItemId: REC,
        });

        expect(
            (
                await db()
                    .select({ generation: itemProcessing.requestedGeneration })
                    .from(itemProcessing)
                    .where(
                        and(
                            eq(itemProcessing.itemId, REC),
                            eq(itemProcessing.userId, ALICE),
                            eq(itemProcessing.view, "private"),
                        ),
                    )
            )[0]?.generation,
        ).toBe((beforeProposalMerge ?? 0) + 2);
        expect((await review(alice)).proposals).toEqual([]);
    });

    it("moves a mail proposal's quote, text anchor and provenance together", async () => {
        const mailId = "mail-merge";
        await addMail(mailId);
        const [first, second] = await db()
            .insert(recordingTasks)
            .values([
                {
                    itemId: mailId,
                    userId: ALICE,
                    status: "proposed" as const,
                    text: encryptText("Draft the reply"),
                    evidenceSegmentIndex: 0,
                    evidenceCharStart: 1,
                    evidenceCharEnd: 6,
                    evidenceProvenance: "unverified" as const,
                    source: "riffado" as const,
                    position: 0,
                },
                {
                    itemId: mailId,
                    userId: ALICE,
                    status: "proposed" as const,
                    text: encryptText("Send the reply"),
                    quote: encryptText("send the reply"),
                    evidenceSegmentIndex: 2,
                    evidenceCharStart: 10,
                    evidenceCharEnd: 24,
                    evidenceProvenance: "quoted" as const,
                    source: "riffado" as const,
                    position: 1,
                },
            ])
            .returning({ id: recordingTasks.id });

        const merged = await mergeProposals(alice, mailId, [
            first?.id ?? "",
            second?.id ?? "",
        ]);
        expect(merged).toMatchObject({
            quote: "send the reply",
            evidenceStartMs: null,
            evidenceText: {
                segmentIndex: 2,
                charStart: 10,
                charEnd: 24,
            },
            evidenceProvenance: "quoted",
        });
    });

    it("offers a visible mail task to an audio summary, but not another owner's private task", async () => {
        await db().insert(transcriptSpeakers).values({
            userId: ALICE,
            transcriptionId: transcriptId,
            label: "speaker_0",
            personId: bobPrivate,
            source: "user",
            status: "confirmed",
            confirmedByUserId: ALICE,
        });
        await addMail("mail-candidate");
        const mailTask = await addTask(alice, "mail-candidate", {
            text: "Send the mail contract",
            assigneePersonId: bobPrivate,
            status: "open",
        });
        await addMail("mail-private-other", BOB);
        const [otherTask] = await db()
            .insert(recordingTasks)
            .values({
                itemId: "mail-private-other",
                userId: BOB,
                status: "open",
                text: encryptText("Private task of Bob"),
                assigneePersonId: bobPrivate,
                source: "manual",
            })
            .returning({ id: recordingTasks.id });

        const context = await loadTasksPromptContext({
            recording: {
                id: REC,
                userId: ALICE,
                occurredAt: new Date("2026-10-06T10:00:00Z"),
                timezone: 0,
                zonemins: 0,
            },
            transcriptionId: transcriptId,
            orgView: false,
            reviewer: alice,
        });
        expect([...context.refs.values()]).toEqual([mailTask.id]);
        expect(context.text).toContain("Send the mail contract");
        expect(context.text).toContain("speaker_0");
        expect(context.text).not.toContain("Private task of Bob");
        expect([...context.refs.values()]).not.toContain(otherTask?.id);
    });

    it("refuses a stale version", async () => {
        const task = await addTask(alice, REC, {
            text: "Call Dana",
            status: "open",
        });
        await updateTask(alice, task.id, {
            version: task.version,
            text: "Call Dana today",
        });
        await expect(
            updateTask(alice, task.id, {
                version: task.version,
                text: "Call Dana",
            }),
        ).rejects.toMatchObject({ statusCode: 409 });
        // The old words are not proposed again.
        await summarize(REC, [proposal("Call Dana"), proposal("Book a room")]);
        expect((await review(alice)).proposals.map((row) => row.text)).toEqual([
            "Book a room",
        ]);
    });

    it("sets field effective times on manual edits", async () => {
        const task = await addTask(alice, REC, {
            text: "Call Dana",
            status: "open",
        });
        const due = await updateTask(alice, task.id, {
            version: task.version,
            dueDate: "2026-10-20",
        });
        const assigned = await updateTask(alice, task.id, {
            version: due.version,
            assigneePersonId: bobPrivate,
        });
        await updateTask(alice, task.id, {
            version: assigned.version,
            status: "done",
        });

        const [stored] = await db()
            .select({
                status: recordingTasks.statusEffectiveAt,
                due: recordingTasks.dueEffectiveAt,
                assignee: recordingTasks.assigneeEffectiveAt,
            })
            .from(recordingTasks)
            .where(eq(recordingTasks.id, task.id));
        const itemTime = new Date("2026-10-06T10:00:00.000Z").getTime();
        expect(stored?.status?.getTime()).toBeGreaterThan(itemTime);
        expect(stored?.due?.getTime()).toBeGreaterThan(itemTime);
        expect(stored?.assignee?.getTime()).toBeGreaterThan(itemTime);
    });

    it("keeps a private recording's tasks to its owner, whoever they name", async () => {
        const task = await addTask(alice, REC, {
            text: "Draft the pricing page",
            assigneePersonId: bobPrivate,
            status: "open",
        });
        expect(await review(bob, REC).catch(() => null)).toBeNull();
        expect(await review(org, REC).catch(() => null)).toBeNull();
        expect(await listTasks(bob, query("mine"))).toEqual([]);
        expect(await countNewTasks(bob)).toBe(0);
        await expect(
            updateTask(bob, task.id, { version: task.version, status: "done" }),
        ).rejects.toMatchObject({ statusCode: 404 });
        await expect(
            addTask(org, REC, {
                text: "Organization cannot add privately",
                status: "open",
            }),
        ).rejects.toMatchObject({ statusCode: 404 });
        expect(
            (await listTasks(alice, query("tracked"))).map((row) => row.text),
        ).toEqual(["Draft the pricing page"]);
    });

    it("on a shared recording: home owner and curator edit, assignee closes, members read", async () => {
        await share();
        const task = await addTask(org, REC, {
            text: "Draft the pricing page",
            assigneePersonId: bobOrg,
            dueDate: "2026-10-16",
            status: "open",
        });
        expect(task).toMatchObject({ canEdit: true, canClose: true });

        // A private person cannot be named on a shared recording.
        await expect(
            addTask(org, REC, {
                text: "x",
                assigneePersonId: bobPrivate,
                status: "open",
            }),
        ).rejects.toMatchObject({ statusCode: 400 });

        // Bob: in his list and badge, may close, may not edit.
        const [mine] = await listTasks(bob, query("mine"));
        expect(mine).toMatchObject({
            id: task.id,
            canEdit: false,
            canClose: true,
            recording: { id: REC, view: "org" },
        });
        expect(await countNewTasks(bob)).toBe(1);
        await markTasksSeen(bob);
        expect(await countNewTasks(bob)).toBe(0);
        await expect(
            updateTask(bob, task.id, { version: task.version, text: "x" }),
        ).rejects.toMatchObject({ statusCode: 403 });
        const done = await updateTask(bob, task.id, {
            version: task.version,
            status: "done",
        });
        expect(done.status).toBe("done");

        // Alice, the home owner: may reopen, edit and drop.
        const reopened = await updateTask(alice, task.id, {
            version: done.version,
            status: "open",
        });
        const edited = await updateTask(alice, task.id, {
            version: reopened.version,
            text: "Draft the launch page",
        });
        const dropped = await updateTask(alice, task.id, {
            version: edited.version,
            status: "dropped",
        });
        expect(dropped).toMatchObject({
            text: "Draft the launch page",
            status: "dropped",
        });

        // Carol, a member: sees it on the recording, not in her lists.
        const forCarol = await review(carol);
        expect(forCarol.canEdit).toBe(false);
        expect(forCarol.tasks[0]).toMatchObject({
            canEdit: false,
            canClose: false,
        });
        expect(await listTasks(carol, query("mine"))).toEqual([]);
        expect(await listTasks(carol, query("tracked"))).toEqual([]);

        // The Organization tracks it.
        expect(
            (await listTasks(org, query("tracked"))).map((row) => row.id),
        ).toEqual([task.id]);
        expect(
            (
                await listCallerTasks(org, {
                    status: "all",
                    assigneePersonId: null,
                    recordingId: null,
                    dueBefore: null,
                    recordingCondition: null,
                    after: null,
                    limit: 10,
                })
            ).map((row) => row.id),
        ).toEqual([task.id]);
    });

    it("gives an idp curator the shared-item rights and match-review right", async () => {
        mockEnv.AUTHZ_MODE = "idp";
        try {
            await share();
            await share(LATER);
            const memberActor: ActorContext = {
                kind: "user",
                actorId: CAROL,
                issuer: "https://idp.example.test/realms/chatterbox",
                subject: "carol-subject",
                capabilities: new Set(["use"]),
                clientId: "chatterbox",
                clientPermissions: new Set(),
                verifiedAt: new Date(),
            };
            const curatorActor: ActorContext = {
                kind: "user",
                actorId: CAROL,
                issuer: "https://idp.example.test/realms/chatterbox",
                subject: "carol-subject",
                capabilities: new Set(["use", "org.curate"]),
                clientId: "chatterbox",
                clientPermissions: new Set(),
                verifiedAt: new Date(),
            };
            const curator = await taskViewer(
                { id: CAROL, email: "carol@example.test" },
                curatorActor,
            );
            const member = await taskViewer(
                { id: CAROL, email: "carol@example.test" },
                memberActor,
            );
            const carolMail = "mail-carol-private-rights";
            const aliceMail = "mail-alice-private-rights";
            await addMail(carolMail, CAROL);
            await addMail(aliceMail);
            const ownPrivate = await addTask(curator, carolMail, {
                text: "Carol's private task",
                status: "open",
            });
            const otherPrivate = await addTask(alice, aliceMail, {
                text: "Alice's private task",
                status: "open",
            });
            expect(
                (await listTasks(curator, query("tracked"))).map(
                    (row) => row.id,
                ),
            ).toContain(ownPrivate.id);
            const callerTasks = await listCallerTasks(curator, {
                status: "all",
                assigneePersonId: null,
                recordingId: null,
                dueBefore: null,
                recordingCondition: null,
                after: null,
                limit: 10,
            });
            expect(callerTasks.map((row) => row.id)).toContain(ownPrivate.id);
            expect(callerTasks.map((row) => row.id)).not.toContain(
                otherPrivate.id,
            );
            expect(
                await review(curator, aliceMail).catch(() => null),
            ).toBeNull();
            await expect(
                updateTask(curator, otherPrivate.id, {
                    version: otherPrivate.version,
                    text: "Curator must not see this",
                }),
            ).rejects.toMatchObject({ statusCode: 404 });
            const ownEdited = await updateTask(curator, ownPrivate.id, {
                version: ownPrivate.version,
                text: "Carol's edited private task",
            });
            const ownClosed = await updateTask(curator, ownPrivate.id, {
                version: ownEdited.version,
                status: "done",
            });
            expect(ownClosed).toMatchObject({
                text: "Carol's edited private task",
                status: "done",
                canEdit: true,
                canClose: true,
            });

            await markTasksSeen(curator);
            const [privateRouted] = await db()
                .insert(taskUpdateProposals)
                .values({
                    taskId: ownPrivate.id,
                    itemId: carolMail,
                    userId: CAROL,
                    kind: "due",
                    dueDate: "2026-10-22",
                    state: "awaiting_target_review",
                    routedTo: [CAROL],
                    version: ownClosed.version,
                })
                .returning({ id: taskUpdateProposals.id });
            expect(
                (await listRoutedTaskProposals(curator)).map((row) => row.id),
            ).toContain(privateRouted?.id);
            expect(await countNewTasks(curator)).toBe(1);
            await markTasksSeen(curator);
            expect(await countNewTasks(curator)).toBe(1);
            await expect(
                applyRoutedTaskProposal(
                    curator,
                    carolMail,
                    privateRouted?.id ?? "",
                ),
            ).resolves.toEqual({
                state: "obsolete",
                obsoleteReason: "task_closed",
            });
            expect(await countNewTasks(curator)).toBe(0);

            const task = await addTask(alice, REC, {
                text: "Prepare the launch notes",
                assigneePersonId: bobOrg,
                status: "open",
            });

            expect((await review(curator, REC)).tasks[0]).toMatchObject({
                id: task.id,
                canEdit: true,
                canClose: true,
            });
            expect(
                (
                    await listTasks(curator, {
                        ...query("tracked"),
                        organization: true,
                    })
                ).map((row) => row.id),
            ).toContain(task.id);
            const edited = await updateTask(curator, task.id, {
                version: task.version,
                text: "Prepare the final launch notes",
            });
            expect(edited.text).toBe("Prepare the final launch notes");
            expect((await review(member, REC)).tasks[0]).toMatchObject({
                id: task.id,
                canEdit: false,
                canClose: false,
            });
            await expect(
                addTask(member, REC, {
                    text: "Member cannot add",
                    status: "open",
                }),
            ).rejects.toMatchObject({ statusCode: 403 });
            await expect(
                addTask(curator, REC, {
                    text: "Curator can add",
                    status: "open",
                }),
            ).resolves.toMatchObject({ canEdit: true, canClose: true });

            await db()
                .insert(taskMentions)
                .values({
                    taskId: task.id,
                    itemId: LATER,
                    userId: ALICE,
                    view: "org",
                    statementAt: new Date("2026-10-08T10:00:00Z"),
                    matchDecision: "suggested",
                    ticked: true,
                });
            expect((await review(curator, LATER)).matches).toHaveLength(1);
            await acceptReview(curator, LATER);
            const [mention] = await db()
                .select({ decision: taskMentions.matchDecision })
                .from(taskMentions)
                .where(
                    and(
                        eq(taskMentions.itemId, LATER),
                        eq(taskMentions.taskId, task.id),
                    ),
                );
            expect(mention?.decision).toBe("accepted");
            const closed = await updateTask(curator, task.id, {
                version: edited.version,
                status: "done",
            });
            expect(closed.status).toBe("done");
        } finally {
            mockEnv.AUTHZ_MODE = "local";
        }
    });

    it.each([
        "local",
        "idp",
    ] as const)("resolves %s curators for accepting and undoing shared matches", async (mode) => {
        mockEnv.AUTHZ_MODE = mode;
        try {
            const curator =
                mode === "local"
                    ? org
                    : await taskViewer(
                          { id: CAROL, email: "carol@example.test" },
                          {
                              kind: "user",
                              actorId: CAROL,
                              issuer: "https://idp.example.test/realms/chatterbox",
                              subject: "carol-subject",
                              capabilities: new Set(["use", "org.curate"]),
                              clientId: "chatterbox",
                              clientPermissions: new Set(),
                              verifiedAt: new Date(),
                          },
                      );
            const task = await addTask(alice, REC, {
                text: "Publish the launch notes",
                status: "open",
            });
            expect(await review(curator, LATER).catch(() => null)).toBeNull();

            await share(REC);
            await share(LATER);
            const [mention] = await db()
                .insert(taskMentions)
                .values({
                    taskId: task.id,
                    itemId: LATER,
                    userId: ALICE,
                    view: "org",
                    statementAt: new Date("2026-10-08T10:00:00Z"),
                    matchDecision: "suggested",
                    ticked: true,
                })
                .returning({ id: taskMentions.id });
            await tickUpdateProposal(
                curator,
                LATER,
                mention?.id ?? "",
                false,
                task.version,
            );
            await tickUpdateProposal(
                curator,
                LATER,
                mention?.id ?? "",
                true,
                task.version,
            );
            await acceptReview(curator, LATER);
            expect(
                (
                    await db()
                        .select({ decision: taskMentions.matchDecision })
                        .from(taskMentions)
                        .where(eq(taskMentions.id, mention?.id ?? ""))
                )[0]?.decision,
            ).toBe("accepted");
        } finally {
            mockEnv.AUTHZ_MODE = "local";
        }
    });

    it("shows a shared recording's proposals to the home owner and curators", async () => {
        await share();
        await db()
            .insert(recordingTasks)
            .values({
                itemId: REC,
                userId: ALICE,
                status: "proposed",
                text: encryptText("Book the venue"),
                source: "riffado",
            });
        expect((await review(org)).proposals).toHaveLength(1);
        expect((await review(alice)).proposals).toHaveLength(1);
        expect((await review(bob)).proposals).toEqual([]);
        await expect(acceptReview(alice, REC)).resolves.toMatchObject({
            accepted: 1,
            rejected: 0,
        });
    });

    it("applies a ticked follow-up from a later recording", async () => {
        const task = await addTask(alice, REC, {
            text: "Send the partner email",
            status: "open",
        });
        const [update] = await db()
            .insert(taskUpdateProposals)
            .values({
                taskId: task.id,
                itemId: LATER,
                userId: ALICE,
                kind: "done",
                quote: encryptText("I sent the partner email"),
            })
            .returning({
                id: taskUpdateProposals.id,
                version: taskUpdateProposals.version,
            });
        const later = await review(alice, LATER);
        expect(later.updates[0]?.task).toMatchObject({
            id: task.id,
            text: "Send the partner email",
        });
        await tickUpdateProposal(
            alice,
            LATER,
            update?.id ?? "",
            true,
            update?.version ?? 0,
        );
        expect(await acceptReview(alice, LATER)).toMatchObject({
            updatesApplied: 1,
            updatesSkipped: 0,
        });
        const [row] = await db()
            .select({ status: recordingTasks.status })
            .from(recordingTasks)
            .where(and(eq(recordingTasks.id, task.id)));
        expect(row?.status).toBe("done");
        expect(
            await db()
                .select({ state: taskUpdateProposals.state })
                .from(taskUpdateProposals)
                .where(eq(taskUpdateProposals.itemId, LATER)),
        ).toEqual([{ state: "applied" }]);
    });

    it("waits for a private source to be shared, then routes by proposal kind", async () => {
        await share(REC);
        const completionTarget = await addTask(alice, REC, {
            text: "Send the launch brief",
            assigneePersonId: bobOrg,
            status: "open",
        });
        const dueTarget = await addTask(alice, REC, {
            text: "Prepare the launch deck",
            assigneePersonId: bobOrg,
            status: "open",
        });
        await markTasksSeen(bob);
        await markTasksSeen(org);
        await new Promise((resolve) => setTimeout(resolve, 5));
        await summarize(LATER, [], {
            updates: [
                {
                    taskId: completionTarget.id,
                    kind: "done",
                    dueDate: null,
                    duePhrase: null,
                    quote: "the brief was sent",
                    evidenceStartMs: 1_000,
                },
                {
                    taskId: dueTarget.id,
                    kind: "due",
                    dueDate: "2026-10-20",
                    duePhrase: "by October 20",
                    quote: "the deck moved to October 20",
                    evidenceStartMs: 2_000,
                },
            ],
        });
        const updates = (await review(alice, LATER)).updates;
        for (const update of updates) {
            await tickUpdateProposal(
                alice,
                LATER,
                update.id,
                true,
                update.version,
            );
        }

        await acceptReview(alice, LATER);
        const waiting = await db()
            .select({
                id: taskUpdateProposals.id,
                kind: taskUpdateProposals.kind,
                state: taskUpdateProposals.state,
                routedTo: taskUpdateProposals.routedTo,
                decidedBy: taskUpdateProposals.decidedByUserId,
                decidedAt: taskUpdateProposals.decidedAt,
            })
            .from(taskUpdateProposals)
            .where(eq(taskUpdateProposals.itemId, LATER));
        expect(waiting).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: "done",
                    state: "awaiting_share",
                    routedTo: null,
                    decidedBy: ALICE,
                    decidedAt: expect.any(Date),
                }),
                expect.objectContaining({
                    kind: "due",
                    state: "awaiting_share",
                    routedTo: null,
                }),
            ]),
        );
        expect(
            await db()
                .select({ view: taskMentions.view })
                .from(taskMentions)
                .where(eq(taskMentions.itemId, LATER)),
        ).toEqual(
            expect.arrayContaining([{ view: "private" }, { view: "private" }]),
        );
        expect((await review(alice, REC)).tasks).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: completionTarget.id,
                    status: "open",
                }),
                expect.objectContaining({ id: dueTarget.id, dueDate: null }),
            ]),
        );

        await share(LATER);
        const routed = await db()
            .select({
                id: taskUpdateProposals.id,
                kind: taskUpdateProposals.kind,
                state: taskUpdateProposals.state,
                routedTo: taskUpdateProposals.routedTo,
            })
            .from(taskUpdateProposals)
            .where(eq(taskUpdateProposals.itemId, LATER));
        expect(routed).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: "done",
                    state: "awaiting_target_review",
                    routedTo: expect.arrayContaining([ALICE, BOB]),
                }),
                expect.objectContaining({
                    kind: "due",
                    state: "awaiting_target_review",
                    routedTo: [ALICE],
                }),
            ]),
        );
        expect(
            await db()
                .select({ view: taskMentions.view })
                .from(taskMentions)
                .where(eq(taskMentions.itemId, LATER)),
        ).toEqual(expect.arrayContaining([{ view: "org" }, { view: "org" }]));
        expect(
            (await listRoutedTaskProposals(bob)).map((row) => row.kind),
        ).toEqual(["done"]);
        expect(
            new Set(
                (await listRoutedTaskProposals(org)).map((row) => row.kind),
            ),
        ).toEqual(new Set(["done", "due"]));
        expect(await countNewTasks(bob)).toBe(1);
        expect(await countNewTasks(org)).toBe(2);

        const completion = routed.find((row) => row.kind === "done");
        const due = routed.find((row) => row.kind === "due");
        if (!completion) throw new Error("missing routed completion");
        if (!due) throw new Error("missing routed due proposal");
        await expect(
            rejectRoutedTaskProposal(org, LATER, due.id),
        ).resolves.toMatchObject({ state: "rejected" });
        const [rejected] = await db()
            .select({
                state: taskUpdateProposals.state,
                decidedBy: taskUpdateProposals.decidedByUserId,
                decidedAt: taskUpdateProposals.decidedAt,
            })
            .from(taskUpdateProposals)
            .where(eq(taskUpdateProposals.id, due.id));
        expect(rejected).toEqual({
            state: "rejected",
            decidedBy: orgUserId,
            decidedAt: expect.any(Date),
        });
        await expect(
            applyRoutedTaskProposal(alice, LATER, completion.id),
        ).resolves.toMatchObject({ state: "applied" });
        expect((await review(alice, REC)).tasks).toContainEqual(
            expect.objectContaining({
                id: completionTarget.id,
                status: "done",
            }),
        );
    });

    it("reports only the stored state when rejection races with an apply", async () => {
        const target = await addTask(alice, REC, {
            text: "Publish the concurrent decision notes",
            status: "open",
        });
        const [proposal] = await db()
            .insert(taskUpdateProposals)
            .values({
                taskId: target.id,
                itemId: LATER,
                userId: ALICE,
                kind: "due",
                dueDate: "2026-10-30",
                statementAt: new Date("2026-10-08T10:00:00Z"),
                state: "awaiting_target_review",
                routedTo: [ALICE],
                version: target.version,
            })
            .returning({ id: taskUpdateProposals.id });
        if (!proposal) throw new Error("missing routed proposal");

        const decisions = await Promise.allSettled([
            applyRoutedTaskProposal(alice, LATER, proposal.id),
            rejectRoutedTaskProposal(alice, LATER, proposal.id),
        ]);
        const [stored] = await db()
            .select({
                state: taskUpdateProposals.state,
                obsoleteReason: taskUpdateProposals.obsoleteReason,
            })
            .from(taskUpdateProposals)
            .where(eq(taskUpdateProposals.id, proposal.id));
        expect(stored).toBeDefined();
        const completed = decisions.filter(
            (decision) => decision.status === "fulfilled",
        );
        expect(completed.length).toBeGreaterThan(0);
        for (const decision of completed) {
            if (decision.status !== "fulfilled") continue;
            expect(decision.value).toEqual({
                state: stored?.state,
                obsoleteReason: stored?.obsoleteReason,
            });
        }
    });

    it("routes an awaiting-share proposal to another member's shared task", async () => {
        const bobShared = "rec-bob-shared-target";
        const bobPrivateMail = "mail-bob-private-target";
        await addRecording(bobShared, "2026-10-09T10:00:00Z", BOB);
        await share(bobShared, BOB);
        await addMail(bobPrivateMail, BOB);
        const sharedTarget = await addTask(org, bobShared, {
            text: "Publish Bob's shared notes",
            status: "open",
        });
        const privateTarget = await addTask(bob, bobPrivateMail, {
            text: "Bob's private notes",
            status: "open",
        });
        await db()
            .insert(taskUpdateProposals)
            .values([
                {
                    taskId: sharedTarget.id,
                    itemId: LATER,
                    userId: ALICE,
                    kind: "due",
                    dueDate: "2026-10-24",
                    duePhrase: encryptText("by October 24"),
                    quote: encryptText("publish by October 24"),
                    state: "awaiting_share",
                    routedTo: null,
                    version: sharedTarget.version,
                },
                {
                    taskId: privateTarget.id,
                    itemId: LATER,
                    userId: ALICE,
                    kind: "done",
                    state: "awaiting_share",
                    routedTo: null,
                    version: privateTarget.version,
                },
            ]);

        await share(LATER);

        const routed = await db()
            .select({
                taskId: taskUpdateProposals.taskId,
                state: taskUpdateProposals.state,
                reason: taskUpdateProposals.obsoleteReason,
            })
            .from(taskUpdateProposals)
            .where(eq(taskUpdateProposals.itemId, LATER));
        expect(routed).toEqual(
            expect.arrayContaining([
                {
                    taskId: sharedTarget.id,
                    state: "awaiting_target_review",
                    reason: null,
                },
                {
                    taskId: privateTarget.id,
                    state: "obsolete",
                    reason: "task_invisible",
                },
            ]),
        );
    });

    it("makes every routed apply re-check failure obsolete with its reason", async () => {
        await share(REC);
        const versionTarget = await addTask(alice, REC, {
            text: "Version target",
            status: "open",
        });
        const closedTarget = await addTask(alice, REC, {
            text: "Closed target",
            status: "open",
        });
        const invisibleTarget = await addTask(alice, LATER, {
            text: "Invisible target",
            status: "open",
        });
        const rightsTarget = await addTask(alice, REC, {
            text: "Rights target",
            assigneePersonId: bobOrg,
            status: "open",
        });
        const inserted = await db()
            .insert(taskUpdateProposals)
            .values([
                {
                    taskId: versionTarget.id,
                    itemId: LATER,
                    userId: ALICE,
                    kind: "due",
                    dueDate: "2026-10-20",
                    state: "awaiting_target_review",
                    routedTo: [ALICE],
                    version: versionTarget.version,
                },
                {
                    taskId: closedTarget.id,
                    itemId: LATER,
                    userId: ALICE,
                    kind: "done",
                    state: "awaiting_target_review",
                    routedTo: [ALICE],
                    version: closedTarget.version,
                },
                {
                    taskId: invisibleTarget.id,
                    itemId: REC,
                    userId: ALICE,
                    kind: "done",
                    state: "awaiting_target_review",
                    routedTo: [BOB],
                    version: invisibleTarget.version,
                },
                {
                    taskId: rightsTarget.id,
                    itemId: LATER,
                    userId: ALICE,
                    kind: "done",
                    state: "awaiting_target_review",
                    routedTo: [BOB],
                    version: rightsTarget.version,
                },
            ])
            .returning({
                id: taskUpdateProposals.id,
                kind: taskUpdateProposals.kind,
            });
        const [
            versionProposal,
            closedProposal,
            invisibleProposal,
            rightsProposal,
        ] = inserted;
        if (
            !versionProposal ||
            !closedProposal ||
            !invisibleProposal ||
            !rightsProposal
        ) {
            throw new Error("missing routed proposals");
        }
        await updateTask(alice, versionTarget.id, {
            version: versionTarget.version,
            text: "Changed version target",
        });
        await db()
            .update(recordingTasks)
            .set({ status: "done" })
            .where(eq(recordingTasks.id, closedTarget.id));
        await db()
            .update(recordingTasks)
            .set({ assigneePersonId: null })
            .where(eq(recordingTasks.id, rightsTarget.id));

        await expect(
            applyRoutedTaskProposal(alice, LATER, versionProposal.id),
        ).resolves.toMatchObject({
            state: "obsolete",
            obsoleteReason: "version_changed",
        });
        await expect(
            applyRoutedTaskProposal(alice, LATER, closedProposal.id),
        ).resolves.toMatchObject({
            state: "obsolete",
            obsoleteReason: "task_closed",
        });
        await expect(
            applyRoutedTaskProposal(bob, REC, invisibleProposal.id),
        ).resolves.toMatchObject({
            state: "obsolete",
            obsoleteReason: "task_invisible",
        });
        await expect(
            applyRoutedTaskProposal(bob, LATER, rightsProposal.id),
        ).resolves.toMatchObject({
            state: "obsolete",
            obsoleteReason: "source_withdrawn",
        });
    });

    it("applies a vague deadline without inventing a date", async () => {
        const task = await addTask(alice, REC, {
            text: "Send the partner email",
            dueDate: "2026-10-16",
            status: "open",
        });
        await summarize(LATER, [], {
            updates: [
                {
                    taskId: task.id,
                    kind: "due_phrase",
                    dueDate: null,
                    duePhrase: "later this month",
                    quote: "let us do it later this month",
                    evidenceStartMs: 1_000,
                },
            ],
        });
        const [update] = (await review(alice, LATER)).updates;
        if (!update) throw new Error("missing vague deadline");
        expect(update).toMatchObject({
            kind: "due_phrase",
            dueDate: null,
            duePhrase: "later this month",
            ticked: false,
            task: { dueDate: "2026-10-16" },
        });

        await tickUpdateProposal(alice, LATER, update.id, true, update.version);
        await acceptReview(alice, LATER);

        const [stored] = await db()
            .select({
                dueDate: recordingTasks.dueDate,
                duePhrase: recordingTasks.duePhrase,
                dueEffectiveAt: recordingTasks.dueEffectiveAt,
            })
            .from(recordingTasks)
            .where(eq(recordingTasks.id, task.id));
        expect(stored).toMatchObject({
            dueDate: null,
            dueEffectiveAt: new Date("2026-10-08T10:00:00.000Z"),
        });
        expect(stored?.duePhrase ? decryptText(stored.duePhrase) : null).toBe(
            "later this month",
        );
    });

    it("decides follow-up mentions and keeps only accepted evidence", async () => {
        const task = await addTask(alice, REC, {
            text: "Send the partner email",
            status: "open",
        });
        await summarize(LATER, [], {
            updates: [
                {
                    taskId: task.id,
                    kind: "done",
                    dueDate: null,
                    duePhrase: null,
                    quote: "dismissed follow-up evidence",
                    evidenceStartMs: 1_000,
                },
            ],
        });

        await acceptReview(alice, LATER);

        const [mention] = await db()
            .select({
                decision: taskMentions.matchDecision,
                decidedBy: taskMentions.decidedByUserId,
                decidedAt: taskMentions.decidedAt,
            })
            .from(taskMentions)
            .where(
                and(
                    eq(taskMentions.taskId, task.id),
                    eq(taskMentions.itemId, LATER),
                ),
            );
        expect(mention).toMatchObject({
            decision: "rejected",
            decidedBy: ALICE,
        });
        expect(mention?.decidedAt).toBeInstanceOf(Date);
        const [listed] = await listTasks(alice, query("tracked"));
        expect(listed?.visibleMentionQuotes).not.toContainEqual({
            text: "dismissed follow-up evidence",
            kind: "audio",
        });
    });

    it("keeps an applied follow-up mention through a re-summary", async () => {
        const task = await addTask(alice, REC, {
            text: "Send the partner email",
            status: "open",
        });
        await summarize(LATER, [], {
            updates: [
                {
                    taskId: task.id,
                    kind: "done",
                    dueDate: null,
                    duePhrase: null,
                    quote: "accepted follow-up evidence",
                    evidenceStartMs: 2_000,
                },
            ],
        });
        const [update] = (await review(alice, LATER)).updates;
        if (!update) throw new Error("missing follow-up");
        await tickUpdateProposal(alice, LATER, update.id, true, update.version);
        await acceptReview(alice, LATER);

        await summarize(LATER, []);

        const mentions = await db()
            .select({
                decision: taskMentions.matchDecision,
                quote: taskMentions.quote,
            })
            .from(taskMentions)
            .where(
                and(
                    eq(taskMentions.taskId, task.id),
                    eq(taskMentions.itemId, LATER),
                ),
            );
        expect(
            mentions.map((mention) => ({
                decision: mention.decision,
                quote: mention.quote ? decryptText(mention.quote) : null,
            })),
        ).toEqual([
            {
                decision: "accepted",
                quote: "accepted follow-up evidence",
            },
        ]);
    });

    it("applies a ticked follow-up to a task on a mail", async () => {
        const mailId = "mail-follow-up-target";
        await addMail(mailId);
        const task = await addTask(alice, mailId, {
            text: "Send the signed mail attachment",
            status: "open",
        });
        const [update] = await db()
            .insert(taskUpdateProposals)
            .values({
                taskId: task.id,
                itemId: LATER,
                userId: ALICE,
                kind: "done",
            })
            .returning({
                id: taskUpdateProposals.id,
                version: taskUpdateProposals.version,
            });

        expect((await review(alice, LATER)).updates[0]?.task.id).toBe(task.id);
        await tickUpdateProposal(
            alice,
            LATER,
            update?.id ?? "",
            true,
            update?.version ?? 0,
        );
        expect(await acceptReview(alice, LATER)).toMatchObject({
            updatesApplied: 1,
            updatesSkipped: 0,
        });
        const [stored] = await db()
            .select({ status: recordingTasks.status })
            .from(recordingTasks)
            .where(eq(recordingTasks.id, task.id));
        expect(stored?.status).toBe("done");
    });

    it("sorts by due date with undated last, and filters overdue", async () => {
        for (const [text, dueDate] of [
            ["A", "2026-10-20"],
            ["B", null],
            ["C", "2026-10-01"],
        ] as const) {
            await addTask(alice, REC, { text, dueDate, status: "open" });
        }
        const byDue = await listTasks(alice, {
            ...query("tracked"),
            sort: "due",
        });
        expect(byDue.map((row) => row.text)).toEqual(["C", "A", "B"]);
        const overdue = await listTasks(alice, {
            ...query("tracked"),
            due: "overdue",
            today: "2026-10-07",
        });
        expect(overdue.map((row) => row.text)).toEqual(["C"]);
    });

    it("keeps the summary when a follow-up's task or an assignee went meanwhile", async () => {
        const task = await addTask(alice, LATER, {
            text: "Gone",
            status: "open",
        });
        await db().delete(recordingTasks).where(eq(recordingTasks.id, task.id));
        await summarize(
            REC,
            [proposal("Call Dana", { assigneePersonId: "person-deleted" })],
            {
                updates: [
                    {
                        taskId: task.id,
                        kind: "done",
                        dueDate: null,
                        duePhrase: null,
                        quote: null,
                        evidenceStartMs: null,
                    },
                ],
            },
        );
        const { proposals, updates } = await review(alice);
        expect(proposals.map((row) => [row.text, row.assignee])).toEqual([
            ["Call Dana", null],
        ]);
        expect(updates).toEqual([]);
    });

    it("settles an earlier source decision after its task moved on", async () => {
        const task = await addTask(alice, LATER, {
            text: "Send the partner email",
            status: "open",
        });
        await db().insert(taskUpdateProposals).values({
            taskId: task.id,
            itemId: REC,
            userId: ALICE,
            kind: "done",
        });
        await updateTask(alice, task.id, {
            version: task.version,
            status: "done",
        });
        expect((await review(alice, REC)).updates).toEqual([]);
        await expect(share(REC)).resolves.toBeUndefined();
        await acceptReview(alice, REC);
        expect(
            await db()
                .select({
                    state: taskUpdateProposals.state,
                    reason: taskUpdateProposals.obsoleteReason,
                })
                .from(taskUpdateProposals),
        ).toEqual([{ state: "obsolete", reason: "earlier_statement" }]);
    });

    it("clears the badge for someone who never saved settings, and counts a reassignment", async () => {
        await share();
        const other = await addTask(org, REC, {
            text: "Call Dana",
            status: "open",
        });
        await db().delete(userSettings).where(eq(userSettings.userId, BOB));
        await addTask(org, REC, {
            text: "Book the venue",
            assigneePersonId: bobOrg,
            status: "open",
        });
        expect(await countNewTasks(bob)).toBe(1);
        await markTasksSeen(bob);
        expect(await countNewTasks(bob)).toBe(0);
        await new Promise((resolve) => setTimeout(resolve, 5));
        await updateTask(org, other.id, {
            version: other.version,
            assigneePersonId: bobOrg,
        });
        expect(await countNewTasks(bob)).toBe(1);
    });

    it("hands a private assignee to the Organization when the recording is shared", async () => {
        await addTask(alice, REC, {
            text: "Draft the pricing page",
            assigneePersonId: bobPrivate,
            status: "open",
        });
        await share();
        // Bob's private record folds into the Organization's Bob (same email).
        const [mine] = await listTasks(bob, query("mine"));
        expect(mine?.assignee?.personId).toBe(bobOrg);
        expect(await countNewTasks(bob)).toBe(1);
    });

    it("archives a shared recording's tasks for the Organization, and for the owner only theirs", async () => {
        await summarize(REC, [proposal("Draft the pricing page")]);
        await acceptReview(alice, REC);
        const [draft] = (await review(alice)).tasks;
        if (!draft) throw new Error("missing accepted task");
        await addTask(alice, LATER, { text: "Call Dana", status: "open" });
        await share();
        await db()
            .insert(taskMentions)
            .values([
                {
                    taskId: draft.id,
                    itemId: REC,
                    userId: ALICE,
                    view: "org",
                    quote: encryptText("organization evidence"),
                    statementAt: new Date("2026-10-07T10:00:00Z"),
                    matchDecision: "accepted",
                },
                {
                    taskId: draft.id,
                    itemId: LATER,
                    userId: ALICE,
                    view: "org",
                    quote: encryptText("withdrawn evidence"),
                    statementAt: new Date("2026-10-08T10:00:00Z"),
                    matchDecision: "accepted",
                },
            ]);
        await addTask(org, REC, { text: "Book the venue", status: "open" });

        const archived = async (scope: TaskArchiveScope) =>
            Object.fromEntries(
                [...(await tasksForArchive(scope, [REC, LATER]))].map(
                    ([id, list]) => [id, list.map((task) => task.text).sort()],
                ),
            );
        expect(await archived({ kind: "personal", userId: ALICE })).toEqual({
            [REC]: ["Draft the pricing page"],
            [LATER]: ["Call Dana"],
        });
        expect(await archived({ kind: "organization", orgUserId })).toEqual({
            [REC]: ["Book the venue", "Draft the pricing page"],
        });
        expect(await archived({ kind: "owner", userId: ALICE })).toEqual({
            [REC]: ["Book the venue", "Draft the pricing page"],
            [LATER]: ["Call Dana"],
        });
        expect(await archived({ kind: "personal", userId: BOB })).toEqual({});
        const organizationTasks = await tasksForArchive(
            { kind: "organization", orgUserId },
            [REC, LATER],
        );
        expect(
            organizationTasks.get(REC)?.find((task) => task.id === draft.id)
                ?.quote,
        ).toBe("organization evidence");
    });

    it("moves tasks to the survivor of a person merge", async () => {
        const task = await addTask(alice, REC, {
            text: "Draft the pricing page",
            assigneePersonId: bobPrivate,
            status: "open",
        });
        await mergePeople(ALICE, bobOrg, bobPrivate);
        const [row] = await db()
            .select({ assignee: recordingTasks.assigneePersonId })
            .from(recordingTasks)
            .where(eq(recordingTasks.id, task.id));
        expect(row?.assignee).toBe(bobOrg);
    });

    it("drops the tasks with the recording's last summary, also one a re-run left", async () => {
        await addTask(alice, REC, { text: "Call Dana", status: "open" });
        // A re-run replaced the summary and nothing was made again.
        await db().delete(aiEnhancements).where(eq(aiEnhancements.itemId, REC));
        expect((await review(alice)).tasks).toHaveLength(1);
        await deleteSummaryForRecording(
            REC,
            ALICE,
            { isOrg: false, orgUserId },
            new Date(),
        );
        expect((await review(alice)).tasks).toEqual([]);
    });

    it("removes the home mention with its last summary without moving the home", async () => {
        await summarize(REC, [proposal("Send the partner email")]);
        await acceptReview(alice, REC);
        const [task] = (await review(alice)).tasks;
        if (!task) throw new Error("missing accepted task");
        await summarize(LATER, [], {
            updates: [
                {
                    taskId: task.id,
                    kind: "done",
                    dueDate: null,
                    duePhrase: null,
                    quote: "the partner email was sent",
                    evidenceStartMs: 1_000,
                },
            ],
        });
        const [update] = (await review(alice, LATER)).updates;
        if (!update) throw new Error("missing follow-up");
        await tickUpdateProposal(alice, LATER, update.id, true, update.version);
        await acceptReview(alice, LATER);

        await deleteSummaryForRecording(
            REC,
            ALICE,
            { isOrg: false, orgUserId },
            new Date(),
        );

        const [stored] = await db()
            .select({ itemId: recordingTasks.itemId })
            .from(recordingTasks)
            .where(eq(recordingTasks.id, task.id));
        expect(stored?.itemId).toBe(REC);
        expect(
            await db()
                .select()
                .from(taskMentions)
                .where(eq(taskMentions.taskId, task.id)),
        ).toHaveLength(1);
        expect(
            await db()
                .select()
                .from(taskHomeMoves)
                .where(eq(taskHomeMoves.taskId, task.id)),
        ).toEqual([]);
    });

    it.each([
        "deleted",
        "erased",
    ] as const)("moves a %s home to its newest remaining mention and records the move", async (reason) => {
        const task = await addTask(alice, REC, {
            text: "Send the partner email",
            status: "open",
        });
        await db()
            .insert(taskMentions)
            .values({
                taskId: task.id,
                itemId: LATER,
                userId: ALICE,
                view: "private",
                quote: encryptText("the newer mention"),
                statementAt: new Date("2026-10-08T10:00:00Z"),
                matchDecision: "accepted",
            });

        await db().transaction(async (tx) => {
            await tx
                .select({ id: chatterItems.id })
                .from(chatterItems)
                .where(eq(chatterItems.id, REC))
                .for("update");
            await deleteItemTaskDataInTx(tx, {
                itemId: REC,
                ownerUserId: ALICE,
                actorUserId: ALICE,
                orgUserId,
                reason,
            });
            await tx
                .update(chatterItems)
                .set({ deletedAt: new Date() })
                .where(eq(chatterItems.id, REC));
        });

        const [stored] = await db()
            .select({ itemId: recordingTasks.itemId })
            .from(recordingTasks)
            .where(eq(recordingTasks.id, task.id));
        expect(stored?.itemId).toBe(LATER);
        const [move] = await db()
            .select()
            .from(taskHomeMoves)
            .where(eq(taskHomeMoves.taskId, task.id));
        expect(move).toMatchObject({
            fromItemId: REC,
            toItemId: LATER,
            fromUserId: ALICE,
            toUserId: ALICE,
            reason,
            actorUserId: ALICE,
        });
    });

    it("moves the home when the last remaining artifact is erased", async () => {
        await summarize(REC, []);
        await db()
            .insert(taskContentVectors)
            .values({
                id: "erase-content-vector",
                userId: ALICE,
                itemId: REC,
                contentSourceId: "transcription",
                contentRevision: 1,
                vectorGeneration: "erase-model",
                chunkIndex: 0,
                dim: 2,
                vector: "encrypted-vector",
                inputHmac: "0".repeat(64),
            });
        const task = await addTask(alice, REC, {
            text: "Send the partner email",
            status: "open",
        });
        await db()
            .insert(taskMentions)
            .values({
                taskId: task.id,
                itemId: LATER,
                userId: ALICE,
                view: "private",
                quote: encryptText("the newer mention"),
                statementAt: new Date("2026-10-08T10:00:00Z"),
                matchDecision: "accepted",
            });

        await eraseLocalArtifact(ALICE, REC, "summary");
        expect(
            (
                await db()
                    .select({ itemId: recordingTasks.itemId })
                    .from(recordingTasks)
                    .where(eq(recordingTasks.id, task.id))
            )[0]?.itemId,
        ).toBe(REC);
        await eraseLocalArtifact(ALICE, REC, "transcript");
        expect(
            await db()
                .select()
                .from(taskContentVectors)
                .where(eq(taskContentVectors.itemId, REC)),
        ).toEqual([]);
        expect(
            (
                await db()
                    .select({ itemId: recordingTasks.itemId })
                    .from(recordingTasks)
                    .where(eq(recordingTasks.id, task.id))
            )[0]?.itemId,
        ).toBe(REC);

        await eraseLocalArtifact(ALICE, REC, "audio");

        expect(
            (
                await db()
                    .select({ itemId: recordingTasks.itemId })
                    .from(recordingTasks)
                    .where(eq(recordingTasks.id, task.id))
            )[0]?.itemId,
        ).toBe(LATER);
        expect(
            await db()
                .select({ reason: taskHomeMoves.reason })
                .from(taskHomeMoves)
                .where(eq(taskHomeMoves.taskId, task.id)),
        ).toEqual([{ reason: "erased" }]);
    });

    it("deletes a task when only a suggested mention remains", async () => {
        const task = await addTask(alice, REC, {
            text: "Send the partner email",
            status: "open",
        });
        await summarize(LATER, [], {
            updates: [
                {
                    taskId: task.id,
                    kind: "done",
                    dueDate: null,
                    duePhrase: null,
                    quote: "not decided yet",
                    evidenceStartMs: 1_000,
                },
            ],
        });

        await db().transaction(async (tx) => {
            await deleteItemTaskDataInTx(tx, {
                itemId: REC,
                ownerUserId: ALICE,
                actorUserId: ALICE,
                orgUserId,
                reason: "deleted",
            });
        });

        expect(
            await db()
                .select()
                .from(recordingTasks)
                .where(eq(recordingTasks.id, task.id)),
        ).toEqual([]);
    });

    it("keeps an Organization task alive on another member's linked private item", async () => {
        await share(REC);
        const task = await addTask(org, REC, {
            text: "Keep this in the Organization",
            status: "open",
        });
        const bobMail = "mail-bob-private-home-candidate";
        await addMail(bobMail, BOB);
        await db()
            .insert(taskMentions)
            .values({
                taskId: task.id,
                itemId: bobMail,
                userId: BOB,
                view: "private",
                quote: encryptText("Bob's private evidence"),
                statementAt: new Date("2026-10-09T10:00:00Z"),
                matchDecision: "accepted",
            });

        await db().transaction(async (tx) => {
            await deleteItemTaskDataInTx(tx, {
                itemId: REC,
                ownerUserId: ALICE,
                actorUserId: ALICE,
                orgUserId,
                reason: "deleted",
            });
        });

        expect(
            await db()
                .select({
                    itemId: recordingTasks.itemId,
                    userId: recordingTasks.userId,
                })
                .from(recordingTasks)
                .where(eq(recordingTasks.id, task.id)),
        ).toEqual([{ itemId: bobMail, userId: BOB }]);
    });

    it("withdraws a home to another shared mention, or leaves it private", async () => {
        await share(REC);
        await share(LATER);
        const moved = await addTask(org, REC, {
            text: "Move this task",
            status: "open",
        });
        const privateAfter = await addTask(org, REC, {
            text: "Keep this task private",
            status: "open",
        });
        await db()
            .insert(taskContentVectors)
            .values({
                id: "withdraw-content-vector",
                userId: ALICE,
                itemId: REC,
                contentSourceId: "transcription",
                contentRevision: 1,
                vectorGeneration: "withdraw-model",
                chunkIndex: 0,
                dim: 2,
                vector: "encrypted-vector",
                inputHmac: "0".repeat(64),
            });
        await db()
            .insert(taskMentions)
            .values({
                taskId: moved.id,
                itemId: LATER,
                userId: ALICE,
                view: "org",
                quote: encryptText("visible shared evidence"),
                statementAt: new Date("2026-10-08T10:00:00Z"),
                matchDecision: "accepted",
            });

        await unshareRecording(ALICE, REC, { withdraw: true });
        expect(
            await db()
                .select()
                .from(taskContentVectors)
                .where(eq(taskContentVectors.itemId, REC)),
        ).toEqual([]);

        const stored = await db()
            .select({ id: recordingTasks.id, itemId: recordingTasks.itemId })
            .from(recordingTasks)
            .where(inArray(recordingTasks.id, [moved.id, privateAfter.id]));
        expect(stored).toEqual(
            expect.arrayContaining([
                { id: moved.id, itemId: LATER },
                { id: privateAfter.id, itemId: REC },
            ]),
        );
        expect((await review(org, LATER)).tasks.map((row) => row.id)).toContain(
            moved.id,
        );
        const organizationTasks = await listTasks(org, query("tracked"));
        expect(organizationTasks.map((row) => row.id)).not.toContain(
            privateAfter.id,
        );
        expect(
            organizationTasks.find((row) => row.id === moved.id)?.quote,
        ).toBe("visible shared evidence");
        const archived = await tasksForArchive(
            { kind: "organization", orgUserId },
            [REC, LATER],
        );
        expect(archived.get(REC) ?? []).toEqual([]);
        expect(archived.get(LATER)).toEqual([
            expect.objectContaining({
                id: moved.id,
                quote: "visible shared evidence",
            }),
        ]);
        expect((await review(alice, REC)).tasks.map((row) => row.id)).toContain(
            privateAfter.id,
        );
    });

    it("identifies another visible item as the evidence target", async () => {
        await share(REC);
        await share(LATER);
        const task = await addTask(org, REC, {
            text: "Publish the launch note",
            status: "open",
        });
        await db()
            .update(taskMentions)
            .set({ view: "private" })
            .where(eq(taskMentions.taskId, task.id));
        await db()
            .insert(taskMentions)
            .values({
                taskId: task.id,
                itemId: LATER,
                userId: ALICE,
                view: "org",
                quote: encryptText("publish it after the follow-up"),
                evidenceStartMs: 4_000,
                statementAt: new Date("2026-10-08T10:00:00Z"),
                matchDecision: "accepted",
            });

        const listed = (await listTasks(org, query("tracked"))).find(
            (row) => row.id === task.id,
        );
        expect(listed).toMatchObject({
            recordingId: REC,
            evidenceItemId: LATER,
            evidenceItemKind: "audio",
            quote: "publish it after the follow-up",
            evidenceStartMs: 4_000,
        });
    });

    it("keeps visible home evidence ahead of a newer linked mention", async () => {
        const task = await addTask(alice, REC, {
            text: "Publish the launch note",
            status: "open",
        });
        await db()
            .insert(taskMentions)
            .values({
                taskId: task.id,
                itemId: LATER,
                userId: ALICE,
                view: "private",
                quote: encryptText("newer evidence elsewhere"),
                evidenceStartMs: 4_000,
                statementAt: new Date("2026-10-08T10:00:00Z"),
                matchDecision: "accepted",
            });

        const listed = (await listTasks(alice, query("tracked"))).find(
            (row) => row.id === task.id,
        );
        expect(listed).toMatchObject({
            evidenceItemId: REC,
            evidenceItemKind: "audio",
            quote: null,
            evidenceStartMs: null,
        });
    });

    it("serializes retention, task review, and withdrawal without losing the surviving home", async () => {
        await summarize(REC, []);
        await share(REC);
        await share(LATER);
        const task = await addTask(org, REC, {
            text: "Publish the launch note",
            status: "open",
        });
        await db()
            .insert(taskMentions)
            .values({
                taskId: task.id,
                itemId: LATER,
                userId: ALICE,
                view: "org",
                quote: encryptText("publish it after the follow-up"),
                statementAt: new Date("2026-10-08T10:00:00Z"),
                matchDecision: "accepted",
            });
        await followUp(task.id, REC);

        const results = await Promise.allSettled([
            deleteSummaryForRecording(
                REC,
                ALICE,
                { isOrg: true, orgUserId },
                new Date(),
            ),
            acceptReview(org, REC),
            unshareRecording(ALICE, REC, { withdraw: true }),
        ]);

        for (const result of results) {
            if (result.status === "rejected") {
                const error = result.reason as {
                    code?: string;
                    cause?: { code?: string };
                };
                expect(error.code).not.toBe("40P01");
                expect(error.cause?.code).not.toBe("40P01");
            }
        }
        const [stored] = await db()
            .select({ itemId: recordingTasks.itemId })
            .from(recordingTasks)
            .where(eq(recordingTasks.id, task.id));
        expect(stored?.itemId).toBe(LATER);
        expect(
            (await listTasks(org, query("tracked"))).map((row) => row.id),
        ).toContain(task.id);
        expect(
            await db()
                .select()
                .from(taskHomeMoves)
                .where(eq(taskHomeMoves.taskId, task.id)),
        ).toEqual([
            expect.objectContaining({
                fromItemId: REC,
                toItemId: LATER,
                reason: "withdrawn",
            }),
        ]);
    });

    it("serializes deleting a home with mail and audio follow-up reviews", async () => {
        const mailId = "mail-concurrent-follow-up";
        const audioId = "rec-concurrent-follow-up";
        await addMail(mailId);
        await addRecording(audioId, "2026-10-09T10:00:00Z");
        const task = await addTask(alice, REC, {
            text: "Publish the launch note",
            status: "open",
        });
        for (const [itemId, statementAt] of [
            [mailId, new Date("2026-10-08T10:00:00Z")],
            [audioId, new Date("2026-10-09T10:00:00Z")],
        ] as const) {
            const [update] = await db()
                .insert(taskUpdateProposals)
                .values({
                    taskId: task.id,
                    itemId,
                    userId: ALICE,
                    kind: "done",
                    ticked: true,
                })
                .returning({ id: taskUpdateProposals.id });
            await db()
                .insert(taskMentions)
                .values({
                    id: update?.id ?? "",
                    taskId: task.id,
                    itemId,
                    userId: ALICE,
                    view: "private",
                    quote: encryptText(`evidence on ${itemId}`),
                    statementAt,
                    matchDecision: "suggested",
                });
        }

        const results = await Promise.allSettled([
            db().transaction(async (tx) => {
                await deleteItemTaskDataInTx(tx, {
                    itemId: REC,
                    ownerUserId: ALICE,
                    actorUserId: ALICE,
                    orgUserId,
                    reason: "deleted",
                });
            }),
            acceptReview(alice, mailId),
            acceptReview(alice, audioId),
        ]);

        for (const result of results) {
            if (result.status === "rejected") {
                const error = result.reason as {
                    code?: string;
                    cause?: { code?: string };
                };
                expect(error.code).not.toBe("40P01");
                expect(error.cause?.code).not.toBe("40P01");
            }
        }
        const [stored] = await db()
            .select({ itemId: recordingTasks.itemId })
            .from(recordingTasks)
            .where(eq(recordingTasks.id, task.id));
        if (stored) {
            expect([mailId, audioId]).toContain(stored.itemId);
            const linked = await db()
                .select({ decision: taskMentions.matchDecision })
                .from(taskMentions)
                .where(eq(taskMentions.taskId, task.id));
            expect(linked.some((row) => row.decision === "accepted")).toBe(
                true,
            );
        }
    });

    async function propose(recordingId: string, text: string) {
        await db()
            .insert(recordingTasks)
            .values({
                itemId: recordingId,
                userId: ALICE,
                status: "proposed",
                text: encryptText(text),
                source: "riffado",
            });
    }

    async function followUp(taskId: string, recordingId: string) {
        await db().insert(taskUpdateProposals).values({
            taskId,
            itemId: recordingId,
            userId: ALICE,
            kind: "done",
        });
    }

    it("lists the recordings awaiting their reviewer, newest first, with what waits", async () => {
        const open = await addTask(alice, REC, {
            text: "Send the partner email",
            status: "open",
        });
        const closed = await addTask(alice, REC, {
            text: "Book the venue",
            status: "open",
        });
        await updateTask(alice, closed.id, {
            version: closed.version,
            status: "done",
        });
        await propose(REC, "Call Dana");
        await propose(LATER, "Draft the pricing page");
        await propose(LATER, "Share the draft");
        await followUp(open.id, LATER);
        // About a task done since: nothing to review.
        await followUp(closed.id, LATER);
        await addRecording("rec-gone", "2026-10-09T10:00:00Z");
        await propose("rec-gone", "Gone with its recording");
        await markRecordingDeleted(db(), {
            id: "rec-gone",
            userId: ALICE,
            at: new Date(),
        });

        expect(await recordingsAwaitingTaskReview(alice)).toEqual([
            {
                recordingId: LATER,
                kind: "audio",
                title: `Recording ${LATER}`,
                proposals: 3,
            },
            {
                recordingId: REC,
                kind: "audio",
                title: `Recording ${REC}`,
                proposals: 1,
            },
        ]);
        expect(await recordingsAwaitingTaskReview(bob)).toEqual([]);
        expect(await recordingsAwaitingTaskReview(org)).toEqual([]);
    });

    it("lists a shared recording's review for its owner and curators", async () => {
        const open = await addTask(alice, LATER, {
            text: "Send the partner email",
            status: "open",
        });
        await share(REC);
        await propose(REC, "Call Dana");
        await followUp(open.id, REC);
        await propose(LATER, "Draft the pricing page");

        expect(await recordingsAwaitingTaskReview(org)).toEqual([
            {
                recordingId: REC,
                kind: "audio",
                title: `Recording ${REC}`,
                proposals: 1,
            },
        ]);
        expect(await recordingsAwaitingTaskReview(alice)).toEqual([
            {
                recordingId: LATER,
                kind: "audio",
                title: `Recording ${LATER}`,
                proposals: 1,
            },
            {
                recordingId: REC,
                kind: "audio",
                title: `Recording ${REC}`,
                proposals: 2,
            },
        ]);
    });

    it("refuses an accept when the proposals changed since they were shown", async () => {
        await summarize(REC, [proposal("Call Dana")]);
        const shown = (await review(alice)).proposals.map((row) => row.id);
        await summarize(REC, [proposal("Book the venue")]);
        await expect(
            acceptReview(alice, REC, { proposals: shown, updates: [] }),
        ).rejects.toMatchObject({ statusCode: 409 });
    });

    it("[A] drops without deleting, leaves open lists, keeps evidence, and restores", async () => {
        const task = await addTask(alice, REC, {
            text: "Prepare the obsolete launch deck",
            status: "open",
        });
        await summarize(LATER, [], {
            updates: [
                {
                    taskId: task.id,
                    kind: "drop",
                    dueDate: null,
                    duePhrase: null,
                    assigneePersonId: null,
                    assigneeHint: null,
                    assigneeCheck: false,
                    quote: "We no longer need that launch deck",
                    evidenceStartMs: 4_000,
                },
            ],
        });
        const [drop] = (await review(alice, LATER)).updates;
        if (!drop) throw new Error("missing drop proposal");
        expect(drop).toMatchObject({
            kind: "drop",
            quote: "We no longer need that launch deck",
            evidenceStartMs: 4_000,
            ticked: false,
        });
        await tickUpdateProposal(alice, LATER, drop.id, true, drop.version);
        await acceptReview(alice, LATER);

        const [stored] = await db()
            .select({
                status: recordingTasks.status,
                effectiveAt: recordingTasks.statusEffectiveAt,
            })
            .from(recordingTasks)
            .where(eq(recordingTasks.id, task.id));
        expect(stored).toEqual({
            status: "dropped",
            effectiveAt: new Date("2026-10-08T10:00:00.000Z"),
        });
        expect(
            (
                await listTasks(alice, {
                    ...query("tracked"),
                    state: "open",
                })
            ).map((row) => row.id),
        ).not.toContain(task.id);
        const dropped = (await listTasks(alice, query("tracked"))).find(
            (row) => row.id === task.id,
        );
        expect(dropped?.status).toBe("dropped");
        await updateTask(alice, task.id, {
            version: dropped?.version ?? -1,
            status: "open",
        });
        expect(
            (
                await listTasks(alice, {
                    ...query("tracked"),
                    state: "open",
                })
            ).map((row) => row.id),
        ).toContain(task.id);
    });

    it("[B] resolves and applies a reassignment without inventing a person", async () => {
        await db().insert(transcriptSpeakers).values({
            userId: ALICE,
            transcriptionId: transcriptId,
            label: "speaker_0",
            personId: bobPrivate,
            source: "user",
            status: "confirmed",
            confirmedByUserId: ALICE,
        });
        const task = await addTask(alice, REC, {
            text: "Prepare the handoff",
            status: "open",
        });
        const refs = new Map([["T1", task.id]]);
        const resolved = await resolveTaskProposals({
            source: "riffado",
            items: [],
            updates: [
                {
                    ref: "T1",
                    kind: "assignee",
                    due: null,
                    assignee: "speaker_0",
                    quote: "Bob is taking over the handoff",
                },
            ],
            refs,
            ownerUserId: ALICE,
            transcriptionId: transcriptId,
            turns: [
                {
                    speaker: "speaker_0",
                    startMs: 0,
                    endMs: 1_000,
                    text: "Bob is taking over the handoff",
                },
            ],
            language: "en",
            orgView: false,
            reviewer: alice,
            summaryText: "",
        });
        expect(resolved.updates).toEqual([
            expect.objectContaining({
                kind: "assignee",
                assigneePersonId: bobPrivate,
                assigneeHint: null,
                assigneeCheck: false,
            }),
        ]);
        const unresolved = await resolveTaskProposals({
            source: "riffado",
            items: [],
            updates: [
                {
                    ref: "T1",
                    kind: "assignee",
                    due: null,
                    assignee: "Dana Unknown",
                    quote: null,
                },
            ],
            refs,
            ownerUserId: ALICE,
            transcriptionId: null,
            turns: null,
            language: "en",
            orgView: false,
            reviewer: alice,
            summaryText: "",
        });
        expect(unresolved.updates).toEqual([
            expect.objectContaining({
                assigneePersonId: null,
                assigneeHint: "Dana Unknown",
                assigneeCheck: false,
            }),
        ]);

        await summarize(LATER, [], { updates: resolved.updates });
        const [handoff] = (await review(alice, LATER)).updates;
        if (!handoff) throw new Error("missing reassignment proposal");
        expect(handoff).toMatchObject({
            kind: "assignee",
            proposedAssignee: { personId: bobPrivate, name: "Bob" },
            ticked: false,
        });
        await tickUpdateProposal(
            alice,
            LATER,
            handoff.id,
            true,
            handoff.version,
        );
        await acceptReview(alice, LATER);
        const [stored] = await db()
            .select({
                assigneePersonId: recordingTasks.assigneePersonId,
                effectiveAt: recordingTasks.assigneeEffectiveAt,
            })
            .from(recordingTasks)
            .where(eq(recordingTasks.id, task.id));
        expect(stored).toEqual({
            assigneePersonId: bobPrivate,
            effectiveAt: new Date("2026-10-08T10:00:00.000Z"),
        });
    });

    it("[C] settles older drop and assignee statements while later statements win", async () => {
        const earlierItem = "rec-earlier-stage-4b";
        await addRecording(earlierItem, "2026-10-07T10:00:00Z");
        const dropTask = await addTask(alice, REC, {
            text: "Drop in chronological order",
            status: "open",
        });
        const assigneeTask = await addTask(alice, REC, {
            text: "Assign in chronological order",
            status: "open",
        });
        await db()
            .update(recordingTasks)
            .set({
                statusEffectiveAt: new Date("2026-10-01T00:00:00.000Z"),
                assigneeEffectiveAt: new Date("2026-10-01T00:00:00.000Z"),
            })
            .where(inArray(recordingTasks.id, [dropTask.id, assigneeTask.id]));
        await summarize(LATER, [], {
            updates: [
                {
                    taskId: dropTask.id,
                    kind: "drop",
                    dueDate: null,
                    duePhrase: null,
                    assigneePersonId: null,
                    assigneeHint: null,
                    assigneeCheck: false,
                    quote: "later cancellation",
                    evidenceStartMs: null,
                },
                {
                    taskId: assigneeTask.id,
                    kind: "assignee",
                    dueDate: null,
                    duePhrase: null,
                    assigneePersonId: bobPrivate,
                    assigneeHint: null,
                    assigneeCheck: false,
                    quote: "later handoff",
                    evidenceStartMs: null,
                },
            ],
        });
        for (const update of (await review(alice, LATER)).updates) {
            await tickUpdateProposal(
                alice,
                LATER,
                update.id,
                true,
                update.version,
            );
        }
        await acceptReview(alice, LATER);
        await summarize(earlierItem, [], {
            updates: [
                {
                    taskId: dropTask.id,
                    kind: "drop",
                    dueDate: null,
                    duePhrase: null,
                    assigneePersonId: null,
                    assigneeHint: null,
                    assigneeCheck: false,
                    quote: "older cancellation",
                    evidenceStartMs: null,
                },
                {
                    taskId: assigneeTask.id,
                    kind: "assignee",
                    dueDate: null,
                    duePhrase: null,
                    assigneePersonId: null,
                    assigneeHint: "Dana Unknown",
                    assigneeCheck: false,
                    quote: "older handoff",
                    evidenceStartMs: null,
                },
            ],
        });
        expect((await review(alice, earlierItem)).updates).toEqual([
            expect.objectContaining({
                kind: "assignee",
                earlierMention: true,
            }),
        ]);
        expect(
            await db()
                .select({
                    kind: taskUpdateProposals.kind,
                    state: taskUpdateProposals.state,
                    reason: taskUpdateProposals.obsoleteReason,
                })
                .from(taskUpdateProposals)
                .where(eq(taskUpdateProposals.itemId, earlierItem)),
        ).toEqual(
            expect.arrayContaining([
                {
                    kind: "drop",
                    state: "obsolete",
                    reason: "earlier_statement",
                },
                {
                    kind: "assignee",
                    state: "obsolete",
                    reason: "earlier_statement",
                },
            ]),
        );
        const rows = await db()
            .select({
                id: recordingTasks.id,
                status: recordingTasks.status,
                assigneePersonId: recordingTasks.assigneePersonId,
            })
            .from(recordingTasks)
            .where(inArray(recordingTasks.id, [dropTask.id, assigneeTask.id]));
        expect(rows).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: dropTask.id, status: "dropped" }),
                expect.objectContaining({
                    id: assigneeTask.id,
                    assigneePersonId: bobPrivate,
                }),
            ]),
        );
    });

    it("[D] treats drop and reassignment as edit rights and re-checks routed apply", async () => {
        await share(REC);
        const task = await addTask(alice, REC, {
            text: "Owner-only edit",
            assigneePersonId: bobOrg,
            status: "open",
        });
        await summarize(LATER, [], {
            updates: [
                {
                    taskId: task.id,
                    kind: "assignee",
                    dueDate: null,
                    duePhrase: null,
                    assigneePersonId: bobPrivate,
                    assigneeHint: null,
                    assigneeCheck: false,
                    quote: "Bob is taking this over",
                    evidenceStartMs: null,
                },
            ],
        });
        const [handoff] = (await review(alice, LATER)).updates;
        if (!handoff) throw new Error("missing private reassignment proposal");
        await tickUpdateProposal(
            alice,
            LATER,
            handoff.id,
            true,
            handoff.version,
        );
        await acceptReview(alice, LATER);
        expect(
            await db()
                .select({
                    state: taskUpdateProposals.state,
                    routedTo: taskUpdateProposals.routedTo,
                })
                .from(taskUpdateProposals)
                .where(eq(taskUpdateProposals.id, handoff.id)),
        ).toEqual([{ state: "awaiting_share", routedTo: null }]);
        expect((await review(alice, REC)).tasks).toContainEqual(
            expect.objectContaining({
                id: task.id,
                assignee: expect.objectContaining({ personId: bobOrg }),
            }),
        );

        await share(LATER);
        expect(
            await db()
                .select({
                    state: taskUpdateProposals.state,
                    routedTo: taskUpdateProposals.routedTo,
                    proposedAssigneePersonId:
                        taskUpdateProposals.proposedAssigneePersonId,
                })
                .from(taskUpdateProposals)
                .where(eq(taskUpdateProposals.id, handoff.id)),
        ).toEqual([
            {
                state: "awaiting_target_review",
                routedTo: [ALICE],
                proposedAssigneePersonId: bobOrg,
            },
        ]);
        expect(
            (await listRoutedTaskProposals(org)).map((row) => row.id),
        ).toContain(handoff.id);

        const [drop] = await db()
            .insert(taskUpdateProposals)
            .values({
                taskId: task.id,
                itemId: LATER,
                userId: ALICE,
                kind: "drop",
                state: "awaiting_target_review",
                routedTo: [BOB],
                version: task.version,
            })
            .returning({ id: taskUpdateProposals.id });
        expect(
            await applyRoutedTaskProposal(bob, LATER, drop?.id ?? ""),
        ).toEqual({ state: "obsolete", obsoleteReason: "rights_lost" });
    });

    it("[F] refuses selected completion and drop alternatives for one task", async () => {
        const task = await addTask(alice, REC, {
            text: "One outcome only",
            status: "open",
        });
        await summarize(LATER, [], {
            matches: [
                match(task.id, {
                    quote: "this is the same task",
                }),
            ],
            updates: [
                {
                    taskId: task.id,
                    kind: "done",
                    dueDate: null,
                    duePhrase: null,
                    assigneePersonId: null,
                    assigneeHint: null,
                    assigneeCheck: false,
                    quote: "done",
                    evidenceStartMs: null,
                },
                {
                    taskId: task.id,
                    kind: "drop",
                    dueDate: null,
                    duePhrase: null,
                    assigneePersonId: null,
                    assigneeHint: null,
                    assigneeCheck: false,
                    quote: "cancelled",
                    evidenceStartMs: null,
                },
            ],
        });
        const conflictReview = await review(alice, LATER);
        expect(conflictReview.matches).toEqual([
            expect.objectContaining({
                candidate: expect.objectContaining({ id: task.id }),
                ticked: false,
            }),
        ]);
        expect(
            conflictReview.updates.map((update) => update.kind).sort(),
        ).toEqual(["done", "drop"]);
        for (const update of conflictReview.updates) {
            await tickUpdateProposal(
                alice,
                LATER,
                update.id,
                true,
                update.version,
            );
        }
        await expect(acceptReview(alice, LATER)).rejects.toMatchObject({
            statusCode: 400,
            message: expect.stringMatching(/completion.*no longer needed/i),
        });
    });

    it("[G] archives the new kinds and proposed assignee", async () => {
        const task = await addTask(alice, REC, {
            text: "Archive proposal fields",
            status: "open",
        });
        await summarize(LATER, [], {
            updates: [
                {
                    taskId: task.id,
                    kind: "drop",
                    dueDate: null,
                    duePhrase: null,
                    assigneePersonId: null,
                    assigneeHint: null,
                    assigneeCheck: false,
                    quote: "cancel this",
                    evidenceStartMs: null,
                },
                {
                    taskId: task.id,
                    kind: "assignee",
                    dueDate: null,
                    duePhrase: null,
                    assigneePersonId: bobPrivate,
                    assigneeHint: null,
                    assigneeCheck: true,
                    quote: "Bob took this",
                    evidenceStartMs: null,
                },
            ],
        });
        const archived = await taskUpdatesForArchive(
            { kind: "personal", userId: ALICE },
            [LATER],
            new Set([task.id]),
        );
        expect(archived.get(LATER)).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: "drop" }),
                expect.objectContaining({
                    kind: "assignee",
                    proposedAssignee: {
                        personId: bobPrivate,
                        name: "Bob",
                    },
                    proposedAssigneeCheck: true,
                }),
            ]),
        );
    });

    it("obsoletes routed proposals when their shared source is withdrawn", async () => {
        const targetItem = "rec-routed-source-target";
        await addRecording(targetItem, "2026-10-09T10:00:00Z", BOB);
        await share(targetItem, BOB);
        await share(LATER);
        const target = await addTask(org, targetItem, {
            text: "Publish the source-withdrawal notes",
            assigneePersonId: bobOrg,
            status: "open",
        });
        const [proposalRow] = await db()
            .insert(taskUpdateProposals)
            .values({
                taskId: target.id,
                itemId: LATER,
                userId: ALICE,
                kind: "done",
                state: "awaiting_target_review",
                routedTo: [BOB],
                version: target.version,
            })
            .returning({ id: taskUpdateProposals.id });

        expect(
            (await listRoutedTaskProposals(bob)).map((row) => row.id),
        ).toContain(proposalRow?.id);
        await unshareRecording(ALICE, LATER, { withdraw: true });

        expect(
            (await listRoutedTaskProposals(bob)).map((row) => row.id),
        ).not.toContain(proposalRow?.id);
        expect(
            await db()
                .select({
                    state: taskUpdateProposals.state,
                    reason: taskUpdateProposals.obsoleteReason,
                })
                .from(taskUpdateProposals)
                .where(eq(taskUpdateProposals.id, proposalRow?.id ?? "")),
        ).toEqual([{ state: "obsolete", reason: "source_withdrawn" }]);
        await expect(
            applyRoutedTaskProposal(bob, LATER, proposalRow?.id ?? ""),
        ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("obsoletes routed proposals when their target becomes invisible", async () => {
        const targetItem = "rec-routed-invisible-target";
        await addRecording(targetItem, "2026-10-09T10:00:00Z", BOB);
        await share(REC);
        await share(targetItem, BOB);
        const target = await addTask(org, targetItem, {
            text: "Publish the target-withdrawal notes",
            assigneePersonId: bobOrg,
            status: "open",
        });
        const [proposalRow] = await db()
            .insert(taskUpdateProposals)
            .values({
                taskId: target.id,
                itemId: REC,
                userId: ALICE,
                kind: "done",
                state: "awaiting_target_review",
                routedTo: [ALICE],
                version: target.version,
            })
            .returning({ id: taskUpdateProposals.id });

        await unshareRecording(BOB, targetItem, { withdraw: true });

        expect(
            (await listRoutedTaskProposals(alice)).map((row) => row.id),
        ).not.toContain(proposalRow?.id);
        expect(
            await db()
                .select({
                    state: taskUpdateProposals.state,
                    reason: taskUpdateProposals.obsoleteReason,
                })
                .from(taskUpdateProposals)
                .where(eq(taskUpdateProposals.id, proposalRow?.id ?? "")),
        ).toEqual([{ state: "obsolete", reason: "task_invisible" }]);
        await expect(
            rejectRoutedTaskProposal(alice, REC, proposalRow?.id ?? ""),
        ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("settles invisible shown review rows without blocking the share gate", async () => {
        const targetItem = "rec-review-withdrawn-target";
        await addRecording(targetItem, "2026-10-09T10:00:00Z", BOB);
        await share(targetItem, BOB);
        const target = await addTask(org, targetItem, {
            text: "Review the withdrawn target",
            status: "open",
        });
        await db()
            .update(recordingTasks)
            .set({ statusEffectiveAt: new Date("2026-10-01T00:00:00Z") })
            .where(
                and(
                    eq(recordingTasks.id, target.id),
                    eq(recordingTasks.userId, BOB),
                ),
            );
        await summarize(REC, [], {
            matches: [match(target.id)],
            updates: [
                {
                    taskId: target.id,
                    kind: "done",
                    dueDate: null,
                    duePhrase: null,
                    assigneePersonId: null,
                    assigneeHint: null,
                    assigneeCheck: false,
                    quote: "this is done",
                    evidenceStartMs: 1_000,
                },
            ],
        });
        const shownReview = await review(alice);
        await unshareRecording(BOB, targetItem, { withdraw: true });

        await expect(
            acceptReview(alice, REC, {
                proposals: [],
                updates: shownReview.updates.map((row) => row.id),
            }),
        ).resolves.toBeDefined();
        await expect(share(REC)).resolves.toBeUndefined();
        expect(await recordingsAwaitingTaskReview(alice)).toEqual([]);
        const [update] = await db()
            .select({
                state: taskUpdateProposals.state,
                reason: taskUpdateProposals.obsoleteReason,
                decidedBy: taskUpdateProposals.decidedByUserId,
            })
            .from(taskUpdateProposals)
            .where(eq(taskUpdateProposals.itemId, REC));
        expect(update).toEqual({
            state: "obsolete",
            reason: "task_invisible",
            decidedBy: null,
        });
        const [suggestion] = await db()
            .select({
                decision: taskMentions.matchDecision,
                decidedBy: taskMentions.decidedByUserId,
            })
            .from(taskMentions)
            .where(
                and(
                    eq(taskMentions.itemId, REC),
                    eq(taskMentions.taskId, target.id),
                ),
            );
        expect(suggestion).toEqual({ decision: "rejected", decidedBy: null });
    });

    it("uses each field proposal's own statement time", async () => {
        const mailId = "mail-proposal-statement-time";
        await addMail(mailId);
        await db()
            .update(chatterItems)
            .set({ occurredAt: new Date("2026-10-12T12:00:00Z") })
            .where(
                and(
                    eq(chatterItems.id, mailId),
                    eq(chatterItems.userId, ALICE),
                ),
            );
        const task = await addTask(alice, REC, {
            text: "Send the chronology note",
            status: "open",
        });
        await db()
            .update(recordingTasks)
            .set({ statusEffectiveAt: new Date("2026-10-12T10:00:00Z") })
            .where(
                and(
                    eq(recordingTasks.id, task.id),
                    eq(recordingTasks.userId, ALICE),
                ),
            );
        await summarize(mailId, [], {
            matches: [
                match(task.id, {
                    quote: "Earlier quoted mention",
                    evidenceProvenance: "quoted",
                    quotedAt: new Date("2026-10-12T08:00:00.000Z"),
                }),
            ],
            updates: [
                {
                    taskId: task.id,
                    kind: "done",
                    dueDate: null,
                    duePhrase: null,
                    assigneePersonId: null,
                    assigneeHint: null,
                    assigneeCheck: false,
                    quote: "It is done",
                    evidenceStartMs: null,
                    evidenceProvenance: "unverified",
                },
            ],
        });
        const [update] = (await review(alice, mailId)).updates;
        if (!update) throw new Error("missing chronology proposal");
        expect(update.earlierMention).toBe(false);
        await tickUpdateProposal(
            alice,
            mailId,
            update.id,
            true,
            update.version,
        );
        await acceptReview(alice, mailId);
        expect(
            (
                await db()
                    .select({ status: recordingTasks.status })
                    .from(recordingTasks)
                    .where(
                        and(
                            eq(recordingTasks.id, task.id),
                            eq(recordingTasks.userId, ALICE),
                        ),
                    )
            )[0]?.status,
        ).toBe("done");
    });

    it("keeps an earlier quoted field statement informational", async () => {
        const mailId = "mail-earlier-field-statement";
        await addMail(mailId);
        await db()
            .update(chatterItems)
            .set({ occurredAt: new Date("2026-10-12T12:00:00Z") })
            .where(
                and(
                    eq(chatterItems.id, mailId),
                    eq(chatterItems.userId, ALICE),
                ),
            );
        const task = await addTask(alice, REC, {
            text: "Keep the later chronology",
            status: "open",
        });
        await db()
            .update(recordingTasks)
            .set({ statusEffectiveAt: new Date("2026-10-12T10:00:00Z") })
            .where(
                and(
                    eq(recordingTasks.id, task.id),
                    eq(recordingTasks.userId, ALICE),
                ),
            );
        await summarize(mailId, [], {
            matches: [
                match(task.id, {
                    quote: "Current mail text",
                    evidenceProvenance: "unverified",
                }),
            ],
            updates: [
                {
                    taskId: task.id,
                    kind: "done",
                    dueDate: null,
                    duePhrase: null,
                    assigneePersonId: null,
                    assigneeHint: null,
                    assigneeCheck: false,
                    quote: "Earlier quoted completion",
                    evidenceStartMs: null,
                    evidenceProvenance: "quoted",
                    quotedAt: new Date("2026-10-12T08:00:00Z"),
                },
            ],
        });

        expect((await review(alice, mailId)).updates).toEqual([
            expect.objectContaining({ earlierMention: true, ticked: false }),
        ]);
        expect(
            await db()
                .select({
                    state: taskUpdateProposals.state,
                    reason: taskUpdateProposals.obsoleteReason,
                })
                .from(taskUpdateProposals)
                .where(eq(taskUpdateProposals.itemId, mailId)),
        ).toEqual([{ state: "obsolete", reason: "earlier_statement" }]);
    });

    it("settles a proposal immediately when an edit makes it earlier", async () => {
        const task = await addTask(alice, LATER, {
            text: "Settle the earlier edit",
            status: "open",
        });
        await db()
            .insert(taskUpdateProposals)
            .values({
                taskId: task.id,
                itemId: REC,
                userId: ALICE,
                kind: "due",
                dueDate: "2026-10-20",
                statementAt: new Date("2026-10-06T10:00:00Z"),
            });
        await updateTask(alice, task.id, {
            version: task.version,
            dueDate: "2026-10-21",
        });

        expect(
            await db()
                .select({
                    state: taskUpdateProposals.state,
                    reason: taskUpdateProposals.obsoleteReason,
                })
                .from(taskUpdateProposals)
                .where(eq(taskUpdateProposals.itemId, REC)),
        ).toEqual([{ state: "obsolete", reason: "earlier_statement" }]);
        expect((await review(alice, REC)).updates).toEqual([
            expect.objectContaining({ earlierMention: true }),
        ]);
        await expect(share(REC)).resolves.toBeUndefined();
        expect(await recordingsAwaitingTaskReview(alice)).toEqual([]);
    });

    it("keeps accepted tasks and other members' mentions on browser and forced retranscription", async () => {
        await summarize(REC, [proposal("Preserve the accepted task")]);
        await acceptReview(alice, REC);
        const [task] = (await review(alice)).tasks;
        if (!task) throw new Error("missing accepted task");
        const otherItem = "rec-other-member-mention";
        await addRecording(otherItem, "2026-10-09T10:00:00Z", BOB);
        await db()
            .insert(taskMentions)
            .values({
                taskId: task.id,
                itemId: otherItem,
                userId: BOB,
                view: "private",
                statementAt: new Date("2026-10-09T10:00:00Z"),
                matchDecision: "accepted",
            });

        await expect(
            storeBrowserTranscription({
                userId: ALICE,
                recordingId: REC,
                text: "Browser replacement transcript.",
                detectedLanguage: "en",
                model: "whisper-tiny",
            }),
        ).resolves.toMatchObject({ success: true });
        expect(
            await db()
                .select({ id: recordingTasks.id })
                .from(recordingTasks)
                .where(eq(recordingTasks.id, task.id)),
        ).toEqual([{ id: task.id }]);
        await summarize(REC, []);

        await upsertTranscription({
            userId: ALICE,
            recordingId: REC,
            text: "Replacement transcript.",
            detectedLanguage: "en",
            source: "riffado",
            provider: "openai",
            model: "whisper-1",
            allowReaped: true,
            dropSummaryOnReplace: "riffado",
        });

        expect(
            await db()
                .select({ id: recordingTasks.id })
                .from(recordingTasks)
                .where(eq(recordingTasks.id, task.id)),
        ).toEqual([{ id: task.id }]);
        expect(
            await db()
                .select({ itemId: taskMentions.itemId })
                .from(taskMentions)
                .where(eq(taskMentions.taskId, task.id)),
        ).toEqual(
            expect.arrayContaining([{ itemId: REC }, { itemId: otherItem }]),
        );
    });

    it("ends one recording and one mail review as one task with two mentions", async () => {
        const mailId = "mail-shared-task-acceptance";
        await addMail(mailId);
        await summarize(REC, [proposal("Send the combined follow-up")]);
        await acceptReview(alice, REC);
        const [task] = (await review(alice)).tasks;
        if (!task) throw new Error("missing accepted task");

        await summarize(mailId, [], {
            matches: [match(task.id, { quote: "send the combined follow-up" })],
        });
        const [suggestion] = (await review(alice, mailId)).matches;
        if (!suggestion) throw new Error("missing suggested match");
        await tickUpdateProposal(
            alice,
            mailId,
            suggestion.id,
            true,
            suggestion.version,
        );
        await acceptReview(alice, mailId);

        expect(
            await db()
                .select({ id: recordingTasks.id })
                .from(recordingTasks)
                .where(eq(recordingTasks.userId, ALICE)),
        ).toEqual([{ id: task.id }]);
        expect(
            await db()
                .select({ itemId: taskMentions.itemId })
                .from(taskMentions)
                .where(
                    and(
                        eq(taskMentions.taskId, task.id),
                        eq(taskMentions.userId, ALICE),
                    ),
                ),
        ).toEqual(
            expect.arrayContaining([{ itemId: REC }, { itemId: mailId }]),
        );
    });

    it("routes merge evidence only from current linked Organization mentions", async () => {
        const targetItem = "rec-merge-target-owner";
        const privateMail = "mail-private-merge-noise";
        await addRecording(targetItem, "2026-10-10T10:00:00Z", BOB);
        await addMail(privateMail);
        await share(REC);
        await share(LATER);
        await share(targetItem, BOB);
        const source = await addTask(org, REC, {
            text: "Attach the launch evidence",
            status: "open",
        });
        const target = await addTask(org, targetItem, {
            text: "Publish the launch evidence",
            status: "open",
        });
        await db()
            .insert(taskMentions)
            .values([
                {
                    taskId: source.id,
                    itemId: LATER,
                    userId: ALICE,
                    view: "org",
                    quote: encryptText("current shared home evidence"),
                    statementAt: new Date("2026-10-08T10:00:00Z"),
                    matchDecision: "accepted",
                },
                {
                    taskId: source.id,
                    itemId: privateMail,
                    userId: ALICE,
                    view: "private",
                    quote: encryptText("newer private rejected evidence"),
                    statementAt: new Date("2026-10-12T10:00:00Z"),
                    matchDecision: "rejected",
                },
            ]);
        await db()
            .update(recordingTasks)
            .set({ itemId: LATER })
            .where(
                and(
                    eq(recordingTasks.id, source.id),
                    eq(recordingTasks.userId, ALICE),
                ),
            );

        await mergeTaskIntoTask(alice, source.id, target.id);

        const notice = (await listRoutedTaskProposals(bob)).find(
            (row) => row.kind === "attach_merge",
        );
        expect(notice).toMatchObject({
            quote: "current shared home evidence",
            sourceItem: { id: LATER },
        });
    });

    it("routes a merge notice without evidence when no linked shared mention remains", async () => {
        const targetItem = "rec-merge-target-without-evidence";
        await addRecording(targetItem, "2026-10-10T10:00:00Z", BOB);
        await share(REC);
        await share(targetItem, BOB);
        const source = await addTask(org, REC, {
            text: "Attach without visible evidence",
            status: "open",
        });
        const target = await addTask(org, targetItem, {
            text: "Receive the evidence-free notice",
            status: "open",
        });
        await db()
            .update(taskMentions)
            .set({ view: "private" })
            .where(
                and(
                    eq(taskMentions.taskId, source.id),
                    eq(taskMentions.userId, ALICE),
                ),
            );

        await mergeTaskIntoTask(alice, source.id, target.id);

        expect(
            (await listRoutedTaskProposals(bob)).find(
                (row) => row.kind === "attach_merge",
            ),
        ).toMatchObject({ quote: null, sourceItem: null });
    });

    it("reroutes pending proposals when a task home moves", async () => {
        const bobHome = "rec-bob-new-task-home";
        await addRecording(bobHome, "2026-10-10T10:00:00Z", BOB);
        await share(REC);
        await share(LATER);
        await share(bobHome, BOB);
        const task = await addTask(org, REC, {
            text: "Move and reroute this task",
            status: "open",
        });
        await db()
            .insert(taskMentions)
            .values({
                taskId: task.id,
                itemId: bobHome,
                userId: BOB,
                view: "org",
                statementAt: new Date("2026-10-10T10:00:00Z"),
                matchDecision: "accepted",
            });
        const [pending] = await db()
            .insert(taskUpdateProposals)
            .values({
                taskId: task.id,
                itemId: LATER,
                userId: ALICE,
                kind: "due",
                dueDate: "2026-10-30",
                statementAt: new Date("2026-10-08T10:00:00Z"),
                state: "awaiting_target_review",
                routedTo: [ALICE],
                version: task.version,
            })
            .returning({ id: taskUpdateProposals.id });

        await db().transaction(async (tx) => {
            await deleteItemTaskDataInTx(tx, {
                itemId: REC,
                ownerUserId: ALICE,
                actorUserId: ALICE,
                orgUserId,
                reason: "deleted",
            });
        });

        expect(
            await db()
                .select({ routedTo: taskUpdateProposals.routedTo })
                .from(taskUpdateProposals)
                .where(eq(taskUpdateProposals.id, pending?.id ?? "")),
        ).toEqual([{ routedTo: [BOB] }]);
        expect(
            (await listRoutedTaskProposals(bob)).map((row) => row.id),
        ).toContain(pending?.id);
        expect(
            (await listRoutedTaskProposals(org)).map((row) => row.id),
        ).toContain(pending?.id);
        await db()
            .update(taskUpdateProposals)
            .set({ routedTo: [ALICE, BOB] })
            .where(eq(taskUpdateProposals.id, pending?.id ?? ""));
        await expect(
            rejectRoutedTaskProposal(alice, LATER, pending?.id ?? ""),
        ).rejects.toMatchObject({ statusCode: 404 });
        await expect(
            rejectRoutedTaskProposal(bob, LATER, pending?.id ?? ""),
        ).resolves.toMatchObject({ state: "rejected" });
    });
});

function query(tab: "mine" | "tracked") {
    return {
        tab,
        state: "all" as const,
        folderId: null,
        due: null,
        today: null,
        sort: "created" as const,
    };
}
