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
    createOrgType,
    createPrivateType,
    deleteOwnType,
    keepAdoptedType,
    listOwnTypes,
    listVocabularyProposals,
    mergeOwnTypes,
    proposePhrase,
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
        expect(await factsOf(BOB)).toEqual([]);
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
        const [alices] = await db()
            .select({ adoptedAsKey: knowledgeEntityTypes.adoptedAsKey })
            .from(knowledgeEntityTypes)
            .where(eq(knowledgeEntityTypes.key, alicesVenue));
        expect(alices?.adoptedAsKey).toBe(place);
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
