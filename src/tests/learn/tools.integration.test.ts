/**
 * The tools a Learn run reads knowledge through, against a real PostgreSQL:
 * only the run's scopes (the owner's and the Organization's on a private
 * recording, the Organization's alone on a shared one), found by words and
 * never anything of another account's, within the run's budget.
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
import { createEntity, describeEntity } from "@/lib/knowledge/entities";
import { confirmManualFact } from "@/lib/knowledge/facts";
import { knowledgeStore } from "@/lib/knowledge/knowledge-loader";
import { seedCoreVocabulary } from "@/lib/knowledge/vocabulary";
import {
    findEntities,
    findFacts,
    getEntity,
    LearnToolBudgetExhausted,
    type LearnToolContext,
} from "@/lib/learn/tools";
import { ensureOrgAccount } from "@/lib/org/account";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const ALICE = "user-alice";
const BOB = "user-bob";

describeWithDatabase("Learn tools (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";
    let orgJan = "";
    let orion = "";
    let bobsOrion = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "learn_tools",
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
        bobsOrion = (
            await createEntity(BOB, { typeKey: "project", name: "Orion" })
        ).id;
        await addAlias(ALICE, { personId: orgJan }, "Honza");
        await describeEntity(ALICE, orion, "CRM migration");
        await confirmManualFact(ALICE, {
            subject: { personId: orgJan },
            relationKey: "leads",
            object: { entityId: orion },
        });
    });

    const alicesRun = (shared = false, calls = 20): LearnToolContext => ({
        read: { kind: "recording", ownerUserId: ALICE, shared },
        budget: { remaining: calls },
    });

    it("finds what the run may read by its words, and nothing of anyone else's", async () => {
        const found = await findEntities(alicesRun(), { text: "Orijon" });
        expect(found.entities.map((entity) => entity.id)).toEqual([orion]);
        expect(found.entities[0]).toMatchObject({
            kind: "entity",
            typeKey: "project",
            name: "Orion",
            scope: "personal",
            reasons: [expect.any(String)],
        });
        const byAlias = await findEntities(alicesRun(), {
            text: "Honza",
            type: "person",
        });
        expect(byAlias.entities.map((entity) => entity.id)).toEqual([orgJan]);
        expect(
            (await findEntities(alicesRun(), { text: "Orion", type: "person" }))
                .entities,
        ).toEqual([]);
    });

    it("reads one item and the facts about it, and answers another account's as nothing", async () => {
        expect(await getEntity(alicesRun(), orion)).toMatchObject({
            id: orion,
            name: "Orion",
            description: "CRM migration",
        });
        expect(await getEntity(alicesRun(), bobsOrion)).toBeNull();
        expect(await findFacts(alicesRun(), orion)).toEqual([
            {
                subject: { personId: orgJan, name: "Jan Novotný" },
                relationKey: "leads",
                object: { entityId: orion, name: "Orion" },
                scope: "personal",
            },
        ]);
        expect(await findFacts(alicesRun(), bobsOrion)).toEqual([]);
    });

    it("reads only the Organization's on a shared recording", async () => {
        const shared = alicesRun(true);
        expect(
            (await findEntities(shared, { text: "Orion" })).entities,
        ).toEqual([]);
        expect(
            (await findEntities(shared, { text: "Honza" })).entities,
        ).toEqual([]);
        expect(
            (await findEntities(shared, { text: "Jan Novotny" })).entities.map(
                (entity) => entity.id,
            ),
        ).toEqual([orgJan]);
        expect(await getEntity(shared, orion)).toBeNull();
        expect(await findFacts(shared, orgJan)).toEqual([]);
    });

    it("stops a run that spent its calls", async () => {
        const run = alicesRun(false, 2);
        await findEntities(run, { text: "Orion" });
        await getEntity(run, orion);
        await expect(findFacts(run, orion)).rejects.toBeInstanceOf(
            LearnToolBudgetExhausted,
        );
    });
});
