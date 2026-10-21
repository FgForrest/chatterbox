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
import { DELETE as deleteAlias } from "@/app/api/knowledge/aliases/[id]/route";
import { POST as addAlias } from "@/app/api/knowledge/aliases/route";
import {
    DELETE as eraseEntity,
    POST as mergeEntity,
    PATCH as renameEntity,
} from "@/app/api/knowledge/entities/[id]/route";
import { POST as addEntity } from "@/app/api/knowledge/entities/route";
import {
    PUT as changeFact,
    DELETE as eraseFact,
} from "@/app/api/knowledge/facts/[id]/route";
import { POST as addFact } from "@/app/api/knowledge/facts/route";
import { POST as importNames } from "@/app/api/knowledge/import/route";
import { POST as decidePhrase } from "@/app/api/knowledge/proposals/[id]/route";
import {
    DELETE as eraseType,
    POST as mergeType,
    PATCH as renameType,
} from "@/app/api/knowledge/types/[kind]/[key]/route";
import {
    DELETE as erasePerson,
    POST as mergePerson,
    PATCH as renamePerson,
} from "@/app/api/people/[id]/route";
import { POST as addPerson } from "@/app/api/people/route";
import {
    knowledgeAliases,
    knowledgeEntities,
    knowledgeEntityTypes,
    knowledgeFacts,
    knowledgeRelationTypes,
    people,
    recordingTasks,
    transcriptions,
    transcriptSpeakers,
    userAccessStates,
    users,
} from "@/db/schema";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { createEntity, getEntity } from "@/lib/knowledge/entities";
import { createPerson, getPerson } from "@/lib/knowledge/people";
import {
    createOrgType,
    createPrivateType,
    listOwnTypes,
    listVocabularyProposals,
    proposePhrase,
    seedCoreVocabulary,
    typeMergeCount,
} from "@/lib/knowledge/vocabulary";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";
import { insertRecording } from "@/tests/mcp/fixtures";

const { dbRef, dbProxy, mockEnv } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    return {
        dbRef: ref,
        dbProxy: new Proxy(
            {},
            {
                get: (_target, key) => {
                    const value = ref.current?.[key];
                    return typeof value === "function"
                        ? value.bind(ref.current)
                        : value;
                },
            },
        ),
        mockEnv: {
            IS_HOSTED: false,
            SELF_HOST_MODE: "shared",
            ORG_ACCOUNT_EMAIL: "org@example.test",
            ORG_ACCOUNT_PASSWORD: undefined as string | undefined,
            OIDC_ISSUER_URL: "https://identity.example.test/realms/test",
            OIDC_CLIENT_ID: "chatterbox",
            OIDC_CLIENT_SECRET: "test-secret",
            AUTHZ_MODE: "idp" as "idp" | "local",
            AUTHZ_VERIFICATION_MAX_AGE: 1800,
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            DATABASE_URL: "postgres://unused",
        },
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async (request: Request) => ({
        user: {
            id: request.headers.get("x-test-user") ?? "member",
            email: "curator@example.test",
        },
    }),
}));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));

type Handler = (
    request: Request,
    context: { params: Promise<Record<string, string>> },
) => Promise<Response>;

async function call(
    handler: unknown,
    user: string,
    method: string,
    body?: unknown,
    params: Record<string, string> = {},
) {
    return (handler as Handler)(
        new Request("http://localhost/api/test", {
            method,
            headers: {
                "x-test-user": user,
                "content-type": "application/json",
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        }),
        { params: Promise.resolve(params) },
    );
}

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

describeWithDatabase("Organization curators manage the Almanac", () => {
    let database: TestPostgresDatabase;
    const db = () => database.db;

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "curator_almanac",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);
    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);
    beforeEach(async () => {
        mockEnv.AUTHZ_MODE = "idp";
        mockEnv.ORG_ACCOUNT_PASSWORD = undefined;
        await db().delete(users);
        await db()
            .insert(users)
            .values([
                { id: "org", email: "org@example.test", role: "org" },
                { id: "curator", email: "curator@example.test" },
                { id: "member", email: "member@example.test" },
                { id: "other", email: "other@example.test" },
            ]);
        await db()
            .insert(userAccessStates)
            .values(
                ["curator", "member", "other"].map((userId) => ({
                    userId,
                    issuer: mockEnv.OIDC_ISSUER_URL,
                    subject: userId,
                    capabilities:
                        userId === "curator" ? ["use", "org.curate"] : ["use"],
                    verifiedAt: new Date(),
                    source: "login" as const,
                })),
            );
        await seedCoreVocabulary();
    });

    it("renames, merges and erases Organization people, moving tasks and speakers", async () => {
        const keep = await createPerson({
            userId: "org",
            displayName: "Karel Vondra",
            createdByUserId: "member",
        });
        const lose = await createPerson({
            userId: "org",
            displayName: "Karel Vondra",
        });
        await insertRecording(db(), { id: "rec", userId: "other" });
        const [transcript] = await db()
            .insert(transcriptions)
            .values({
                recordingId: "rec",
                userId: "other",
                text: encryptText("Hello"),
                provider: "test",
                model: "test",
                source: "riffado",
            })
            .returning();
        await db().insert(transcriptSpeakers).values({
            userId: "other",
            transcriptionId: transcript.id,
            label: "speaker_0",
            personId: lose.id,
            source: "user",
            status: "confirmed",
        });
        await db()
            .insert(recordingTasks)
            .values({
                userId: "other",
                itemId: "rec",
                status: "open",
                source: "manual",
                text: encryptText("Send notes"),
                assigneePersonId: lose.id,
            });
        expect(
            (
                await call(
                    renamePerson,
                    "curator",
                    "PATCH",
                    {
                        displayName: "Karel",
                        primaryEmail: "karel@example.test",
                    },
                    { id: keep.id },
                )
            ).status,
        ).toBe(200);
        expect(await getPerson("member", keep.id)).toMatchObject({
            displayName: "Karel",
            primaryEmail: "karel@example.test",
            scope: "org",
        });
        expect(
            (
                await call(
                    mergePerson,
                    "curator",
                    "POST",
                    { mergeIntoId: keep.id },
                    { id: lose.id },
                )
            ).status,
        ).toBe(200);
        expect(
            (await db().select().from(transcriptSpeakers))[0]?.personId,
        ).toBe(keep.id);
        expect(
            (await db().select().from(recordingTasks))[0]?.assigneePersonId,
        ).toBe(keep.id);
        expect(await getPerson("member", lose.id)).toMatchObject({
            mergedIntoId: keep.id,
        });
        expect(
            (await db().select().from(people).where(eq(people.id, keep.id)))[0],
        ).toMatchObject({ userId: "org", createdByUserId: "member" });
        expect(
            (
                await call(erasePerson, "curator", "DELETE", undefined, {
                    id: keep.id,
                })
            ).status,
        ).toBe(200);
        expect(await db().select().from(people)).toEqual([]);
        expect(
            (await db().select().from(transcriptSpeakers))[0]?.personId,
        ).toBeNull();
        expect(
            (await db().select().from(recordingTasks))[0]?.assigneePersonId,
        ).toBeNull();
    });

    it("refuses members and other people's private entries, preserving private merge rules", async () => {
        const shared = await createPerson({
            userId: "org",
            displayName: "Shared",
        });
        const privatePerson = await createPerson({
            userId: "other",
            displayName: "Private",
        });
        const sharedTarget = await createPerson({
            userId: "org",
            displayName: "Target",
        });
        const own = await createPerson({
            userId: "curator",
            displayName: "Own",
        });
        for (const [handler, method, body] of [
            [renamePerson, "PATCH", { displayName: "Changed" }],
            [mergePerson, "POST", { mergeIntoId: sharedTarget.id }],
            [erasePerson, "DELETE", undefined],
        ] as const) {
            expect(
                (await call(handler, "member", method, body, { id: shared.id }))
                    .status,
            ).toBe(403);
            expect(
                (
                    await call(handler, "curator", method, body, {
                        id: privatePerson.id,
                    })
                ).status,
            ).toBe(404);
        }
        expect(
            (
                await call(
                    mergePerson,
                    "curator",
                    "POST",
                    { mergeIntoId: own.id },
                    { id: shared.id },
                )
            ).status,
        ).toBe(403);
        expect(
            (
                await call(
                    mergePerson,
                    "curator",
                    "POST",
                    { mergeIntoId: shared.id },
                    { id: own.id },
                )
            ).status,
        ).toBe(200);
        await db()
            .update(userAccessStates)
            .set({ capabilities: ["use"] })
            .where(eq(userAccessStates.userId, "curator"));
        expect(
            (
                await call(
                    renamePerson,
                    "curator",
                    "PATCH",
                    { displayName: "Late" },
                    { id: shared.id },
                )
            ).status,
        ).toBe(403);
    });

    it("renames, describes, merges and erases existing Organization things as the curator", async () => {
        const create = async (name: string) => {
            const entity = await createEntity("org", {
                typeKey: "project",
                name,
            });
            return entity.id;
        };
        const keep = await create("Orion");
        const lose = await create("Orion duplicate");
        expect(
            (
                await call(
                    renameEntity,
                    "member",
                    "PATCH",
                    { name: "Changed" },
                    { id: keep },
                )
            ).status,
        ).toBe(403);
        expect(
            (
                await call(eraseEntity, "member", "DELETE", undefined, {
                    id: keep,
                })
            ).status,
        ).toBe(403);
        expect(
            (
                await call(
                    mergeEntity,
                    "member",
                    "POST",
                    { mergeIntoId: keep },
                    { id: lose },
                )
            ).status,
        ).toBe(403);
        expect(
            (
                await call(
                    renameEntity,
                    "curator",
                    "PATCH",
                    {
                        name: "Orion project",
                        description: "Shared description",
                    },
                    { id: keep },
                )
            ).status,
        ).toBe(200);
        const [row] = await db()
            .select()
            .from(knowledgeEntities)
            .where(eq(knowledgeEntities.id, keep));
        expect(row).toMatchObject({
            userId: "org",
            createdByUserId: "org",
        });
        expect(decryptText(row.description ?? "")).toBe("Shared description");
        expect(
            (
                await call(
                    mergeEntity,
                    "curator",
                    "POST",
                    { mergeIntoId: keep },
                    { id: lose },
                )
            ).status,
        ).toBe(200);
        expect(
            (
                await call(eraseEntity, "curator", "DELETE", undefined, {
                    id: keep,
                })
            ).status,
        ).toBe(200);
        expect(await db().select().from(knowledgeEntities)).toEqual([]);
    });

    it("refuses a curator access to another member's private things and Organization merges into private things", async () => {
        const shared = await createEntity("org", {
            typeKey: "project",
            name: "Orion",
        });
        const other = await createEntity("other", {
            typeKey: "project",
            name: "Private Orion",
        });
        const own = await createEntity("curator", {
            typeKey: "project",
            name: "My Orion",
        });
        for (const [handler, method, body] of [
            [renameEntity, "PATCH", { name: "Changed" }],
            [mergeEntity, "POST", { mergeIntoId: shared.id }],
            [eraseEntity, "DELETE", undefined],
        ] as const) {
            expect(
                (
                    await call(handler, "curator", method, body, {
                        id: other.id,
                    })
                ).status,
            ).toBe(404);
        }
        expect(await getEntity("other", other.id)).toMatchObject({
            name: "Private Orion",
            mergedIntoId: null,
            scope: "personal",
        });
        expect(
            (
                await call(
                    mergeEntity,
                    "curator",
                    "POST",
                    { mergeIntoId: own.id },
                    { id: shared.id },
                )
            ).status,
        ).toBe(403);
        expect(await getEntity("member", shared.id)).toMatchObject({
            name: "Orion",
            mergedIntoId: null,
            scope: "org",
        });
        expect(
            (
                await call(
                    mergeEntity,
                    "curator",
                    "POST",
                    { mergeIntoId: shared.id },
                    { id: own.id },
                )
            ).status,
        ).toBe(200);
        expect(await getEntity("curator", own.id)).toMatchObject({
            mergedIntoId: shared.id,
        });
    });

    it("adds a private thing with nicknames using the curator's private vocabulary", async () => {
        const typeKey = await createPrivateType("curator", {
            kind: "entity",
            label: "Private initiative",
        });
        expect(
            (
                await db()
                    .select()
                    .from(knowledgeEntityTypes)
                    .where(eq(knowledgeEntityTypes.key, typeKey))
            )[0],
        ).toMatchObject({ userId: "curator", createdByUserId: "curator" });
        const response = await call(addEntity, "curator", "POST", {
            typeKey,
            name: "Private Orion",
            nicknames: ["My Orion"],
        });
        expect(response.status).toBe(201);
        const { entity } = (await response.json()) as {
            entity: { id: string; scope: string };
        };
        expect(entity.scope).toBe("personal");
        expect((await db().select().from(knowledgeEntities))[0]).toMatchObject({
            userId: "curator",
            createdByUserId: "curator",
            typeKey,
        });
        expect((await db().select().from(knowledgeAliases))[0]).toMatchObject({
            userId: "curator",
            createdByUserId: "curator",
            entityId: entity.id,
        });
        expect(await getEntity("member", entity.id)).toBeNull();
    });

    it.each([
        "entity",
        "relation",
    ] as const)("manages Organization %s vocabulary with Organization counts and ownership", async (kind) => {
        const key = await createOrgType(
            "curator",
            kind === "entity"
                ? { kind, label: "Initiative" }
                : {
                      kind,
                      label: "Coordinates",
                      subjectTypes: ["person"],
                      objectTypes: ["project"],
                      objectKind: "entity",
                      cardinality: "many",
                  },
        );
        const table =
            kind === "entity" ? knowledgeEntityTypes : knowledgeRelationTypes;
        expect(
            (await db().select().from(table).where(eq(table.key, key)))[0],
        ).toMatchObject({ userId: "org", createdByUserId: "curator" });
        expect((await listOwnTypes("org")).map((type) => type.key)).toContain(
            key,
        );
        const params = { kind, key };
        expect(
            (
                await call(
                    renameType,
                    "member",
                    "PATCH",
                    { label: "Changed" },
                    params,
                )
            ).status,
        ).toBe(403);
        expect(
            (
                await call(
                    eraseType,
                    "member",
                    "DELETE",
                    { confirmCount: 0 },
                    params,
                )
            ).status,
        ).toBe(403);
        expect(
            (
                await call(
                    renameType,
                    "curator",
                    "PATCH",
                    { label: "Renamed" },
                    params,
                )
            ).status,
        ).toBe(200);
        expect(
            (await call(renameType, "curator", "PATCH", { keep: true }, params))
                .status,
        ).toBe(200);
        const into = kind === "entity" ? "project" : "leads";
        expect(await typeMergeCount("curator", kind, key, into)).toBe(0);
        expect(
            (
                await call(
                    mergeType,
                    "curator",
                    "POST",
                    { mergeInto: into, confirmCount: 0 },
                    params,
                )
            ).status,
        ).toBe(200);
        expect(
            await db().select().from(table).where(eq(table.key, key)),
        ).toEqual([]);
        const otherKey = await createOrgType("curator", {
            kind: "entity",
            label: "Disposable",
        });
        expect(
            (
                await call(
                    eraseType,
                    "curator",
                    "DELETE",
                    { confirmCount: 0 },
                    { kind: "entity", key: otherKey },
                )
            ).status,
        ).toBe(200);
        const privateKey = await createPrivateType("other", {
            kind: "entity",
            label: "Private type",
        });
        expect(
            (
                await call(
                    renameType,
                    "curator",
                    "PATCH",
                    { label: "Stolen" },
                    { kind: "entity", key: privateKey },
                )
            ).status,
        ).toBe(404);
    });

    it("manages shared aliases and facts while private subjects stay private", async () => {
        const person = await createPerson({
            userId: "org",
            displayName: "Jana",
        });
        const response = await call(addAlias, "curator", "POST", {
            target: { personId: person.id },
            text: "Janička",
        });
        expect(response.status).toBe(201);
        const { id: aliasId } = (await response.json()) as { id: string };
        expect((await db().select().from(knowledgeAliases))[0]).toMatchObject({
            userId: "org",
            createdByUserId: "curator",
        });
        expect(
            (
                await call(deleteAlias, "member", "DELETE", undefined, {
                    id: aliasId,
                })
            ).status,
        ).toBe(403);
        expect(
            (
                await call(deleteAlias, "curator", "DELETE", undefined, {
                    id: aliasId,
                })
            ).status,
        ).toBe(200);
        const fact = await call(addFact, "curator", "POST", {
            subject: { personId: person.id },
            relationKey: "has_role",
            object: { literal: "Engineer" },
        });
        expect(fact.status).toBe(201);
        const { id: factId } = (await fact.json()) as { id: string };
        expect((await db().select().from(knowledgeFacts))[0]).toMatchObject({
            userId: "org",
            createdByUserId: "curator",
        });
        expect(
            (
                await call(eraseFact, "member", "DELETE", undefined, {
                    id: factId,
                })
            ).status,
        ).toBe(403);
        const replacement = await call(
            changeFact,
            "curator",
            "PUT",
            { object: { literal: "Designer" } },
            { id: factId },
        );
        expect(replacement.status).toBe(200);
        const { id: replacementId } = (await replacement.json()) as {
            id: string;
        };
        expect(
            (
                await call(eraseFact, "curator", "DELETE", undefined, {
                    id: replacementId,
                })
            ).status,
        ).toBe(200);
        const privatePerson = await createPerson({
            userId: "curator",
            displayName: "Private",
        });
        expect(
            (
                await call(addAlias, "curator", "POST", {
                    target: { personId: privatePerson.id },
                    text: "Mine",
                })
            ).status,
        ).toBe(201);
        expect((await db().select().from(knowledgeAliases))[0]?.userId).toBe(
            "curator",
        );
    });

    it("imports and creates private entries, retaining curator authorship", async () => {
        const preview = await call(importNames, "curator", "POST", {
            text: "person: Jana (Janička)\nproject: Orion",
            dryRun: true,
        });
        expect(preview.status).toBe(200);
        expect(await db().select().from(people)).toEqual([]);
        const imported = await call(importNames, "curator", "POST", {
            text: "person: Jana (Janička)\nproject: Orion",
            dryRun: false,
        });
        expect(imported.status).toBe(200);
        expect((await db().select().from(people))[0]).toMatchObject({
            userId: "curator",
            createdByUserId: "curator",
        });
        expect((await db().select().from(knowledgeEntities))[0]).toMatchObject({
            userId: "curator",
            createdByUserId: "curator",
        });
        expect((await db().select().from(knowledgeAliases))[0]).toMatchObject({
            userId: "curator",
            createdByUserId: "curator",
        });
        const added = await call(addPerson, "curator", "POST", {
            displayName: "Petr",
            primaryEmail: "petr@example.test",
            notes: "Private contact",
        });
        expect(added.status).toBe(201);
        const { person } = (await added.json()) as {
            person: { id: string; scope: string; notes: string };
        };
        expect(person).toMatchObject({
            scope: "personal",
            notes: "Private contact",
        });
        expect(await getPerson("member", person.id)).toBeNull();
        expect(
            (await db().select().from(people)).every(
                (row) =>
                    row.userId === "curator" &&
                    row.createdByUserId === "curator",
            ),
        ).toBe(true);
        for (const importedPerson of await db().select().from(people)) {
            expect(await getPerson("member", importedPerson.id)).toBeNull();
        }
        for (const importedEntity of await db()
            .select()
            .from(knowledgeEntities)) {
            expect(await getEntity("member", importedEntity.id)).toBeNull();
        }
    });

    it("serializes two imports into the same curator's private scope", async () => {
        const responses = await Promise.all(
            ["curator", "curator"].map((user) =>
                call(importNames, user, "POST", {
                    text: "person: Same person (Nickname)",
                    dryRun: false,
                }),
            ),
        );
        expect(responses.map((response) => response.status)).toEqual([
            200, 200,
        ]);
        expect(await db().select().from(people)).toHaveLength(1);
        expect(await db().select().from(knowledgeAliases)).toHaveLength(1);
        expect((await db().select().from(people))[0]?.userId).toBe("curator");
    });

    it("lets curators adopt, map and reject suggested phrases", async () => {
        for (const [phrase, action] of [
            ["Coordinates", "create"],
            ["Runs", "map"],
            ["Supports", "reject"],
        ] as const) {
            await proposePhrase("member", phrase);
            const proposal = (await listVocabularyProposals("curator")).find(
                (row) => row.phrase === phrase,
            );
            const body =
                action === "create"
                    ? {
                          action,
                          spec: {
                              subjectTypes: ["person"],
                              objectTypes: ["project"],
                              objectKind: "entity",
                              cardinality: "many",
                          },
                      }
                    : { action, key: "leads" };
            expect(
                (
                    await call(decidePhrase, "member", "POST", body, {
                        id: proposal?.id ?? "",
                    })
                ).status,
            ).toBe(403);
            expect(
                (
                    await call(decidePhrase, "curator", "POST", body, {
                        id: proposal?.id ?? "",
                    })
                ).status,
            ).toBe(200);
        }
        const created = (await db().select().from(knowledgeRelationTypes)).find(
            (row) => row.createdByUserId === "curator",
        );
        expect(created?.userId).toBe("org");
    });

    it("keeps local mode limited to the organization account", async () => {
        mockEnv.AUTHZ_MODE = "local";
        mockEnv.ORG_ACCOUNT_PASSWORD = "password";
        const person = await createPerson({
            userId: "org",
            displayName: "Shared",
        });
        expect(
            (
                await call(
                    renamePerson,
                    "curator",
                    "PATCH",
                    { displayName: "Changed" },
                    { id: person.id },
                )
            ).status,
        ).toBe(403);
        expect(
            (
                await call(
                    renamePerson,
                    "org",
                    "PATCH",
                    { displayName: "Changed" },
                    { id: person.id },
                )
            ).status,
        ).toBe(200);
    });
});
