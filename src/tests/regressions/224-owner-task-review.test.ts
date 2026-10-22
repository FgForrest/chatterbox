import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
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
import {
    chatterItems,
    itemProcessing,
    mailMessages,
    people,
    recordingFolders,
    recordingTasks,
    transcriptions,
    users,
} from "@/db/schema";
import { encryptText } from "@/lib/encryption/fields";
import { addRecordingToFolder, ensureRootFolders } from "@/lib/folders/folders";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { ensureOrgAccount } from "@/lib/org/account";
import { pipelineAdvanceJobHandler } from "@/lib/pipeline/advance-job";
import { gatherFacts } from "@/lib/pipeline/facts";
import { loadPrivateItemProcessing } from "@/lib/pipeline/presentation";
import { deriveWorkflowStatus } from "@/lib/pipeline/workflow-status";
import { resolveDefaultProfile } from "@/lib/profiles/resolve";
import { taskViewer } from "@/lib/tasks/access";
import { taskFingerprint } from "@/lib/tasks/proposals";
import { acceptReview, listRecordingTasks, listTasks } from "@/lib/tasks/tasks";
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
    requireApiSession: vi.fn(async () => ({
        user: { id: "owner", email: "velnira@example.test" },
    })),
}));
vi.mock("@/lib/knowledge/availability", () => ({
    isLearnDeploymentAvailable: () => false,
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

describeWithDatabase("#224 owner Task review without a sharing gate", () => {
    let database: TestPostgresDatabase;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "owner_task_review",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);
    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);
    beforeEach(async () => {
        await database.db.delete(users);
    });

    it.each([
        "audio",
        "mail",
    ] as const)("proposes %s tasks, shares before review, then delivers accepted tasks", async (kind) => {
        const db = database.db;
        await db.insert(users).values([
            { id: "owner", email: "velnira@example.test" },
            { id: "assignee", email: "quorlen@example.test" },
        ]);
        const orgUserId = await ensureOrgAccount();
        if (!orgUserId) throw new Error("organization missing");
        const [folder] = await db
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, orgUserId));
        const [person] = await db
            .insert(people)
            .values({
                userId: "owner",
                displayName: encryptText("Quorlen Voss"),
                primaryEmail: encryptText("quorlen@example.test"),
                primaryEmailHash: lookupHash("quorlen@example.test"),
            })
            .returning({ id: people.id });
        if (!person || !folder) throw new Error("task fixture missing");
        const at = new Date("2026-10-22T08:00:00Z");
        let transcriptionId: string | null = null;
        if (kind === "audio") {
            await insertRecordings(db, {
                id: "review-item",
                userId: "owner",
                deviceSn: "review-device",
                plaudFileId: "review-file",
                filename: encryptText("Review recording"),
                duration: 1_000,
                startTime: at,
                endTime: at,
                filesize: 1,
                fileMd5: "0".repeat(32),
                storageType: "local",
                storagePath: "owner/review.mp3",
                plaudVersion: "1",
            });
            await upsertTranscription({
                userId: "owner",
                recordingId: "review-item",
                text: "Send the report.",
                detectedLanguage: "en",
                source: "riffado",
                provider: "test",
                model: "test",
            });
            const [transcript] = await db
                .select({ id: transcriptions.id })
                .from(transcriptions)
                .where(
                    and(
                        eq(transcriptions.recordingId, "review-item"),
                        eq(transcriptions.userId, "owner"),
                    ),
                );
            transcriptionId = transcript?.id ?? null;
        } else {
            await db.insert(chatterItems).values({
                id: "review-item",
                userId: "owner",
                kind,
                title: encryptText("Review mail"),
                occurredAt: at,
            });
            await db.insert(mailMessages).values({
                id: "review-item",
                userId: "owner",
                rawHash: "review-mail",
                receivedAt: at,
                sizeBytes: 1,
                auth: {},
                senderVerified: true,
            });
        }
        await ensureRootFolders("owner");
        const [privateRoot] = await db
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(
                and(
                    eq(recordingFolders.userId, "owner"),
                    eq(recordingFolders.kind, "private"),
                ),
            );
        if (!privateRoot) throw new Error("private root missing");
        await db.insert(recordingFolders).values({
            id: "review-private",
            parentId: privateRoot.id,
            userId: "owner",
            name: "Review",
            nameHash: "review-folder",
            kind: "custom",
        });
        await addRecordingToFolder({
            userId: "owner",
            recordingId: "review-item",
            folderId: "review-private",
        });
        const profile = await resolveDefaultProfile("owner", kind);
        await db
            .update(itemProcessing)
            .set({
                manualOnly: true,
                profileId: profile.profile.id,
                profileRevisionId: profile.revisionId,
                phases: {
                    categorize: {
                        state: "done",
                        reason: "categorized",
                        generation: 1,
                        at: at.toISOString(),
                    },
                },
            })
            .where(
                and(
                    eq(itemProcessing.itemId, "review-item"),
                    eq(itemProcessing.userId, "owner"),
                    eq(itemProcessing.view, "private"),
                ),
            );
        const owner = await taskViewer({
            id: "owner",
            email: "velnira@example.test",
        });
        const assignee = await taskViewer({
            id: "assignee",
            email: "quorlen@example.test",
        });
        const saved = await upsertEnhancement({
            userId: "owner",
            recordingId: "review-item",
            kind,
            transcriptionId,
            summary: "Send the report.",
            keyPoints: [],
            actionItems: ["Send the report"],
            source: "riffado",
            provider: "test",
            model: "test",
            allowReaped: true,
            tasks: {
                source: "riffado",
                reviewer: owner,
                fingerprintOf: taskFingerprint,
                updates: [],
                tasks: [
                    {
                        text: "Send the report",
                        fingerprint: taskFingerprint("Send the report"),
                        assigneePersonId: person.id,
                        assigneeHint: null,
                        assigneeCheck: false,
                        dueDate: null,
                        duePhrase: null,
                        quote: null,
                        evidenceStartMs: null,
                    },
                ],
            },
        });
        expect(saved.committed).toBe(true);
        expect(
            await db
                .select({
                    status: recordingTasks.status,
                    acceptedAt: recordingTasks.acceptedAt,
                })
                .from(recordingTasks),
        ).toEqual([{ status: "proposed", acceptedAt: null }]);
        expect(
            (await listRecordingTasks(owner, "review-item"))?.proposals,
        ).toHaveLength(1);
        expect(
            await (
                await pendingReviews(
                    new NextRequest("http://localhost/api/learn/pending"),
                )
            ).json(),
        ).toEqual({ count: 1 });
        const facts = await gatherFacts("review-item", "private", "owner");
        expect(facts.taskReview.proposals).toBe(1);
        await pipelineAdvanceJobHandler.run({
            jobId: "review-pipeline",
            userId: "owner",
            attempt: 1,
            maxAttempts: 10,
            payload: {
                itemId: "review-item",
                view: "private",
                reason: "summary",
            },
            signal: new AbortController().signal,
            reportProgress: vi.fn(),
        });
        const processing = await loadPrivateItemProcessing(
            "owner",
            "review-item",
        );
        if (!processing) throw new Error("workflow missing");
        expect(deriveWorkflowStatus(processing, kind).steps).toContainEqual(
            expect.objectContaining({ id: "taskReview", state: "review" }),
        );

        await expect(
            addRecordingToFolder({
                userId: "owner",
                recordingId: "review-item",
                folderId: folder.id,
            }),
        ).resolves.toBeUndefined();
        expect(await listRecordingTasks(assignee, "review-item")).toMatchObject(
            {
                reviewed: true,
                proposals: [],
                tasks: [],
            },
        );
        const query = {
            tab: "mine",
            state: "open",
            folderId: null,
            due: null,
            today: null,
            sort: "created",
        } as const;
        expect(await listTasks(assignee, query)).toEqual([]);
        await expect(acceptReview(owner, "review-item")).resolves.toMatchObject(
            { accepted: 1 },
        );
        expect(await listTasks(assignee, query)).toMatchObject([
            { text: "Send the report", status: "open", canClose: true },
        ]);
        expect(
            await (
                await pendingReviews(
                    new NextRequest("http://localhost/api/learn/pending"),
                )
            ).json(),
        ).toEqual({ count: 0 });
    });
});
