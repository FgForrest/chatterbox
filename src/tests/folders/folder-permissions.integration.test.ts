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
    chatterItems,
    recordingFolderAssignments,
    recordingFolders,
    recordings,
    users,
} from "@/db/schema";
import type { ActorContext } from "@/lib/authz/model";
import { encryptText } from "@/lib/encryption/fields";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
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
            actorId: "member",
            capabilities: new Set<"use" | "org.curate">(["use"]),
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
        BETTER_AUTH_SECRET: "folder-permissions-test-secret",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        DATABASE_URL: "postgres://unused",
    },
}));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: async () => "organization",
    isOrgAccount: async (userId: string) => userId === "organization",
    isOrgScopeEnabled: () => true,
    isOrgScopeVisible: () => true,
    assertOrgScopeWritable: () => undefined,
}));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async () => ({
        user: { id: state.actorId, email: `${state.actorId}@example.test` },
        session: { id: `session-${state.actorId}` },
    }),
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
vi.mock("@/lib/authz/curator", () => ({
    actsForOrganization: async (actor: ActorContext) =>
        actor.kind === "user" && actor.capabilities.has("org.curate"),
}));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/knowledge/org-people", () => ({
    lockOrgPeople: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/knowledge/scope-generation", () => ({
    bumpScopeInTx: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/knowledge/share-knowledge", () => ({
    publishKnowledgeInTx: vi
        .fn()
        .mockResolvedValue({ scopes: new Set<string>() }),
    withdrawKnowledgeInTx: vi.fn().mockResolvedValue(new Set<string>()),
}));
vi.mock("@/lib/mail/address-blocking", () => ({
    blockFolderAddressesInTx: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/mail/addresses", () => ({
    ensureFolderAddress: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/mail/share-gate", () => ({
    mailShareProblems: vi.fn().mockResolvedValue([]),
    shareMailInTx: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/org/events", () => ({
    notifyOrgChange: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/pipeline/trigger", () => ({
    requestAdvanceInTx: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/sharing/load-share-gate", () => ({
    loadShareGate: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/sharing/share-names", () => ({
    publishSpeakerNamesInTx: vi
        .fn()
        .mockResolvedValue({ scopes: new Set<string>() }),
    publishTaskAssigneesInTx: vi.fn().mockResolvedValue(new Set<string>()),
}));
vi.mock("@/lib/sharing/shared", () => ({
    isRecordingShared: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/lib/tasks/mentions", () => ({
    lockItemTaskGraphInTx: vi.fn().mockResolvedValue(undefined),
    withdrawItemTaskHomesInTx: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));

import { DELETE, PATCH } from "@/app/api/folders/[id]/route";
import { POST } from "@/app/api/folders/route";
import {
    addRecordingToFolder,
    createFolder,
    deleteFolder,
    moveFolder,
    renameFolder,
} from "@/lib/folders/folders";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const MEMBER = "member";
const CURATOR = "curator";
const ORGANIZATION = "organization";

function context(id: string) {
    return { params: Promise.resolve({ id }) };
}

function request(method: string, path: string, body?: Record<string, unknown>) {
    return new Request(`https://app.example.test${path}`, {
        method,
        ...(body
            ? {
                  body: JSON.stringify(body),
                  headers: { "Content-Type": "application/json" },
              }
            : {}),
    });
}

describeWithDatabase("Organization folder permissions", () => {
    let database: TestPostgresDatabase | null = null;

    function db() {
        if (!database) throw new Error("test database not ready");
        return database.db;
    }

    async function addFolder(input: {
        id: string;
        userId: string;
        parentId: string | null;
        kind?: "private" | "public" | "custom";
        sortOrder?: number;
    }) {
        await db()
            .insert(recordingFolders)
            .values({
                id: input.id,
                userId: input.userId,
                parentId: input.parentId,
                name: encryptText(input.id),
                nameHash: lookupHash(input.id),
                kind: input.kind ?? "custom",
                sortOrder: input.sortOrder ?? 0,
            });
    }

    async function addRecording() {
        const occurredAt = new Date("2026-10-16T10:00:00.000Z");
        await db()
            .insert(chatterItems)
            .values({
                id: "recording",
                userId: MEMBER,
                kind: "audio",
                title: encryptText("Recording"),
                occurredAt,
            });
        await db().insert(recordings).values({
            id: "recording",
            userId: MEMBER,
            deviceSn: "local",
            plaudFileId: "recording",
            duration: 1_000,
            endTime: occurredAt,
            filesize: 1_000,
            fileMd5: "0123456789abcdef0123456789abcdef",
            storageType: "local",
            storagePath: "recording.mp3",
            plaudVersion: "1",
        });
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "folder_permissions",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        await db()
            .insert(users)
            .values([
                { id: MEMBER, email: "member@example.test" },
                { id: CURATOR, email: "curator@example.test" },
                {
                    id: ORGANIZATION,
                    email: "org@example.test",
                    role: "org",
                },
            ]);
    }, 120_000);

    beforeEach(async () => {
        state.actorId = MEMBER;
        state.capabilities = new Set(["use"]);
        await db().delete(chatterItems);
        await db().delete(recordingFolders);
        await addFolder({
            id: "personal-root",
            userId: MEMBER,
            parentId: null,
            kind: "private",
        });
        await addFolder({
            id: "personal-folder",
            userId: MEMBER,
            parentId: "personal-root",
        });
        await addFolder({
            id: "personal-destination",
            userId: MEMBER,
            parentId: "personal-root",
            sortOrder: 1000,
        });
        await addFolder({
            id: "org-root",
            userId: ORGANIZATION,
            parentId: null,
            kind: "public",
        });
        await addFolder({
            id: "org-folder",
            userId: ORGANIZATION,
            parentId: "org-root",
        });
        await addFolder({
            id: "org-destination",
            userId: ORGANIZATION,
            parentId: "org-root",
            sortOrder: 1000,
        });
    });

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    it("allows members to create Organization subfolders", async () => {
        const created = await createFolder({
            userId: MEMBER,
            parentId: "org-folder",
            name: "Member subfolder",
            canCurate: false,
        });

        expect(created).toMatchObject({
            parentId: "org-folder",
            scope: "org",
        });
    });

    it("refuses top-level create, rename, move, and delete to members", async () => {
        await expect(
            createFolder({
                userId: MEMBER,
                parentId: "org-root",
                name: "Top level",
                canCurate: false,
            }),
        ).rejects.toMatchObject({ statusCode: 403 });
        await expect(
            renameFolder({
                userId: MEMBER,
                folderId: "org-folder",
                name: "Renamed",
                canCurate: false,
            }),
        ).rejects.toMatchObject({ statusCode: 403 });
        await expect(
            moveFolder({
                userId: MEMBER,
                folderId: "org-folder",
                parentId: "org-destination",
                canCurate: false,
            }),
        ).rejects.toMatchObject({ statusCode: 403 });
        await expect(
            moveFolder({
                userId: MEMBER,
                folderId: "personal-folder",
                parentId: "org-destination",
                canCurate: false,
            }),
        ).rejects.toMatchObject({ statusCode: 403 });
        await expect(
            moveFolder({
                userId: MEMBER,
                folderId: "org-folder",
                parentId: "personal-destination",
                canCurate: false,
            }),
        ).rejects.toMatchObject({ statusCode: 403 });
        await expect(
            deleteFolder(MEMBER, "org-folder", { canCurate: false }),
        ).rejects.toMatchObject({ statusCode: 403 });
    });

    it("allows curators to manage the Organization tree", async () => {
        const created = await createFolder({
            userId: CURATOR,
            parentId: "org-root",
            name: "Curator folder",
            canCurate: true,
        });
        const renamed = await renameFolder({
            userId: CURATOR,
            folderId: created.id,
            name: "Renamed by curator",
            canCurate: true,
        });
        const moved = await moveFolder({
            userId: CURATOR,
            folderId: created.id,
            parentId: "org-destination",
            canCurate: true,
        });
        await deleteFolder(CURATOR, created.id, { canCurate: true });

        expect(renamed.name).toBe("Renamed by curator");
        expect(moved.parentId).toBe("org-destination");
        expect(
            await db()
                .select({ id: recordingFolders.id })
                .from(recordingFolders)
                .where(eq(recordingFolders.id, created.id)),
        ).toHaveLength(0);
    });

    it("leaves personal folder management unchanged", async () => {
        const created = await createFolder({
            userId: MEMBER,
            parentId: "personal-root",
            name: "Personal folder",
            canCurate: false,
        });
        await renameFolder({
            userId: MEMBER,
            folderId: created.id,
            name: "Personal renamed",
            canCurate: false,
        });
        await moveFolder({
            userId: MEMBER,
            folderId: created.id,
            parentId: "personal-destination",
            canCurate: false,
        });
        await deleteFolder(MEMBER, created.id, { canCurate: false });

        expect(
            await db()
                .select({ id: recordingFolders.id })
                .from(recordingFolders)
                .where(eq(recordingFolders.id, created.id)),
        ).toHaveLength(0);
    });

    it("keeps filing recordings into Organization folders open to members", async () => {
        await addRecording();

        await addRecordingToFolder({
            userId: MEMBER,
            recordingId: "recording",
            folderId: "org-folder",
        });

        expect(
            await db()
                .select()
                .from(recordingFolderAssignments)
                .where(
                    and(
                        eq(recordingFolderAssignments.itemId, "recording"),
                        eq(recordingFolderAssignments.folderId, "org-folder"),
                    ),
                ),
        ).toHaveLength(1);
    });

    it("returns 403 from POST, PATCH, and DELETE routes for a member", async () => {
        const post = await POST(
            request("POST", "/api/folders", {
                parentId: "org-root",
                name: "Blocked",
            }),
        );
        const patch = await PATCH(
            request("PATCH", "/api/folders/org-folder", {
                name: "Blocked",
            }),
            context("org-folder"),
        );
        const remove = await DELETE(
            request("DELETE", "/api/folders/org-folder"),
            context("org-folder"),
        );

        expect(post.status).toBe(403);
        expect(patch.status).toBe(403);
        expect(remove.status).toBe(403);
    });
});
