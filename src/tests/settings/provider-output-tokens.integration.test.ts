import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import unzipper from "unzipper";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PUT as updateOrganization } from "@/app/api/settings/ai/organization-providers/[id]/route";
import {
    POST as createOrganization,
    GET as listOrganization,
} from "@/app/api/settings/ai/organization-providers/route";
import { PUT as updatePersonal } from "@/app/api/settings/ai/providers/[id]/route";
import {
    POST as createPersonal,
    GET as listPersonal,
} from "@/app/api/settings/ai/providers/route";
import { apiCredentials, users } from "@/db/schema";
import type { ArchiveScope } from "@/lib/export/archive-scope";
import { buildAndUploadExportArchive } from "@/lib/export/build-archive";
import type { StorageProvider } from "@/lib/storage/types";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbRef, dbProxy, actor } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    return {
        dbRef: ref,
        dbProxy: new Proxy(
            {},
            {
                get: (_target, property) => {
                    if (!ref.current)
                        throw new Error("test database not ready");
                    const value = ref.current[property];
                    return typeof value === "function"
                        ? value.bind(ref.current)
                        : value;
                },
            },
        ),
        actor: { id: "manager" },
    };
});
vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: { IS_HOSTED: false } }));
vi.mock("@/lib/encryption", () => ({
    encrypt: (value: string) => `encrypted:${value}`,
    decrypt: (value: string) => value.replace(/^encrypted:/, ""),
    decryptBuffer: (value: Buffer) => value,
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/pipeline/provider-recovery", () => ({
    requestProviderRecoveryInTx: vi.fn(),
}));
vi.mock("@/lib/knowledge/availability", () => ({
    isLearnDeploymentAvailable: () => false,
}));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: async () => "org-user",
    isOrgScopeEnabled: () => true,
}));
vi.mock("@/lib/identity/factory", () => ({ isIdpAuthorization: () => true }));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async () => ({
        user: { id: actor.id, email: `${actor.id}@example.test` },
    }),
    requireApiSessionActor: async () => ({
        session: { user: { id: actor.id, email: `${actor.id}@example.test` } },
        actor: {
            kind: "user",
            actorId: actor.id,
            capabilities: new Set(["use", "access.manage"]),
        },
    }),
}));

function request(method: string, body?: Record<string, unknown>) {
    return new Request("https://app.example.test/api/settings/ai/providers", {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
}

async function archiveProviders(
    scope: ArchiveScope,
): Promise<Record<string, unknown>[]> {
    let bytes = Buffer.alloc(0);
    const storage: StorageProvider = {
        uploadFile: async (key) => key,
        downloadFile: async () => Buffer.alloc(0),
        downloadStream: async () => Readable.from([]),
        uploadStream: async (key, stream) => {
            const chunks: Buffer[] = [];
            for await (const chunk of stream) chunks.push(Buffer.from(chunk));
            bytes = Buffer.concat(chunks);
            return key;
        },
        exists: async () => false,
        getSignedUrl: async (key) => key,
        deleteFile: async () => {},
        testConnection: async () => true,
    };
    await buildAndUploadExportArchive({
        scope,
        sourceStorage: storage,
        destinationStorage: storage,
        storageKey: "backup.zip",
    });
    const zip = await unzipper.Open.buffer(bytes);
    const file = zip.files.find(
        (entry) => entry.path === "ai/provider-rates.json",
    );
    expect(file).toBeDefined();
    const json = (await file?.buffer())?.toString() ?? "";
    expect(json).not.toContain("apiKey");
    expect(json).not.toContain("test-secret");
    return JSON.parse(json) as Record<string, unknown>[];
}

const databaseUrl = getTestDatabaseUrl();
const withDatabase = databaseUrl ? describe : describe.skip;

withDatabase("provider output limits with PostgreSQL and archives", () => {
    let database: TestPostgresDatabase;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            databaseUrl ?? "",
            "provider_output_tokens",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        await database.db.insert(users).values([
            { id: "manager", email: "manager@example.test" },
            { id: "org-user", email: "org@example.test", role: "org" },
            { id: "other", email: "other@example.test" },
        ]);
    }, 120000);
    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30000);

    it.each([
        "personal",
        "organization",
    ] as const)("round trips a %s cap through routes, lists and backup metadata", async (scope) => {
        actor.id = "manager";
        const owner = scope === "personal" ? "manager" : "org-user";
        const create =
            scope === "personal" ? createPersonal : createOrganization;
        const update =
            scope === "personal" ? updatePersonal : updateOrganization;
        const list = scope === "personal" ? listPersonal : listOrganization;
        const created = await create(
            request("POST", {
                provider: "Codex",
                apiKey: "test-secret",
                defaultModel: "example-chat",
                maxOutputTokens: 8192,
            }),
        );
        expect(created.status).toBe(200);
        const { provider } = await created.json();
        expect(provider.maxOutputTokens).toBe(8192);
        const context = {
            params: Promise.resolve({ id: provider.id as string }),
        };
        expect(
            (await update(request("PUT", { maxOutputTokens: 12000 }), context))
                .status,
        ).toBe(200);
        expect(
            (
                await update(
                    request("PUT", { defaultModel: "example-chat-v2" }),
                    context,
                )
            ).status,
        ).toBe(200);
        const listed = await (await list(request("GET"))).json();
        expect(listed.providers).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: provider.id,
                    maxOutputTokens: 12000,
                }),
            ]),
        );
        const backup = await archiveProviders(
            scope === "personal"
                ? { kind: "personal", userId: owner }
                : { kind: "organization", orgUserId: owner },
        );
        const card = backup.find((entry) => entry.model === "example-chat-v2");
        expect(card).toMatchObject({
            provider: "Codex",
            maxOutputTokens: 12000,
            inputUsdPerMillion: null,
            audioUsdPerHour: null,
        });
        await database.db
            .delete(apiCredentials)
            .where(
                and(
                    eq(apiCredentials.id, provider.id),
                    eq(apiCredentials.userId, owner),
                ),
            );
        const restored = await create(
            request("POST", {
                ...card,
                model: undefined,
                defaultModel: card?.model,
                apiKey: "test-secret",
                inputUsdPerMillion: undefined,
                outputUsdPerMillion: undefined,
                audioUsdPerHour: undefined,
            }),
        );
        expect(restored.status).toBe(200);
        const restoredBody = await restored.json();
        expect(restoredBody.provider.maxOutputTokens).toBe(12000);
        const restoredContext = {
            params: Promise.resolve({ id: restoredBody.provider.id as string }),
        };
        expect(
            (
                await update(
                    request("PUT", { maxOutputTokens: null }),
                    restoredContext,
                )
            ).status,
        ).toBe(200);
        const [row] = await database.db
            .select()
            .from(apiCredentials)
            .where(
                and(
                    eq(apiCredentials.id, restoredBody.provider.id),
                    eq(apiCredentials.userId, owner),
                ),
            );
        expect(row?.maxOutputTokens).toBeNull();
    });

    it("keeps other users' personal settings out of updates and archives", async () => {
        await database.db.insert(apiCredentials).values({
            id: "other-card",
            userId: "other",
            provider: "Codex",
            apiKey: "encrypted:test-secret",
            defaultModel: "other-model",
            maxOutputTokens: 12345,
        });
        actor.id = "manager";
        expect(
            (
                await updatePersonal(request("PUT", { maxOutputTokens: 256 }), {
                    params: Promise.resolve({ id: "other-card" }),
                })
            ).status,
        ).toBe(404);
        const [row] = await database.db
            .select()
            .from(apiCredentials)
            .where(
                and(
                    eq(apiCredentials.id, "other-card"),
                    eq(apiCredentials.userId, "other"),
                ),
            );
        expect(row?.maxOutputTokens).toBe(12345);
        await database.db.insert(apiCredentials).values({
            userId: "manager",
            provider: "Codex",
            apiKey: "encrypted:test-secret",
            defaultModel: "own-model",
            maxOutputTokens: 4096,
        });
        expect(
            await archiveProviders({ kind: "personal", userId: "manager" }),
        ).not.toEqual(
            expect.arrayContaining([
                expect.objectContaining({ model: "other-model" }),
            ]),
        );
    });
});
