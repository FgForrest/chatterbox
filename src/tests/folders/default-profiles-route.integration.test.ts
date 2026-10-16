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
    folderDefaultProfiles,
    processingProfileRevisions,
    processingProfiles,
    recordingFolders,
    users,
} from "@/db/schema";
import type { ActorContext } from "@/lib/authz/model";
import { encryptText } from "@/lib/encryption/fields";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import {
    defaultProfileSettings,
    type ProfileChannel,
} from "@/lib/profiles/settings";
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
            actorId: "folder-owner",
            capabilities: new Set<"use" | "org.curate">(["use"]),
            holderMayUse: true,
        },
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({
    env: {
        IS_HOSTED: false,
        SELF_HOST_MODE: "shared",
        AUTHZ_MODE: "idp",
        ORG_ACCOUNT_EMAIL: "org@example.test",
        ORG_ACCOUNT_PASSWORD: "password",
        BETTER_AUTH_SECRET: "folder-default-test-secret",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        DATABASE_URL: "postgres://unused",
    },
}));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: async () => "folder-org",
    isOrgAccount: async (userId: string) => userId === "folder-org",
    isOrgScopeEnabled: () => true,
    isOrgScopeVisible: () => true,
    assertOrgScopeWritable: () => undefined,
}));
vi.mock("@/lib/identity/factory", () => ({
    isIdpAuthorization: () => true,
}));
vi.mock("@/lib/authz/access-state", () => ({
    holderAccess: async (userId: string) =>
        userId === "outsider" || !state.holderMayUse
            ? { ok: false, reason: "disabled" }
            : { ok: true, capabilities: new Set(["use"]) },
}));
vi.mock("@/lib/authz/curator", () => ({
    actsForOrganization: async (actor: ActorContext) =>
        actor.kind === "user" && actor.capabilities.has("org.curate"),
    userCuratesOrganizationNow: async (userId: string) => userId === "curator",
}));
vi.mock("@/lib/auth-server", () => ({
    requireApiSessionActor: async () => {
        const actor: ActorContext = {
            kind: "user",
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
                user: {
                    id: state.actorId,
                    email: `${state.actorId}@example.test`,
                },
                session: { id: `session-${state.actorId}` },
            },
            actor,
            authTime: new Date(),
        };
    },
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));

import { GET, PUT } from "@/app/api/folders/[id]/default-profiles/route";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const OWNER = "folder-owner";
const OTHER = "folder-other";
const CURATOR = "curator";
const MEMBER = "member";
const ORG = "folder-org";

function request(
    method: string,
    folderId: string,
    body?: Record<string, unknown>,
) {
    return new Request(
        `https://app.example.test/api/folders/${folderId}/default-profiles`,
        {
            method,
            ...(body
                ? {
                      body: JSON.stringify(body),
                      headers: { "Content-Type": "application/json" },
                  }
                : {}),
        },
    );
}

function context(id: string) {
    return { params: Promise.resolve({ id }) };
}

describeWithDatabase("folder default profile routes", () => {
    let database: TestPostgresDatabase | null = null;

    function db() {
        if (!database) throw new Error("test database not ready");
        return database.db;
    }

    async function addFolder(input: {
        id: string;
        ownerUserId: string;
        parentId: string | null;
        kind?: "private" | "public" | "custom";
    }) {
        await db()
            .insert(recordingFolders)
            .values({
                id: input.id,
                userId: input.ownerUserId,
                parentId: input.parentId,
                name: encryptText(input.id),
                nameHash: lookupHash(input.id),
                kind: input.kind ?? "custom",
            });
    }

    async function addProfile(input: {
        id: string;
        ownerUserId: string;
        scope: "personal" | "organization";
        channel?: ProfileChannel;
        isDefault?: boolean;
    }) {
        const channel = input.channel ?? "audio";
        const revisionId = `${input.id}-revision`;
        await db()
            .insert(processingProfiles)
            .values({
                id: input.id,
                ownerUserId: input.ownerUserId,
                scope: input.scope,
                channel,
                name: encryptText(input.id),
                currentRevisionId: revisionId,
                createdBy: input.ownerUserId,
                updatedBy: input.ownerUserId,
                isDefault: input.isDefault ?? false,
            });
        await db()
            .insert(processingProfileRevisions)
            .values({
                id: revisionId,
                profileId: input.id,
                settings: encryptText(
                    JSON.stringify(defaultProfileSettings(channel)),
                ),
                createdBy: input.ownerUserId,
            });
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "folder_default_profiles_route",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        await db()
            .insert(users)
            .values([
                { id: OWNER, email: "owner@example.test" },
                { id: OTHER, email: "other@example.test" },
                { id: CURATOR, email: "curator@example.test" },
                { id: MEMBER, email: "member@example.test" },
                { id: ORG, email: "org@example.test", role: "org" },
            ]);
    }, 120_000);

    beforeEach(async () => {
        state.actorId = OWNER;
        state.capabilities = new Set(["use"]);
        state.holderMayUse = true;
        await db().delete(folderDefaultProfiles);
        await db().delete(recordingFolders);
        await db().delete(processingProfiles);
        await addFolder({
            id: "personal-root",
            ownerUserId: OWNER,
            parentId: null,
            kind: "private",
        });
        await addFolder({
            id: "personal-parent",
            ownerUserId: OWNER,
            parentId: "personal-root",
        });
        await addFolder({
            id: "personal-child",
            ownerUserId: OWNER,
            parentId: "personal-parent",
        });
        await addFolder({
            id: "other-folder",
            ownerUserId: OTHER,
            parentId: null,
            kind: "private",
        });
        await addFolder({
            id: "org-root",
            ownerUserId: ORG,
            parentId: null,
            kind: "public",
        });
        await addFolder({
            id: "org-folder",
            ownerUserId: ORG,
            parentId: "org-root",
        });
        await addProfile({
            id: "personal-audio",
            ownerUserId: OWNER,
            scope: "personal",
            isDefault: true,
        });
        await addProfile({
            id: "org-audio",
            ownerUserId: ORG,
            scope: "organization",
            isDefault: true,
        });
    });

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    it("lets the owner set, read, inherit, and clear a personal folder default", async () => {
        const set = await PUT(
            request("PUT", "personal-parent", {
                channel: "audio",
                profileId: "personal-audio",
            }),
            context("personal-parent"),
        );
        expect(set.status).toBe(200);

        const inherited = await GET(
            request("GET", "personal-child"),
            context("personal-child"),
        );
        expect(await inherited.json()).toMatchObject({
            scope: "personal",
            defaults: {
                audio: {
                    own: null,
                    ownManualOnly: false,
                    effective: { id: "personal-audio" },
                    effectiveManualOnly: false,
                    inheritedFromFolderId: "personal-parent",
                    accountDefault: { id: "personal-audio" },
                },
            },
        });

        const cleared = await PUT(
            request("PUT", "personal-parent", {
                channel: "audio",
                profileId: null,
            }),
            context("personal-parent"),
        );
        expect(cleared.status).toBe(200);
        expect(
            await db()
                .select()
                .from(folderDefaultProfiles)
                .where(eq(folderDefaultProfiles.folderId, "personal-parent")),
        ).toHaveLength(0);
    });

    it("stores and inherits Nothing automatic as a distinct mode", async () => {
        const set = await PUT(
            request("PUT", "personal-parent", {
                channel: "audio",
                profileId: null,
                manualOnly: true,
            }),
            context("personal-parent"),
        );
        expect(set.status).toBe(200);
        expect(
            await db()
                .select()
                .from(folderDefaultProfiles)
                .where(eq(folderDefaultProfiles.folderId, "personal-parent")),
        ).toEqual([
            expect.objectContaining({ profileId: null, manualOnly: true }),
        ]);

        const inherited = await GET(
            request("GET", "personal-child"),
            context("personal-child"),
        );
        expect(await inherited.json()).toMatchObject({
            scope: "personal",
            defaults: {
                audio: {
                    own: null,
                    ownManualOnly: false,
                    effective: null,
                    effectiveManualOnly: true,
                    inheritedFromFolderId: "personal-parent",
                    accountDefault: { id: "personal-audio" },
                },
            },
        });
    });

    it("does not let another user reach a personal folder", async () => {
        state.actorId = OTHER;
        expect(
            (
                await PUT(
                    request("PUT", "personal-child", {
                        channel: "audio",
                        profileId: null,
                    }),
                    context("personal-child"),
                )
            ).status,
        ).toBe(404);
    });

    it("lets a curator set an Organization default", async () => {
        state.actorId = CURATOR;
        state.capabilities = new Set(["use", "org.curate"]);
        const response = await PUT(
            request("PUT", "org-folder", {
                channel: "audio",
                profileId: "org-audio",
            }),
            context("org-folder"),
        );
        expect(response.status).toBe(200);
    });

    it("does not expose the Organization account default for an Organization folder", async () => {
        const response = await GET(
            request("GET", "org-folder"),
            context("org-folder"),
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
            scope: "org",
            defaults: {
                audio: { accountDefault: null },
                mail: { accountDefault: null },
            },
        });
    });

    it("refuses an Organization write from a member without curation", async () => {
        state.actorId = MEMBER;
        state.capabilities = new Set(["use"]);
        const response = await PUT(
            request("PUT", "org-folder", {
                channel: "audio",
                profileId: "org-audio",
            }),
            context("org-folder"),
        );
        expect(response.status).toBe(403);
    });

    it("refuses Organization defaults after a member loses use access", async () => {
        state.actorId = MEMBER;
        state.capabilities = new Set();
        state.holderMayUse = false;

        const read = await GET(
            request("GET", "org-folder"),
            context("org-folder"),
        );
        expect(read.status).toBe(403);

        const write = await PUT(
            request("PUT", "org-folder", {
                channel: "audio",
                profileId: null,
            }),
            context("org-folder"),
        );
        expect(write.status).toBe(403);
    });

    it("refuses defaults on roots", async () => {
        const response = await PUT(
            request("PUT", "personal-root", {
                channel: "audio",
                profileId: "personal-audio",
            }),
            context("personal-root"),
        );
        expect(response.status).toBe(400);
    });

    it("refuses a personal profile on an Organization folder", async () => {
        state.actorId = CURATOR;
        state.capabilities = new Set(["use", "org.curate"]);
        const response = await PUT(
            request("PUT", "org-folder", {
                channel: "audio",
                profileId: "personal-audio",
            }),
            context("org-folder"),
        );
        expect(response.status).toBe(400);
    });

    it("allows a usable Organization profile on a personal folder", async () => {
        const response = await PUT(
            request("PUT", "personal-child", {
                channel: "audio",
                profileId: "org-audio",
            }),
            context("personal-child"),
        );
        expect(response.status).toBe(200);
    });
});
