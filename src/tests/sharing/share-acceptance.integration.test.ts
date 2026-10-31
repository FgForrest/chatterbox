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
import { GET as listShares } from "@/app/api/items/[id]/shares/route";
import {
    isItemReceived,
    listOutgoingSharedItemIds,
} from "@/db/queries/item-shares";
import {
    chatterItems,
    folderShares,
    itemShares,
    receivedFolderAttachments,
    recordingFolderAssignments,
    recordingFolders,
    userAccessStates,
    users,
} from "@/db/schema";
import { encryptText } from "@/lib/encryption/fields";
import { changeFolderShare, inviteToFolder } from "@/lib/sharing/folder-shares";
import {
    changePersonShare,
    inviteToItem,
    listItemFolderAudience,
    listItemShares,
    listMyInvitations,
    listVisibleItemFolders,
} from "@/lib/sharing/person-shares";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { ref, mockEnv } = vi.hoisted(() => ({
    ref: { current: null as Record<PropertyKey, unknown> | null },
    mockEnv: {
        IS_HOSTED: false,
        SELF_HOST_MODE: "shared",
        AUTHZ_MODE: "local",
        MAIL_DOMAIN: "mail.example.com",
        MAIL_ADDRESS_HASH_SECRET: "m".repeat(40),
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
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
}));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/events/personal", () => ({ notifyPersonShareChanged: vi.fn() }));
vi.mock("@/lib/notifications/person-share", () => ({
    sendPersonShareInvitation: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async (request: Request) => ({
        user: { id: request.headers.get("x-test-user") ?? "owner" },
    }),
}));
vi.mock("@/lib/rate-limit", () => ({
    consumeRateLimitBucket: async () => ({ allowed: true }),
}));

const url = getTestDatabaseUrl();
describe.skipIf(!url)(
    "share acceptance and folder audience (PostgreSQL)",
    () => {
        let database: TestPostgresDatabase;
        beforeAll(async () => {
            database = await createMigratedTestDatabase(
                url ?? "",
                "share_acceptance",
            );
            ref.current = database.db as unknown as Record<
                PropertyKey,
                unknown
            >;
        }, 120_000);
        afterAll(async () => {
            ref.current = null;
            await database?.dispose();
        });
        beforeEach(async () => {
            mockEnv.AUTHZ_MODE = "local";
            await database.db.delete(users);
            await database.db.insert(users).values(
                ["owner", "receiver", "other", "pending", "inactive"].map(
                    (id) => ({
                        id,
                        email: `${id}@example.com`,
                        name: `Demo ${id}`,
                    }),
                ),
            );
            await database.db.insert(recordingFolders).values([
                {
                    id: "source",
                    userId: "owner",
                    name: encryptText("Research"),
                    nameHash: "source",
                },
                {
                    id: "nested",
                    userId: "owner",
                    parentId: "source",
                    name: encryptText("Private child"),
                    nameHash: "nested",
                },
                {
                    id: "mine",
                    userId: "receiver",
                    name: encryptText("Projects"),
                    nameHash: "mine",
                },
                {
                    id: "foreign",
                    userId: "other",
                    name: encryptText("Foreign original"),
                    nameHash: "foreign",
                },
                {
                    id: "hidden",
                    userId: "other",
                    name: encryptText("Other private name"),
                    nameHash: "hidden",
                },
            ]);
            await database.db.insert(chatterItems).values(
                ["audio", "mail"].map((kind) => ({
                    id: kind,
                    userId: "owner",
                    kind: kind as "audio" | "mail",
                    title: encryptText("Project update"),
                    occurredAt: new Date(),
                })),
            );
        });
        const place = async (folderId = "source", itemId = "audio") => {
            await database.db
                .insert(recordingFolderAssignments)
                .values({ userId: "owner", itemId, folderId });
        };
        const folderInvite = async (
            owner = "owner",
            folder = "source",
            receiver = "receiver",
            accept = false,
        ) => {
            const shares = await inviteToFolder(owner, folder, [receiver]);
            const share = shares.find(
                (share) => share.receiverUserId === receiver,
            );
            if (!share) throw new Error("Missing fixture invitation");
            if (accept)
                await changeFolderShare(receiver, share.id, {
                    action: "accept",
                    version: share.version,
                    name: `${receiver}'s attachment`,
                });
            return share;
        };
        const direct = async (kind = "audio") =>
            (await inviteToItem("owner", kind, ["receiver"]))[0];

        it("lists accepted and pending active folder recipients and matches outgoing markers", async () => {
            await place();
            await folderInvite("owner", "source", "receiver", true);
            await folderInvite("owner", "source", "pending");
            await folderInvite("owner", "source", "inactive");
            await database.db
                .update(users)
                .set({ suspendedAt: new Date() })
                .where(eq(users.id, "inactive"));
            await folderInvite("owner", "nested", "other", true);
            const audience = await listItemFolderAudience("owner", "audio");
            expect(audience).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        receiverUserId: "receiver",
                        folderName: "Research",
                        state: "accepted",
                        canManage: true,
                    }),
                    expect.objectContaining({
                        receiverUserId: "pending",
                        folderName: "Research",
                        state: "pending",
                    }),
                ]),
            );
            expect(audience).toHaveLength(2);
            expect(await listOutgoingSharedItemIds("owner")).toEqual(
                new Set(["audio"]),
            );
            await database.db
                .update(users)
                .set({ suspendedAt: new Date() })
                .where(eq(users.id, "receiver"));
            await database.db
                .update(users)
                .set({ suspendedAt: new Date() })
                .where(eq(users.id, "pending"));
            expect(await listItemFolderAudience("owner", "audio")).toEqual([]);
            expect(await listOutgoingSharedItemIds("owner")).toEqual(new Set());
        });

        it("lists a foreign folder's owner and fellow recipients under the contributor's attachment name", async () => {
            await folderInvite("other", "foreign", "owner", true);
            await folderInvite("other", "foreign", "pending");
            await folderInvite("other", "foreign", "receiver", true);
            await place("foreign");
            const audience = await listItemFolderAudience("owner", "audio");
            expect(audience.map((row) => row.receiverUserId).sort()).toEqual([
                "other",
                "pending",
                "receiver",
            ]);
            for (const row of audience)
                expect(row).toMatchObject({
                    folderName: "owner's attachment",
                    canManage: false,
                });
            expect(
                await inviteToItem("owner", "audio", [
                    "other",
                    "pending",
                    "receiver",
                ]),
            ).toEqual([]);
            await database.db
                .delete(folderShares)
                .where(eq(folderShares.receiverUserId, "pending"));
            await database.db
                .delete(folderShares)
                .where(eq(folderShares.receiverUserId, "receiver"));
            expect(await listOutgoingSharedItemIds("owner")).toEqual(
                new Set(["audio"]),
            );
            await database.db
                .update(folderShares)
                .set({ state: "removed" })
                .where(eq(folderShares.receiverUserId, "owner"));
            expect(await listItemFolderAudience("owner", "audio")).toEqual([]);
            expect(await listOutgoingSharedItemIds("owner")).toEqual(new Set());
        });

        it.each([
            false,
            true,
        ])("skips fresh and renewed redundant invitations for accepted=%s folders", async (accept) => {
            const share = await direct();
            await changePersonShare("receiver", share.id, {
                action: "decline",
                version: share.version,
            });
            await place();
            await place("source", "mail");
            await folderInvite("owner", "source", "receiver", accept);
            expect(await inviteToItem("owner", "mail", ["receiver"])).toEqual(
                [],
            );
            const shares = await inviteToItem("owner", "audio", [
                "receiver",
                "other",
            ]);
            expect(
                shares.find((row) => row.receiverUserId === "receiver")?.state,
            ).toBe("declined");
            expect(
                shares.find((row) => row.receiverUserId === "other")?.state,
            ).toBe("pending");
        });

        it("returns only the receiver's accepted paths with local and own folder names", async () => {
            await direct();
            await place();
            await folderInvite("owner", "source", "receiver", true);
            await folderInvite("receiver", "mine", "owner", true);
            await place("mine");
            await folderInvite("other", "foreign", "owner", true);
            await folderInvite("other", "foreign", "receiver");
            await place("foreign");
            const [invitation] = await listMyInvitations("receiver");
            expect(
                invitation.visibleInFolders.map((folder) => folder.name).sort(),
            ).toEqual(["Projects", "receiver's attachment"]);
            expect(JSON.stringify(invitation)).not.toMatch(
                /Foreign original|Research|Other private name|pending@example/,
            );
            expect(await listVisibleItemFolders("pending", ["audio"])).toEqual(
                [],
            );
            await expect(
                listItemFolderAudience("receiver", "audio"),
            ).rejects.toMatchObject({ statusCode: 404 });
        });

        it("adds the folder audience to the owner GET and keeps the owner gate", async () => {
            await place();
            await folderInvite();
            const context = { params: Promise.resolve({ id: "audio" }) };
            const response = await listShares(
                new Request("http://localhost/api/items/audio/shares"),
                context,
            );
            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({
                shares: [],
                folderAudience: [
                    expect.objectContaining({
                        folderName: "Research",
                        receiverUserId: "receiver",
                    }),
                ],
            });
            const denied = await listShares(
                new Request("http://localhost/api/items/audio/shares", {
                    headers: { "x-test-user": "receiver" },
                }),
                context,
            );
            expect(denied.status).toBe(404);
        });

        describe.each(["audio", "mail"])("%s", (kind) => {
            it("accepts without filing, files explicitly and unfiles while retaining direct access", async () => {
                const share = await direct(kind);
                await place("source", kind);
                await folderInvite("owner", "source", "receiver", true);
                await changePersonShare("receiver", share.id, {
                    action: "accept",
                    version: 0,
                });
                expect((await listItemShares("owner", kind))[0]).toMatchObject({
                    state: "accepted",
                    version: 1,
                });
                await changePersonShare("receiver", share.id, {
                    action: "file",
                    version: 1,
                    folderId: "mine",
                });
                await changePersonShare("receiver", share.id, {
                    action: "file",
                    version: 2,
                });
                const [row] = await database.db
                    .select()
                    .from(itemShares)
                    .where(eq(itemShares.id, share.id));
                expect(row).toMatchObject({
                    state: "accepted",
                    filingFolderId: null,
                    version: 3,
                });
                await database.db.delete(recordingFolderAssignments);
                expect(await isItemReceived("receiver", kind)).toBe(true);
                await expect(
                    changePersonShare("receiver", share.id, {
                        action: "file",
                        version: 3,
                    }),
                ).rejects.toMatchObject({ statusCode: 400 });
            });

            it.each([
                "absent",
                "pending",
                "removed",
                "unfiled",
            ])("refuses acceptance without filing for a %s folder path", async (path) => {
                const share = await direct(kind);
                await place("source", kind);
                if (path !== "absent") {
                    const folder = await folderInvite(
                        "owner",
                        "source",
                        "receiver",
                        path !== "pending",
                    );
                    if (path === "removed")
                        await changeFolderShare("receiver", folder.id, {
                            action: "remove",
                            version: 1,
                        });
                    if (path === "unfiled")
                        await database.db.delete(recordingFolderAssignments);
                }
                await expect(
                    changePersonShare("receiver", share.id, {
                        action: "accept",
                        version: 0,
                    }),
                ).rejects.toMatchObject({
                    statusCode: 400,
                    message: "Choose a private folder",
                });
                await changePersonShare("receiver", share.id, {
                    action: "accept",
                    version: 0,
                    folderId: "mine",
                });
                await expect(
                    changePersonShare("receiver", share.id, {
                        action: "file",
                        version: 1,
                    }),
                ).rejects.toMatchObject({ statusCode: 400 });
            });
        });

        it("permits folder-free acceptance by the folder owner for a participant's contribution", async () => {
            const [share] = await inviteToItem("owner", "audio", ["other"]);
            await folderInvite("other", "foreign", "owner", true);
            await place("foreign");
            expect(
                (await listMyInvitations("other"))[0].visibleInFolders,
            ).toEqual([{ id: "foreign", name: "Foreign original" }]);
            await changePersonShare("other", share.id, {
                action: "accept",
                version: 0,
            });
            expect(await isItemReceived("other", "audio")).toBe(true);
        });

        it("keeps version, receiver and own-folder checks when a live folder path exists", async () => {
            const share = await direct();
            await place();
            await folderInvite("owner", "source", "receiver", true);
            await expect(
                changePersonShare("receiver", share.id, {
                    action: "accept",
                    version: 9,
                }),
            ).rejects.toMatchObject({ statusCode: 409 });
            await expect(
                changePersonShare("other", share.id, {
                    action: "accept",
                    version: 0,
                }),
            ).rejects.toMatchObject({ statusCode: 404 });
            await expect(
                changePersonShare("owner", share.id, {
                    action: "accept",
                    version: 0,
                }),
            ).rejects.toMatchObject({ statusCode: 404 });
            await expect(
                changePersonShare("receiver", share.id, {
                    action: "accept",
                    version: 0,
                    folderId: "source",
                }),
            ).rejects.toMatchObject({ statusCode: 404 });
        });

        it("excludes inactive identity-provider recipients from the audience and received paths", async () => {
            await place();
            await folderInvite("owner", "source", "receiver", true);
            await folderInvite("owner", "source", "pending");
            mockEnv.AUTHZ_MODE = "idp";
            await database.db.insert(userAccessStates).values({
                userId: "receiver",
                issuer: "https://sso.example.com",
                subject: "demo-receiver",
                status: "active",
                capabilities: ["use"],
                verifiedAt: new Date(),
                source: "login",
            });
            expect(
                (await listItemFolderAudience("owner", "audio")).map(
                    (row) => row.receiverUserId,
                ),
            ).toEqual(["receiver"]);
            await database.db
                .update(userAccessStates)
                .set({ status: "disabled" })
                .where(eq(userAccessStates.userId, "receiver"));
            expect(await listItemFolderAudience("owner", "audio")).toEqual([]);
            expect(await listVisibleItemFolders("receiver", ["audio"])).toEqual(
                [],
            );
            expect(
                await database.db.select().from(receivedFolderAttachments),
            ).toHaveLength(1);
        });
    },
);
