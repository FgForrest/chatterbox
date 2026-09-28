/**
 * What one account's private knowledge reveals to another, against a real
 * PostgreSQL: nothing. User B must learn nothing about A's private layer
 * through ids, lists, search, counts, vocabulary, vectors or review items,
 * nor through merge targets, uniqueness errors or error messages.
 *
 * Grows with every knowledge table (plan, Phase 2 conventions).
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
    createPrivateType,
    deleteOwnType,
    listVocabularyProposals,
    proposePhrase,
    renameOwnType,
    seedCoreVocabulary,
    vocabularyVisibleTo,
} from "@/lib/knowledge/vocabulary";
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

describeWithDatabase("private knowledge stays private (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "leakage",
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

    describe("vocabulary", () => {
        it("lists no other account's private types, to anyone", async () => {
            const key = await createPrivateType(ALICE, worksWith);
            for (const viewer of [BOB, orgUserId]) {
                const { relationTypes } = await vocabularyVisibleTo(viewer);
                expect(relationTypes.some((r) => r.key === key)).toBe(false);
                expect(relationTypes.some((r) => r.label === "mentors")).toBe(
                    false,
                );
            }
        });

        it("answers a change to another account's type as to a missing one", async () => {
            const key = await createPrivateType(ALICE, worksWith);
            const missing = await refusal(
                renameOwnType(BOB, "relation", "u_missing", "x"),
            );
            for (const attempt of [
                () => renameOwnType(BOB, "relation", key, "x"),
                () => deleteOwnType(BOB, "relation", key, 0),
                () => renameOwnType(orgUserId, "relation", key, "x"),
            ]) {
                const error = await refusal(attempt());
                expect(error).toMatchObject({
                    statusCode: (missing as { statusCode?: number }).statusCode,
                    code: (missing as { code?: string }).code,
                });
                expect((error as Error).message).toBe(
                    (missing as Error).message,
                );
            }
        });

        it("never refuses a name because another account uses it", async () => {
            await createPrivateType(ALICE, worksWith);
            await expect(createPrivateType(BOB, worksWith)).resolves.toMatch(
                /^u_/,
            );
        });

        it("shows suggested phrases only to the organization account, without who suggested them", async () => {
            await proposePhrase(ALICE, "mentors");
            expect(await refusal(listVocabularyProposals(BOB))).toMatchObject({
                statusCode: 403,
            });
            const proposals = await listVocabularyProposals(orgUserId);
            expect(proposals).toHaveLength(1);
            expect(JSON.stringify(proposals)).not.toContain(ALICE);
        });
    });
});
