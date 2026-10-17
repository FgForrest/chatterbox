/**
 * The Almanac names a transcription is told to expect, against a real
 * PostgreSQL: the recorder first, then what the owner's transcripts named,
 * from the owner's and the Organization's records, never another
 * account's; on the Organization view, the Organization's alone.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { almanacScopeUsage } from "@/db/queries/almanac-usage";
import {
    people,
    recordingFolderAssignments,
    recordingFolders,
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
            KNOWLEDGE_MEMORY_MB: 64,
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

import { encryptText } from "@/lib/encryption/fields";
import { itemScopeFolderIds } from "@/lib/folders/item-scope";
import { addAlias } from "@/lib/knowledge/aliases";
import { createEntity } from "@/lib/knowledge/entities";
import { knowledgeStore } from "@/lib/knowledge/knowledge-loader";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { createPerson } from "@/lib/knowledge/people";
import { seedCoreVocabulary } from "@/lib/knowledge/vocabulary";
import { ensureOrgAccount } from "@/lib/org/account";
import { almanacTermsFor } from "@/lib/transcription/almanac-terms";
import { insertRecordings } from "@/tests/integration/items";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const ALICE = "user-alice";
const BOB = "user-bob";

describeWithDatabase("Almanac terms for transcription (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    async function transcriptNaming(
        id: string,
        named: { label: string; personId: string; status?: "rejected" }[],
        userId = ALICE,
    ): Promise<void> {
        await insertRecordings(db(), {
            id,
            userId,
            deviceSn: "SN-1",
            plaudFileId: `plaud-${id}`,
            filename: encryptText("Weekly"),
            duration: 10_000,
            startTime: new Date("2026-09-01T10:00:00Z"),
            endTime: new Date("2026-09-01T10:00:10Z"),
            filesize: 11,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: `${userId}/${id}.mp3`,
            plaudVersion: "1",
        });
        const [transcript] = await db()
            .insert(transcriptions)
            .values({
                recordingId: id,
                userId,
                text: encryptText("speaker_0: Hello."),
                detectedLanguage: "cs",
                provider: "ElevenLabs",
                model: "scribe_v2+diarize",
                source: "riffado",
            })
            .returning({ id: transcriptions.id });
        for (const speaker of named) {
            await db()
                .insert(transcriptSpeakers)
                .values({
                    userId,
                    transcriptionId: transcript?.id ?? "",
                    label: speaker.label,
                    personId: speaker.personId,
                    source: "user",
                    status: speaker.status ?? "confirmed",
                });
        }
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "almanac_terms",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        knowledgeStore().invalidateAll();
        await db().delete(users);
        await db()
            .insert(users)
            .values([
                { id: ALICE, email: "alice@example.test" },
                { id: BOB, email: "bob@example.test" },
            ]);
        orgUserId = (await ensureOrgAccount()) ?? "";
        await seedCoreVocabulary();
    });

    it("puts the recorder first and what the transcripts named next, from both scopes", async () => {
        const [zora] = await db()
            .insert(people)
            .values({ userId: orgUserId, displayName: encryptText("Zora Kos") })
            .returning({ id: people.id });
        await createPerson({
            userId: ALICE,
            displayName: "Alice Malá",
            primaryEmail: "alice@example.test",
        });
        const eva = await createPerson({
            userId: ALICE,
            displayName: "Eva Svobodová",
        });
        const rejected = await createPerson({
            userId: ALICE,
            displayName: "Ada Bílá",
        });
        const orion = await createEntity(ALICE, {
            typeKey: "project",
            name: "Orion",
        });
        await addAlias(ALICE, { entityId: orion.id }, "Ori");
        await createEntity(BOB, { typeKey: "project", name: "Borealis" });
        await transcriptNaming("rec-1", [
            { label: "speaker_0", personId: eva.id },
            { label: "speaker_1", personId: zora?.id ?? "" },
            { label: "speaker_2", personId: rejected.id, status: "rejected" },
        ]);
        await transcriptNaming("rec-2", [
            { label: "speaker_0", personId: eva.id },
        ]);

        const terms = await almanacTermsFor({
            ownerUserId: ALICE,
            shared: false,
            language: "cs",
        });
        expect(terms.map((term) => term.text)).toEqual([
            "Alice Malá",
            "Eva Svobodová",
            "Zora Kos",
            "Ada Bílá",
            "Orion",
            "Ori",
        ]);

        const shared = await almanacTermsFor({
            ownerUserId: ALICE,
            shared: true,
            language: "cs",
        });
        expect(shared.map((term) => term.text)).toEqual(["Zora Kos"]);
    });

    it("sends nothing for an empty Almanac", async () => {
        expect(
            await almanacTermsFor({
                ownerUserId: ALICE,
                shared: false,
                language: null,
            }),
        ).toEqual([]);
    });

    it("ranks names used by other items in the folder scope first", async () => {
        const scoped = await createPerson({
            userId: ALICE,
            displayName: "Zora Scoped",
        });
        const accountWide = await createPerson({
            userId: ALICE,
            displayName: "Ada Account",
        });
        await transcriptNaming("rec-current", [
            { label: "speaker_0", personId: accountWide.id },
        ]);
        await transcriptNaming("rec-scoped", [
            { label: "speaker_0", personId: scoped.id },
        ]);
        await transcriptNaming("rec-outside", [
            { label: "speaker_0", personId: accountWide.id },
        ]);
        await db()
            .insert(recordingFolders)
            .values([
                {
                    id: "scope-root",
                    userId: ALICE,
                    parentId: null,
                    name: encryptText("Private"),
                    nameHash: lookupHash("Private"),
                    kind: "private",
                },
                {
                    id: "scope-parent",
                    userId: ALICE,
                    parentId: "scope-root",
                    name: encryptText("Work"),
                    nameHash: lookupHash("Work"),
                    kind: "custom",
                },
                {
                    id: "scope-child",
                    userId: ALICE,
                    parentId: "scope-parent",
                    name: encryptText("Project"),
                    nameHash: lookupHash("Project"),
                    kind: "custom",
                },
            ]);
        await db()
            .insert(recordingFolderAssignments)
            .values([
                {
                    userId: ALICE,
                    itemId: "rec-current",
                    folderId: "scope-parent",
                },
                {
                    userId: ALICE,
                    itemId: "rec-scoped",
                    folderId: "scope-child",
                },
            ]);
        const scopeFolderIds = await itemScopeFolderIds(
            "rec-current",
            "private",
            ALICE,
        );
        const scopeUsage = await almanacScopeUsage({
            ownerUserId: ALICE,
            orgUserId,
            itemId: "rec-current",
            view: "private",
            scopeFolderIds,
            recentSince: new Date("2026-01-01T00:00:00Z"),
        });

        const terms = await almanacTermsFor({
            ownerUserId: ALICE,
            shared: false,
            language: "cs",
            itemId: "rec-current",
            scopeFolderIds,
        });

        expect(terms.map((term) => term.text)).toEqual([
            "Zora Scoped",
            "Ada Account",
        ]);
        expect(scopeUsage).toMatchObject([
            { personId: scoped.id, recent: 1, total: 1 },
        ]);
    });

    it("uses all items placed in the Organization scope on its view", async () => {
        const [scoped, current] = await db()
            .insert(people)
            .values([
                {
                    userId: orgUserId,
                    displayName: encryptText("Zora Organization Scope"),
                },
                {
                    userId: orgUserId,
                    displayName: encryptText("Ada Current Item"),
                },
            ])
            .returning({ id: people.id });
        await transcriptNaming("org-current", [
            { label: "speaker_0", personId: current?.id ?? "" },
        ]);
        await transcriptNaming(
            "org-other-owner",
            [{ label: "speaker_0", personId: scoped?.id ?? "" }],
            BOB,
        );
        const orgFolders = await db()
            .select({
                id: recordingFolders.id,
                userId: recordingFolders.userId,
                parentId: recordingFolders.parentId,
            })
            .from(recordingFolders);
        const orgRoot = orgFolders.find(
            (folder) => folder.userId === orgUserId && folder.parentId === null,
        );
        expect(orgRoot).toBeDefined();
        await db()
            .insert(recordingFolders)
            .values({
                id: "org-scope-folder",
                userId: orgUserId,
                parentId: orgRoot?.id ?? "",
                name: encryptText("Customers"),
                nameHash: lookupHash("Customers"),
                kind: "custom",
            });
        await db()
            .insert(recordingFolderAssignments)
            .values([
                {
                    userId: ALICE,
                    itemId: "org-current",
                    folderId: "org-scope-folder",
                },
                {
                    userId: BOB,
                    itemId: "org-other-owner",
                    folderId: "org-scope-folder",
                },
            ]);
        const scopeFolderIds = await itemScopeFolderIds(
            "org-current",
            "org",
            ALICE,
        );

        const terms = await almanacTermsFor({
            ownerUserId: ALICE,
            shared: true,
            language: "cs",
            itemId: "org-current",
            scopeFolderIds,
        });

        expect(terms.map((term) => term.text)).toEqual([
            "Zora Organization Scope",
            "Ada Current Item",
        ]);
    });
});
