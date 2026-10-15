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
    mailMessages,
    people,
    recordingFolders,
    recordingTaskRejections,
    recordingTasks,
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
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { addRecordingToFolder, unshareRecording } from "@/lib/folders/folders";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { mergePeople } from "@/lib/knowledge/people";
import { ensureOrgAccount } from "@/lib/org/account";
import { eraseLocalArtifact } from "@/lib/recordings/erase";
import { type TaskViewer, taskViewer } from "@/lib/tasks/access";
import { type TaskArchiveScope, tasksForArchive } from "@/lib/tasks/archive";
import { deleteItemTaskDataInTx } from "@/lib/tasks/mentions";
import { loadTasksPromptContext, taskFingerprint } from "@/lib/tasks/proposals";
import type { ProposedTask, TaskProposals } from "@/lib/tasks/store";
import {
    acceptReview,
    addTask,
    countNewTasks,
    listRecordingTasks,
    listTasks,
    markTasksSeen,
    mergeProposals,
    recordingsAwaitingTaskReview,
    tickUpdateProposal,
    updateTask,
} from "@/lib/tasks/tasks";
import {
    type UpsertEnhancementArgs,
    upsertEnhancement,
} from "@/lib/transcription/persist";
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

    async function addRecording(id: string, startTime: string) {
        await insertRecordings(db(), {
            id,
            userId: ALICE,
            deviceSn: "SN-1",
            plaudFileId: `plaud-${id}`,
            filename: encryptText(`Recording ${id}`),
            duration: 60_000,
            startTime: new Date(startTime),
            endTime: new Date(startTime),
            filesize: 11,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: `${ALICE}/${id}.mp3`,
            storageFilename: `${id}.mp3`,
            plaudVersion: "1",
        });
        const [transcript] = await db()
            .insert(transcriptions)
            .values({
                recordingId: id,
                userId: ALICE,
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
            transcriptionId: transcriptId,
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
                fingerprintOf: taskFingerprint,
                ...extra,
            },
        });
        expect(result.committed).toBe(true);
    }

    async function share(recordingId = REC) {
        const [root] = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, orgUserId));
        await addRecordingToFolder({
            userId: ALICE,
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

    it("refuses to share while follow-ups heard on the recording wait", async () => {
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
        await expect(share(REC)).rejects.toMatchObject({
            statusCode: 409,
            details: {
                problems: [{ kind: "tasks_unreviewed", proposals: 1 }],
            },
        });
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

    it("keeps a private recording's tasks to its owner, whoever they name", async () => {
        const task = await addTask(alice, REC, {
            text: "Draft the pricing page",
            assigneePersonId: bobPrivate,
            status: "open",
        });
        expect(await review(bob, REC).catch(() => null)).toBeNull();
        expect(await listTasks(bob, query("mine"))).toEqual([]);
        expect(await countNewTasks(bob)).toBe(0);
        await expect(
            updateTask(bob, task.id, { version: task.version, status: "done" }),
        ).rejects.toMatchObject({ statusCode: 404 });
        expect(
            (await listTasks(alice, query("tracked"))).map((row) => row.text),
        ).toEqual(["Draft the pricing page"]);
    });

    it("on a shared recording: the Organization edits, owner and assignee close, members read", async () => {
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

        // Alice, the owner: may reopen, may not edit or drop.
        const reopened = await updateTask(alice, task.id, {
            version: done.version,
            status: "open",
        });
        await expect(
            updateTask(alice, task.id, {
                version: reopened.version,
                status: "dropped",
            }),
        ).rejects.toMatchObject({ statusCode: 403 });

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
    });

    it("hides a shared recording's proposals from all but the Organization", async () => {
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
        expect((await review(alice)).proposals).toEqual([]);
        expect((await review(bob)).proposals).toEqual([]);
        await expect(acceptReview(alice, REC)).rejects.toMatchObject({
            statusCode: 403,
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
                .select()
                .from(taskUpdateProposals)
                .where(eq(taskUpdateProposals.itemId, LATER)),
        ).toEqual([]);
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

    it("lets a follow-up whose task moved on stop blocking the share", async () => {
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
        expect((await review(alice)).updates).toEqual([]);
        await share(REC);
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

    it("does not move an Organization task to another member's private item", async () => {
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
                .select()
                .from(recordingTasks)
                .where(eq(recordingTasks.id, task.id)),
        ).toEqual([]);
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

    it("lists a shared recording's review for the Organization only", async () => {
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
                proposals: 2,
            },
        ]);
        expect(await recordingsAwaitingTaskReview(alice)).toEqual([
            {
                recordingId: LATER,
                kind: "audio",
                title: `Recording ${LATER}`,
                proposals: 1,
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
