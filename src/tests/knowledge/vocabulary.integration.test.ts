/**
 * The knowledge vocabulary, against a real PostgreSQL: the core seed, the
 * three layers, the deny list, and phrases suggested to the Organization.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { eq, sql } from "drizzle-orm";
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
    knowledgeEntities,
    knowledgeEntityTypes,
    knowledgeFacts,
    knowledgeRelationTypes,
    knowledgeVocabularyProposals,
    knowledgeVocabularyVersion,
    people,
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

import { decryptText, encryptText } from "@/lib/encryption/fields";
import { createEntity } from "@/lib/knowledge/entities";
import { confirmManualFact } from "@/lib/knowledge/facts";
import { readScopeGenerations } from "@/lib/knowledge/scope-generation";
import {
    adoptPhrase,
    adoptTypesForShareInTx,
    bumpVocabularyVersionInTx,
    createOrgType,
    createOwnTypeInTx,
    createPrivateType,
    deleteOwnType,
    keepAdoptedType,
    listOwnTypes,
    listVocabularyProposals,
    mapPhrase,
    mergeOwnTypes,
    proposePhrase,
    rejectPhrase,
    renameOwnType,
    seedCoreVocabulary,
    typeMergeCount,
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

    /** Until `count` sessions of the test database wait for a lock. */
    async function untilWaiting(count: number) {
        const waiting = async () => {
            const [row] = await db().execute<{ count: number }>(
                sql`select count(*)::int as count from pg_stat_activity
                    where datname = current_database() and wait_event_type = 'Lock'`,
            );
            return Number(row?.count ?? 0);
        };
        for (let i = 0; i < 200 && (await waiting()) < count; i++) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(await waiting()).toBeGreaterThanOrEqual(count);
    }

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

    it("tells the scopes using a core label the code changed", async () => {
        const [jan, pavel] = await db()
            .insert(people)
            .values([
                { userId: ALICE, displayName: encryptText("Jan") },
                { userId: ALICE, displayName: encryptText("Pavel") },
            ])
            .returning({ id: people.id });
        await confirmManualFact(ALICE, {
            subject: { personId: jan?.id ?? "" },
            relationKey: "reports_to",
            object: { personId: pavel?.id ?? "" },
        });
        const generation = async () =>
            (await readScopeGenerations(db(), [ALICE, BOB])).get(ALICE) ?? 0;
        const before = await generation();
        await seedCoreVocabulary();
        expect(await generation()).toBe(before);

        // As a code update renaming it would leave the stored row.
        await db()
            .update(knowledgeRelationTypes)
            .set({ labelHmac: "old-label" })
            .where(eq(knowledgeRelationTypes.key, "reports_to"));
        await seedCoreVocabulary();
        expect(await generation()).toBe(before + 1);
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
        // Refused once (the curator deleted its adoption): adopting the
        // name takes it all the same.
        await db()
            .update(knowledgeRelationTypes)
            .set({ adoptionRefusedAt: new Date() })
            .where(eq(knowledgeRelationTypes.key, alicesKey));
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
        const [alices] = await db()
            .select({ refused: knowledgeRelationTypes.adoptionRefusedAt })
            .from(knowledgeRelationTypes)
            .where(eq(knowledgeRelationTypes.key, alicesKey));
        expect(alices?.refused).toBeNull();
        const [adopted] = await listVocabularyProposals(orgUserId);
        expect(adopted?.status).toBe("adopted");
    });

    it("maps a suggested phrase to a relation the Organization has, for private types of that name", async () => {
        const alicesKey = await createPrivateType(ALICE, worksWith);
        await proposePhrase(ALICE, "mentors");
        const [proposal] = await listVocabularyProposals(orgUserId);
        const coaches = await createOrgType(orgUserId, {
            ...worksWith,
            label: "coaches",
        });

        // Only the organization account, only a relation the Organization
        // or the core has.
        expect(
            await refusal(mapPhrase(ALICE, proposal?.id ?? "", coaches)),
        ).toMatchObject({ statusCode: 403 });
        expect(
            await refusal(mapPhrase(orgUserId, proposal?.id ?? "", alicesKey)),
        ).toMatchObject({ statusCode: 404 });

        await mapPhrase(orgUserId, proposal?.id ?? "", coaches);

        expect(
            (await vocabularyVisibleTo(ALICE)).relationTypes.find(
                (r) => r.key === alicesKey,
            )?.adoptedAsKey,
        ).toBe(coaches);
        const [mapped] = await listVocabularyProposals(orgUserId);
        expect(mapped?.status).toBe("adopted");
        // Decided: nothing more to do with it.
        expect(
            await refusal(mapPhrase(orgUserId, proposal?.id ?? "", "leads")),
        ).toMatchObject({ statusCode: 404 });
    });

    it("adopts members' types by the phrase they suggested, whatever name the curator gives it", async () => {
        const alicesKey = await createPrivateType(ALICE, worksWith);
        const bobsKey = await createPrivateType(BOB, {
            ...worksWith,
            label: "coaches",
        });
        await proposePhrase(ALICE, "mentors");
        const [proposal] = await listVocabularyProposals(orgUserId);

        const key = await adoptPhrase(orgUserId, proposal?.id ?? "", {
            label: "coaches",
            subjectTypes: ["person"],
            objectTypes: ["person"],
            objectKind: "entity",
            cardinality: "many",
        });

        const adopted = async (user: string, own: string) =>
            (await vocabularyVisibleTo(user)).relationTypes.find(
                (r) => r.key === own,
            )?.adoptedAsKey;
        expect(await adopted(ALICE, alicesKey)).toBe(key);
        // Named like the new relation, but never suggested as it.
        expect(await adopted(BOB, bobsKey)).toBeNull();
    });

    it("rejects a suggested phrase, which members' types keep as theirs", async () => {
        const alicesKey = await createPrivateType(ALICE, worksWith);
        await proposePhrase(ALICE, "mentors");
        const [proposal] = await listVocabularyProposals(orgUserId);
        expect(
            await refusal(rejectPhrase(ALICE, proposal?.id ?? "")),
        ).toMatchObject({ statusCode: 403 });

        await rejectPhrase(orgUserId, proposal?.id ?? "");

        const [rejected] = await listVocabularyProposals(orgUserId);
        expect(rejected?.status).toBe("rejected");
        expect(
            (await vocabularyVisibleTo(ALICE)).relationTypes.find(
                (r) => r.key === alicesKey,
            )?.adoptedAsKey,
        ).toBeNull();
    });

    it("gives members their adopted type back, with their facts, when the Organization deletes it", async () => {
        const alicesKey = await createPrivateType(ALICE, worksWith);
        const person = async (userId: string, name: string) =>
            (
                await db()
                    .insert(people)
                    .values({ userId, displayName: encryptText(name) })
                    .returning({ id: people.id })
            )[0]?.id ?? "";
        const [jan, pavel, eva] = [
            await person(ALICE, "Jan"),
            await person(ALICE, "Pavel"),
            await person(ALICE, "Eva"),
        ];
        const [petr, olga] = [
            await person(BOB, "Petr"),
            await person(BOB, "Olga"),
        ];
        const mentors = (
            userId: string,
            relationKey: string,
            a: string,
            b: string,
        ) =>
            confirmManualFact(userId, {
                subject: { personId: a },
                relationKey,
                object: { personId: b },
            });
        // Before the adoption, under her own key.
        const before = await mentors(ALICE, alicesKey, jan ?? "", pavel ?? "");
        await proposePhrase(ALICE, "mentors");
        const [proposal] = await listVocabularyProposals(orgUserId);
        const key = await adoptPhrase(orgUserId, proposal?.id ?? "", {
            subjectTypes: ["person"],
            objectTypes: ["person"],
            objectKind: "entity",
            cardinality: "many",
        });
        // After it, the Organization's key: once the same, once new.
        await mentors(ALICE, alicesKey, jan ?? "", pavel ?? "");
        await mentors(ALICE, alicesKey, jan ?? "", eva ?? "");
        // Bob uses the Organization's type directly.
        await mentors(BOB, key, petr ?? "", olga ?? "");
        const factsOf = (userId: string) =>
            db()
                .select({
                    id: knowledgeFacts.id,
                    relationKey: knowledgeFacts.relationKey,
                    objectPersonId: knowledgeFacts.objectPersonId,
                })
                .from(knowledgeFacts)
                .where(eq(knowledgeFacts.userId, userId));
        expect(
            (await factsOf(ALICE)).map((fact) => fact.relationKey).sort(),
        ).toEqual([alicesKey, key, key].sort());

        await deleteOwnType(orgUserId, "relation", key, 0);

        const alices = await factsOf(ALICE);
        expect(alices).toHaveLength(2);
        expect(alices.every((fact) => fact.relationKey === alicesKey)).toBe(
            true,
        );
        expect(alices.map((fact) => fact.id)).toContain(before);
        expect(alices.map((fact) => fact.objectPersonId).sort()).toEqual(
            [pavel, eva].sort(),
        );
        expect(
            (await vocabularyVisibleTo(ALICE)).relationTypes.find(
                (r) => r.key === alicesKey,
            )?.adoptedAsKey,
        ).toBeNull();
        // The curator refused it: a share adopts hers no more.
        const [refused] = await db()
            .select({ refused: knowledgeRelationTypes.adoptionRefusedAt })
            .from(knowledgeRelationTypes)
            .where(eq(knowledgeRelationTypes.key, alicesKey));
        expect(refused?.refused).toBeInstanceOf(Date);
        expect(await factsOf(BOB)).toEqual([]);

        // The suggestion is open again: adopting it anew lifts the refusal.
        const [reopened] = await listVocabularyProposals(orgUserId);
        expect(reopened?.status).toBe("open");
        const again = await adoptPhrase(orgUserId, reopened?.id ?? "", {
            subjectTypes: ["person"],
            objectTypes: ["person"],
            objectKind: "entity",
            cardinality: "many",
        });
        const [lifted] = await db()
            .select({
                adoptedAsKey: knowledgeRelationTypes.adoptedAsKey,
                refused: knowledgeRelationTypes.adoptionRefusedAt,
                refusedAs: knowledgeRelationTypes.adoptionRefusedAs,
            })
            .from(knowledgeRelationTypes)
            .where(eq(knowledgeRelationTypes.key, alicesKey));
        expect(lifted).toEqual({
            adoptedAsKey: again,
            refused: null,
            refusedAs: null,
        });
    });

    it("keeps a member's refusal through a rename and a merge of theirs", async () => {
        const mentors = await createPrivateType(ALICE, worksWith);
        const coaches = await createOrgType(orgUserId, {
            ...worksWith,
            label: "coaches",
        });
        await db()
            .update(knowledgeRelationTypes)
            .set({ adoptedAsKey: coaches })
            .where(eq(knowledgeRelationTypes.key, mentors));
        await deleteOwnType(orgUserId, "relation", coaches, 0);
        const refusalOf = async (key: string) =>
            (
                await db()
                    .select({
                        adoptedAsKey: knowledgeRelationTypes.adoptedAsKey,
                        refused: knowledgeRelationTypes.adoptionRefusedAt,
                        refusedAs: knowledgeRelationTypes.adoptionRefusedAs,
                    })
                    .from(knowledgeRelationTypes)
                    .where(eq(knowledgeRelationTypes.key, key))
            )[0];
        const refused = await refusalOf(mentors);
        expect(refused?.refused).toBeInstanceOf(Date);
        expect(refused?.refusedAs).toEqual(expect.any(String));

        await renameOwnType(ALICE, "relation", mentors, "guides");
        expect(await refusalOf(mentors)).toEqual(refused);

        const tutors = await createPrivateType(ALICE, {
            ...worksWith,
            label: "tutors",
        });
        await mergeOwnTypes(ALICE, "relation", mentors, tutors, 0);
        expect(await refusalOf(tutors)).toEqual(refused);
    });

    it("gives a member back only the facts that fit their own type", async () => {
        const alicesKey = await createPrivateType(ALICE, worksWith);
        const [jan, pavel] = await db()
            .insert(people)
            .values([
                { userId: ALICE, displayName: encryptText("Jan") },
                { userId: ALICE, displayName: encryptText("Pavel") },
            ])
            .returning({ id: people.id });
        const before = await confirmManualFact(ALICE, {
            subject: { personId: jan?.id ?? "" },
            relationKey: alicesKey,
            object: { personId: pavel?.id ?? "" },
        });
        const orion = await createEntity(ALICE, {
            typeKey: "project",
            name: "Orion",
        });
        await proposePhrase(ALICE, "mentors");
        const [proposal] = await listVocabularyProposals(orgUserId);
        // The Organization's "mentors" is another shape: project -> text.
        const key = await adoptPhrase(orgUserId, proposal?.id ?? "", {
            subjectTypes: ["project"],
            objectTypes: [],
            objectKind: "literal",
            cardinality: "many",
        });
        await confirmManualFact(ALICE, {
            subject: { entityId: orion.id },
            relationKey: alicesKey,
            object: { literal: "the migration" },
        });

        await deleteOwnType(orgUserId, "relation", key, 0);

        const left = await db()
            .select({
                id: knowledgeFacts.id,
                relationKey: knowledgeFacts.relationKey,
            })
            .from(knowledgeFacts)
            .where(eq(knowledgeFacts.userId, ALICE));
        expect(left).toEqual([{ id: before, relationKey: alicesKey }]);
    });

    it("takes members' entities of an Organization type with it, counting only its own", async () => {
        const venue = await createOrgType(orgUserId, {
            kind: "entity",
            label: "venue",
        });
        await createEntity(orgUserId, { typeKey: venue, name: "Hall A" });
        const bobs = (
            await createEntity(BOB, { typeKey: venue, name: "Kavárna" })
        ).id;
        // Alice's own type is hers, and stays.
        const alicesType = await createPrivateType(ALICE, {
            kind: "entity",
            label: "place",
        });
        const alices = (
            await createEntity(ALICE, { typeKey: alicesType, name: "Sklep" })
        ).id;

        // The count confirmed is the Organization's own.
        expect(
            await refusal(deleteOwnType(orgUserId, "entity", venue, 2)),
        ).toMatchObject({ statusCode: 409 });
        await deleteOwnType(orgUserId, "entity", venue, 1);

        const left = await db()
            .select({ id: knowledgeEntities.id })
            .from(knowledgeEntities);
        expect(left.map((row) => row.id)).toEqual([alices]);
        expect(left.map((row) => row.id)).not.toContain(bobs);
    });

    it("lists an account's own types for it to tend, those a share adopted first, until kept or renamed", async () => {
        const venue = await createOrgType(orgUserId, {
            kind: "entity",
            label: "venue",
        });
        await createEntity(orgUserId, { typeKey: venue, name: "Hall A" });
        const fromShare = async (label: string) => {
            const key = await createOrgType(orgUserId, {
                kind: "relation",
                label,
                subjectTypes: ["person"],
                objectTypes: ["project"],
                objectKind: "entity",
                cardinality: "many",
            });
            await db()
                .update(knowledgeRelationTypes)
                .set({ adoptedFromShare: true })
                .where(eq(knowledgeRelationTypes.key, key));
            return key;
        };
        const sponsors = await fromShare("sponsors");
        const funds = await fromShare("funds");

        expect(await listOwnTypes(orgUserId)).toEqual([
            {
                kind: "relation",
                key: funds,
                label: "funds",
                adoptedFromShare: true,
                uses: 0,
                shape: {
                    subjectTypes: ["person"],
                    objectTypes: ["project"],
                    objectKind: "entity",
                    cardinality: "many",
                },
            },
            expect.objectContaining({ key: sponsors, adoptedFromShare: true }),
            {
                kind: "entity",
                key: venue,
                label: "venue",
                adoptedFromShare: false,
                uses: 1,
            },
        ]);
        // Alice sees her own only.
        expect(await listOwnTypes(ALICE)).toEqual([]);

        await keepAdoptedType(orgUserId, "relation", sponsors);
        await renameOwnType(orgUserId, "relation", funds, "finances");
        expect(
            (await listOwnTypes(orgUserId)).map((type) => [
                type.label,
                type.adoptedFromShare,
            ]),
        ).toEqual([
            ["finances", false],
            ["sponsors", false],
            ["venue", false],
        ]);
        expect(
            await refusal(keepAdoptedType(ALICE, "relation", sponsors)),
        ).toMatchObject({ statusCode: 404 });
    });

    it("merges one of an account's relation types into another, combining facts and dropping those the other does not take", async () => {
        const mentors = await createPrivateType(ALICE, {
            ...worksWith,
            objectTypes: ["person", "project"],
        });
        const coaches = await createPrivateType(ALICE, {
            ...worksWith,
            label: "coaches",
        });
        const [jan, pavel] = await db()
            .insert(people)
            .values([
                { userId: ALICE, displayName: encryptText("Jan") },
                { userId: ALICE, displayName: encryptText("Pavel") },
            ])
            .returning({ id: people.id });
        const orion = await createEntity(ALICE, {
            typeKey: "project",
            name: "Orion",
        });
        const fact = (
            relationKey: string,
            object: { personId: string } | { entityId: string },
        ) =>
            confirmManualFact(ALICE, {
                subject: { personId: jan?.id ?? "" },
                relationKey,
                object,
            });
        const kept = await fact(coaches, { personId: pavel?.id ?? "" });
        await fact(mentors, { personId: pavel?.id ?? "" });
        await fact(mentors, { entityId: orion.id });
        const version = await vocabularyVersion();

        // The count confirmed is what goes: the fact "coaches" does not take.
        expect(
            await refusal(
                mergeOwnTypes(ALICE, "relation", mentors, coaches, 0),
            ),
        ).toMatchObject({ statusCode: 409, details: { count: 1 } });
        expect(await typeMergeCount(ALICE, "relation", mentors, coaches)).toBe(
            1,
        );
        await mergeOwnTypes(ALICE, "relation", mentors, coaches, 1);

        expect(
            await db()
                .select({
                    id: knowledgeFacts.id,
                    relationKey: knowledgeFacts.relationKey,
                })
                .from(knowledgeFacts)
                .where(eq(knowledgeFacts.userId, ALICE)),
        ).toEqual([{ id: kept, relationKey: coaches }]);
        expect(
            (await vocabularyVisibleTo(ALICE)).relationTypes.map((r) => r.key),
        ).not.toContain(mentors);
        expect(await vocabularyVersion()).toBeGreaterThan(version);
    });

    it("gives the type a member merges into the adoption of the one that goes, so their facts come back to it", async () => {
        const mentors = await createPrivateType(ALICE, worksWith);
        const coaches = await createPrivateType(ALICE, {
            ...worksWith,
            label: "coaches",
        });
        await proposePhrase(ALICE, "mentors");
        const [proposal] = await listVocabularyProposals(orgUserId);
        const shared = await adoptPhrase(orgUserId, proposal?.id ?? "", {
            subjectTypes: ["person"],
            objectTypes: ["person"],
            objectKind: "entity",
            cardinality: "many",
        });
        const [jan, pavel] = await db()
            .insert(people)
            .values([
                { userId: ALICE, displayName: encryptText("Jan") },
                { userId: ALICE, displayName: encryptText("Pavel") },
            ])
            .returning({ id: people.id });
        // Stated with her type, stored under the Organization's.
        const fact = await confirmManualFact(ALICE, {
            subject: { personId: jan?.id ?? "" },
            relationKey: mentors,
            object: { personId: pavel?.id ?? "" },
        });

        await mergeOwnTypes(ALICE, "relation", mentors, coaches, 0);
        await deleteOwnType(orgUserId, "relation", shared, 0);

        expect(
            await db()
                .select({
                    id: knowledgeFacts.id,
                    relationKey: knowledgeFacts.relationKey,
                })
                .from(knowledgeFacts)
                .where(eq(knowledgeFacts.userId, ALICE)),
        ).toEqual([{ id: fact, relationKey: coaches }]);
    });

    it("takes a deleted entity type out of the relations relating it", async () => {
        const gadget = await createPrivateType(ALICE, {
            kind: "entity",
            label: "gadget",
        });
        const builds = await createPrivateType(ALICE, {
            kind: "relation",
            label: "builds",
            subjectTypes: ["organization"],
            objectTypes: [gadget, "project"],
            objectKind: "entity",
            cardinality: "many",
        });
        const tinkers = await createPrivateType(ALICE, {
            kind: "relation",
            label: "tinkers with",
            subjectTypes: ["person"],
            objectTypes: [gadget],
            objectKind: "entity",
            cardinality: "many",
        });

        await deleteOwnType(ALICE, "entity", gadget, 0);

        const relations = await db()
            .select({
                key: knowledgeRelationTypes.key,
                objectTypes: knowledgeRelationTypes.objectTypes,
            })
            .from(knowledgeRelationTypes)
            .where(eq(knowledgeRelationTypes.userId, ALICE));
        // One keeps what it still relates; one relating nothing else goes.
        expect(relations).toEqual([{ key: builds, objectTypes: ["project"] }]);
        expect(relations.map((row) => row.key)).not.toContain(tinkers);
    });

    it("keeps private what relates an entity type the curator deleted, and adopts it whole once the Organization has that type again", async () => {
        const venue = await createPrivateType(ALICE, {
            kind: "entity",
            label: "venue",
        });
        const hosts = await createPrivateType(ALICE, {
            kind: "relation",
            label: "hosts",
            subjectTypes: [venue],
            objectTypes: [],
            objectKind: "literal",
            cardinality: "many",
        });
        const hall = await createEntity(ALICE, {
            typeKey: venue,
            name: "Hall",
        });
        const adopt = () =>
            db().transaction((tx) =>
                adoptTypesForShareInTx(tx, {
                    ownerUserId: ALICE,
                    orgUserId,
                    entityIds: [hall.id],
                    relationKeys: [hosts],
                }),
            );
        const adoptions = async () => {
            const [entity] = await db()
                .select({ adoptedAsKey: knowledgeEntityTypes.adoptedAsKey })
                .from(knowledgeEntityTypes)
                .where(eq(knowledgeEntityTypes.key, venue));
            const [relation] = await db()
                .select({ adoptedAsKey: knowledgeRelationTypes.adoptedAsKey })
                .from(knowledgeRelationTypes)
                .where(eq(knowledgeRelationTypes.key, hosts));
            const [shape] = await db()
                .select({ subjectTypes: knowledgeRelationTypes.subjectTypes })
                .from(knowledgeRelationTypes)
                .where(
                    eq(
                        knowledgeRelationTypes.key,
                        relation?.adoptedAsKey ?? "",
                    ),
                );
            return {
                venue: entity?.adoptedAsKey ?? null,
                hosts: relation?.adoptedAsKey ?? null,
                hostsRelates: shape?.subjectTypes ?? null,
            };
        };
        await adopt();
        const first = await adoptions();
        expect(first.hostsRelates).toEqual([first.venue]);

        await deleteOwnType(orgUserId, "entity", first.venue ?? "", 0);
        await adopt();

        // Refused: neither the type nor the relation relating it is copied.
        expect(await adoptions()).toEqual({
            venue: null,
            hosts: null,
            hostsRelates: null,
        });

        const orgVenue = await createOrgType(orgUserId, {
            kind: "entity",
            label: "venue",
        });
        await adopt();

        const second = await adoptions();
        expect(second.venue).toBe(orgVenue);
        expect(second.hostsRelates).toEqual([orgVenue]);
    });

    it("reuses a numbered copy a share made for another member's relation of the same name and shape", async () => {
        // The members named theirs before the Organization had "supplies".
        const keys = new Map<string, string>();
        for (const member of [ALICE, BOB]) {
            keys.set(
                member,
                await createPrivateType(member, {
                    kind: "relation",
                    label: "supplies",
                    subjectTypes: ["person"],
                    objectTypes: ["project"],
                    objectKind: "entity",
                    cardinality: "many",
                }),
            );
        }
        await createOrgType(orgUserId, {
            kind: "relation",
            label: "supplies",
            subjectTypes: ["organization"],
            objectTypes: ["organization"],
            objectKind: "entity",
            cardinality: "many",
        });
        for (const [member, key] of keys) {
            await db().transaction((tx) =>
                adoptTypesForShareInTx(tx, {
                    ownerUserId: member,
                    orgUserId,
                    entityIds: [],
                    relationKeys: [key],
                }),
            );
        }
        const labels = (
            await db()
                .select({ label: knowledgeRelationTypes.label })
                .from(knowledgeRelationTypes)
                .where(eq(knowledgeRelationTypes.userId, orgUserId))
        )
            .map((row) => decryptText(row.label))
            .sort();
        expect(labels).toEqual(["supplies", "supplies (2)"]);
    });

    it("merges an Organization entity type into another: every account's entities of it, same names folded, relations and adoptions following", async () => {
        // Alice's own "venue", adopted as the Organization's.
        const alicesVenue = await createPrivateType(ALICE, {
            kind: "entity",
            label: "venue",
        });
        const venue = await createOrgType(orgUserId, {
            kind: "entity",
            label: "venue",
        });
        await db()
            .update(knowledgeEntityTypes)
            .set({ adoptedAsKey: venue })
            .where(eq(knowledgeEntityTypes.key, alicesVenue));
        const place = await createOrgType(orgUserId, {
            kind: "entity",
            label: "place",
        });
        const hosts = await createOrgType(orgUserId, {
            kind: "relation",
            label: "hosts",
            subjectTypes: [venue, place],
            objectTypes: [],
            objectKind: "literal",
            cardinality: "many",
        });
        const hallVenue = await createEntity(orgUserId, {
            typeKey: venue,
            name: "Hall A",
            description: "By the river",
        });
        const hallPlace = await createEntity(orgUserId, {
            typeKey: place,
            name: "Hall A",
        });
        const hosting = await confirmManualFact(orgUserId, {
            subject: { entityId: hallVenue.id },
            relationKey: hosts,
            object: { literal: "the kickoff" },
        });
        const kavarna = await createEntity(BOB, {
            typeKey: venue,
            name: "Kavárna",
        });
        const bobsVisits = await createPrivateType(BOB, {
            kind: "relation",
            label: "visits",
            subjectTypes: ["person"],
            objectTypes: [venue],
            objectKind: "entity",
            cardinality: "many",
        });

        // The count confirmed is the Organization's own entities folded
        // into one of the same name.
        expect(
            await refusal(mergeOwnTypes(orgUserId, "entity", venue, place, 0)),
        ).toMatchObject({ statusCode: 409, details: { count: 1 } });
        expect(await typeMergeCount(orgUserId, "entity", venue, place)).toBe(1);
        await mergeOwnTypes(orgUserId, "entity", venue, place, 1);

        const entities = await db()
            .select({
                id: knowledgeEntities.id,
                typeKey: knowledgeEntities.typeKey,
                description: knowledgeEntities.description,
                mergedIntoId: knowledgeEntities.mergedIntoId,
            })
            .from(knowledgeEntities);
        expect(entities.filter((row) => row.typeKey === venue)).toEqual([]);
        expect(
            entities.find((row) => row.id === hallVenue.id)?.mergedIntoId,
        ).toBe(hallPlace.id);
        expect(entities.find((row) => row.id === kavarna.id)).toMatchObject({
            typeKey: place,
            mergedIntoId: null,
        });
        const [hall] = await db()
            .select({ description: knowledgeEntities.description })
            .from(knowledgeEntities)
            .where(eq(knowledgeEntities.id, hallPlace.id));
        expect(decryptText(hall?.description ?? "")).toBe("By the river");
        const [fact] = await db()
            .select({ subjectEntityId: knowledgeFacts.subjectEntityId })
            .from(knowledgeFacts)
            .where(eq(knowledgeFacts.id, hosting));
        expect(fact?.subjectEntityId).toBe(hallPlace.id);
        const shapes = await db()
            .select({
                key: knowledgeRelationTypes.key,
                subjectTypes: knowledgeRelationTypes.subjectTypes,
                objectTypes: knowledgeRelationTypes.objectTypes,
            })
            .from(knowledgeRelationTypes);
        expect(shapes.find((row) => row.key === hosts)?.subjectTypes).toEqual([
            place,
        ]);
        expect(
            shapes.find((row) => row.key === bobsVisits)?.objectTypes,
        ).toEqual([place]);
        // A merge by the curator refuses nothing.
        const [alices] = await db()
            .select({
                adoptedAsKey: knowledgeEntityTypes.adoptedAsKey,
                refused: knowledgeEntityTypes.adoptionRefusedAt,
            })
            .from(knowledgeEntityTypes)
            .where(eq(knowledgeEntityTypes.key, alicesVenue));
        expect(alices).toEqual({ adoptedAsKey: place, refused: null });
        expect(
            (await vocabularyVisibleTo(orgUserId)).entityTypes.map(
                (type) => type.key,
            ),
        ).not.toContain(venue);
    });

    it("merges only into another type of the same kind the account has, or the core's", async () => {
        const gadget = await createPrivateType(ALICE, {
            kind: "entity",
            label: "gadget",
        });
        const bobs = await createPrivateType(BOB, {
            kind: "entity",
            label: "gizmo",
        });
        const orgs = await createOrgType(orgUserId, {
            kind: "entity",
            label: "device",
        });
        const coreRelation = CORE_RELATIONS[0]?.key ?? "";
        for (const into of [bobs, orgs, coreRelation, "missing"]) {
            expect(
                await refusal(mergeOwnTypes(ALICE, "entity", gadget, into, 0)),
            ).toMatchObject({ statusCode: 404 });
        }
        expect(
            await refusal(mergeOwnTypes(ALICE, "entity", gadget, gadget, 0)),
        ).toMatchObject({ statusCode: 400 });
        // Nor someone else's, nor the core's, as the one that goes.
        expect(
            await refusal(mergeOwnTypes(ALICE, "entity", bobs, gadget, 0)),
        ).toMatchObject({ statusCode: 404 });
        expect(
            await refusal(mergeOwnTypes(ALICE, "entity", "project", gadget, 0)),
        ).toMatchObject({ statusCode: 404 });

        const thing = await createEntity(ALICE, {
            typeKey: gadget,
            name: "Toaster",
        });
        // People are not entities: nothing becomes a "person" entity.
        expect(
            await refusal(mergeOwnTypes(ALICE, "entity", gadget, "person", 0)),
        ).toMatchObject({ statusCode: 400 });
        expect(
            await refusal(typeMergeCount(ALICE, "entity", gadget, "person")),
        ).toMatchObject({ statusCode: 400 });
        await mergeOwnTypes(ALICE, "entity", gadget, "project", 0);
        const [row] = await db()
            .select({ typeKey: knowledgeEntities.typeKey })
            .from(knowledgeEntities)
            .where(eq(knowledgeEntities.id, thing.id));
        expect(row?.typeKey).toBe("project");
    });

    it("rewrites a relation type made while its entity type is merged away", async () => {
        const venue = await createOrgType(orgUserId, {
            kind: "entity",
            label: "venue",
        });
        const place = await createOrgType(orgUserId, {
            kind: "entity",
            label: "place",
        });
        // Something else changing the vocabulary holds its version, so
        // Bob's new type waits for it once made, and the merge meanwhile.
        let release = () => {};
        const released = new Promise<void>((resolve) => {
            release = resolve;
        });
        const blocker = db().transaction(async (tx) => {
            await tx
                .select()
                .from(knowledgeVocabularyVersion)
                .where(eq(knowledgeVocabularyVersion.id, 1))
                .for("update");
            await released;
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        const visits = createPrivateType(BOB, {
            kind: "relation",
            label: "visits",
            subjectTypes: ["person"],
            objectTypes: [venue],
            objectKind: "entity",
            cardinality: "many",
        });
        await untilWaiting(1);
        const merge = mergeOwnTypes(orgUserId, "entity", venue, place, 0);
        await untilWaiting(2);
        release();
        await blocker;
        const key = await visits;
        await merge;

        const [row] = await db()
            .select({ objectTypes: knowledgeRelationTypes.objectTypes })
            .from(knowledgeRelationTypes)
            .where(eq(knowledgeRelationTypes.key, key));
        expect(row?.objectTypes).toEqual([place]);
    });

    it("adopts a phrase relating an entity type merged away meanwhile, deadlocking nothing", async () => {
        const [from, into] = (
            await db()
                .select({
                    id: knowledgeEntityTypes.id,
                    key: knowledgeEntityTypes.key,
                })
                .from(knowledgeEntityTypes)
                .where(
                    sql`${knowledgeEntityTypes.key} in (${await createOrgType(
                        orgUserId,
                        { kind: "entity", label: "venue" },
                    )}, ${await createOrgType(orgUserId, {
                        kind: "entity",
                        label: "place",
                    })})`,
                )
        ).sort((a, b) => (a.id < b.id ? -1 : 1));
        // Alice's own "hosts", relating the type that goes.
        await createPrivateType(ALICE, {
            kind: "relation",
            label: "hosts",
            subjectTypes: [from?.key ?? ""],
            objectTypes: [],
            objectKind: "literal",
            cardinality: "many",
        });
        await proposePhrase(ALICE, "hosts");
        const [proposal] = await listVocabularyProposals(orgUserId);
        // The merge takes the first type row and waits for the second; the
        // adoption takes Alice's "hosts" and would wait for the first.
        let release = () => {};
        const released = new Promise<void>((resolve) => {
            release = resolve;
        });
        const blocker = db().transaction(async (tx) => {
            await tx
                .select()
                .from(knowledgeEntityTypes)
                .where(eq(knowledgeEntityTypes.id, into?.id ?? ""))
                .for("update");
            await released;
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        const merge = mergeOwnTypes(
            orgUserId,
            "entity",
            from?.key ?? "",
            into?.key ?? "",
            0,
        );
        await untilWaiting(1);
        const adoption = adoptPhrase(orgUserId, proposal?.id ?? "", {
            subjectTypes: [from?.key ?? ""],
            objectTypes: [],
            objectKind: "literal",
            cardinality: "many",
        });
        await untilWaiting(2);
        release();
        await blocker;
        const outcomes = await Promise.allSettled([merge, adoption]);
        expect(
            outcomes.map((outcome) =>
                outcome.status === "rejected"
                    ? ((outcome.reason as { statusCode?: number }).statusCode ??
                      String(
                          (outcome.reason as { cause?: unknown }).cause ??
                              outcome.reason,
                      ))
                    : "done",
            ),
        ).toEqual(["done", 400]);
    }, 30_000);

    it("makes a relation type relating two types while one merges into the other, deadlocking nothing", async () => {
        const first = await createOrgType(orgUserId, {
            kind: "entity",
            label: "venue",
        });
        const second = await createOrgType(orgUserId, {
            kind: "entity",
            label: "place",
        });
        // Rewritten, the first row goes last in the table and first by id:
        // a scan meets the second first.
        await db()
            .update(knowledgeEntityTypes)
            .set({ id: "0000000000000000000" })
            .where(eq(knowledgeEntityTypes.key, first));
        // Holds the second without keeping readers off it, so the merge
        // waits there with the first taken.
        let release = () => {};
        const released = new Promise<void>((resolve) => {
            release = resolve;
        });
        const blocker = db().transaction(async (tx) => {
            await tx.execute(
                sql`select 1 from knowledge_entity_types where key = ${second} for key share`,
            );
            await released;
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        const merge = mergeOwnTypes(orgUserId, "entity", first, second, 0);
        await untilWaiting(1);
        const made = createPrivateType(BOB, {
            kind: "relation",
            label: "visits",
            subjectTypes: ["person"],
            objectTypes: [second, first],
            objectKind: "entity",
            cardinality: "many",
        });
        await untilWaiting(2);
        release();
        await blocker;
        const outcomes = await Promise.allSettled([merge, made]);
        expect(
            outcomes.map((outcome) =>
                outcome.status === "rejected"
                    ? ((outcome.reason as { statusCode?: number }).statusCode ??
                      String(
                          (outcome.reason as { cause?: unknown }).cause ??
                              outcome.reason,
                      ))
                    : "done",
            ),
        ).toEqual(["done", 400]);
    }, 30_000);

    it("creates two types in one finish while the curator renames the one the second relates, deadlocking nothing", async () => {
        const venue = await createOrgType(orgUserId, {
            kind: "entity",
            label: "venue",
        });
        let resume = () => {};
        const resumed = new Promise<void>((resolve) => {
            resume = resolve;
        });
        // As a finished review does: types one after another, the scope
        // and the vocabulary's version bumped once, last.
        const finish = db().transaction(async (tx) => {
            await createOwnTypeInTx(tx, ALICE, false, {
                kind: "entity",
                label: "stage",
            });
            await resumed;
            await createOwnTypeInTx(tx, ALICE, false, {
                kind: "relation",
                label: "plays at",
                subjectTypes: ["person"],
                objectTypes: [venue],
                objectKind: "entity",
                cardinality: "many",
            });
            await bumpVocabularyVersionInTx(tx);
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        const rename = renameOwnType(orgUserId, "entity", venue, "hall");
        // The rename either finishes or waits for the finish.
        await Promise.race([
            rename.catch(() => {}),
            new Promise((resolve) => setTimeout(resolve, 500)),
        ]);
        resume();
        const outcomes = await Promise.allSettled([finish, rename]);
        expect(
            outcomes.map((outcome) =>
                outcome.status === "rejected"
                    ? String(
                          (outcome.reason as { cause?: unknown }).cause ??
                              outcome.reason,
                      )
                    : "done",
            ),
        ).toEqual(["done", "done"]);
    }, 30_000);

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
    it("adopts a phrase while a member renames or deletes their type of that name, deadlocking nothing", async () => {
        const until = untilWaiting;
        for (const change of ["rename", "delete"] as const) {
            await db().delete(knowledgeVocabularyProposals);
            const alicesKey = await createPrivateType(ALICE, {
                ...worksWith,
                label: `coaches ${change}`,
            });
            await proposePhrase(ALICE, `coaches ${change}`);
            const [proposal] = await listVocabularyProposals(orgUserId);
            // Something else changing the vocabulary holds its version, so
            // the adoption waits for it after creating its type, and the
            // member's change takes their type meanwhile.
            let release = () => {};
            const released = new Promise<void>((resolve) => {
                release = resolve;
            });
            const blocker = db().transaction(async (tx) => {
                await tx
                    .select()
                    .from(knowledgeVocabularyVersion)
                    .where(eq(knowledgeVocabularyVersion.id, 1))
                    .for("update");
                await released;
            });
            await new Promise((resolve) => setTimeout(resolve, 50));
            const adoption = adoptPhrase(orgUserId, proposal?.id ?? "", {
                subjectTypes: ["person"],
                objectTypes: ["person"],
                objectKind: "entity",
                cardinality: "many",
            });
            await until(1);
            const members =
                change === "rename"
                    ? renameOwnType(
                          ALICE,
                          "relation",
                          alicesKey,
                          `trains ${change}`,
                      )
                    : deleteOwnType(ALICE, "relation", alicesKey, 0);
            await until(2);
            release();
            await blocker;
            const outcomes = await Promise.allSettled([adoption, members]);
            expect(
                outcomes.map((outcome) =>
                    outcome.status === "rejected"
                        ? String(
                              (outcome.reason as { cause?: unknown }).cause ??
                                  outcome.reason,
                          )
                        : "done",
                ),
            ).toEqual(["done", "done"]);
        }
    }, 30_000);
});
