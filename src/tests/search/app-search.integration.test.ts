import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
    accounts,
    chatterItems,
    knowledgeAliases,
    knowledgeEntities,
    knowledgeEntityTypes,
    mailContents,
    mailMessages,
    recordingFolderAssignments,
    recordingFolders,
    recordingTasks,
    transcriptCorrections,
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
                    const current = ref.current;
                    if (!current)
                        throw new Error("test database was not initialized");
                    const value = current[key];
                    return typeof value === "function"
                        ? value.bind(current)
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
            KNOWLEDGE_MEMORY_MB: 32,
            OIDC_ISSUER_URL: "https://id.example.test/realms/test",
            OIDC_CLIENT_ID: "chatterbox",
            OIDC_CLIENT_SECRET: "test-secret",
            MAIL_DOMAIN: "mail.example.test",
            MAIL_ORG_NICKNAME: "team",
            MAIL_FORMER_ORG_NICKNAMES: [] as string[],
            MAIL_ADDRESS_HASH_SECRET: "m".repeat(40),
            MAIL_INGEST_SECRET: "i".repeat(40),
            MAIL_INACTIVE_DAYS: 180,
        },
    };
});
vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/export/document-sidecars", () => ({
    refreshExistingRecordingSidecars: vi.fn(),
    exportRecordingSidecarsIfEnabled: vi.fn(),
}));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));

import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import { addRecordingToFolder, ensureRootFolders } from "@/lib/folders/folders";
import { domainLookupHash, lookupHash } from "@/lib/knowledge/lookup-hash";
import { seedCoreVocabulary } from "@/lib/knowledge/vocabulary";
import { createSecretAddress, ensureMailbox } from "@/lib/mail/addresses";
import { loadMailListRows, loadSharedMailRows } from "@/lib/mail/list";
import { ensureOrgAccount } from "@/lib/org/account";
import { searchAlmanac, searchApp, searchTasks } from "@/lib/search/app-search";
import { type TaskViewer, taskViewer } from "@/lib/tasks/access";
import { getCallerTask } from "@/lib/tasks/tasks";
import {
    insertPerson,
    insertRecording,
    insertTask,
    insertTranscript,
    shareRecording,
} from "@/tests/mcp/fixtures";

const databaseUrl = getTestDatabaseUrl();
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const ALICE = "search-alice";
const BOB = "search-bob";
const CAROL = "search-carol";

describeWithDatabase("page-scoped search (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    let orgId = "";
    let alice: TaskViewer;
    let bob: TaskViewer;
    let org: TaskViewer;
    let person = "";
    let orgPerson = "";
    let bobPerson = "";
    let task = "";
    let sharedTask = "";
    let privateTask = "";
    let doneTask = "";
    const db = () => database.db;

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            databaseUrl ?? "",
            "app_search",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        await db()
            .insert(users)
            .values([
                { id: ALICE, email: "alice@example.test" },
                { id: BOB, email: "bob@example.test" },
                { id: CAROL, email: "carol@example.test" },
            ]);
        orgId = (await ensureOrgAccount()) ?? "";
        await seedCoreVocabulary();
        person = await insertPerson(db(), ALICE, "Petra Dvořáková");
        orgPerson = await insertPerson(db(), orgId, "Shared colleague", {
            emailHash: lookupHash("alice@example.test"),
        });
        bobPerson = await insertPerson(db(), BOB, "Bob secret person");
        await db()
            .insert(knowledgeEntityTypes)
            .values({
                userId: ALICE,
                key: "u_custom",
                label: encryptText("Research topic"),
                labelHmac: domainLookupHash(
                    "entity-type-label",
                    "Research topic",
                ),
            });
        const entities = [
            {
                id: "evita",
                userId: ALICE,
                name: "Evita 100%_ready\\docs",
                typeKey: "product",
            },
            {
                id: "topic",
                userId: ALICE,
                name: "Custom record",
                typeKey: "u_custom",
            },
            {
                id: "org-entity",
                userId: orgId,
                name: "Organization project",
                typeKey: "project",
            },
            {
                id: "bob-entity",
                userId: BOB,
                name: "Bob secret thing",
                typeKey: "term",
            },
        ];
        for (const entity of entities)
            await db()
                .insert(knowledgeEntities)
                .values({
                    ...entity,
                    name: encryptText(entity.name),
                    nameHmac: domainLookupHash("entity-name", entity.name),
                });
        await insertRecording(db(), {
            id: "alice-private",
            userId: ALICE,
            title: "Private planning",
        });
        await insertRecording(db(), {
            id: "bob-private",
            userId: BOB,
            title: "Bob secret recording",
        });
        await insertRecording(db(), {
            id: "bob-shared",
            userId: BOB,
            title: "Shared planning",
        });
        await insertRecording(db(), {
            id: "deleted",
            userId: ALICE,
            deletedAt: new Date(),
            title: "Deleted planning",
        });
        await shareRecording(db(), "bob-shared", orgId);
        const transcriptionId = await insertTranscript(
            db(),
            "alice-private",
            ALICE,
        );
        const [correction] = await db()
            .insert(transcriptCorrections)
            .values({
                userId: ALICE,
                transcriptionId,
                transcriptRevision: 0,
                turnIndex: 0,
                charStart: 0,
                charEnd: 5,
                heard: encryptText("evitě"),
                heardHmac: domainLookupHash("correction-heard", "evitě"),
                kind: "correct",
                targetEntityId: "evita",
                replacement: encryptText("Evitě"),
            })
            .returning();
        if (!correction) throw new Error("correction missing");
        await db()
            .insert(knowledgeAliases)
            .values([
                {
                    userId: ALICE,
                    personId: person,
                    kind: "alias",
                    text: encryptText("Peta"),
                    textHmac: domainLookupHash("alias", "Peta"),
                },
                {
                    userId: ALICE,
                    entityId: "evita",
                    kind: "heard_as",
                    text: encryptText("evitě"),
                    textHmac: domainLookupHash("alias", "evitě"),
                    correctionId: correction.id,
                },
                {
                    userId: BOB,
                    personId: orgPerson,
                    kind: "alias",
                    text: encryptText("secret nickname"),
                    textHmac: domainLookupHash("alias", "secret nickname"),
                },
            ]);
        task = await insertTask(db(), {
            recordingId: "alice-private",
            userId: ALICE,
            text: "Ship 100%_ready\\docs",
        });
        await db()
            .update(recordingTasks)
            .set({ dueDate: "2026-10-23" })
            .where(eq(recordingTasks.id, task));
        sharedTask = await insertTask(db(), {
            recordingId: "bob-shared",
            userId: BOB,
            text: "Ship shared task",
            assigneePersonId: orgPerson,
        });
        privateTask = await insertTask(db(), {
            recordingId: "bob-private",
            userId: BOB,
            text: "Ship secret task",
            assigneePersonId: orgPerson,
        });
        doneTask = await insertTask(db(), {
            recordingId: "alice-private",
            userId: ALICE,
            text: "Ship done task",
            status: "done",
        });
        await insertTask(db(), {
            recordingId: "alice-private",
            userId: ALICE,
            text: "Ship proposed task",
            status: "proposed",
        });
        await insertTask(db(), {
            recordingId: "alice-private",
            userId: ALICE,
            text: "Ship dropped task",
            status: "dropped",
        });
        await insertTask(db(), {
            recordingId: "deleted",
            userId: ALICE,
            text: "Ship deleted task",
        });
        alice = await taskViewer({ id: ALICE, email: "alice@example.test" });
        bob = await taskViewer({ id: BOB, email: "bob@example.test" });
        org = await taskViewer({ id: orgId, email: "org@example.test" });
    }, 120_000);
    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    it("finds people by names and aliases, ignoring case and accents", async () => {
        expect(
            (await searchAlmanac(ALICE, "dvorakova")).hits.map((hit) => hit.id),
        ).toEqual([person]);
        expect(
            (await searchAlmanac(ALICE, "PETA")).hits.map((hit) => hit.id),
        ).toEqual([person]);
    });
    it("returns taught forms with their correct record and destination", async () => {
        expect((await searchAlmanac(ALICE, "evitě")).hits).toContainEqual(
            expect.objectContaining({
                kind: "glossary",
                heard: "evitě",
                name: "Evita 100%_ready\\docs",
                href: "/almanac/things/evita",
            }),
        );
    });
    it("keeps custom vocabulary labels", async () => {
        expect((await searchAlmanac(ALICE, "Custom")).hits).toEqual([
            expect.objectContaining({
                typeKey: "u_custom",
                typeLabel: "Research topic",
            }),
        ]);
    });
    it("reads personal and Organization records but never another user's private records or aliases", async () => {
        const hits = (await searchAlmanac(ALICE, "")).hits;
        expect(hits.map((hit) => hit.id)).toContain(orgPerson);
        expect(hits.map((hit) => hit.id)).toContain("org-entity");
        expect(hits.map((hit) => hit.id)).not.toContain(bobPerson);
        expect(hits.map((hit) => hit.id)).not.toContain("bob-entity");
        expect((await searchAlmanac(ALICE, "secret")).hits).toEqual([]);
        expect((await searchAlmanac(orgId, "Petra")).hits).toEqual([]);
    });
    it.each([
        "%",
        "_",
        "\\",
    ])("treats ILIKE metacharacter %s literally in Almanac search", async (query) => {
        expect(
            new Set(
                (await searchAlmanac(ALICE, query)).hits.map((hit) => hit.id),
            ),
        ).toEqual(new Set(["evita"]));
    });
    it("combines Mine and Tracked and orders open before done", async () => {
        const hits = (await searchTasks(alice, "Ship")).hits;
        expect(hits.map((hit) => hit.id)).toEqual([sharedTask, task, doneTask]);
        expect(hits.find((hit) => hit.id === task)).toMatchObject({
            dueDate: "2026-10-23",
            recording: { title: "Private planning" },
            href: `/tasks/${task}`,
        });
    });
    it("never exposes tasks on someone else's private recording, even to the assignee", async () => {
        expect((await searchTasks(alice, "secret")).hits).toEqual([]);
        expect(await getCallerTask(alice, privateTask)).toBeNull();
        expect(
            (await searchTasks(bob, "Ship")).hits.map((hit) => hit.id),
        ).toContain(privateTask);
    });
    it("exposes shared assigned tasks, and every shared task to the Organization", async () => {
        expect(
            (await searchTasks(org, "Ship")).hits.map((hit) => hit.id),
        ).toEqual([sharedTask]);
        const carol = await taskViewer({
            id: CAROL,
            email: "carol@example.test",
        });
        expect((await searchTasks(carol, "Ship")).hits).toEqual([]);
        expect(await getCallerTask(carol, sharedTask)).toBeNull();
        expect(await getCallerTask(alice, sharedTask)).not.toBeNull();
    });
    it.each([
        "%",
        "_",
        "\\",
    ])("treats ILIKE metacharacter %s literally in task search", async (query) => {
        expect(
            (await searchTasks(alice, query)).hits.map((hit) => hit.id),
        ).toEqual([task]);
    });
    it("returns only the requested sections and combines them for Everywhere", async () => {
        const scoped = await searchApp(alice, "tasks", "Ship");
        expect(scoped.almanac).toEqual([]);
        expect(scoped.chatter).toEqual([]);
        const all = await searchApp(alice, "all", "");
        expect(all.chatter.map((hit) => hit.id)).toContain("bob-shared");
        expect(all.chatter.map((hit) => hit.id)).not.toContain("bob-private");
        expect(all.almanac.length).toBeGreaterThan(0);
        expect(all.tasks.length).toBeGreaterThan(0);
    });
    it.each([
        true,
        false,
    ])("keeps Organization knowledge out when hosted=%s and Organization visibility is off", async (hosted) => {
        mockEnv.IS_HOSTED = hosted;
        mockEnv.SELF_HOST_MODE = "local";
        try {
            expect((await searchAlmanac(ALICE, "Organization")).hits).toEqual(
                [],
            );
            const local = await taskViewer({
                id: ALICE,
                email: "alice@example.test",
            });
            expect((await searchTasks(local, "shared")).hits).toEqual([]);
        } finally {
            mockEnv.IS_HOSTED = false;
            mockEnv.SELF_HOST_MODE = "shared";
        }
    });
    it("excludes matching private and deleted Chatter items for non-empty queries", async () => {
        const own = await searchApp(alice, "chatter", "planning");
        expect(own.chatter.map((hit) => hit.id).sort()).toEqual([
            "alice-private",
            "bob-shared",
        ]);
        expect(
            (await searchApp(alice, "chatter", "secret recording")).chatter,
        ).toEqual([]);
        expect(
            (await searchApp(bob, "chatter", "secret recording")).chatter.map(
                (hit) => hit.id,
            ),
        ).toEqual(["bob-private"]);
        expect(
            (await searchApp(alice, "chatter", "Deleted planning")).chatter,
        ).toEqual([]);
    });
    it.each([
        { hosted: false, mode: "local" },
        { hosted: true, mode: "local" },
        { hosted: true, mode: "shared" },
    ])("matches Chatter list visibility with hosted=$hosted and mode=$mode", async ({
        hosted,
        mode,
    }) => {
        mockEnv.IS_HOSTED = hosted;
        mockEnv.SELF_HOST_MODE = mode;
        try {
            const results = await searchApp(alice, "chatter", "planning");
            expect(results.chatter.map((hit) => hit.id)).toEqual([
                "alice-private",
            ]);
            expect(await loadSharedMailRows(ALICE, orgId)).toEqual([]);
        } finally {
            mockEnv.IS_HOSTED = false;
            mockEnv.SELF_HOST_MODE = "shared";
        }
    });
    it("masks a colleague's mail title and snippet like the list", async () => {
        await db()
            .update(users)
            .set({ emailVerified: true, lastSsoLoginAt: new Date() })
            .where(eq(users.id, BOB));
        await db().insert(accounts).values({
            userId: BOB,
            accountId: "bob-subject",
            providerId: "oidc",
        });
        const mailbox = await ensureMailbox(BOB);
        const secret = await createSecretAddress({
            userId: BOB,
            baseAddressId: mailbox?.id ?? "",
            label: null,
        });
        const address = `${secret.localPart}@mail.example.test`;
        await db()
            .insert(chatterItems)
            .values({
                id: "bob-mail",
                userId: BOB,
                kind: "mail",
                title: encryptText(`Delivery to ${address}`),
                occurredAt: new Date(),
            });
        await db()
            .insert(mailMessages)
            .values({
                id: "bob-mail",
                userId: BOB,
                addressId: mailbox?.id,
                rawHash: "f".repeat(64),
                receivedAt: new Date(),
                sizeBytes: 120,
                auth: encryptJsonField({}),
                senderVerified: true,
            });
        await db()
            .insert(mailContents)
            .values({
                itemId: "bob-mail",
                userId: BOB,
                parserVersion: 1,
                segments: encryptJsonField([
                    { role: "body", text: `Receipts go to ${address} please.` },
                ]),
            });
        await ensureRootFolders(orgId);
        const [root] = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(
                and(
                    eq(recordingFolders.userId, orgId),
                    isNull(recordingFolders.parentId),
                ),
            )
            .limit(1);
        await addRecordingToFolder({
            userId: BOB,
            recordingId: "bob-mail",
            folderId: root?.id ?? "",
        });
        const result = await searchApp(alice, "chatter", "Receipts");
        const hit = result.chatter.find((row) => row.id === "bob-mail");
        const listed = (await loadSharedMailRows(ALICE, orgId)).find(
            (row) => row.id === "bob-mail",
        );
        expect(hit?.title).toBe(listed?.filename);
        expect(hit?.title).not.toContain(secret.localPart);
        expect(hit?.snippet).toContain("Receipts");
        expect(hit?.snippet).not.toContain(secret.localPart);
        expect(
            (await searchApp(alice, "chatter", secret.localPart.slice(0, 7)))
                .chatter,
        ).toEqual([]);
        const own = await searchApp(bob, "chatter", "Receipts");
        expect(
            own.chatter.find((row) => row.id === "bob-mail")?.snippet,
        ).toContain(secret.localPart);
        expect(
            (await loadMailListRows(BOB)).find((row) => row.id === "bob-mail")
                ?.filename,
        ).toContain(secret.localPart);
    });
    it("immediately stops returning a task after its source is withdrawn", async () => {
        await db()
            .delete(recordingFolderAssignments)
            .where(
                and(
                    eq(recordingFolderAssignments.itemId, "bob-shared"),
                    eq(recordingFolderAssignments.userId, BOB),
                ),
            );
        expect((await searchTasks(alice, "shared")).hits).toEqual([]);
        expect(await getCallerTask(alice, sharedTask)).toBeNull();
    });
});
