/**
 * The knowledge a reader gets from memory, against a real PostgreSQL: the
 * Organization's and their own, only the Organization's on a shared run,
 * never another account's, and fresh after any change, an erasure above
 * all.
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
import { people, users } from "@/db/schema";
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
import { addAlias } from "@/lib/knowledge/aliases";
import {
    createEntity,
    deleteEntity,
    describeEntity,
    renameEntity,
} from "@/lib/knowledge/entities";
import { confirmManualFact } from "@/lib/knowledge/facts";
import {
    findByName,
    knowledgeStore,
    knowledgeView,
} from "@/lib/knowledge/knowledge-loader";
import { deletePerson } from "@/lib/knowledge/people";
import { seedCoreVocabulary } from "@/lib/knowledge/vocabulary";
import { ensureOrgAccount } from "@/lib/org/account";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const ALICE = "user-alice";
const BOB = "user-bob";

const pages = (viewerUserId: string) => ({
    kind: "pages" as const,
    viewerUserId,
});

describeWithDatabase("the knowledge view (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";
    let orgJan = "";
    let orion = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "knowledge_view",
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
        const [jan] = await db()
            .insert(people)
            .values({
                userId: orgUserId,
                displayName: encryptText("Jan Novotný"),
            })
            .returning({ id: people.id });
        orgJan = jan?.id ?? "";
        orion = (
            await createEntity(ALICE, { typeKey: "project", name: "Orion" })
        ).id;
        await addAlias(ALICE, { personId: orgJan }, "Honza");
        await describeEntity(ALICE, orion, "CRM migration");
        await confirmManualFact(ALICE, {
            subject: { personId: orgJan },
            relationKey: "leads",
            object: { entityId: orion },
        });
    });

    it("gives a reader the Organization's and their own, and a shared run the Organization's", async () => {
        const alice = await knowledgeView(pages(ALICE));
        expect(
            alice.items.map((item) => [item.name, item.scope]).sort(),
        ).toEqual([
            ["Jan Novotný", "org"],
            ["Orion", "personal"],
        ]);
        expect(
            alice.items
                .find((item) => item.id === orgJan)
                ?.names.map((n) => n.text),
        ).toEqual(["Honza"]);
        expect(alice.facts).toHaveLength(1);
        expect(findByName(alice, "Honzou")[0]).toMatchObject({
            id: orgJan,
            reason: "trigram",
        });

        const shared = await knowledgeView({
            kind: "recording",
            ownerUserId: ALICE,
            shared: true,
        });
        expect(shared.items.map((item) => item.name)).toEqual(["Jan Novotný"]);
        expect(shared.items[0]?.names).toEqual([]);
        expect(shared.facts).toEqual([]);

        const bob = await knowledgeView(pages(BOB));
        expect(bob.items.map((item) => item.name)).toEqual(["Jan Novotný"]);
        expect(bob.facts).toEqual([]);
    });

    it("shows a change on the next read, and forgets what was erased", async () => {
        await knowledgeView(pages(ALICE));
        await renameEntity(ALICE, orion, "Orion CRM");
        expect(
            (await knowledgeView(pages(ALICE))).items
                .map((item) => item.name)
                .sort(),
        ).toEqual(["Jan Novotný", "Orion CRM"]);

        await deletePerson(orgUserId, orgJan);
        const after = await knowledgeView(pages(ALICE));
        expect(after.items.map((item) => item.name)).toEqual(["Orion CRM"]);
        expect(after.facts).toEqual([]);
        expect(JSON.stringify(after)).not.toContain("Honza");

        await deleteEntity(ALICE, orion);
        expect((await knowledgeView(pages(ALICE))).items).toEqual([]);
    });

    it("reads from memory while nothing changed", async () => {
        await knowledgeView(pages(ALICE));
        const before = knowledgeStore().stats();
        await knowledgeView(pages(ALICE));
        const after = knowledgeStore().stats();
        expect(after.loads).toBe(before.loads);
        expect(after.hits).toBe(before.hits + 2);
    });
});
