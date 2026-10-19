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
import { aiUsageEvents, chatterItems, users } from "@/db/schema";
import { recordingAiCost } from "@/lib/ai/usage-cost";
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
                        throw new Error("test database was not initialized");
                    const value = ref.current[property];
                    return typeof value === "function"
                        ? value.bind(ref.current)
                        : value;
                },
            },
        ),
    };
});

vi.mock("@/db", () => ({ db: dbProxy }));

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const VIEWER = "viewer";
const ORGANIZATION = "organization";
const MEMBER = "member";
const ITEM = "recording";

describeWithDatabase(
    "recording AI spend across all payers (PostgreSQL)",
    () => {
        let database: TestPostgresDatabase | null = null;

        function db() {
            if (!database) throw new Error("test database was not initialized");
            return database.db;
        }

        async function usage(
            payerUserId: string,
            costUsd: string | null,
            operation = "summary",
            provider = "Codex",
            itemId = ITEM,
        ) {
            await db()
                .insert(aiUsageEvents)
                .values({
                    itemId,
                    userId: VIEWER,
                    actorUserId: VIEWER,
                    payerUserId,
                    operation,
                    provider,
                    model: "model",
                    costUsd,
                    createdAt: new Date("2026-01-01T00:00:00Z"),
                });
        }

        beforeAll(async () => {
            database = await createMigratedTestDatabase(
                testDatabaseUrl ?? "",
                "ai_cost_payers",
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
                    {
                        id: VIEWER,
                        email: "viewer@example.test",
                        name: "Viewer",
                    },
                    {
                        id: ORGANIZATION,
                        email: "org@example.test",
                        name: "Internal org name",
                        role: "org",
                    },
                    {
                        id: MEMBER,
                        email: "member@example.test",
                        name: "Petra Malá",
                    },
                ]);
            await db()
                .insert(chatterItems)
                .values([
                    {
                        id: ITEM,
                        userId: VIEWER,
                        kind: "audio",
                        title: "Recording",
                        occurredAt: new Date(),
                    },
                    {
                        id: "mail",
                        userId: VIEWER,
                        kind: "mail",
                        title: "Mail",
                        occurredAt: new Date(),
                    },
                ]);
        });

        it.each([
            ITEM,
            "mail",
        ])("includes Organization-only spend for %s", async (itemId) => {
            await usage(
                ORGANIZATION,
                "0.22",
                "transcription",
                "ElevenLabs",
                itemId,
            );
            await usage(ORGANIZATION, "0.03", "learn", "Codex", itemId);
            await usage(ORGANIZATION, "0.10", "summary", "Codex", itemId);

            expect(await recordingAiCost(itemId, VIEWER)).toEqual({
                totalUsd: 0.35,
                byOperation: { transcription: 0.22, learn: 0.03, summary: 0.1 },
                byService: {
                    "ElevenLabs · model": 0.22,
                    "Codex · model": 0.13,
                },
                unknownByService: {},
                unknownCount: 0,
                requestCount: 3,
                payers: [
                    {
                        payer: { type: "organization" },
                        byOperation: {
                            transcription: 0.22,
                            learn: 0.03,
                            summary: 0.1,
                        },
                        byService: {
                            "ElevenLabs · model": 0.22,
                            "Codex · model": 0.13,
                        },
                        unknownByService: {},
                    },
                ],
            });
        });

        it("splits shared services, operations and unpriced requests by their actual payer", async () => {
            for (const payer of [VIEWER, ORGANIZATION, MEMBER]) {
                await usage(payer, "0.25");
                await usage(payer, null);
            }
            await usage(ORGANIZATION, "99", "summary", "Codex", "mail");
            const result = await recordingAiCost(ITEM, VIEWER);
            expect(result).toMatchObject({
                totalUsd: 0.75,
                byOperation: { summary: 0.75 },
                byService: { "Codex · model": 0.75 },
                unknownByService: { "Codex · model": 3 },
                unknownCount: 3,
                requestCount: 6,
            });
            expect(result.payers).toEqual(
                expect.arrayContaining([
                    {
                        payer: { type: "you" },
                        byOperation: { summary: 0.25 },
                        byService: { "Codex · model": 0.25 },
                        unknownByService: { "Codex · model": 1 },
                    },
                    {
                        payer: { type: "organization" },
                        byOperation: { summary: 0.25 },
                        byService: { "Codex · model": 0.25 },
                        unknownByService: { "Codex · model": 1 },
                    },
                    {
                        payer: { type: "member", name: "Petra Malá" },
                        byOperation: { summary: 0.25 },
                        byService: { "Codex · model": 0.25 },
                        unknownByService: { "Codex · model": 1 },
                    },
                ]),
            );
            expect(result.payers).toHaveLength(3);
            expect(JSON.stringify(result)).not.toContain("@example.test");
        });

        it("keeps wholly unknown Organization usage distinct from no events", async () => {
            await usage(ORGANIZATION, null);
            expect(await recordingAiCost(ITEM, VIEWER)).toEqual({
                totalUsd: 0,
                byOperation: {},
                byService: {},
                unknownByService: { "Codex · model": 1 },
                unknownCount: 1,
                requestCount: 1,
                payers: [
                    {
                        payer: { type: "organization" },
                        byOperation: {},
                        byService: {},
                        unknownByService: { "Codex · model": 1 },
                    },
                ],
            });
        });

        it.each([
            null,
            "   ",
            "member@example.test",
        ])("uses a neutral member label for name %j without exposing email", async (name) => {
            await db().update(users).set({ name }).where(eq(users.id, MEMBER));
            await usage(MEMBER, "0.1");
            const result = await recordingAiCost(ITEM, VIEWER);
            expect(result.payers[0].payer).toEqual({
                type: "member",
                name: null,
            });
            expect(JSON.stringify(result)).not.toContain("@example.test");
        });

        it("classifies you relative to the viewer and keeps the Organization role", async () => {
            await usage(VIEWER, "0");
            await usage(ORGANIZATION, "0.25");
            const result = await recordingAiCost(ITEM, ORGANIZATION);
            expect(result.payers.map(({ payer }) => payer)).toEqual(
                expect.arrayContaining([
                    { type: "member", name: "Viewer" },
                    { type: "organization" },
                ]),
            );
            expect(result.byOperation.summary).toBe(0.25);
            expect(result.requestCount).toBe(2);
        });

        it("keeps distinct payers whose display names match", async () => {
            await db()
                .update(users)
                .set({ name: "Viewer" })
                .where(eq(users.id, MEMBER));
            await usage(VIEWER, "0.1");
            await usage(MEMBER, "0.2");
            const result = await recordingAiCost(ITEM, ORGANIZATION);
            expect(result.payers).toHaveLength(2);
            expect(result.payers.map(({ payer }) => payer)).toEqual([
                { type: "member", name: "Viewer" },
                { type: "member", name: "Viewer" },
            ]);
        });

        it("returns no payers only when the item has no events", async () => {
            await usage(ORGANIZATION, "1", "summary", "Codex", "mail");
            expect(await recordingAiCost(ITEM, VIEWER)).toEqual({
                totalUsd: 0,
                byOperation: {},
                byService: {},
                unknownByService: {},
                unknownCount: 0,
                requestCount: 0,
                payers: [],
            });
        });
    },
);
