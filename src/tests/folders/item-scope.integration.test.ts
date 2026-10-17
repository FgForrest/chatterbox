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
import {
    aiEnhancements,
    chatterItems,
    mailPendingShares,
    recordingFolderAssignments,
    recordingFolders,
    users,
} from "@/db/schema";
import { encryptText } from "@/lib/encryption/fields";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
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

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({
    env: {
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        BETTER_AUTH_SECRET: "item-scope-test-secret",
        DATABASE_URL: "postgres://unused",
    },
}));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: async () => "scope-org",
}));

import { itemScopeFolderIds } from "@/lib/folders/item-scope";
import { itemScopeFingerprint } from "@/lib/pipeline/scope-fingerprint";
import { readStoredSummary } from "@/lib/summary/read-summary";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const OWNER = "scope-owner";
const OTHER = "scope-other";
const ORG = "scope-org";
const ITEM = "scope-item";

describeWithDatabase("item folder scope (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;

    function db() {
        if (!database) throw new Error("test database not ready");
        return database.db;
    }

    async function folder(
        id: string,
        userId: string,
        parentId: string | null,
        kind: "private" | "public" | "custom" = "custom",
    ) {
        await db()
            .insert(recordingFolders)
            .values({
                id,
                userId,
                parentId,
                name: encryptText(id),
                nameHash: lookupHash(id),
                kind,
            });
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "item_folder_scope",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        await db().delete(users);
        await db()
            .insert(users)
            .values([
                { id: OWNER, email: "owner@example.test" },
                { id: OTHER, email: "other@example.test" },
                { id: ORG, email: "org@example.test", role: "org" },
            ]);
        await db()
            .insert(chatterItems)
            .values({
                id: ITEM,
                userId: OWNER,
                kind: "mail",
                title: encryptText("Item"),
                occurredAt: new Date("2026-10-01T00:00:00Z"),
            });

        await folder("personal-root", OWNER, null, "private");
        await folder("personal-parent", OWNER, "personal-root");
        await folder("personal-child", OWNER, "personal-parent");
        await folder("personal-root-child", OWNER, "personal-root");
        await folder("org-root", ORG, null, "public");
        await folder("org-parent", ORG, "org-root");
        await folder("org-child", ORG, "org-parent");
        await folder("other-root", OTHER, null, "private");
        await folder("other-parent", OTHER, "other-root");
        await folder("other-child", OTHER, "other-parent");

        await db()
            .insert(recordingFolderAssignments)
            .values([
                { userId: OWNER, itemId: ITEM, folderId: "personal-root" },
                { userId: OWNER, itemId: ITEM, folderId: "personal-parent" },
                { userId: OTHER, itemId: ITEM, folderId: "other-parent" },
            ]);
        await db()
            .insert(mailPendingShares)
            .values([
                { userId: OWNER, itemId: ITEM, folderId: "org-parent" },
                { userId: OTHER, itemId: ITEM, folderId: "other-parent" },
            ]);
    });

    it("unions placements and intents with descendants, excluding roots and other users", async () => {
        expect(await itemScopeFolderIds(ITEM, "private", OWNER)).toEqual([
            "org-child",
            "org-parent",
            "personal-child",
            "personal-parent",
            "personal-root-child",
        ]);
        expect(await itemScopeFolderIds(ITEM, "org", OWNER)).toEqual([
            "org-child",
            "org-parent",
        ]);
        expect(await itemScopeFolderIds(ITEM, "private", OTHER)).toEqual([]);
    });

    it("reports a summary's scope changed after a folder moves out of its scope", async () => {
        const scopeFingerprint = await itemScopeFingerprint(
            ITEM,
            "private",
            OWNER,
        );
        await db()
            .insert(aiEnhancements)
            .values({
                itemId: ITEM,
                userId: OWNER,
                transcriptionId: null,
                summary: encryptText("Summary"),
                actionItems: [],
                keyPoints: [],
                provider: "test",
                model: "test",
                source: "riffado",
                inputs: {
                    contentId: "content-1",
                    contentRevision: 0,
                    scopeFingerprint,
                },
            });

        expect(
            (await readStoredSummary(OWNER, ITEM, "riffado"))?.scopeChanged,
        ).toBe(false);

        await db()
            .update(recordingFolders)
            .set({ parentId: "org-root" })
            .where(eq(recordingFolders.id, "org-child"));

        expect(
            (await readStoredSummary(OWNER, ITEM, "riffado"))?.scopeChanged,
        ).toBe(true);
    });
});
