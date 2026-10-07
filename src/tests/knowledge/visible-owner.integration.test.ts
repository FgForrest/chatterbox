/**
 * Who sees which knowledge rows, against a real PostgreSQL: a member their
 * own and the Organization's, never another member's; the organization
 * account the Organization's alone; and a member of an instance with no
 * organization account their own.
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
import { users } from "@/db/schema";
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

import { addAlias, aliasTextsVisibleTo } from "@/lib/knowledge/aliases";
import { createEntity, listEntities } from "@/lib/knowledge/entities";
import { confirmManualFact, listFacts } from "@/lib/knowledge/facts";
import {
    createPerson,
    findPersonByEmail,
    getPerson,
    listPeople,
} from "@/lib/knowledge/people";
import { seedCoreVocabulary } from "@/lib/knowledge/vocabulary";
import { ensureOrgAccount } from "@/lib/org/account";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const ALICE = "user-alice";
const BOB = "user-bob";

describeWithDatabase(
    "what each account sees of the knowledge base (PostgreSQL)",
    () => {
        let database: TestPostgresDatabase | null = null;
        let orgUserId = "";
        let alicePerson = "";
        let bobPerson = "";
        let orgPerson = "";

        function db() {
            if (!database) throw new Error("test database was not initialized");
            return database.db;
        }

        beforeAll(async () => {
            database = await createMigratedTestDatabase(
                testDatabaseUrl ?? "",
                "visible_owner",
            );
            dbRef.current = database.db as unknown as Record<
                PropertyKey,
                unknown
            >;
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
                    { id: ALICE, email: "alice@example.test" },
                    { id: BOB, email: "bob@example.test" },
                ]);
            orgUserId = (await ensureOrgAccount()) ?? "";
            await seedCoreVocabulary();
            alicePerson = (
                await createPerson({
                    userId: ALICE,
                    displayName: "Jan Novotný",
                    primaryEmail: "jan@example.test",
                })
            ).id;
            bobPerson = (
                await createPerson({
                    userId: BOB,
                    displayName: "Petra Malá",
                    primaryEmail: "petra@example.test",
                })
            ).id;
            orgPerson = (
                await createPerson({
                    userId: orgUserId,
                    displayName: "Eva Dvořáková",
                    primaryEmail: "eva@example.test",
                })
            ).id;
        });

        const names = (
            rows: readonly { displayName?: string; name?: string }[],
        ) => rows.map((row) => row.displayName ?? row.name).sort();

        it("shows a member their own people and the Organization's, never another member's", async () => {
            expect(names(await listPeople(ALICE))).toEqual([
                "Eva Dvořáková",
                "Jan Novotný",
            ]);
            expect(names(await listPeople(BOB))).toEqual([
                "Eva Dvořáková",
                "Petra Malá",
            ]);
            expect(names(await listPeople(orgUserId))).toEqual([
                "Eva Dvořáková",
            ]);

            expect(
                (await findPersonByEmail(ALICE, "jan@example.test"))?.id,
            ).toBe(alicePerson);
            expect(
                (await findPersonByEmail(ALICE, "eva@example.test"))?.id,
            ).toBe(orgPerson);
            expect(
                await findPersonByEmail(ALICE, "petra@example.test"),
            ).toBeNull();
            expect(await getPerson(ALICE, bobPerson)).toBeNull();
            expect((await getPerson(ALICE, orgPerson))?.scope).toBe("org");
        });

        it("shows a member the names they and the Organization gave, never another member's", async () => {
            await addAlias(ALICE, { personId: orgPerson }, "Evička");
            await addAlias(BOB, { personId: orgPerson }, "Dvořáková E.");
            await addAlias(orgUserId, { personId: orgPerson }, "ED");
            await addAlias(BOB, { personId: bobPerson }, "Péťa");

            const alice = await aliasTextsVisibleTo(ALICE, "person");
            expect(alice.get(orgPerson)?.sort()).toEqual(["ED", "Evička"]);
            expect(alice.has(bobPerson)).toBe(false);
            const organization = await aliasTextsVisibleTo(orgUserId, "person");
            expect(organization.get(orgPerson)).toEqual(["ED"]);
        });

        it("shows a member their own entities and facts and the Organization's, never another member's", async () => {
            await createEntity(ALICE, { typeKey: "project", name: "Orion" });
            await createEntity(BOB, { typeKey: "project", name: "Vega" });
            await createEntity(orgUserId, {
                typeKey: "project",
                name: "Atlas",
            });
            expect(names(await listEntities(ALICE))).toEqual([
                "Atlas",
                "Orion",
            ]);
            expect(names(await listEntities(orgUserId))).toEqual(["Atlas"]);

            for (const [actor, role] of [
                [ALICE, "ředitelka"],
                [BOB, "vedoucí"],
                [orgUserId, "CTO"],
            ] as const) {
                await confirmManualFact(actor, {
                    subject: { personId: orgPerson },
                    relationKey: "has_role",
                    object: { literal: role },
                });
            }
            const said = (facts: Awaited<ReturnType<typeof listFacts>>) =>
                facts
                    .map((fact) =>
                        "literal" in fact.object ? fact.object.literal : "",
                    )
                    .sort();
            expect(
                said(await listFacts(ALICE, { personId: orgPerson })),
            ).toEqual(["CTO", "ředitelka"]);
            expect(
                said(await listFacts(orgUserId, { personId: orgPerson })),
            ).toEqual(["CTO"]);
        });

        it("shows a member their own alone where there is no organization account", async () => {
            await db().delete(users).where(eq(users.id, orgUserId));
            expect(names(await listPeople(ALICE))).toEqual(["Jan Novotný"]);
            expect(
                await findPersonByEmail(ALICE, "petra@example.test"),
            ).toBeNull();
            expect(
                (await findPersonByEmail(ALICE, "jan@example.test"))?.id,
            ).toBe(alicePerson);
        });
    },
);
