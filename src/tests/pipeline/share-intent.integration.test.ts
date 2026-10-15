import { and, eq, isNull } from "drizzle-orm";
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
    chatterItems,
    itemProcessing,
    mailPendingShares,
    recordingFolderAssignments,
    recordingFolders,
    recordingTasks,
    taskUpdateProposals,
    transcriptions,
    users,
} from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef, mockEnv, authzState } = vi.hoisted(() => {
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
            SELF_HOST_MODE: "shared" as const,
            ORG_ACCOUNT_EMAIL: "org@example.test",
            ORG_ACCOUNT_PASSWORD: "organization-password" as string | undefined,
            ORG_ACCOUNT_NAME: undefined as string | undefined,
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            DATABASE_URL: "postgres://unused",
            AUTHZ_MODE: "local" as "local" | "idp",
        },
        authzState: { holderMayUse: true },
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/authz/access-state", () => ({
    holderAccess: vi.fn(async () =>
        authzState.holderMayUse
            ? {
                  ok: true,
                  capabilities: new Set(["use"]),
                  verifiedAt: new Date(),
              }
            : { ok: false, reason: "not-granted" },
    ),
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));

import { db as appDb } from "@/db";
import { encryptText } from "@/lib/encryption/fields";
import {
    assertCategorizableFolder,
    ensureRootFolders,
} from "@/lib/folders/folders";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { mailShareProblems } from "@/lib/mail/share-gate";
import {
    cancelIntendedPlacement,
    executeIntendedShares,
    executeIntendedSharesWithOutcome,
    recordIntendedPlacementInTx,
} from "@/lib/pipeline/share-intent";
import { insertRecordings } from "@/tests/integration/items";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const ALICE = "share-intent-alice";
const BOB = "share-intent-bob";
const ORG = "share-intent-org";

describeWithDatabase("intended Organization placements (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let aliceRootId = "";
    let orgRootId = "";
    let orgFolderId = "";
    let bobFolderId = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    async function rootId(userId: string): Promise<string> {
        const [root] = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(
                and(
                    eq(recordingFolders.userId, userId),
                    isNull(recordingFolders.parentId),
                ),
            )
            .limit(1);
        if (!root) throw new Error(`root missing for ${userId}`);
        return root.id;
    }

    async function insertFolder(input: {
        id: string;
        userId: string;
        parentId: string;
        name: string;
    }): Promise<void> {
        await db()
            .insert(recordingFolders)
            .values({
                ...input,
                kind: "custom",
                name: encryptText(input.name),
                nameHash: lookupHash(input.name),
            });
    }

    async function insertAudio(id: string, userId = ALICE): Promise<void> {
        await insertRecordings(db(), {
            id,
            userId,
            deviceSn: "SN-1",
            plaudFileId: `plaud-${id}`,
            filename: encryptText(`Recording ${id}`),
            duration: 60_000,
            startTime: new Date("2026-10-15T10:00:00Z"),
            endTime: new Date("2026-10-15T10:01:00Z"),
            filesize: 1000,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: `${userId}/${id}.mp3`,
            plaudVersion: "1",
        });
    }

    async function insertTranscript(itemId: string): Promise<void> {
        await db()
            .insert(transcriptions)
            .values({
                recordingId: itemId,
                userId: ALICE,
                text: encryptText("Ready to share."),
                provider: "openai",
                model: "whisper-1",
                source: "riffado",
            });
    }

    async function insertMail(id: string): Promise<void> {
        await db()
            .insert(chatterItems)
            .values({
                id,
                userId: ALICE,
                kind: "mail",
                title: encryptText(`Mail ${id}`),
                occurredAt: new Date("2026-10-15T10:00:00Z"),
            });
    }

    async function recordIntent(itemId: string): Promise<void> {
        await appDb.transaction((tx) =>
            recordIntendedPlacementInTx(tx, {
                ownerUserId: ALICE,
                itemId,
                folderId: orgFolderId,
            }),
        );
    }

    async function assignments(itemId: string): Promise<string[]> {
        return (
            await db()
                .select({ folderId: recordingFolderAssignments.folderId })
                .from(recordingFolderAssignments)
                .where(
                    and(
                        eq(recordingFolderAssignments.userId, ALICE),
                        eq(recordingFolderAssignments.itemId, itemId),
                    ),
                )
        ).map((row) => row.folderId);
    }

    async function intents(itemId: string): Promise<string[]> {
        return (
            await db()
                .select({ folderId: mailPendingShares.folderId })
                .from(mailPendingShares)
                .where(
                    and(
                        eq(mailPendingShares.userId, ALICE),
                        eq(mailPendingShares.itemId, itemId),
                    ),
                )
        ).map((row) => row.folderId);
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "share_intent",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        mockEnv.AUTHZ_MODE = "local";
        authzState.holderMayUse = true;
        await db().delete(users);
        await db()
            .insert(users)
            .values([
                { id: ALICE, email: "alice@example.test", name: "Alice" },
                { id: BOB, email: "bob@example.test", name: "Bob" },
                {
                    id: ORG,
                    email: "org@example.test",
                    name: "Organization",
                    role: "org",
                },
            ]);
        await ensureRootFolders(ALICE);
        await ensureRootFolders(BOB);
        await ensureRootFolders(ORG);
        aliceRootId = await rootId(ALICE);
        orgRootId = await rootId(ORG);
        const bobRootId = await rootId(BOB);
        orgFolderId = "share-intent-org-folder";
        bobFolderId = "share-intent-bob-folder";
        await insertFolder({
            id: orgFolderId,
            userId: ORG,
            parentId: orgRootId,
            name: "Sales",
        });
        await insertFolder({
            id: bobFolderId,
            userId: BOB,
            parentId: bobRootId,
            name: "Bob's folder",
        });
    });

    it("keeps a blocked audio intent, then shares it exactly once", async () => {
        const itemId = "audio-intent";
        await insertAudio(itemId);
        await recordIntent(itemId);

        expect(await executeIntendedShares(ALICE, itemId)).toEqual([
            { kind: "no_transcript" },
        ]);
        expect(await assignments(itemId)).toEqual([]);
        expect(await intents(itemId)).toEqual([orgFolderId]);

        await insertTranscript(itemId);
        expect(await executeIntendedShares(ALICE, itemId)).toEqual([]);
        expect(await assignments(itemId)).toEqual([orgFolderId]);
        expect(await intents(itemId)).toEqual([]);

        expect(await executeIntendedShares(ALICE, itemId)).toEqual([]);
        expect(await assignments(itemId)).toEqual([orgFolderId]);
    });

    it("keeps a blocked mail intent, then shares it exactly once", async () => {
        const itemId = "mail-intent";
        await insertMail(itemId);
        await recordIntent(itemId);
        const [proposal] = await db()
            .insert(recordingTasks)
            .values({
                itemId,
                userId: ALICE,
                status: "proposed",
                source: "riffado",
                text: encryptText("Reply to the customer"),
            })
            .returning({ id: recordingTasks.id });

        expect(await executeIntendedShares(ALICE, itemId)).toEqual([
            { kind: "tasks_unreviewed", proposals: 1 },
        ]);
        expect(await assignments(itemId)).toEqual([]);
        expect(await intents(itemId)).toEqual([orgFolderId]);

        await db()
            .update(recordingTasks)
            .set({ status: "open" })
            .where(eq(recordingTasks.id, proposal?.id ?? ""));
        expect(await executeIntendedShares(ALICE, itemId)).toEqual([]);
        expect(await assignments(itemId)).toEqual([orgFolderId]);
        expect(await intents(itemId)).toEqual([]);

        expect(await executeIntendedShares(ALICE, itemId)).toEqual([]);
        expect(await assignments(itemId)).toEqual([orgFolderId]);
    });

    it("never shares a cancelled intent", async () => {
        const itemId = "cancelled-audio-intent";
        await insertAudio(itemId);
        await recordIntent(itemId);
        await cancelIntendedPlacement(ALICE, itemId, orgFolderId);
        await insertTranscript(itemId);

        expect(await executeIntendedShares(ALICE, itemId)).toEqual([]);
        expect(await assignments(itemId)).toEqual([]);
        expect(await intents(itemId)).toEqual([]);
        const [processing] = await db()
            .select({ phases: itemProcessing.phases })
            .from(itemProcessing)
            .where(
                and(
                    eq(itemProcessing.itemId, itemId),
                    eq(itemProcessing.userId, ALICE),
                    eq(itemProcessing.view, "private"),
                ),
            );
        expect(processing?.phases.share).toMatchObject({
            state: "skipped",
            reason: "cancelled",
        });
    });

    it("does not share when cancellation commits while Share waits for the Organization tree", async () => {
        const itemId = "concurrent-cancelled-audio-intent";
        await insertAudio(itemId);
        await insertTranscript(itemId);
        await recordIntent(itemId);
        if (!database) throw new Error("test database was not initialized");

        let releaseTreeLock = () => {};
        const release = new Promise<void>((resolve) => {
            releaseTreeLock = resolve;
        });
        let treeLocked = () => {};
        const locked = new Promise<void>((resolve) => {
            treeLocked = resolve;
        });
        const blocker = database.sql.begin(async (sql) => {
            await sql`select pg_advisory_xact_lock(hashtext('riffado:org-tree'))`;
            treeLocked();
            await release;
        });
        await locked;

        const sharing = executeIntendedSharesWithOutcome(ALICE, itemId);
        for (;;) {
            const [waiting] = await database.sql<{ waiting: number }[]>`
                select count(*)::int as waiting
                from pg_locks
                where locktype = 'advisory' and not granted
            `;
            if ((waiting?.waiting ?? 0) > 0) break;
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        await cancelIntendedPlacement(ALICE, itemId, orgFolderId);
        releaseTreeLock();
        await blocker;

        await expect(sharing).resolves.toMatchObject({
            shared: false,
            remaining: false,
        });
        expect(await assignments(itemId)).toEqual([]);
        expect(await intents(itemId)).toEqual([]);
    });

    it("leaves intents waiting while the Organization is read-only", async () => {
        const itemId = "read-only-org-intent";
        await insertAudio(itemId);
        await insertTranscript(itemId);
        await recordIntent(itemId);
        mockEnv.ORG_ACCOUNT_PASSWORD = undefined;

        try {
            await expect(
                executeIntendedSharesWithOutcome(ALICE, itemId),
            ).resolves.toMatchObject({
                shared: false,
                remaining: true,
            });
        } finally {
            mockEnv.ORG_ACCOUNT_PASSWORD = "organization-password";
        }
        expect(await assignments(itemId)).toEqual([]);
        expect(await intents(itemId)).toEqual([orgFolderId]);
    });

    it("leaves intents waiting when IdP access to the Organization was revoked", async () => {
        const itemId = "revoked-org-intent";
        await insertAudio(itemId);
        await insertTranscript(itemId);
        await recordIntent(itemId);
        mockEnv.AUTHZ_MODE = "idp";
        authzState.holderMayUse = false;

        await expect(
            executeIntendedSharesWithOutcome(ALICE, itemId),
        ).resolves.toMatchObject({ shared: false, remaining: true });
        expect(await assignments(itemId)).toEqual([]);
        expect(await intents(itemId)).toEqual([orgFolderId]);
    });

    it("refuses both roots and another owner's folder", async () => {
        await expect(
            assertCategorizableFolder(ALICE, aliceRootId),
        ).rejects.toMatchObject({ statusCode: 400 });
        await expect(
            assertCategorizableFolder(ALICE, orgRootId),
        ).rejects.toMatchObject({ statusCode: 400 });
        await expect(
            assertCategorizableFolder(ALICE, bobFolderId),
        ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("counts pending follow-up proposals in the mail share gate", async () => {
        const mailId = "mail-follow-up";
        const targetId = "follow-up-target";
        await insertMail(mailId);
        await insertAudio(targetId);
        const [task] = await db()
            .insert(recordingTasks)
            .values({
                itemId: targetId,
                userId: ALICE,
                status: "open",
                source: "manual",
                text: encryptText("Send the draft"),
            })
            .returning({ id: recordingTasks.id });
        await db()
            .insert(taskUpdateProposals)
            .values({
                taskId: task?.id ?? "",
                itemId: mailId,
                userId: ALICE,
                kind: "done",
            });

        const problems = await appDb.transaction((tx) =>
            mailShareProblems(tx, mailId, ALICE),
        );
        expect(problems).toEqual([{ kind: "tasks_unreviewed", proposals: 1 }]);
    });
});
