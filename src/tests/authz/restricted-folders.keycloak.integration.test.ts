import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as liftRoute } from "@/app/api/folders/[id]/lift/route";
import { POST as restrictRoute } from "@/app/api/folders/[id]/restrict/route";
import {
    PUT as speakersPut,
    GET as speakersRoute,
} from "@/app/api/recordings/[id]/speakers/route";
import { insertAudioItem } from "@/db/items";
import * as schema from "@/db/schema";
import {
    recordingFolderAssignments,
    recordingFolders,
    restrictedFolderMembers,
    userAccessStates,
    users,
} from "@/db/schema";
import { auth } from "@/lib/auth";
import { holderAccess } from "@/lib/authz/access-state";
import { encryptText } from "@/lib/encryption/fields";
import {
    addRecordingToFolder,
    assertCategorizableFolder,
    createFolder,
    ensureRootFolders,
} from "@/lib/folders/folders";
import { changeFolderRestriction } from "@/lib/folders/restricted-folders";
import { adminPath } from "@/lib/identity/providers/keycloak/http";
import { ensureOrgAccount } from "@/lib/org/account";
import { requestArrivalInTx } from "@/lib/pipeline/arrival";
import { resolveArrivalOrganizationContext } from "@/lib/pipeline/arrival-context";
import { resolveRecordingAccess } from "@/lib/sharing/access";
import { isRecordingShared } from "@/lib/sharing/shared";
import { keycloakLogin } from "@/tests/authz/keycloak-login";
import {
    keycloakTestBase,
    provisionTestRealm,
    TEST_APP_URL,
    type TestRealm,
} from "@/tests/identity/keycloak-fixture";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";
import { insertRecording, insertTranscript } from "@/tests/mcp/fixtures";

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
        ? `${new URL(process.env.KEYCLOAK_TEST_ISSUER).origin}/realms/chb-restricted-folders-it`
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
            OIDC_CLIENT_SECRET: "chatterbox-restricted-secret",
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
            AUTHZ_MODE: "idp" as "idp" | "local",
            IDENTITY_PROVIDER: "keycloak" as const,
            KEYCLOAK_ROLES_CLIENT: undefined as string | undefined,
            KEYCLOAK_GROUP_USE_ID: undefined as string | undefined,
            KEYCLOAK_GROUP_CURATE_ID: undefined as string | undefined,
            KEYCLOAK_GROUP_ACCESS_MANAGE_ID: undefined as string | undefined,
            KEYCLOAK_VERIFIER_CLIENT_ID: "chatterbox-verifier" as
                | string
                | undefined,
            KEYCLOAK_VERIFIER_CLIENT_SECRET: "chatterbox-restricted-verifier" as
                | string
                | undefined,
            AUTHZ_VERIFICATION_MAX_AGE: 1800,
            AUTHZ_ADMIN_MAX_AUTH_AGE: 8 * 3600,
            MCP_AUDIENCE: undefined as string | undefined,
            MCP_SERVICE_CLIENTS: [] as string[],
        },
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
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
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/org/events", () => ({
    notifyOrgChange: vi.fn().mockResolvedValue(undefined),
}));
const databaseUrl = getTestDatabaseUrl();
const suite = databaseUrl && keycloakTestBase() ? describe : describe.skip;
suite("restricted folders with verified Keycloak curators", () => {
    let database: TestPostgresDatabase;
    let realm: TestRealm;
    let orgId = "";
    let folderId = "";
    const cookies: Record<string, string> = {};
    const ids: Record<string, string> = {};
    beforeAll(async () => {
        realm = await provisionTestRealm(
            "restricted-folders",
            {
                owner: ["use"],
                member: ["use"],
                curator: ["use", "org.curate"],
                administrator: ["use", "access.manage"],
            },
            {
                realmName: "chb-restricted-folders-it",
                secrets: {
                    chatterbox: "chatterbox-restricted-secret",
                    "chatterbox-verifier": "chatterbox-restricted-verifier",
                },
            },
        );
        mockEnv.KEYCLOAK_GROUP_USE_ID = realm.groupIds.use;
        mockEnv.KEYCLOAK_GROUP_CURATE_ID = realm.groupIds["org.curate"];
        mockEnv.KEYCLOAK_GROUP_ACCESS_MANAGE_ID =
            realm.groupIds["access.manage"];
        database = await createMigratedTestDatabase(
            databaseUrl ?? "",
            "restricted_keycloak",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        orgId = (await ensureOrgAccount()) ?? "";
        for (const [username, person] of Object.entries(realm.people)) {
            const login = await keycloakLogin(auth.handler, person);
            expect(login.location).toBe("/dashboard");
            cookies[username] = login.cookie;
            const [user] = await database.db
                .select({ id: users.id })
                .from(users)
                .where(eq(users.email, `${username}@example.test`));
            ids[username] = user.id;
        }
        await ensureRootFolders(orgId);
        const [root] = await database.db
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, orgId));
        const parent = await createFolder({
            userId: orgId,
            parentId: root.id,
            name: "Acme",
            canCurate: true,
        });
        folderId = (
            await createFolder({
                userId: ids.owner,
                parentId: parent.id,
                name: "Beta",
                restricted: true,
            })
        ).id;
        await insertRecording(database.db, {
            id: "restricted-keycloak-recording",
            userId: ids.owner,
        });
        await insertTranscript(
            database.db,
            "restricted-keycloak-recording",
            ids.owner,
        );
        await addRecordingToFolder({
            userId: ids.owner,
            recordingId: "restricted-keycloak-recording",
            folderId,
        });
    }, 240000);
    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
        await realm?.dispose();
    }, 60000);
    function request(as: string, path: string, method = "GET", body?: object) {
        return new Request(`${TEST_APP_URL}${path}`, {
            method,
            headers: {
                cookie: cookies[as],
                origin: TEST_APP_URL,
                "content-type": "application/json",
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
    }
    it("lets a verified human curator read through received while access.manage grants no content", async () => {
        expect(
            (
                await resolveRecordingAccess(
                    ids.curator,
                    "restricted-keycloak-recording",
                )
            )?.role,
        ).toBe("receiver");
        const context = {
            params: Promise.resolve({ id: "restricted-keycloak-recording" }),
        };
        expect(
            (
                await speakersRoute(
                    request(
                        "curator",
                        "/api/recordings/restricted-keycloak-recording/speakers?view=received",
                    ),
                    context,
                )
            ).status,
        ).toBe(200);
        expect(
            (
                await speakersRoute(
                    request(
                        "administrator",
                        "/api/recordings/restricted-keycloak-recording/speakers?view=received",
                    ),
                    context,
                )
            ).status,
        ).toBe(404);
        expect(
            (
                await speakersPut(
                    request(
                        "curator",
                        "/api/recordings/restricted-keycloak-recording/speakers?view=received",
                        "PUT",
                        {
                            transcriptionId: "unused",
                            revision: 0,
                            label: "Speaker 1",
                            unknown: true,
                        },
                    ),
                    context,
                )
            ).status,
        ).toBe(403);
    });
    it("lifts and re-restricts under a curator's own identity", async () => {
        const context = { params: Promise.resolve({ id: folderId }) };
        expect(
            (
                await liftRoute(
                    request("curator", `/api/folders/${folderId}/lift`, "POST"),
                    context,
                )
            ).status,
        ).toBe(200);
        expect(
            await isRecordingShared("restricted-keycloak-recording", orgId),
        ).toBe(true);
        expect(
            (
                await restrictRoute(
                    request(
                        "administrator",
                        `/api/folders/${folderId}/restrict`,
                        "POST",
                        { audienceUserIds: [] },
                    ),
                    context,
                )
            ).status,
        ).toBe(403);
        expect(
            (
                await restrictRoute(
                    request(
                        "curator",
                        `/api/folders/${folderId}/restrict`,
                        "POST",
                        { audienceUserIds: [] },
                    ),
                    context,
                )
            ).status,
        ).toBe(200);
        expect(
            await isRecordingShared("restricted-keycloak-recording", orgId),
        ).toBe(false);
        expect(
            (
                await resolveRecordingAccess(
                    ids.owner,
                    "restricted-keycloak-recording",
                )
            )?.role,
        ).toBe("owner");
    });
    async function openCreatorFolder(name: string) {
        const [existing] = await database.db
            .select()
            .from(recordingFolders)
            .where(eq(recordingFolders.id, folderId));
        return createFolder({
            userId: ids.owner,
            parentId: existing.parentId ?? "missing",
            name,
        });
    }
    it("lets the creator restrict after fresh provider verification with one connection, while another member gets 403", async () => {
        const target = await openCreatorFolder("Creator restriction");
        const context = { params: Promise.resolve({ id: target.id }) };
        expect(
            (
                await restrictRoute(
                    request(
                        "member",
                        `/api/folders/${target.id}/restrict`,
                        "POST",
                        { audienceUserIds: [] },
                    ),
                    context,
                )
            ).status,
        ).toBe(403);
        await database.db
            .update(userAccessStates)
            .set({ verifiedAt: new Date(0) })
            .where(eq(userAccessStates.userId, ids.owner));
        const client = postgres(database.url, { max: 1 });
        dbRef.current = drizzle(client, { schema }) as unknown as Record<
            PropertyKey,
            unknown
        >;
        try {
            expect(
                (
                    await restrictRoute(
                        request(
                            "owner",
                            `/api/folders/${target.id}/restrict`,
                            "POST",
                            { audienceUserIds: [] },
                        ),
                        context,
                    )
                ).status,
            ).toBe(200);
        } finally {
            dbRef.current = database.db as unknown as Record<
                PropertyKey,
                unknown
            >;
            await client.end({ timeout: 1 });
        }
        expect(
            await database.db
                .select()
                .from(restrictedFolderMembers)
                .where(eq(restrictedFolderMembers.folderId, target.id)),
        ).toMatchObject([{ userId: ids.owner, role: "manager" }]);
    });
    it.each([
        "use",
        "membership",
    ])("refuses a creator after losing %s in Keycloak", async (loss) => {
        const target = await openCreatorFolder(`Lost ${loss}`);
        const person = realm.people.owner;
        const http = realm.admin.http;
        try {
            if (loss === "use")
                await http.delete(
                    adminPath`/users/${person.id}/groups/${realm.groupIds.use}`,
                );
            else
                await http.put(adminPath`/users/${person.id}`, {
                    enabled: false,
                });
            await database.db
                .update(userAccessStates)
                .set({ verifiedAt: new Date(0) })
                .where(eq(userAccessStates.userId, ids.owner));
            await expect(
                changeFolderRestriction(ids.owner, target.id, "restrict"),
            ).rejects.toMatchObject({ statusCode: 403 });
            expect(
                await database.db
                    .select()
                    .from(restrictedFolderMembers)
                    .where(eq(restrictedFolderMembers.folderId, target.id)),
            ).toEqual([]);
            expect(
                (
                    await database.db
                        .select()
                        .from(recordingFolders)
                        .where(eq(recordingFolders.id, target.id))
                )[0],
            ).toMatchObject({ restrictedAt: null, restrictingAt: null });
        } finally {
            if (loss === "use")
                await http.put(
                    adminPath`/users/${person.id}/groups/${realm.groupIds.use}`,
                );
            else
                await http.put(adminPath`/users/${person.id}`, {
                    enabled: true,
                });
            await database.db
                .update(userAccessStates)
                .set({ verifiedAt: new Date(0) })
                .where(eq(userAccessStates.userId, ids.owner));
            expect((await holderAccess(ids.owner)).ok).toBe(true);
        }
    });
    it("refreshes expired curator filing verification before one-connection arrival locks", async () => {
        const target = await createFolder({
            userId: ids.owner,
            parentId:
                folderId === ""
                    ? "missing"
                    : ((
                          await database.db
                              .select()
                              .from(recordingFolders)
                              .where(eq(recordingFolders.id, folderId))
                      )[0].parentId ?? "missing"),
            name: "Expired verification",
            restricted: true,
        });
        await database.db
            .update(userAccessStates)
            .set({ verifiedAt: new Date(0) })
            .where(eq(userAccessStates.userId, ids.curator));
        const client = postgres(database.url, { max: 1 });
        dbRef.current = drizzle(client, { schema }) as unknown as Record<
            PropertyKey,
            unknown
        >;
        try {
            const folder = await assertCategorizableFolder(
                ids.curator,
                target.id,
            );
            const context = await resolveArrivalOrganizationContext({
                userId: ids.curator,
                folder,
                fileId: "expired-arrival",
            });
            expect(context.canCurate).toBe(true);
            const [verified] = await database.db
                .select()
                .from(userAccessStates)
                .where(eq(userAccessStates.userId, ids.curator));
            expect(verified.verifiedAt.getTime()).toBeGreaterThan(
                Date.now() - 60000,
            );
            await insertAudioItem(
                drizzle(client, { schema }),
                {
                    id: "expired-arrival",
                    userId: ids.curator,
                    title: encryptText("Curator capture"),
                    occurredAt: new Date(),
                    deviceSn: "local",
                    plaudFileId: "expired-arrival",
                    duration: 1,
                    endTime: new Date(),
                    filesize: 1,
                    fileMd5: "0".repeat(32),
                    storageType: "local",
                    storagePath: "capture.wav",
                    plaudVersion: "1",
                },
                {
                    pipeline: "arrival",
                    lockOrganizationTree: context.lockOrganizationTree,
                    initializeInTx: (tx, input) =>
                        requestArrivalInTx(tx, {
                            ...input,
                            ...context,
                            folder,
                        }),
                },
            );
        } finally {
            dbRef.current = database.db as unknown as Record<
                PropertyKey,
                unknown
            >;
            await client.end({ timeout: 1 });
        }
        expect(
            await database.db
                .select()
                .from(recordingFolderAssignments)
                .where(
                    and(
                        eq(
                            recordingFolderAssignments.itemId,
                            "expired-arrival",
                        ),
                        eq(recordingFolderAssignments.userId, ids.curator),
                    ),
                ),
        ).toMatchObject([{ folderId: target.id, withheld: true }]);
        expect(await isRecordingShared("expired-arrival", orgId)).toBe(false);
    });
});
