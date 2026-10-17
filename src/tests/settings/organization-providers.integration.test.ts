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
    adminActionLog,
    aiUsageEvents,
    apiCredentials,
    chatterItems,
    users,
} from "@/db/schema";
import type { ActorContext } from "@/lib/authz/model";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef, state } = vi.hoisted(() => {
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
                        throw new Error("test database not ready");
                    const value = ref.current[property];
                    return typeof value === "function"
                        ? value.bind(ref.current)
                        : value;
                },
            },
        ),
        state: {
            orgEnabled: true,
            idp: true,
            actorId: "manager",
            email: "manager@example.test",
            capabilities: new Set<"use" | "org.curate" | "access.manage">([
                "use",
                "access.manage",
            ]),
        },
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: { IS_HOSTED: false } }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));
vi.mock("@/lib/encryption", () => ({
    encrypt: (value: string) => `encrypted:${value}`,
}));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: async () => "org-user",
    isOrgScopeEnabled: () => state.orgEnabled,
}));
vi.mock("@/lib/identity/factory", () => ({
    isIdpAuthorization: () => state.idp,
}));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async () => ({
        user: { id: state.actorId, email: state.email },
    }),
    requireApiSessionActor: async () => {
        const actor: ActorContext = {
            kind: state.idp
                ? "user"
                : state.actorId === "org-user"
                  ? "local-org"
                  : "user",
            actorId: state.actorId,
            issuer: null,
            subject: null,
            capabilities: state.capabilities,
            clientId: null,
            clientPermissions: new Set(),
            verifiedAt: null,
        };
        return {
            session: {
                user: { id: state.actorId, email: state.email },
                session: { id: `session-${state.actorId}` },
            },
            actor,
            authTime: new Date(),
        };
    },
}));

import {
    DELETE as deleteOrganizationProvider,
    PUT as updateOrganizationProvider,
} from "@/app/api/settings/ai/organization-providers/[id]/route";
import {
    POST as createOrganizationProvider,
    GET as listOrganizationProviders,
} from "@/app/api/settings/ai/organization-providers/route";
import { GET as organizationProviderUsage } from "@/app/api/settings/ai/organization-providers/usage/route";
import {
    DELETE as deletePersonalProvider,
    PUT as updatePersonalProvider,
} from "@/app/api/settings/ai/providers/[id]/route";
import { POST as createPersonalProvider } from "@/app/api/settings/ai/providers/route";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

function request(method: string, body?: Record<string, unknown>, path = "") {
    return new Request(
        `https://app.example.test/api/settings/ai/organization-providers${path}`,
        {
            method,
            ...(body ? { body: JSON.stringify(body) } : {}),
        },
    );
}

function context(id: string) {
    return { params: Promise.resolve({ id }) };
}

describeWithDatabase(
    "Organization provider settings routes (PostgreSQL)",
    () => {
        let database: TestPostgresDatabase | null = null;

        function databaseClient() {
            if (!database) throw new Error("test database not ready");
            return database.db;
        }

        beforeAll(async () => {
            database = await createMigratedTestDatabase(
                testDatabaseUrl ?? "",
                "organization_provider_routes",
            );
            dbRef.current = database.db as unknown as Record<
                PropertyKey,
                unknown
            >;
            await databaseClient()
                .insert(users)
                .values([
                    { id: "org-user", email: "org@example.test", role: "org" },
                    { id: "manager", email: "manager@example.test" },
                    { id: "curator", email: "curator@example.test" },
                    { id: "member", email: "member@example.test" },
                ]);
        }, 120_000);

        afterAll(async () => {
            dbRef.current = null;
            await database?.dispose();
        }, 30_000);

        beforeEach(async () => {
            state.orgEnabled = true;
            state.idp = true;
            state.actorId = "manager";
            state.email = "manager@example.test";
            state.capabilities = new Set(["use", "access.manage"]);
            await databaseClient().delete(aiUsageEvents);
            await databaseClient().delete(chatterItems);
            await databaseClient().delete(adminActionLog);
            await databaseClient().delete(apiCredentials);
        });

        it("allows managers, but not curators or plain members, to create providers", async () => {
            const manager = await createOrganizationProvider(
                request("POST", {
                    provider: "OpenAI",
                    apiKey: "manager-secret",
                }),
            );
            expect(manager.status).toBe(200);

            state.actorId = "curator";
            state.email = "curator@example.test";
            state.capabilities = new Set(["use", "org.curate"]);
            expect(
                (
                    await createOrganizationProvider(
                        request("POST", {
                            provider: "OpenAI",
                            apiKey: "curator-secret",
                        }),
                    )
                ).status,
            ).toBe(403);

            state.actorId = "member";
            state.email = "member@example.test";
            state.capabilities = new Set(["use"]);
            expect(
                (
                    await createOrganizationProvider(
                        request("POST", {
                            provider: "OpenAI",
                            apiKey: "member-secret",
                        }),
                    )
                ).status,
            ).toBe(403);
        });

        it("duplicates an Organization provider without decrypting its key", async () => {
            const sourceResponse = await createOrganizationProvider(
                request("POST", {
                    provider: "OpenAI",
                    apiKey: "source-secret",
                }),
            );
            const source = await sourceResponse.json();
            const response = await createOrganizationProvider(
                request("POST", {
                    provider: "OpenAI",
                    copyKeyFrom: source.provider.id,
                    defaultModel: "gpt-4o",
                }),
            );
            const duplicate = await response.json();
            expect(response.status).toBe(200);

            const [sourceRow] = await databaseClient()
                .select()
                .from(apiCredentials)
                .where(eq(apiCredentials.id, source.provider.id));
            const [duplicateRow] = await databaseClient()
                .select()
                .from(apiCredentials)
                .where(eq(apiCredentials.id, duplicate.provider.id));
            expect(duplicateRow?.apiKey).toBe(sourceRow?.apiKey);
            expect(duplicateRow?.userId).toBe("org-user");

            const [audit] = await databaseClient()
                .select()
                .from(adminActionLog)
                .where(
                    eq(adminActionLog.targetResourceId, duplicate.provider.id),
                );
            expect(audit?.action).toBe("org_provider.create");
        });

        it("refuses to duplicate a personal provider into the Organization", async () => {
            await databaseClient().insert(apiCredentials).values({
                id: "personal-source",
                userId: "manager",
                provider: "OpenAI",
                apiKey: "encrypted:personal-secret",
            });
            const response = await createOrganizationProvider(
                request("POST", {
                    provider: "OpenAI",
                    copyKeyFrom: "personal-source",
                }),
            );
            expect(response.status).toBe(404);
        });

        it("refuses to duplicate an Organization key across providers", async () => {
            const sourceResponse = await createOrganizationProvider(
                request("POST", { provider: "OpenAI", apiKey: "secret" }),
            );
            const source = await sourceResponse.json();
            const response = await createOrganizationProvider(
                request("POST", {
                    provider: "Groq",
                    copyKeyFrom: source.provider.id,
                }),
            );
            expect(response.status).toBe(400);
            expect((await response.json()).details).toEqual({
                field: "provider",
            });
        });

        it("refuses Organization duplication by a non-manager", async () => {
            const sourceResponse = await createOrganizationProvider(
                request("POST", { provider: "OpenAI", apiKey: "secret" }),
            );
            const source = await sourceResponse.json();
            state.actorId = "member";
            state.email = "member@example.test";
            state.capabilities = new Set(["use"]);
            const response = await createOrganizationProvider(
                request("POST", {
                    provider: "OpenAI",
                    copyKeyFrom: source.provider.id,
                }),
            );
            expect(response.status).toBe(403);
        });

        it("allows only the organization account to mutate in local mode", async () => {
            state.idp = false;
            state.actorId = "member";
            state.email = "member@example.test";
            state.capabilities = new Set(["use"]);
            expect(
                (
                    await createOrganizationProvider(
                        request("POST", {
                            provider: "OpenAI",
                            apiKey: "secret",
                        }),
                    )
                ).status,
            ).toBe(403);

            state.actorId = "org-user";
            state.email = "org@example.test";
            const response = await createOrganizationProvider(
                request("POST", { provider: "OpenAI", apiKey: "secret" }),
            );
            expect(response.status).toBe(200);
        });

        it("lets a member read the write-only list and returns 404 when scope is disabled", async () => {
            await createOrganizationProvider(
                request("POST", { provider: "OpenAI", apiKey: "read-secret" }),
            );
            state.actorId = "member";
            state.email = "member@example.test";
            state.capabilities = new Set(["use"]);
            const response = await listOrganizationProviders(request("GET"));
            const body = await response.json();
            expect(response.status).toBe(200);
            expect(body.providers).toHaveLength(1);
            expect(JSON.stringify(body)).not.toContain("read-secret");
            expect(JSON.stringify(body)).not.toContain("apiKey");

            state.orgEnabled = false;
            expect(
                (await listOrganizationProviders(request("GET"))).status,
            ).toBe(404);
        });

        it("never returns or audits the key and logs every mutation", async () => {
            const createdResponse = await createOrganizationProvider(
                request("POST", {
                    provider: "OpenAI",
                    apiKey: "never-log-this",
                    baseUrl: "https://api.openai.com/v1",
                    defaultModel: "gpt-4o-mini",
                }),
            );
            const created = await createdResponse.json();
            const id = created.provider.id as string;
            expect(JSON.stringify(created)).not.toContain("never-log-this");
            expect(JSON.stringify(created)).not.toContain("apiKey");

            await updateOrganizationProvider(
                request("PUT", { defaultModel: "gpt-4o" }, `/${id}`),
                context(id),
            );
            await updateOrganizationProvider(
                request("PUT", { disabled: true }, `/${id}`),
                context(id),
            );
            await updateOrganizationProvider(
                request("PUT", { disabled: false }, `/${id}`),
                context(id),
            );
            await deleteOrganizationProvider(
                request("DELETE", undefined, `/${id}`),
                context(id),
            );

            const audit = await databaseClient()
                .select()
                .from(adminActionLog)
                .where(eq(adminActionLog.targetResourceId, id))
                .orderBy(adminActionLog.createdAt);
            expect(audit.map((row) => row.action)).toEqual([
                "org_provider.create",
                "org_provider.update",
                "org_provider.disable",
                "org_provider.enable",
                "org_provider.delete",
            ]);
            expect(audit.every((row) => row.adminUserId === "manager")).toBe(
                true,
            );
            expect(JSON.stringify(audit)).not.toContain("never-log-this");
            expect(JSON.stringify(audit)).not.toContain("apiKey");
        });

        it("audits local Organization-account mutations through personal provider routes", async () => {
            state.idp = false;
            state.actorId = "org-user";
            state.email = "org@example.test";
            const createdResponse = await createPersonalProvider(
                request("POST", { provider: "OpenAI", apiKey: "secret" }),
            );
            const created = await createdResponse.json();
            const id = created.provider.id as string;

            await updatePersonalProvider(
                request("PUT", { defaultModel: "gpt-4o-mini" }, `/${id}`),
                context(id),
            );
            await deletePersonalProvider(
                request("DELETE", undefined, `/${id}`),
                context(id),
            );

            const audit = await databaseClient()
                .select()
                .from(adminActionLog)
                .where(eq(adminActionLog.targetResourceId, id))
                .orderBy(adminActionLog.createdAt);
            expect(audit.map((row) => row.action)).toEqual([
                "org_provider.create",
                "org_provider.update",
                "org_provider.delete",
            ]);
        });

        it("disables and enables only the signed-in user's personal provider", async () => {
            await databaseClient().insert(apiCredentials).values({
                id: "personal-toggle",
                userId: "manager",
                provider: "OpenAI",
                apiKey: "encrypted:secret",
            });

            const disabled = await updatePersonalProvider(
                request("PUT", { disabled: true }, "/personal-toggle"),
                context("personal-toggle"),
            );
            expect(disabled.status).toBe(200);
            const [disabledRow] = await databaseClient()
                .select()
                .from(apiCredentials)
                .where(eq(apiCredentials.id, "personal-toggle"));
            expect(disabledRow?.disabledAt).toBeInstanceOf(Date);

            const enabled = await updatePersonalProvider(
                request("PUT", { disabled: false }, "/personal-toggle"),
                context("personal-toggle"),
            );
            expect(enabled.status).toBe(200);
            const [enabledRow] = await databaseClient()
                .select()
                .from(apiCredentials)
                .where(eq(apiCredentials.id, "personal-toggle"));
            expect(enabledRow?.disabledAt).toBeNull();

            state.actorId = "member";
            state.email = "member@example.test";
            const foreign = await updatePersonalProvider(
                request("PUT", { disabled: true }, "/personal-toggle"),
                context("personal-toggle"),
            );
            expect(foreign.status).toBe(404);
        });

        it("summarizes organization-paid usage per member", async () => {
            await databaseClient()
                .insert(chatterItems)
                .values([
                    {
                        id: "item-manager",
                        userId: "manager",
                        kind: "audio",
                        title: "encrypted",
                        occurredAt: new Date(),
                    },
                    {
                        id: "item-member",
                        userId: "member",
                        kind: "audio",
                        title: "encrypted",
                        occurredAt: new Date(),
                    },
                ]);
            await databaseClient()
                .insert(aiUsageEvents)
                .values([
                    {
                        itemId: "item-manager",
                        userId: "manager",
                        actorUserId: "member",
                        payerUserId: "org-user",
                        operation: "summary",
                        provider: "OpenAI",
                        model: "gpt-4o-mini",
                        costUsd: "0.100000000",
                    },
                    {
                        itemId: "item-member",
                        userId: "member",
                        actorUserId: "manager",
                        payerUserId: "org-user",
                        operation: "topics",
                        provider: "OpenAI",
                        model: "gpt-4o-mini",
                        costUsd: "0.250000000",
                    },
                    {
                        itemId: "item-member",
                        userId: "member",
                        actorUserId: null,
                        payerUserId: "org-user",
                        operation: "title",
                        provider: "OpenAI",
                        model: "gpt-4o-mini",
                        costUsd: null,
                    },
                ]);

            const response = await organizationProviderUsage(
                request("GET", undefined, "/usage"),
            );
            const body = await response.json();
            expect(response.status).toBe(200);
            expect(body.members).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        userId: "manager",
                        calls: 1,
                        estimatedCostUsd: "0.250000000",
                    }),
                    expect.objectContaining({
                        userId: "member",
                        calls: 2,
                        estimatedCostUsd: "0.100000000",
                    }),
                ]),
            );
        });
    },
);
