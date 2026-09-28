/**
 * The knowledge vocabulary, against a real PostgreSQL: the core seed, the
 * three layers, the deny list, and phrases suggested to the Organization.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

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
    knowledgeEntityTypes,
    knowledgeRelationTypes,
    knowledgeVocabularyProposals,
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

import {
    adoptPhrase,
    createOrgType,
    createPrivateType,
    deleteOwnType,
    listVocabularyProposals,
    proposePhrase,
    renameOwnType,
    seedCoreVocabulary,
    vocabularyVersion,
    vocabularyVisibleTo,
} from "@/lib/knowledge/vocabulary";
import { CORE_RELATIONS } from "@/lib/knowledge/vocabulary-core";
import { ensureOrgAccount } from "@/lib/org/account";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const ALICE = "user-alice";
const BOB = "user-bob";

const worksWith = {
    kind: "relation" as const,
    label: "mentors",
    subjectTypes: ["person"],
    objectTypes: ["person"],
    objectKind: "entity" as const,
    cardinality: "many" as const,
};

async function refusal(promise: Promise<unknown>) {
    return promise.then(
        () => null,
        (caught: unknown) => caught as { statusCode?: number; code?: string },
    );
}

describeWithDatabase("the knowledge vocabulary (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "vocabulary",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        await db().delete(knowledgeVocabularyProposals);
        await db().delete(knowledgeRelationTypes);
        await db().delete(knowledgeEntityTypes);
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

    it("seeds the core once, and again changes nothing", async () => {
        const before = await vocabularyVersion();
        await seedCoreVocabulary();
        expect(await vocabularyVersion()).toBe(before);
        const relations = await db()
            .select({ key: knowledgeRelationTypes.key })
            .from(knowledgeRelationTypes);
        expect(relations.map((row) => row.key).sort()).toEqual(
            CORE_RELATIONS.map((relation) => relation.key).sort(),
        );
        const { relationTypes } = await vocabularyVisibleTo(ALICE);
        expect(relationTypes.find((r) => r.key === "leads")).toMatchObject({
            label: "leads",
            layer: "core",
            cardinality: "many",
        });
    });

    it("puts back a core row the code no longer matches, and says so", async () => {
        await db()
            .update(knowledgeRelationTypes)
            .set({ cardinality: "one", status: "retired" })
            .where(eq(knowledgeRelationTypes.key, "leads"));
        const before = await vocabularyVersion();

        await seedCoreVocabulary();

        expect(await vocabularyVersion()).toBe(before + 1);
        expect(
            (await vocabularyVisibleTo(ALICE)).relationTypes.find(
                (r) => r.key === "leads",
            ),
        ).toMatchObject({ cardinality: "many" });
    });

    it("keeps a private type to its owner, and out of shared runs", async () => {
        const key = await createPrivateType(ALICE, worksWith);

        const alice = await vocabularyVisibleTo(ALICE);
        expect(alice.relationTypes.find((r) => r.key === key)).toMatchObject({
            label: "mentors",
            layer: "private",
        });
        const shared = await vocabularyVisibleTo(ALICE, { sharedOnly: true });
        expect(shared.relationTypes.some((r) => r.key === key)).toBe(false);
        const bob = await vocabularyVisibleTo(BOB);
        expect(bob.relationTypes.some((r) => r.key === key)).toBe(false);
        // Stored encrypted, under a key that says nothing.
        const [row] = await db()
            .select()
            .from(knowledgeRelationTypes)
            .where(eq(knowledgeRelationTypes.key, key));
        expect(row?.label).not.toContain("mentors");
        expect(key).not.toContain("mentor");
    });

    it("refuses a label about a denied topic", async () => {
        const error = await refusal(
            createPrivateType(ALICE, { ...worksWith, label: "diagnosis of" }),
        );
        expect(error).toMatchObject({ statusCode: 400 });
    });

    it("refuses a name the owner's vocabulary already has, and core's", async () => {
        await createPrivateType(ALICE, worksWith);
        expect(
            await refusal(createPrivateType(ALICE, worksWith)),
        ).toMatchObject({ statusCode: 409 });
        expect(
            await refusal(
                createPrivateType(ALICE, { ...worksWith, label: "Leads" }),
            ),
        ).toMatchObject({ statusCode: 409 });
        // Bob's name is his own business, the same or not.
        await createPrivateType(BOB, worksWith);
    });

    it("never lets core types be renamed or deleted", async () => {
        expect(
            await refusal(renameOwnType(ALICE, "relation", "leads", "runs")),
        ).toMatchObject({ statusCode: 404 });
        expect(
            await refusal(deleteOwnType(ALICE, "relation", "leads", 0)),
        ).toMatchObject({ statusCode: 404 });
        expect(
            await refusal(
                renameOwnType(orgUserId, "relation", "leads", "runs"),
            ),
        ).toMatchObject({ statusCode: 404 });
    });

    it("renames and deletes a private type, counting what goes with it", async () => {
        const key = await createPrivateType(ALICE, worksWith);
        await renameOwnType(ALICE, "relation", key, "coaches");
        expect(
            (await vocabularyVisibleTo(ALICE)).relationTypes.find(
                (r) => r.key === key,
            )?.label,
        ).toBe("coaches");

        expect(
            await refusal(deleteOwnType(ALICE, "relation", key, 3)),
        ).toMatchObject({ statusCode: 409, details: { count: 0 } });
        await deleteOwnType(ALICE, "relation", key, 0);
        expect(
            (await vocabularyVisibleTo(ALICE)).relationTypes.some(
                (r) => r.key === key,
            ),
        ).toBe(false);
    });

    it("lets only the organization account make Organization types", async () => {
        expect(await refusal(createOrgType(ALICE, worksWith))).toMatchObject({
            statusCode: 403,
        });
        expect(
            await refusal(createPrivateType(orgUserId, worksWith)),
        ).toMatchObject({ statusCode: 403 });
        const key = await createOrgType(orgUserId, worksWith);
        expect(
            (
                await vocabularyVisibleTo(BOB, { sharedOnly: true })
            ).relationTypes.find((r) => r.key === key),
        ).toMatchObject({ layer: "org", label: "mentors" });
    });

    it("counts a suggested phrase once per user, and adopts it for private types of that name", async () => {
        const alicesKey = await createPrivateType(ALICE, worksWith);
        await proposePhrase(ALICE, "mentors");
        await proposePhrase(ALICE, "  Mentors ");
        await proposePhrase(BOB, "mentors");
        expect(await refusal(listVocabularyProposals(ALICE))).toMatchObject({
            statusCode: 403,
        });
        const [proposal] = await listVocabularyProposals(orgUserId);
        expect(proposal).toMatchObject({
            phrase: "mentors",
            count: 2,
            status: "open",
        });

        const key = await adoptPhrase(orgUserId, proposal?.id ?? "", {
            subjectTypes: ["person"],
            objectTypes: ["person"],
            objectKind: "entity",
            cardinality: "many",
        });

        expect(
            (await vocabularyVisibleTo(ALICE)).relationTypes.find(
                (r) => r.key === alicesKey,
            )?.adoptedAsKey,
        ).toBe(key);
        const [adopted] = await listVocabularyProposals(orgUserId);
        expect(adopted?.status).toBe("adopted");
    });

    it("stops counting a suggestion when its account goes, and drops it with the last", async () => {
        await proposePhrase(ALICE, "mentors");
        await proposePhrase(BOB, "mentors");

        await db().delete(users).where(eq(users.id, BOB));
        expect(await listVocabularyProposals(orgUserId)).toMatchObject([
            { phrase: "mentors", count: 1 },
        ]);

        await db().delete(users).where(eq(users.id, ALICE));
        expect(await listVocabularyProposals(orgUserId)).toEqual([]);
    });
});
