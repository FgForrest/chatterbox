import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { POST as browserTranscription } from "@/app/api/recordings/[id]/transcription/from-browser/route";
import { loadStatistics } from "@/db/queries/statistics";
import {
    aiUsageEvents,
    apiCredentials,
    chatterItems,
    mailMessages,
    recordingFolderAssignments,
    recordingFolders,
    recordings,
    recordingTasks,
    taskMentions,
    users,
} from "@/db/schema";
import {
    chatCompletionWithUsage,
    withUsageFailure,
} from "@/lib/ai/usage-attempt";
import {
    type AiUsageContext,
    recordAiUsage,
    recordingAiCost,
} from "@/lib/ai/usage-cost";
import { encrypt } from "@/lib/encryption";
import { encryptText } from "@/lib/encryption/fields";
import { EmbeddingClient } from "@/lib/knowledge/embeddings";
import {
    knowledgeView,
    searchByMeaning,
} from "@/lib/knowledge/knowledge-loader";
import {
    metricIndex,
    type StatisticsData,
    unpackRanking,
} from "@/lib/statistics/data";
import {
    loadTasksPromptContext,
    searchMergeCandidates,
} from "@/lib/tasks/proposals";
import { storeBrowserTranscription } from "@/lib/transcription/transcribe-recording";
import { insertRecordings } from "@/tests/integration/items";
import { migrationsThrough } from "@/tests/integration/migrations";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    migrateTestDatabase,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";
import { resolvedAudioProfile } from "@/tests/profiles/seeded-profile-fixture";

const { ref } = vi.hoisted(() => ({
    ref: { current: null as Record<PropertyKey, unknown> | null },
}));
vi.mock("@/db", () => ({
    db: new Proxy(
        {},
        {
            get(_target, key) {
                if (!ref.current) throw new Error("Database not initialized");
                const value = ref.current[key];
                return typeof value === "function"
                    ? value.bind(ref.current)
                    : value;
            },
        },
    ),
    sqlClient: null,
}));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn(async () => ({ user: { id: "owner" } })),
}));
vi.mock("@/lib/sharing/access", () => ({
    requireRecordingView: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/recordings/erase", () => ({
    allowManualArtifactGeneration: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/env", () => ({
    env: {
        IS_HOSTED: false,
        SELF_HOST_MODE: "shared",
        KNOWLEDGE_MEMORY_MB: 1,
        EMBEDDING_BASE_URL: "https://example.com/v1",
        EMBEDDING_MODEL: "embed",
        EMBEDDING_API_KEY: "test-key",
        AUTHZ_MODE: "local",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
    },
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/profiles/resolve-manual", () => ({
    resolveManualItemProfile: vi.fn(async () => resolvedAudioProfile()),
}));
vi.mock("@/lib/pipeline/trigger", () => ({
    requestAdvanceInTx: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/export/document-sidecars", () => ({
    removeRecordingSidecar: vi.fn(),
    exportRecordingSidecarsIfEnabled: vi.fn(),
}));
vi.mock("@/lib/webhooks/emit", () => ({ emitEvent: vi.fn() }));

const historicalUsers = pgTable("users", {
    id: text("id"),
    email: text("email"),
});

const url = getTestDatabaseUrl();
const context: AiUsageContext = {
    recordingId: "audio",
    ownerUserId: "owner",
    actorUserId: "owner",
    payerUserId: "owner",
    operation: "summary",
    provider: "Example",
    model: "model",
};
const total = (data: StatisticsData, key: keyof typeof metricIndex) =>
    data.daily[metricIndex[key]].reduce((a, b) => a + b, 0);

describe.skipIf(!url)("durable usage ledger (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    let migratedLegacy: typeof aiUsageEvents.$inferSelect;
    beforeAll(async () => {
        const folder = migrationsThrough(143);
        try {
            database = await createMigratedTestDatabase(
                url as string,
                "usage_ledger",
                folder,
            );
            ref.current = database.db as unknown as Record<
                PropertyKey,
                unknown
            >;
            await database.db
                .insert(historicalUsers)
                .values({ id: "legacy", email: "legacy@example.test" });
            await database.db.insert(chatterItems).values({
                id: "legacy-item",
                userId: "legacy",
                kind: "mail",
                title: "Legacy",
                occurredAt: new Date(),
            });
            await database.sql`insert into ai_usage_events (id, recording_id, user_id, payer_user_id, operation, provider, model, cost_usd) values ('legacy-event', 'legacy-item', 'legacy', 'legacy', 'summary', 'Example', 'model', 0.25)`;
            await migrateTestDatabase(url as string, database.db);
            [migratedLegacy] = await database.db.select().from(aiUsageEvents);
        } finally {
            rmSync(folder, { recursive: true, force: true });
        }
    }, 120_000);
    afterAll(async () => {
        ref.current = null;
        await database?.dispose();
    }, 30_000);
    beforeEach(async () => {
        await database.db.delete(users);
        await database.db.insert(users).values([
            { id: "owner", email: "owner@example.test" },
            { id: "payer", email: "payer@example.test" },
            { id: "org", email: "org@example.test", role: "org" },
        ]);
        await insertRecordings(database.db, {
            id: "audio",
            userId: "owner",
            deviceSn: "local",
            plaudFileId: "uploaded-example",
            filename: "Example recording",
            duration: 123_456,
            startTime: new Date(),
            endTime: new Date(),
            filesize: 10,
            fileMd5: "a".repeat(32),
            storageType: "local",
            storagePath: "audio.opus",
            plaudVersion: "1",
        });
        await database.db.insert(chatterItems).values({
            id: "mail",
            userId: "owner",
            kind: "mail",
            title: "Example mail",
            occurredAt: new Date(),
        });
        await database.db.insert(mailMessages).values({
            id: "mail",
            userId: "owner",
            rawHash: "a".repeat(64),
            receivedAt: new Date(),
            sizeBytes: 10,
            auth: {},
            senderVerified: false,
        });
    });

    it("applies generated 0144 over 0143 with existing usage intact", () => {
        expect(migratedLegacy).toMatchObject({
            id: "legacy-event",
            itemId: "legacy-item",
            itemKind: null,
            outcome: "succeeded",
            costUsd: "0.250000000",
        });
    });

    it.each([
        "audio",
        "mail",
    ] as const)("retains %s usage and spend after its hard deletion", async (kind) => {
        await recordAiUsage(
            { ...context, recordingId: kind },
            { reportedCostUsd: 0.25 },
        );
        const before = await loadStatistics("owner", "mine", "UTC");
        expect(total(before, "summaryCost")).toBe(0.25);
        expect(
            total(before, kind === "mail" ? "mailSummaries" : "summaries"),
        ).toBe(1);
        await database.db.delete(chatterItems).where(eq(chatterItems.id, kind));
        expect(
            await database.db
                .select()
                .from(kind === "mail" ? mailMessages : recordings),
        ).toHaveLength(0);
        const [event] = await database.db.select().from(aiUsageEvents);
        expect(event).toMatchObject({
            itemId: null,
            itemKind: kind,
            outcome: "succeeded",
            costUsd: "0.250000000",
        });
        const after = await loadStatistics("owner", "mine", "UTC");
        expect(total(after, "summaryCost")).toBe(0.25);
        expect(total(after, kind === "mail" ? "mailCost" : "audioCost")).toBe(
            0.25,
        );
        expect(
            total(after, kind === "mail" ? "mailSummaries" : "summaries"),
        ).toBe(0);
        expect(after.modelDays.reduce((sum, row) => sum + row[3], 0)).toBe(1);
    });

    it.each([
        "owner",
        "payer",
    ])("account deletion of %s still removes usage", async (account) => {
        await recordAiUsage(
            { ...context, payerUserId: "payer" },
            { reportedCostUsd: 0.25 },
        );
        await database.db
            .delete(chatterItems)
            .where(eq(chatterItems.id, "audio"));
        await database.db.delete(users).where(eq(users.id, account));
        expect(await database.db.select().from(aiUsageEvents)).toEqual([]);
    });

    it("retains Organization-paid spend through its payer without an item", async () => {
        await recordAiUsage(
            { ...context, payerUserId: "org" },
            { reportedCostUsd: 0.7 },
        );
        await database.db
            .delete(chatterItems)
            .where(eq(chatterItems.id, "audio"));
        const data = await loadStatistics("owner", "organization", "UTC");
        expect(total(data, "summaryCost")).toBe(0.7);
        expect(total(data, "summaries")).toBe(0);
        expect(
            total(await loadStatistics("owner", "mine", "UTC"), "summaryCost"),
        ).toBe(0);
        expect(
            total(
                await loadStatistics("owner", "everyone", "UTC"),
                "summaryCost",
            ),
        ).toBe(0.7);
    });

    it("records failed measured and unmeasured calls, preserving the exact original error", async () => {
        const error = Object.assign(new Error("provider failure"), {
            usage: { prompt_tokens: 12, completion_tokens: 4, cost: 0.4 },
        });
        await expect(
            chatCompletionWithUsage(context, async () => {
                throw error;
            }),
        ).rejects.toBe(error);
        const unknown = new Error("offline");
        await expect(
            withUsageFailure(context, async () => {
                throw unknown;
            }),
        ).rejects.toBe(unknown);
        const events = await database.db.select().from(aiUsageEvents);
        expect(events).toHaveLength(2);
        expect(events).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    outcome: "failed",
                    inputTokens: 12,
                    outputTokens: 4,
                    costUsd: "0.400000000",
                }),
                expect.objectContaining({
                    outcome: "failed",
                    inputTokens: null,
                    costUsd: null,
                }),
            ]),
        );
        const data = await loadStatistics("owner", "mine", "UTC");
        expect(total(data, "summaryCost")).toBe(0.4);
        expect(total(data, "summaries")).toBe(0);
        expect(total(data, "unpriced")).toBe(0);
        expect(data.modelDays.reduce((sum, row) => sum + row[5], 0)).toBe(0);
        expect(
            data.modelDays.reduce((sum, row) => sum + (row[6] ?? 0), 0),
        ).toBe(2);
        expect(await recordingAiCost("audio", "owner")).toMatchObject({
            totalUsd: 0.4,
            requestCount: 2,
            unknownCount: 1,
        });
    });

    it("counts only successful calls with unknown cost as unpriced", async () => {
        await recordAiUsage(context, { outcome: "failed" });
        await recordAiUsage(context, { outcome: "succeeded" });
        const data = await loadStatistics("owner", "mine", "UTC");
        expect(total(data, "unpriced")).toBe(1);
        expect(data.modelDays).toHaveLength(1);
        expect(data.modelDays[0].slice(3)).toEqual([2, 0, 1, 1]);
    });

    it("browser persistence records one free call using the recording duration", async () => {
        const result = await storeBrowserTranscription({
            userId: "owner",
            recordingId: "audio",
            text: "Browser transcript",
            detectedLanguage: "en",
            model: "whisper-base",
        });
        expect(result.success).toBe(true);
        expect(await database.db.select().from(aiUsageEvents)).toEqual([
            expect.objectContaining({
                itemId: "audio",
                itemKind: "audio",
                operation: "transcription",
                outcome: "succeeded",
                provider: "browser",
                model: "whisper-base",
                audioSeconds: "123.456",
                costUsd: "0.000000000",
            }),
        ]);
    });

    it("the browser route ignores client-supplied duration, provider and cost", async () => {
        const response = await browserTranscription(
            new Request(
                "http://localhost/api/recordings/audio/transcription/from-browser",
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        text: "Browser transcript",
                        model: "whisper-small",
                        audioSeconds: 999999,
                        provider: "Paid",
                        costUsd: 400,
                    }),
                },
            ),
            { params: Promise.resolve({ id: "audio" }) },
        );
        expect(response.status).toBe(200);
        expect(await database.db.select().from(aiUsageEvents)).toEqual([
            expect.objectContaining({
                provider: "browser",
                model: "whisper-small",
                audioSeconds: "123.456",
                costUsd: "0.000000000",
            }),
        ]);
    });

    it("the browser route validates its model before recording usage", async () => {
        const response = await browserTranscription(
            new Request(
                "http://localhost/api/recordings/audio/transcription/from-browser",
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        text: "Browser transcript",
                        model: "x".repeat(101),
                    }),
                },
            ),
            { params: Promise.resolve({ id: "audio" }) },
        );
        expect(response.status).toBe(400);
        expect(await database.db.select().from(aiUsageEvents)).toEqual([]);
    });

    it("legacy kinds fall back to a live item and become unknown after deletion", async () => {
        await database.db.insert(aiUsageEvents).values({
            itemId: "mail",
            userId: "owner",
            payerUserId: "owner",
            operation: "summary",
            provider: "Example",
            model: "model",
            costUsd: "0.2",
        });
        expect(
            total(await loadStatistics("owner", "mine", "UTC"), "mailCost"),
        ).toBe(0.2);
        await database.db
            .delete(chatterItems)
            .where(eq(chatterItems.id, "mail"));
        const data = await loadStatistics("owner", "mine", "UTC");
        expect(total(data, "summaryCost")).toBe(0.2);
        expect(total(data, "mailCost")).toBe(0);
        expect(total(data, "audioCost")).toBe(0);
    });

    async function embeddingCard(rate: string | null = "2") {
        await database.db.insert(apiCredentials).values({
            id: "embedding-card",
            userId: "owner",
            provider: "Example",
            apiKey: encrypt("test-key"),
            baseUrl: "https://example.com/v1",
            defaultModel: "embed",
            inputUsdPerMillion: rate,
            outputUsdPerMillion: rate,
        });
    }
    function client(fail = false) {
        return new EmbeddingClient({
            baseUrl: "https://example.com/v1",
            model: "embed",
            apiKey: "test-key",
            batchSize: 2,
            fetch: async (_url, init) => {
                if (fail)
                    return Response.json(
                        { usage: { prompt_tokens: 20, cost: 0.03 } },
                        { status: 503 },
                    );
                const body = JSON.parse(String(init?.body)) as {
                    input: string[];
                };
                return Response.json({
                    data: body.input.map((_, index) => ({
                        index,
                        embedding: [1, 0],
                    })),
                    usage: { prompt_tokens: 100 },
                });
            },
        });
    }
    it("logs one embedding row per request batch with card pricing and no item", async () => {
        await embeddingCard();
        await client().embed(["first", "second", "third"], {
            usage: { userId: "owner" },
        });
        const events = await database.db.select().from(aiUsageEvents);
        expect(events).toHaveLength(2);
        for (const event of events)
            expect(event).toMatchObject({
                itemId: null,
                itemKind: null,
                operation: "embedding",
                outcome: "succeeded",
                provider: "Example",
                model: "embed",
                inputTokens: 100,
                outputTokens: 0,
                costUsd: "0.000200000",
                priceSource: "user",
            });
        const data = await loadStatistics("owner", "mine", "UTC");
        expect(total(data, "otherCost")).toBe(0.0004);
        expect(total(data, "audioCost")).toBe(0);
    });
    it("logs embedding failures with measured usage", async () => {
        await embeddingCard();
        await expect(
            client(true).embed(["first", "second"], {
                usage: { userId: "owner", recordingId: "audio" },
            }),
        ).rejects.toThrow("embedding service failed");
        expect(await database.db.select().from(aiUsageEvents)).toEqual([
            expect.objectContaining({
                itemId: "audio",
                itemKind: "audio",
                operation: "embedding",
                outcome: "failed",
                inputTokens: 20,
                costUsd: "0.030000000",
            }),
        ]);
    });
    it("logs priced query embeddings and skips unpriced queries", async () => {
        await client().embed(["query"], {
            usage: { userId: "owner", query: true },
        });
        expect(await database.db.select().from(aiUsageEvents)).toEqual([]);
        await embeddingCard();
        await client().embed(["query"], {
            usage: { userId: "owner", query: true },
        });
        expect(await database.db.select().from(aiUsageEvents)).toHaveLength(1);
    });

    it("does not record a cancelled embedding batch or open its breaker", async () => {
        await embeddingCard();
        const controller = new AbortController();
        const reason = new Error("superseded");
        const embedding = new EmbeddingClient({
            baseUrl: "https://example.com/v1",
            model: "embed",
            apiKey: "test-key",
            failureThreshold: 1,
            fetch: async (_url, init) => {
                controller.abort(reason);
                throw init?.signal?.reason;
            },
        });
        await expect(
            embedding.embed(["query"], {
                signal: controller.signal,
                usage: { userId: "owner", query: true },
            }),
        ).rejects.toBe(reason);
        expect(embedding.available).toBe(true);
        expect(await database.db.select().from(aiUsageEvents)).toEqual([]);
    });

    it("retains completed embedding batches when the next batch is cancelled", async () => {
        const controller = new AbortController();
        const reason = new Error("superseded");
        await expect(
            client().embed(["one", "two", "three"], {
                signal: controller.signal,
                usage: { userId: "owner" },
                onBatch: () => {
                    controller.abort(reason);
                },
            }),
        ).rejects.toBe(reason);
        expect(await database.db.select().from(aiUsageEvents)).toEqual([
            expect.objectContaining({ outcome: "succeeded", inputTokens: 100 }),
        ]);
    });

    it.each([
        "owner",
        "org",
    ])("charges the matching instance embedding credential's account (%s)", async (account) => {
        await embeddingCard();
        await database.db
            .update(apiCredentials)
            .set({ userId: account })
            .where(eq(apiCredentials.id, "embedding-card"));
        await client().embed(["task"], {
            usage: {
                userId: "owner",
                actorUserId: "owner",
                payerUserId: "org",
                credentialUserIds: ["owner"],
            },
        });
        expect(await database.db.select().from(aiUsageEvents)).toEqual([
            expect.objectContaining({
                userId: "owner",
                actorUserId: "owner",
                payerUserId: account,
                priceSource: "user",
                costUsd: "0.000200000",
            }),
        ]);
    });

    it("keeps ambiguous embedding credentials unpriced under the scope payer", async () => {
        await embeddingCard();
        const [card] = await database.db.select().from(apiCredentials);
        await database.db
            .insert(apiCredentials)
            .values({ ...card, id: "second-card", userId: "org" });
        await client().embed(["task"], {
            usage: {
                userId: "owner",
                actorUserId: "owner",
                payerUserId: "org",
                credentialUserIds: ["owner"],
            },
        });
        expect(await database.db.select().from(aiUsageEvents)).toEqual([
            expect.objectContaining({
                payerUserId: "org",
                priceSource: null,
                costUsd: null,
            }),
        ]);
    });

    it("attributes shared knowledge query spend to the viewer while retaining its scope payer", async () => {
        await embeddingCard();
        await database.db
            .update(apiCredentials)
            .set({ userId: "org" })
            .where(eq(apiCredentials.id, "embedding-card"));
        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                Response.json({
                    data: [{ index: 0, embedding: [1, 0] }],
                    usage: { prompt_tokens: 100 },
                }),
            ),
        );
        try {
            const view = await knowledgeView({
                kind: "recording",
                ownerUserId: "payer",
                actorUserId: "owner",
                shared: true,
            });
            expect(view).toMatchObject({
                usageUserId: "org",
                actorUserId: "owner",
            });
            await searchByMeaning(view, "query");
            expect(await database.db.select().from(aiUsageEvents)).toEqual([
                expect.objectContaining({
                    userId: "org",
                    actorUserId: "owner",
                    payerUserId: "org",
                    costUsd: "0.000200000",
                }),
            ]);
            const data = await loadStatistics("owner", "organization", "UTC");
            expect(total(data, "otherCost")).toBe(0.0002);
            const actor = data.members.findIndex(([, isCaller]) => isCaller);
            expect(unpackRanking(data.ranking)).toEqual([
                [expect.any(Number), actor, 0, 0, 0, 0.0002],
            ]);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    const reviewer = {
        userId: "owner",
        emailHash: "unused",
        isOrg: false,
        isCurator: true,
        orgUserId: "org",
    };
    async function sharedTaskScope() {
        await database.db.insert(recordingFolders).values({
            id: "org-root",
            userId: "org",
            kind: "public",
            name: encryptText("Organization"),
            nameHash: "org-root",
        });
        await database.db.insert(recordingFolders).values({
            id: "org-folder",
            userId: "org",
            parentId: "org-root",
            kind: "custom",
            name: encryptText("Shared"),
            nameHash: "shared",
        });
        await database.db.insert(recordingFolderAssignments).values([
            { itemId: "audio", userId: "owner", folderId: "org-folder" },
            { itemId: "mail", userId: "owner", folderId: "org-folder" },
        ]);
        await database.db.insert(recordingTasks).values({
            id: "task",
            userId: "owner",
            itemId: "mail",
            status: "open",
            source: "manual",
            text: encryptText("Prepare example brief"),
        });
        await database.db.insert(taskMentions).values({
            taskId: "task",
            itemId: "mail",
            userId: "owner",
            view: "org",
            statementAt: new Date(),
            matchDecision: "home",
        });
        const fetch = vi.fn(
            async (_input: RequestInfo | URL, init?: RequestInit) => {
                const body = JSON.parse(String(init?.body)) as {
                    input: string[];
                };
                return Response.json({
                    data: body.input.map((_, index) => ({
                        index,
                        embedding: [1, 0],
                    })),
                    usage: { prompt_tokens: 100 },
                });
            },
        );
        vi.stubGlobal("fetch", fetch);
        return fetch;
    }

    it.each([
        true,
        false,
    ])("logs typed merge queries only when priced, while retaining task-vector usage (priced=%s)", async (priced) => {
        const fetch = await sharedTaskScope();
        if (priced) await embeddingCard();
        try {
            const result = await searchMergeCandidates(reviewer, "audio", {
                text: "example brief",
                offset: 0,
                limit: 10,
            });
            expect(result.candidates.map(({ id }) => id)).toEqual(["task"]);
            expect(fetch).toHaveBeenCalledTimes(2);
            let events = await database.db.select().from(aiUsageEvents);
            expect(events).toHaveLength(priced ? 2 : 1);
            for (const event of events)
                expect(event).toMatchObject({
                    userId: "owner",
                    actorUserId: "owner",
                    payerUserId: priced ? "owner" : "org",
                    costUsd: priced ? "0.000200000" : null,
                });
            await searchMergeCandidates(reviewer, "audio", {
                text: "another brief",
                offset: 0,
                limit: 10,
            });
            expect(fetch).toHaveBeenCalledTimes(3);
            events = await database.db.select().from(aiUsageEvents);
            expect(events).toHaveLength(priced ? 3 : 1);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it.each([
        "owner",
        "org",
    ])("uses the matching embedding payer for Organization task prompt context (%s)", async (account) => {
        await sharedTaskScope();
        await embeddingCard();
        await database.db
            .update(apiCredentials)
            .set({ userId: account })
            .where(eq(apiCredentials.id, "embedding-card"));
        try {
            const result = await loadTasksPromptContext({
                recording: {
                    id: "audio",
                    userId: "owner",
                    occurredAt: new Date(),
                    timezone: null,
                    zonemins: null,
                },
                transcriptionId: null,
                orgView: true,
                reviewer,
                itemText: "Prepare example brief",
            });
            expect([...result.refs.values()]).toEqual(["task"]);
            expect(await database.db.select().from(aiUsageEvents)).toEqual([
                expect.objectContaining({
                    userId: "owner",
                    actorUserId: "owner",
                    payerUserId: account,
                    costUsd: "0.000200000",
                }),
            ]);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("does not apply another account's or another key's card", async () => {
        await embeddingCard();
        await client().embed(["text"], { usage: { userId: "payer" } });
        const [event] = await database.db.select().from(aiUsageEvents);
        expect(event).toMatchObject({
            payerUserId: "payer",
            provider: "Embeddings",
            costUsd: null,
        });
    });
});
