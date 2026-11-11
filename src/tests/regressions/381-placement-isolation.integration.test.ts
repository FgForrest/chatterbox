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
import { POST as categorizePost } from "@/app/api/recordings/[id]/categorize/route";
import { db } from "@/db";
import {
    accounts,
    recordingFolderAssignments,
    recordingFolders,
    users,
} from "@/db/schema";
import {
    addRecordingToFolder,
    createFolder,
    ensureRootFolders,
} from "@/lib/folders/folders";
import { changeRestrictedAudience } from "@/lib/folders/restricted-folders";
import { ensureProfiles } from "@/lib/profiles/seed";
import { localActor } from "@/tests/helpers/session-actor";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";
import { insertRecording } from "@/tests/mcp/fixtures";

const { ref, mockEnv, authority } = vi.hoisted(() => ({
    ref: { current: null as Record<PropertyKey, unknown> | null },
    authority: { curator: true },
    mockEnv: {
        IS_HOSTED: false,
        DEFAULT_STORAGE_TYPE: "local",
        SELF_HOST_MODE: "shared",
        AUTHZ_MODE: "local",
        ORG_ACCOUNT_EMAIL: "org@example.com",
        ORG_ACCOUNT_PASSWORD: "demo-password",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
        MAIL_DOMAIN: "mail.example.com",
        MAIL_INGEST_SECRET: "i".repeat(40),
        MAIL_ORG_NICKNAME: "organization",
        MAIL_FORMER_ORG_NICKNAMES: [],
        OIDC_ISSUER_URL: "https://identity.example.com/realms/test",
        OIDC_CLIENT_ID: "chatterbox",
        OIDC_CLIENT_SECRET: "test-client-secret",
        MAIL_ADDRESS_HASH_SECRET: "m".repeat(40),
        MAIL_INACTIVE_DAYS: 90,
        MAIL_MAX_SIGNATURE_AGE_HOURS: 48,
        FILESYSTEM_EXPORT_ROOT: "/tmp/restricted-test-exports",
        KNOWLEDGE_MEMORY_MB: 64,
        APP_URL: "http://localhost:3000",
    },
}));
vi.mock("@/db", () => ({
    db: new Proxy(
        {},
        {
            get: (_, key) => {
                const value = ref.current?.[key];
                return typeof value === "function"
                    ? value.bind(ref.current)
                    : value;
            },
        },
    ),
    sqlClient: null,
}));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/authz/curator", () => ({
    userCuratesOrganizationNow: async (id: string) =>
        id === "org" || (id === "curator" && authority.curator),
    actsForOrganization: async (actor: { actorId: string }) =>
        actor.actorId === "org" ||
        (actor.actorId === "curator" && authority.curator),
}));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
    enqueueExportMaterialization: vi.fn().mockResolvedValue(undefined),
    enqueueExportPlan: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/notifications/person-share", () => ({
    sendPersonShareInvitation: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/org/events", () => ({
    notifyOrgChange: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async (request: Request) => ({
        user: {
            id: request.headers.get("x-test-user") ?? "owner",
            email: `${request.headers.get("x-test-user") ?? "owner"}@example.com`,
        },
    }),
    requireApiSessionActor: async (request: Request) => {
        const id = request.headers.get("x-test-user") ?? "owner";
        return {
            session: { user: { id, email: `${id}@example.com` } },
            actor: request.headers.get("x-test-service")
                ? { ...localActor(id), kind: "service" }
                : localActor(id),
        };
    },
}));
const url = getTestDatabaseUrl();
const suite = url ? describe : describe.skip;
suite("categorization cannot retain another owner's withheld placement", () => {
    let database: TestPostgresDatabase;
    let openId: string;
    let restrictedId: string;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            url ?? "",
            "placement_isolation",
        );
        ref.current = database.db as unknown as Record<PropertyKey, unknown>;
    });
    afterAll(async () => {
        ref.current = null;
        await database?.dispose();
    });
    beforeEach(async () => {
        await db.delete(users);
        await db.insert(users).values(
            ["owner", "member", "other", "curator", "org"].map((id) => ({
                id,
                name: id === "owner" ? "Jitka Dvořáková" : `User ${id}`,
                email: `${id}@example.com`,
                role: id === "org" ? ("org" as const) : ("user" as const),
                lastSsoLoginAt: new Date(),
                emailVerified: true,
            })),
        );
        await db.insert(accounts).values(
            ["owner", "member", "other", "curator"].map((id) => ({
                userId: id,
                providerId: "oidc",
                accountId: `${id}-sub`,
            })),
        );
        await ensureRootFolders("org");
        const [root] = await db
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, "org"));
        openId = (
            await createFolder({
                userId: "org",
                parentId: root.id,
                name: "Acme",
                canCurate: true,
            })
        ).id;
        restrictedId = (
            await createFolder({
                userId: "owner",
                parentId: openId,
                name: "Beta",
                restricted: true,
                audienceUserIds: ["member"],
            })
        ).id;
        await insertRecording(database.db, {
            id: "recording",
            userId: "owner",
            title: "Restricted evidence",
        });
        for (const id of ["own-item", "foreign-item"]) {
            await insertRecording(database.db, {
                id,
                userId: id === "own-item" ? "owner" : "member",
            });
            await addRecordingToFolder({
                userId: id === "own-item" ? "owner" : "member",
                recordingId: id,
                folderId: restrictedId,
            });
        }
        await changeRestrictedAudience("curator", restrictedId, {
            removeUserId: "owner",
        });
        await ensureProfiles("owner");
    });
    async function categorize(id: string, body: object) {
        return categorizePost(
            new Request("http://localhost/api/test", {
                method: "POST",
                headers: {
                    "x-test-user": "owner",
                    "content-type": "application/json",
                },
                body: JSON.stringify(body),
            }),
            { params: Promise.resolve({ id }) },
        );
    }
    it("retains and then removes only the caller's own placement in a shared restricted folder", async () => {
        const before = await db
            .select()
            .from(recordingFolderAssignments)
            .where(eq(recordingFolderAssignments.itemId, "foreign-item"));
        expect(before).toMatchObject([
            { userId: "member", folderId: restrictedId, withheld: true },
        ]);
        expect(
            (
                await categorize("own-item", {
                    folderIds: [restrictedId],
                    manualOnly: true,
                })
            ).status,
        ).toBe(200);
        expect(
            await db
                .select()
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.itemId, "own-item")),
        ).toMatchObject([
            { userId: "owner", folderId: restrictedId, withheld: true },
        ]);
        expect(
            (
                await categorize("foreign-item", {
                    folderIds: [restrictedId],
                    manualOnly: true,
                })
            ).status,
        ).toBe(404);
        expect(
            (
                await categorize("foreign-item", {
                    folderIds: [openId],
                    manualOnly: true,
                })
            ).status,
        ).toBe(404);
        await ensureRootFolders("owner");
        const [personalRoot] = await db
            .select()
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, "owner"));
        const target = await createFolder({
            userId: "owner",
            parentId: personalRoot.id,
            name: "Personal target",
        });
        expect(
            (
                await categorize("own-item", {
                    folderIds: [target.id],
                    retainedFolderIds: [restrictedId],
                    manualOnly: true,
                })
            ).status,
        ).toBe(400);
        expect(
            (
                await categorize("own-item", {
                    folderIds: [target.id],
                    manualOnly: true,
                })
            ).status,
        ).toBe(200);
        expect(
            await db
                .select()
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.itemId, "own-item")),
        ).toMatchObject([
            { userId: "owner", folderId: target.id, withheld: false },
        ]);
        expect(
            (
                await categorize("recording", {
                    folderIds: [restrictedId],
                    manualOnly: true,
                })
            ).status,
        ).toBe(403);
        expect(
            await db
                .select()
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.itemId, "foreign-item")),
        ).toEqual(before);
    });
});
