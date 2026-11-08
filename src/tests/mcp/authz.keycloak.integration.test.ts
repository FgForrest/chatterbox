/**
 * The MCP server with identity-provider authorization, against a realm the
 * test fixture imported and tokens Keycloak issued:
 *
 * - a person is the account linked to their issuer and `sub`, and needs a
 *   verified `use`; a person who never signed in is refused, never taken
 *   for a service;
 * - a service is only a marked token of a configured service-only client,
 *   and sees the Organization's shared data alone;
 * - the web sign-in token and an ID token are never MCP credentials;
 * - a permission taken away hides its tools and refuses a direct call with
 *   `insufficient_scope`; a client asking for the scopes the metadata
 *   lists gets them, and one it may not have is refused by the realm.
 *
 * Opt-in: `TEST_DATABASE_URL` and `KEYCLOAK_TEST_ISSUER`.
 */

import { and, eq, inArray, isNull } from "drizzle-orm";
import { decodeJwt } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
    agendaPoints,
    agendaSuggestions,
    agendaTasks,
    chatterItems,
    meetingAgendas,
    recordingFolderAssignments,
    recordingFolders,
    recordingTasks,
    userAccessStates,
    users,
} from "@/db/schema";
import { adminPath } from "@/lib/identity/providers/keycloak/http";
import { keycloakLogin } from "@/tests/authz/keycloak-login";
import {
    keycloakTestBase,
    provisionTestRealm,
    type TestRealm,
} from "@/tests/identity/keycloak-fixture";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";
import {
    insertRecording,
    insertTask,
    shareRecording,
} from "@/tests/mcp/fixtures";

const REALM = "chb-mcp-it";

const { dbProxy, dbRef, mockEnv } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    const proxy = new Proxy(
        {},
        {
            get: (_target, property: string | symbol) => {
                const current = ref.current;
                if (!current)
                    throw new Error("test database was not initialized");
                const value = current[property];
                return typeof value === "function"
                    ? value.bind(current)
                    : value;
            },
        },
    );
    const issuer = process.env.KEYCLOAK_TEST_ISSUER
        ? `${new URL(process.env.KEYCLOAK_TEST_ISSUER).origin}/realms/chb-mcp-it`
        : undefined;
    return {
        dbProxy: proxy,
        dbRef: ref,
        mockEnv: {
            IS_HOSTED: false,
            BILLING_ENABLED: undefined as boolean | undefined,
            SELF_HOST_MODE: "shared" as "shared" | "local",
            ORG_ACCOUNT_EMAIL: "org@example.test" as string | undefined,
            ORG_ACCOUNT_PASSWORD: undefined as string | undefined,
            ORG_ACCOUNT_NAME: undefined as string | undefined,
            OIDC_ISSUER_URL: issuer,
            OIDC_CLIENT_ID: "chatterbox",
            OIDC_CLIENT_SECRET: "chatterbox-mcp-it-secret",
            OIDC_PROVIDER_NAME: "Keycloak",
            OIDC_SCOPES: ["openid", "profile", "email"],
            OIDC_SESSION_MAX_AGE: 24 * 60 * 60,
            DISABLE_REGISTRATION: false,
            APP_URL: "http://localhost:3000",
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            DATABASE_URL: "postgres://unused",
            KNOWLEDGE_MEMORY_MB: 64,
            RATE_LIMIT_TRUST_PROXY_HEADERS: true,
            MCP_AUDIENCE: "chatterbox-mcp",
            MCP_ALLOWED_CLIENTS: ["mcp-tester", "claude", "chatterbox-bot"],
            MCP_SERVICE_CLIENTS: ["chatterbox-bot"] as string[],
            MCP_PUBLIC_INGRESS_HEADER: undefined as string | undefined,
            MCP_PUBLIC_CLIENTS: [] as string[],
            MCP_CONNECTOR_KEYS: [] as { client: string; key: string }[],
            MCP_RESOURCE_AUDIENCE: undefined as boolean | undefined,
            AUTHZ_MODE: "idp" as "idp" | "local",
            IDENTITY_PROVIDER: "keycloak" as const,
            KEYCLOAK_ROLES_CLIENT: undefined as string | undefined,
            KEYCLOAK_GROUP_USE_ID: undefined as string | undefined,
            KEYCLOAK_GROUP_CURATE_ID: undefined as string | undefined,
            KEYCLOAK_GROUP_ACCESS_MANAGE_ID: undefined as string | undefined,
            KEYCLOAK_VERIFIER_CLIENT_ID: "chatterbox-verifier" as
                | string
                | undefined,
            KEYCLOAK_VERIFIER_CLIENT_SECRET: "chatterbox-mcp-it-verifier" as
                | string
                | undefined,
            AUTHZ_VERIFICATION_MAX_AGE: 1800,
            AUTHZ_ADMIN_MAX_AUTH_AGE: 8 * 3600,
        },
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/hosted/billing/cycle-close", () => ({
    closeCycleForUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/notifications/email", () => ({
    sendEmailChangeConfirm: vi.fn(),
    sendPasswordResetEmail: vi.fn(),
    sendVerifyEmail: vi.fn(),
}));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from "@/app/api/mcp/route";
import { auth } from "@/lib/auth";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { ensureRootFolders } from "@/lib/folders/folders";
import { addAlias } from "@/lib/knowledge/aliases";
import { confirmManualFact } from "@/lib/knowledge/facts";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { createPerson } from "@/lib/knowledge/people";
import {
    createOrgType,
    createPrivateType,
    seedCoreVocabulary,
} from "@/lib/knowledge/vocabulary";
import { ensureOrgAccount } from "@/lib/org/account";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithKeycloak =
    testDatabaseUrl && keycloakTestBase() ? describe : describe.skip;

const KNOWLEDGE_TOOLS = [
    "find_knowledge",
    "get_entity",
    "get_facts",
    "list_knowledge",
    "list_mishearings",
    "list_types",
];
const RECORDING_TOOLS = [
    "list_folders",
    "list_recordings",
    "list_attended_recordings",
];
const TRANSCRIPT_TOOLS = ["get_transcript", "search_transcripts"];
const TASK_READ_TOOLS = ["list_tasks", "search_tasks"];
const MEETING_READ_TOOLS = ["get_meeting", "list_meetings"];

function post(token: string, body: unknown): Request {
    return new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "x-real-ip": "203.0.113.9",
            authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
    });
}

async function toolNames(token: string): Promise<string[]> {
    const response = await POST(
        post(token, { jsonrpc: "2.0", id: 1, method: "tools/list" }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
        result: { tools: { name: string }[] };
    };
    return body.result.tools.map((tool) => tool.name).sort();
}

function callTool(token: string, name: string, args: object = {}) {
    return POST(
        post(token, {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name, arguments: args },
        }),
    );
}

describeWithKeycloak("MCP with identity-provider authorization", () => {
    let database: TestPostgresDatabase | null = null;
    let realm: TestRealm;
    const ids: Record<string, string> = {};

    async function serviceResult(name: string, args: object = {}) {
        const token = (await realm.clientToken("chatterbox-bot")).access_token;
        const response = await callTool(token, name, args);
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.result.isError).toBeUndefined();
        return body.result.structuredContent;
    }

    async function serviceNotFound(name: string, args: object) {
        const token = (await realm.clientToken("chatterbox-bot")).access_token;
        const response = await callTool(token, name, args);
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.result).toMatchObject({
            isError: true,
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        error: `No match for ${JSON.stringify(Object.values(args)[0])}`,
                    }),
                },
            ],
        });
    }

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    async function testerToken(username: string, scope = "openid") {
        const person = realm.people[username];
        if (!person) throw new Error(`no person ${username}`);
        return (await realm.passwordToken("mcp-tester", person, { scope }))
            .access_token;
    }

    async function userId(username: string): Promise<string> {
        const [row] = await db()
            .select({ id: users.id })
            .from(users)
            .where(eq(users.email, `${username}@example.test`))
            .limit(1);
        if (!row) throw new Error(`no local user ${username}`);
        return row.id;
    }

    beforeAll(async () => {
        realm = await provisionTestRealm(
            "mcp",
            {
                ann: ["use"],
                stranger: ["use"],
                admin: ["use", "access.manage"],
                curator: ["use", "org.curate"],
            },
            {
                realmName: REALM,
                secrets: {
                    chatterbox: "chatterbox-mcp-it-secret",
                    "chatterbox-verifier": "chatterbox-mcp-it-verifier",
                },
            },
        );
        mockEnv.KEYCLOAK_GROUP_USE_ID = realm.groupIds.use;
        mockEnv.KEYCLOAK_GROUP_CURATE_ID = realm.groupIds["org.curate"];
        mockEnv.KEYCLOAK_GROUP_ACCESS_MANAGE_ID =
            realm.groupIds["access.manage"];
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "mcp_authz",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        const orgUserId = await ensureOrgAccount();
        if (!orgUserId) throw new Error("organization account missing");
        const person = realm.people.ann;
        if (!person) throw new Error("no ann");
        expect((await keycloakLogin(auth.handler, person)).location).toBe(
            "/dashboard",
        );
        const curator = realm.people.curator;
        if (!curator) throw new Error("no curator");
        expect((await keycloakLogin(auth.handler, curator)).location).toBe(
            "/dashboard",
        );
        const ann = await userId("ann");
        await ensureRootFolders(ann);
        await insertRecording(db(), {
            id: "ann-private",
            userId: ann,
            title: "Private call",
            startTime: new Date("2026-09-05T10:00:00Z"),
        });
        await insertRecording(db(), {
            id: "ann-shared",
            userId: ann,
            title: "Launch review",
            startTime: new Date("2026-09-06T10:00:00Z"),
        });
        await shareRecording(db(), "ann-shared", orgUserId);
        ids.privateTask = await insertTask(db(), {
            userId: ann,
            recordingId: "ann-private",
            text: "Review private material",
        });
        ids.sharedTask = await insertTask(db(), {
            userId: ann,
            recordingId: "ann-shared",
            text: "Review shared material",
        });
        ids.privatePerson = (
            await createPerson({ userId: ann, displayName: "Private Person" })
        ).id;
        ids.sharedPerson = (
            await createPerson({
                userId: orgUserId,
                displayName: "Shared Person",
            })
        ).id;
        await addAlias(ann, { personId: ids.sharedPerson }, "Private nickname");
        await seedCoreVocabulary();
        ids.privateFact = await confirmManualFact(ann, {
            subject: { personId: ids.sharedPerson },
            relationKey: "has_role",
            object: { literal: "Private role" },
        });
        ids.sharedFact = await confirmManualFact(orgUserId, {
            subject: { personId: ids.sharedPerson },
            relationKey: "has_role",
            object: { literal: "Shared role" },
        });
        ids.privateType = await createPrivateType(ann, {
            kind: "entity",
            label: "Private category",
        });
        ids.sharedType = await createOrgType(await userId("curator"), {
            kind: "entity",
            label: "Shared category",
        });
        const folders = await db()
            .select()
            .from(recordingFolders)
            .where(
                and(
                    isNull(recordingFolders.parentId),
                    eq(recordingFolders.userId, orgUserId),
                ),
            );
        const orgRoot = folders[0];
        if (!orgRoot) throw new Error("missing Organization root");
        const [privateFolder] = await db()
            .insert(recordingFolders)
            .values({
                userId: ann,
                name: encryptText("Private folder"),
                nameHash: lookupHash("Private folder"),
                kind: "custom",
            })
            .returning();
        if (!privateFolder) throw new Error("missing private folder");
        ids.privateFolder = privateFolder.id;
        ids.sharedFolder = orgRoot.id;
        for (const scope of ["private", "shared"] as const) {
            const itemId = `${scope}-meeting-item`;
            const agendaId = `${scope}-agenda`;
            ids[`${scope}Meeting`] = agendaId;
            await db()
                .insert(chatterItems)
                .values({
                    id: itemId,
                    userId: ann,
                    kind: "meeting",
                    occurredAt: new Date("2026-11-03T10:00:00Z"),
                    title: encryptText(`${scope} meeting`),
                });
            await db()
                .insert(meetingAgendas)
                .values({ id: agendaId, userId: ann, meetingItemId: itemId });
            await db()
                .insert(recordingFolderAssignments)
                .values({
                    userId: ann,
                    itemId,
                    folderId:
                        scope === "shared" ? orgRoot.id : privateFolder.id,
                });
            await db()
                .insert(agendaPoints)
                .values({
                    id: `${scope}-point`,
                    userId: ann,
                    agendaId,
                    text: encryptText(`${scope} discussion`),
                    authorUserId: ann,
                });
            await db()
                .insert(agendaSuggestions)
                .values({
                    id: `${scope}-suggestion`,
                    userId: ann,
                    agendaId,
                    kind: "ai",
                    text: encryptText(`${scope} suggestion`),
                    sources: { itemIds: [], taskIds: [] },
                });
        }
        await db().insert(recordingFolderAssignments).values({
            userId: ann,
            itemId: "shared-meeting-item",
            folderId: privateFolder.id,
        });
        await db()
            .insert(agendaTasks)
            .values([
                {
                    userId: ann,
                    agendaId: ids.sharedMeeting,
                    taskId: ids.sharedTask,
                    origin: "older",
                },
                {
                    userId: ann,
                    agendaId: ids.sharedMeeting,
                    taskId: ids.privateTask,
                    origin: "older",
                },
            ]);
    }, 240_000);

    afterAll(async () => {
        vi.restoreAllMocks();
        dbRef.current = null;
        await database?.dispose();
        await realm?.dispose();
    }, 60_000);

    it("serves a signed-in person with use by their linked account", async () => {
        expect(await toolNames(await testerToken("ann"))).toEqual(
            [
                ...KNOWLEDGE_TOOLS,
                ...RECORDING_TOOLS,
                ...TRANSCRIPT_TOOLS,
            ].sort(),
        );
        const response = await callTool(
            await testerToken("ann"),
            "list_recordings",
        );
        const body = (await response.json()) as {
            result: { structuredContent: { recordings: { id: string }[] } };
        };
        expect(
            body.result.structuredContent.recordings.map((r) => r.id).sort(),
        ).toEqual(["ann-private", "ann-shared"]);
    });

    it("refuses a person who never signed in, never treating them as a service", async () => {
        const response = await POST(
            post(await testerToken("stranger"), {
                jsonrpc: "2.0",
                id: 1,
                method: "tools/list",
            }),
        );
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({
            error: "Sign in to Chatterbox once first",
        });
    });

    it("writes a note only with the existing tasks:write permission scope", async () => {
        const ann = await userId("ann");
        const [task] = await db()
            .insert(recordingTasks)
            .values({
                userId: ann,
                source: "personal",
                status: "open",
                text: encryptText("Private reminder"),
            })
            .returning({ id: recordingTasks.id });
        if (!task) throw new Error("missing task");
        const args = {
            task: task.id,
            version: 0,
            note: "Shipped in release X",
        };
        const denied = await callTool(
            await testerToken("ann"),
            "update_task",
            args,
        );
        expect(denied.status).toBe(403);
        expect(denied.headers.get("WWW-Authenticate")).toContain(
            'error="insufficient_scope", scope="tasks:write"',
        );

        const { http } = realm.admin;
        const [client] = await http.get<{ id: string }[]>(adminPath`/clients`, {
            clientId: "mcp-tester",
        });
        const scopes =
            await http.get<{ id: string; name: string }[]>(
                adminPath`/client-scopes`,
            );
        const write = scopes.find((scope) => scope.name === "tasks:write");
        if (!client || !write) throw new Error("missing task write scope");
        const path = adminPath`/clients/${client.id}/optional-client-scopes/${write.id}`;
        await http.put(path);
        try {
            const token = await testerToken("ann", "openid tasks:write");
            const response = await callTool(token, "update_task", args);
            expect(response.status).toBe(200);
            const body = await response.json();
            expect(body.result).toMatchObject({
                structuredContent: {
                    task: {
                        note: args.note,
                        note_by: { id: ann },
                        note_updated_at: expect.any(String),
                        version: 1,
                    },
                },
            });
            const [stored] = await db()
                .select()
                .from(recordingTasks)
                .where(eq(recordingTasks.id, task.id));
            expect(decryptText(stored?.note ?? "")).toBe(args.note);
            expect(stored?.noteUpdatedByUserId).toBe(ann);
        } finally {
            await http.delete(path);
        }
    });

    it("serves the marked service client with the Organization's shared data only", async () => {
        const bot = (await realm.clientToken("chatterbox-bot")).access_token;
        expect(await toolNames(bot)).toEqual(
            [
                ...KNOWLEDGE_TOOLS,
                ...RECORDING_TOOLS,
                ...TASK_READ_TOOLS,
                ...MEETING_READ_TOOLS,
            ].sort(),
        );
        const response = await callTool(bot, "list_recordings");
        const body = (await response.json()) as {
            result: {
                structuredContent: {
                    recordings: { id: string; view: string }[];
                };
            };
        };
        expect(body.result.structuredContent.recordings).toEqual([
            expect.objectContaining({ id: "ann-shared", view: "org" }),
        ]);
        const write = await callTool(bot, "update_task", {});
        expect(write.status).toBe(403);
    });

    it("keeps every knowledge tool in the service client's Organization scope", async () => {
        const types = await serviceResult("list_types");
        expect(types.entity_types).toContainEqual(
            expect.objectContaining({ key: ids.sharedType, layer: "org" }),
        );
        expect(types.entity_types).not.toContainEqual(
            expect.objectContaining({ key: ids.privateType }),
        );
        const knowledge = await serviceResult("list_knowledge");
        expect(knowledge.items).toContainEqual(
            expect.objectContaining({ id: ids.sharedPerson, scope: "org" }),
        );
        expect(knowledge.items).not.toContainEqual(
            expect.objectContaining({ id: ids.privatePerson }),
        );
        expect(
            await serviceResult("find_knowledge", { text: "Shared Person" }),
        ).toMatchObject({
            items: [expect.objectContaining({ id: ids.sharedPerson })],
        });
        expect(
            await serviceResult("find_knowledge", { text: "Private Person" }),
        ).toMatchObject({ items: [] });
        const person = await serviceResult("get_entity", {
            entity: ids.sharedPerson,
        });
        expect(person).toMatchObject({
            id: ids.sharedPerson,
            scope: "org",
            other_names: [],
        });
        expect(JSON.stringify(person)).not.toContain("Private nickname");
        expect(
            await serviceResult("get_facts", { entity: ids.sharedPerson }),
        ).toMatchObject({
            facts: [
                expect.objectContaining({
                    id: ids.sharedFact,
                    object: { literal: "Shared role" },
                }),
            ],
        });
        await serviceNotFound("get_entity", { entity: ids.privatePerson });
        await serviceNotFound("get_facts", { entity: ids.privatePerson });
        expect(await serviceResult("list_mishearings")).toMatchObject({
            items: [],
        });
        await serviceNotFound("list_mishearings", {
            entity: ids.privatePerson,
        });
    });

    it("keeps folder and task reads in the service client's Organization scope", async () => {
        const folders = await serviceResult("list_folders");
        expect(folders.folders).toEqual([
            expect.objectContaining({ id: ids.sharedFolder, scope: "org" }),
        ]);
        for (const name of TASK_READ_TOOLS) {
            const result = await serviceResult(
                name,
                name === "search_tasks" ? { query: "Review" } : {},
            );
            expect(result.tasks).toEqual([
                expect.objectContaining({ id: ids.sharedTask }),
            ]);
            expect(JSON.stringify(result)).not.toContain(ids.privateTask);
        }
        await serviceNotFound("list_tasks", { recording: "ann-private" });
    });

    it("omits suggestions with private or withdrawn recording and task sources through a service token (#324)", async () => {
        const ann = await userId("ann");
        await db()
            .insert(agendaSuggestions)
            .values(
                [
                    {
                        id: "private-recording-suggestion",
                        sources: { itemIds: ["ann-private"], taskIds: [] },
                    },
                    {
                        id: "private-task-suggestion",
                        sources: { itemIds: [], taskIds: [ids.privateTask] },
                    },
                    {
                        id: "mixed-suggestion",
                        sources: {
                            itemIds: ["ann-shared", "ann-private"],
                            taskIds: [ids.sharedTask],
                        },
                    },
                    {
                        id: "visible-suggestion",
                        sources: {
                            itemIds: ["ann-shared"],
                            taskIds: [ids.sharedTask],
                        },
                    },
                ].map((row) => ({
                    ...row,
                    userId: ann,
                    agendaId: ids.sharedMeeting,
                    kind: "ai" as const,
                    text: encryptText(row.id),
                })),
            );
        try {
            const result = await serviceResult("get_meeting", {
                meetingId: ids.sharedMeeting,
            });
            expect(
                result.meeting.suggestions
                    .map((row: { id: string }) => row.id)
                    .sort(),
            ).toEqual(["shared-suggestion", "visible-suggestion"]);
            const placements = await db()
                .delete(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.itemId, "ann-shared"))
                .returning();
            try {
                const withdrawn = await serviceResult("get_meeting", {
                    meetingId: ids.sharedMeeting,
                });
                expect(withdrawn.meeting.suggestions).toMatchObject([
                    { id: "shared-suggestion" },
                ]);
            } finally {
                await db()
                    .insert(recordingFolderAssignments)
                    .values(placements);
            }
        } finally {
            await db()
                .delete(agendaSuggestions)
                .where(
                    and(
                        eq(agendaSuggestions.agendaId, ids.sharedMeeting),
                        inArray(agendaSuggestions.id, [
                            "private-recording-suggestion",
                            "private-task-suggestion",
                            "mixed-suggestion",
                            "visible-suggestion",
                        ]),
                    ),
                );
        }
    });

    it("conceals both private task source pointers through a service token (#324)", async () => {
        await db()
            .update(meetingAgendas)
            .set({
                taskSourceItemId: "ann-private",
                snapshotSourceItemId: "ann-private",
            })
            .where(eq(meetingAgendas.id, ids.sharedMeeting));
        try {
            const result = await serviceResult("get_meeting", {
                meetingId: ids.sharedMeeting,
            });
            expect(result.meeting).toMatchObject({
                taskSource: null,
                taskSourceItemId: null,
                snapshotSourceItemId: null,
            });
        } finally {
            await db()
                .update(meetingAgendas)
                .set({ taskSourceItemId: null, snapshotSourceItemId: null })
                .where(eq(meetingAgendas.id, ids.sharedMeeting));
        }
    });

    it("counts only visible agenda tasks through a service token (#324)", async () => {
        const detail = await serviceResult("get_meeting", {
            meetingId: ids.sharedMeeting,
        });
        const listed = await serviceResult("list_meetings");
        expect(detail.meeting.tasks).toHaveLength(1);
        expect(listed.meetings).toMatchObject([
            { id: ids.sharedMeeting, counts: { tasks: 1 } },
        ]);
    });

    it("lists and reads shared agendas through the service token without private meetings or tasks (#293)", async () => {
        const listed = await serviceResult("list_meetings");
        expect(JSON.stringify(listed)).not.toContain("Private folder");
        expect(listed.meetings).toEqual([
            expect.objectContaining({
                id: ids.sharedMeeting,
                title: "shared meeting",
            }),
        ]);
        expect(
            await serviceResult("list_meetings", {
                folderId: ids.privateFolder,
            }),
        ).toMatchObject({ meetings: [] });
        expect(
            await serviceResult("list_meetings", {
                folderId: ids.sharedFolder,
            }),
        ).toMatchObject({
            meetings: [expect.objectContaining({ id: ids.sharedMeeting })],
        });
        const detail = await serviceResult("get_meeting", {
            meetingId: ids.sharedMeeting,
        });
        expect(detail.meeting).toMatchObject({
            id: ids.sharedMeeting,
            title: "shared meeting",
            points: [expect.objectContaining({ text: "shared discussion" })],
            suggestions: [
                expect.objectContaining({ text: "shared suggestion" }),
            ],
            tasks: [expect.objectContaining({ id: ids.sharedTask })],
        });
        expect(JSON.stringify(detail)).not.toContain("Private folder");
        expect(JSON.stringify(detail)).not.toContain(ids.privateFolder);
        expect(JSON.stringify(detail)).not.toContain(ids.privateTask);
        expect(JSON.stringify(detail)).not.toContain("Review private material");
        const bot = (await realm.clientToken("chatterbox-bot")).access_token;
        for (const meetingId of [
            ids.privateMeeting,
            "private-meeting-item",
            "missing-meeting",
        ]) {
            const response = await callTool(bot, "get_meeting", { meetingId });
            expect(response.status).toBe(200);
            expect((await response.json()).result).toMatchObject({
                isError: true,
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ error: "Meeting not found" }),
                    },
                ],
            });
        }
        await db()
            .delete(recordingFolderAssignments)
            .where(
                and(
                    eq(
                        recordingFolderAssignments.itemId,
                        "shared-meeting-item",
                    ),
                    eq(recordingFolderAssignments.folderId, ids.sharedFolder),
                ),
            );
        expect(await serviceResult("list_meetings")).toMatchObject({
            meetings: [],
        });
        const revoked = await callTool(bot, "get_meeting", {
            meetingId: ids.sharedMeeting,
        });
        expect((await revoked.json()).result).toMatchObject({
            isError: true,
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ error: "Meeting not found" }),
                },
            ],
        });
    });

    it("does not take a client token for a service unless the client is listed", async () => {
        mockEnv.MCP_SERVICE_CLIENTS = [];
        try {
            const bot = (await realm.clientToken("chatterbox-bot"))
                .access_token;
            const response = await POST(
                post(bot, { jsonrpc: "2.0", id: 1, method: "tools/list" }),
            );
            expect(response.status).toBe(403);
        } finally {
            mockEnv.MCP_SERVICE_CLIENTS = ["chatterbox-bot"];
        }
    });

    it("never accepts the web sign-in token or an ID token", async () => {
        const web = await realm.passwordToken(
            "chatterbox",
            realm.people.admin ?? (undefined as never),
        );
        expect(
            (
                decodeJwt(web.access_token).resource_access as Record<
                    string,
                    unknown
                >
            )["realm-management"],
        ).toBeDefined();
        const webResponse = await POST(
            post(web.access_token, {
                jsonrpc: "2.0",
                id: 1,
                method: "tools/list",
            }),
        );
        expect(webResponse.status).toBe(403);

        const tester = await realm.passwordToken(
            "mcp-tester",
            realm.people.ann ?? (undefined as never),
        );
        const idResponse = await POST(
            post(tester.id_token ?? "", {
                jsonrpc: "2.0",
                id: 1,
                method: "tools/list",
            }),
        );
        expect(idResponse.status).toBe(401);
    });

    it("hides a permission taken away and answers a direct call with insufficient_scope", async () => {
        const { http } = realm.admin;
        const [client] = await http.get<{ id: string }[]>(adminPath`/clients`, {
            clientId: "mcp-tester",
        });
        const scopes = await http.get<{ id: string; name: string }[]>(
            adminPath`/clients/${client?.id ?? ""}/default-client-scopes`,
        );
        const transcript = scopes.find(
            (scope) => scope.name === "transcripts:read",
        );
        if (!client || !transcript) throw new Error("Missing tester scope");
        const path = adminPath`/clients/${client.id}/default-client-scopes/${transcript.id}`;
        await http.delete(path);
        try {
            const token = await testerToken("ann");
            expect(await toolNames(token)).not.toContain("get_transcript");
            const response = await callTool(token, "get_transcript", {
                recording_id: "ann-private",
            });
            expect(response.status).toBe(403);
            expect(response.headers.get("WWW-Authenticate")).toContain(
                'error="insufficient_scope", scope="transcripts:read"',
            );
        } finally {
            await http.put(path);
        }
    });

    it("refuses a person whose access was withdrawn, and answers 503 while it cannot be verified", async () => {
        const ann = await userId("ann");
        await db()
            .update(userAccessStates)
            .set({ capabilities: [], source: "access-change" })
            .where(eq(userAccessStates.userId, ann));
        const withdrawn = await POST(
            post(await testerToken("ann"), {
                jsonrpc: "2.0",
                id: 1,
                method: "tools/list",
            }),
        );
        expect(withdrawn.status).toBe(403);
        expect(await withdrawn.json()).toEqual({
            error: "Your access to Chatterbox has been withdrawn",
        });

        await db()
            .update(userAccessStates)
            .set({ verifiedAt: new Date(Date.now() - 2 * 3600 * 1000) })
            .where(eq(userAccessStates.userId, ann));
        const token = await testerToken("ann");
        const realFetch = globalThis.fetch;
        vi.spyOn(globalThis, "fetch").mockImplementation(
            async (input, init) => {
                const url =
                    typeof input === "string"
                        ? input
                        : input instanceof URL
                          ? input.href
                          : input.url;
                if (url.includes("/admin/realms/"))
                    throw new TypeError("fetch failed");
                return realFetch(input, init);
            },
        );
        try {
            const unavailable = await POST(
                post(token, { jsonrpc: "2.0", id: 1, method: "tools/list" }),
            );
            expect(unavailable.status).toBe(503);
        } finally {
            vi.restoreAllMocks();
        }
        expect(await toolNames(token)).toContain("list_knowledge");
    });

    it("gives a client the permission scopes the metadata lists, within what it may have", async () => {
        const granted = await testerToken(
            "ann",
            "openid knowledge:read transcripts:read",
        );
        expect(String(decodeJwt(granted).scope).split(" ")).toEqual(
            expect.arrayContaining(["knowledge:read", "transcripts:read"]),
        );
        expect(await toolNames(granted)).toContain("get_transcript");

        await expect(testerToken("ann", "openid tasks:write")).rejects.toThrow(
            /400/,
        );
        expect([decodeJwt(granted).aud ?? []].flat()).toContain(
            "chatterbox-mcp",
        );
    });
});
