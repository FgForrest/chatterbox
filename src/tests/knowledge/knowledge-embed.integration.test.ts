/**
 * Vectors against a real PostgreSQL and a fake OpenAI-compatible
 * embeddings server: what is embedded, what is embedded again, how a new
 * generation replaces the old only once complete, and that a search by
 * meaning finds only what the reader may read.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
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
    asyncJobs,
    knowledgeEntities,
    knowledgeFacts,
    knowledgeVectorState,
    knowledgeVectors,
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
            KNOWLEDGE_MEMORY_MB: 64,
            EMBEDDING_BASE_URL: undefined as string | undefined,
            EMBEDDING_MODEL: "fake-a",
            EMBEDDING_API_KEY: undefined,
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

import { encryptText } from "@/lib/encryption/fields";
import {
    EmbeddingClient,
    EmbeddingUnavailable,
} from "@/lib/knowledge/embeddings";
import {
    createEntity,
    deleteEntity,
    renameEntity,
} from "@/lib/knowledge/entities";
import { confirmManualFact, deleteFact } from "@/lib/knowledge/facts";
import {
    embedScope,
    seedKnowledgeEmbedJobs,
} from "@/lib/knowledge/knowledge-embed";
import {
    knowledgeStore,
    knowledgeView,
    searchByMeaning,
} from "@/lib/knowledge/knowledge-loader";
import { seedCoreVocabulary } from "@/lib/knowledge/vocabulary";
import { ensureOrgAccount } from "@/lib/org/account";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const ALICE = "user-alice";
const BOB = "user-bob";
const DIM = 32;

/** Words hashed into a small bag-of-words vector: alike texts, alike vectors. */
function fakeVector(text: string): number[] {
    const vector = new Array(DIM).fill(0);
    for (const word of text
        .toLowerCase()
        .normalize("NFKD")
        .replace(/\p{M}/gu, "")
        .split(/[^a-z0-9]+/)
        .filter(Boolean)) {
        let hash = 0;
        for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
        vector[hash % DIM] += 1;
    }
    return vector;
}

describeWithDatabase("knowledge vectors (PostgreSQL, fake embeddings)", () => {
    let database: TestPostgresDatabase | null = null;
    let server: Server | null = null;
    let baseUrl = "";
    let down = false;
    let embedded: string[] = [];
    // Runs while a request is answered: what changes during a run.
    let meanwhile: (() => Promise<void>) | null = null;
    let jan = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    const client = (model = "fake-a") =>
        new EmbeddingClient({ baseUrl, model, failureThreshold: 100 });

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "knowledge_embed",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        server = createServer((request, response) => {
            let body = "";
            request.on("data", (chunk) => {
                body += chunk;
            });
            request.on("end", async () => {
                const during = meanwhile;
                meanwhile = null;
                await during?.();
                if (down || request.url !== "/v1/embeddings") {
                    response.writeHead(503).end("down");
                    return;
                }
                const { input } = JSON.parse(body) as { input: string[] };
                embedded.push(...input);
                response
                    .writeHead(200, { "content-type": "application/json" })
                    .end(
                        JSON.stringify({
                            data: input.map((text, index) => ({
                                index,
                                embedding: fakeVector(text),
                            })),
                        }),
                    );
            });
        });
        await new Promise<void>((resolve) =>
            server?.listen(0, "127.0.0.1", resolve),
        );
        const { port } = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${port}/v1`;
        mockEnv.EMBEDDING_BASE_URL = baseUrl;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await new Promise((resolve) => server?.close(resolve));
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        down = false;
        embedded = [];
        meanwhile = null;
        knowledgeStore().invalidateAll();
        await db().delete(users);
        await db()
            .insert(users)
            .values([
                { id: ALICE, email: "alice@example.test" },
                { id: BOB, email: "bob@example.test" },
            ]);
        await ensureOrgAccount();
        await seedCoreVocabulary();
        const [row] = await db()
            .insert(people)
            .values({ userId: ALICE, displayName: encryptText("Jan Novotný") })
            .returning({ id: people.id });
        jan = row?.id ?? "";
    });

    async function aliceKnows() {
        const orion = await createEntity(ALICE, {
            typeKey: "project",
            name: "Orion",
            description: "CRM migration for a logistics client",
        });
        await createEntity(ALICE, { typeKey: "product", name: "Kafka" });
        await confirmManualFact(ALICE, {
            subject: { personId: jan },
            relationKey: "leads",
            object: { entityId: orion.id },
        });
        return orion.id;
    }

    const vectorsOf = (scope: string) =>
        db()
            .select({
                entityId: knowledgeVectors.entityId,
                factId: knowledgeVectors.factId,
                vectorGeneration: knowledgeVectors.vectorGeneration,
            })
            .from(knowledgeVectors)
            .where(eq(knowledgeVectors.userId, scope));

    it("embeds described entities and current facts, never a name alone", async () => {
        await aliceKnows();
        const result = await embedScope(ALICE, client());
        expect(result).toMatchObject({ embedded: 2, active: "fake-a#r1" });
        expect(embedded.sort()).toEqual([
            "Jan Novotný leads Orion",
            "Orion (Project): CRM migration for a logistics client",
        ]);
        const [state] = await db()
            .select()
            .from(knowledgeVectorState)
            .where(eq(knowledgeVectorState.userId, ALICE));
        expect(state?.activeGeneration).toBe("fake-a#r1");
        const [stored] = await vectorsOf(ALICE);
        expect(stored).toBeDefined();
    });

    it("embeds again only what changed", async () => {
        const orion = await aliceKnows();
        await embedScope(ALICE, client());
        embedded = [];
        expect(await embedScope(ALICE, client())).toMatchObject({
            embedded: 0,
        });
        await renameEntity(ALICE, orion, "Orion CRM");
        await embedScope(ALICE, client());
        expect(embedded.sort()).toEqual([
            "Jan Novotný leads Orion CRM",
            "Orion CRM (Project): CRM migration for a logistics client",
        ]);
    });

    it("keeps the old generation searched until the new one is complete", async () => {
        await aliceKnows();
        await embedScope(ALICE, client("fake-a"));
        down = true;
        await expect(
            embedScope(ALICE, client("fake-b")),
        ).rejects.toBeInstanceOf(EmbeddingUnavailable);
        expect(
            new Set(
                (await vectorsOf(ALICE)).map((row) => row.vectorGeneration),
            ),
        ).toEqual(new Set(["fake-a#r1"]));

        down = false;
        await embedScope(ALICE, client("fake-b"));
        expect(
            new Set(
                (await vectorsOf(ALICE)).map((row) => row.vectorGeneration),
            ),
        ).toEqual(new Set(["fake-b#r1"]));
    });

    it("finds by meaning what the reader may read, and nothing of anyone else's", async () => {
        await aliceKnows();
        await embedScope(ALICE, client());
        const alice = await knowledgeView({
            kind: "pages",
            viewerUserId: ALICE,
        });
        const found = await searchByMeaning(alice, "the CRM migration", 3);
        expect(found.available).toBe(true);
        expect(found.hits[0]).toMatchObject({ scope: ALICE, kind: "entity" });

        const bob = await knowledgeView({ kind: "pages", viewerUserId: BOB });
        expect(bob.vectors).toEqual([]);
        expect((await searchByMeaning(bob, "the CRM migration")).hits).toEqual(
            [],
        );
    });

    it("drops a vector with what it was made from", async () => {
        const orion = await aliceKnows();
        await embedScope(ALICE, client());
        await deleteEntity(ALICE, orion);
        expect(await vectorsOf(ALICE)).toEqual([]);
    });

    it("queues a run for a scope whose knowledge moved past its vectors", async () => {
        await aliceKnows();
        expect(await seedKnowledgeEmbedJobs()).toBeGreaterThan(0);
        const queued = await db()
            .select({ subjectId: asyncJobs.subjectId })
            .from(asyncJobs)
            .where(
                and(
                    eq(asyncJobs.kind, "knowledge.embed"),
                    eq(asyncJobs.userId, ALICE),
                ),
            );
        expect(queued).toEqual([{ subjectId: `knowledge:${ALICE}` }]);

        await db().delete(asyncJobs);
        await embedScope(ALICE, client());
        await seedKnowledgeEmbedJobs();
        const again = await db()
            .select({ userId: asyncJobs.userId })
            .from(asyncJobs)
            .where(eq(asyncJobs.userId, ALICE));
        expect(again).toEqual([]);
    });

    const stateOf = async (scope: string) =>
        (
            await db()
                .select()
                .from(knowledgeVectorState)
                .where(eq(knowledgeVectorState.userId, scope))
        )[0];

    it("keeps what still exists when something goes during a run", async () => {
        const orion = await aliceKnows();
        const [fact] = await db()
            .select({ id: knowledgeFacts.id })
            .from(knowledgeFacts);
        meanwhile = () => deleteFact(ALICE, fact?.id ?? "");

        const result = await embedScope(ALICE, client());

        expect(result.active).toBe("fake-a#r1");
        expect(await vectorsOf(ALICE)).toEqual([
            expect.objectContaining({ entityId: orion, factId: null }),
        ]);
        // Made from what was read before the fact went: another run follows.
        await seedKnowledgeEmbedJobs();
        expect(
            await db()
                .select({ userId: asyncJobs.userId })
                .from(asyncJobs)
                .where(eq(asyncJobs.userId, ALICE)),
        ).toHaveLength(1);
    });

    it("stops between batches when its job is cancelled, activating nothing", async () => {
        await aliceKnows();
        const controller = new AbortController();
        meanwhile = async () => controller.abort(new Error("cancelled"));
        await expect(
            embedScope(ALICE, client(), {
                signal: controller.signal,
                chunkSize: 1,
            }),
        ).rejects.toThrow("cancelled");
        expect(await vectorsOf(ALICE)).toEqual([]);
        expect(await stateOf(ALICE)).toBeUndefined();
    });

    it("queues nothing while the service is paused", async () => {
        await aliceKnows();
        const paused = new EmbeddingClient({
            baseUrl,
            model: "fake-a",
            failureThreshold: 1,
        });
        down = true;
        await expect(paused.embed(["x"])).rejects.toBeInstanceOf(
            EmbeddingUnavailable,
        );
        expect(await seedKnowledgeEmbedJobs({ client: paused })).toBe(0);
    });

    it("waits half an hour before queuing again a scope whose run failed", async () => {
        await aliceKnows();
        const failed = (minutesAgo: number) =>
            db()
                .insert(asyncJobs)
                .values({
                    userId: ALICE,
                    kind: "knowledge.embed",
                    subjectId: `knowledge:${ALICE}`,
                    status: "failed",
                    completedAt: new Date(Date.now() - minutesAgo * 60_000),
                });
        await failed(5);
        expect(await seedKnowledgeEmbedJobs()).toBe(0);
        await db().delete(asyncJobs);
        await failed(31);
        expect(await seedKnowledgeEmbedJobs()).toBe(1);
    });

    it("gives a promoted entity its own vector in the Organization's scope", async () => {
        const orion = await aliceKnows();
        await embedScope(ALICE, client());
        const [org] = await db()
            .select({ id: users.id })
            .from(users)
            .where(eq(users.role, "org"));
        const orgUserId = org?.id ?? "";
        // What a share does to it, reduced to the row.
        await db()
            .update(knowledgeEntities)
            .set({ userId: orgUserId })
            .where(eq(knowledgeEntities.id, orion));

        await embedScope(orgUserId, client());

        expect(await vectorsOf(orgUserId)).toEqual([
            expect.objectContaining({ entityId: orion }),
        ]);
    });
});
