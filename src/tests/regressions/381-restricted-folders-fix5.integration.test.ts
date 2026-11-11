import { and, eq } from "drizzle-orm";
import type postgres from "postgres";
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { POST as audiencePost } from "@/app/api/folders/[id]/audience/route";
import { db } from "@/db";
import { folderKnowledgeContext } from "@/db/queries/folder-knowledge";
import { queryItemScopeFolderIds } from "@/db/queries/folder-scope";
import { meetingItemAudienceInTx } from "@/db/queries/meeting-audience";
import {
    accounts,
    folderExportConfigurations,
    folderExportMaterializations,
    googleDriveExportSettings,
    itemShares,
    mailAddresses,
    mailDeliveryLog,
    mailMessages,
    recordingFolderAssignments,
    recordingFolders,
    restrictedFolderMembers,
    userAccessStates,
    users,
} from "@/db/schema";
import { AppError, ErrorCode } from "@/lib/errors";
import { DriveTargetLostError } from "@/lib/folder-exports/drive-provider";
import * as exportProviders from "@/lib/folder-exports/provider-factory";
import { isExportErrorRetryable } from "@/lib/folder-exports/retry";
import { withExportRevocationCleanup } from "@/lib/folder-exports/revocations";
import {
    addRecordingToFolder,
    createFolder,
    ensureRootFolders,
    listFolderOrganization,
    shareItemToOrganizationFolderInTx,
} from "@/lib/folders/folders";
import { restoreWithheldPlacements } from "@/lib/folders/restore-restrictions";
import {
    changeFolderRestriction,
    listRestrictedAudience,
    previewFolderLift,
    restrictedItemReaders,
} from "@/lib/folders/restricted-folders";
import {
    GoogleApiError,
    GoogleConnectionUnavailableError,
} from "@/lib/integrations/google/errors";
import {
    createSecretAddress,
    ensureMailbox,
    findFolderAddress,
} from "@/lib/mail/addresses";
import { authenticateMessage } from "@/lib/mail/dkim";
import { ingestMail, precheckMail } from "@/lib/mail/ingest";
import * as mailStore from "@/lib/mail/store";
import { agendaCandidates } from "@/lib/meetings/attachment";
import { prepareMeeting } from "@/lib/meetings/service";
import { agendaSuggestionsProvider } from "@/lib/meetings/suggestions-provider";
import * as profileResolution from "@/lib/profiles/resolve-for-placement";
import * as rateLimit from "@/lib/rate-limit";
import { localActor } from "@/tests/helpers/session-actor";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";
import {
    rawMessage,
    signMessage,
    testResolver,
    testSigner,
} from "@/tests/mail/dkim-fixtures";
import { insertRecording } from "@/tests/mcp/fixtures";

const { ref, sqlRef, mockEnv, authority } = vi.hoisted(() => ({
    ref: { current: null as Record<PropertyKey, unknown> | null },
    sqlRef: { current: null as postgres.Sql | null },
    authority: { curator: true },
    mockEnv: {
        IS_HOSTED: false,
        DEFAULT_STORAGE_TYPE: "local",
        SELF_HOST_MODE: "shared",
        AUTHZ_MODE: "local",
        AUTHZ_VERIFICATION_MAX_AGE: 1800,
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
        MAIL_DAILY_LIMIT: 500,
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
    get sqlClient() {
        return sqlRef.current;
    },
}));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/authz/curator", () => ({
    userCuratesOrganizationNow: async (id: string) =>
        id === "org" || (id === "curator" && authority.curator),
    actsForOrganization: async (actor: { actorId: string }) =>
        actor.actorId === "org" ||
        (actor.actorId === "curator" && authority.curator),
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
            actor: localActor(id),
        };
    },
}));
vi.mock("@/lib/mail/raw-storage", () => ({
    storeRawMail: async (_user: string, item: string) => `mail/${item}`,
    deleteRawMail: async () => {},
}));
vi.mock("@/lib/rate-limit", () => ({
    consumeRateLimitBucket: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));

const url = getTestDatabaseUrl();
const suite = url ? describe : describe.skip;
const signer = testSigner("example.com");
const resolver = testResolver([signer]);

suite("restricted folders review 5 (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    let openId: string;
    let restrictedId: string;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            url ?? "",
            "restricted_fix5",
        );
        sqlRef.current = database.sql;
        ref.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120000);
    afterAll(async () => {
        sqlRef.current = null;
        ref.current = null;
        await database?.dispose();
    }, 30000);
    beforeEach(async () => {
        vi.restoreAllMocks();
        vi.mocked(rateLimit.consumeRateLimitBucket).mockResolvedValue({
            allowed: true,
            remaining: 59,
            limit: 60,
            resetAt: new Date(Date.now() + 60000),
        });
        mockEnv.AUTHZ_MODE = "local";
        authority.curator = true;
        await db.delete(mailAddresses);
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
        await addRecordingToFolder({
            userId: "owner",
            recordingId: "recording",
            folderId: restrictedId,
        });
    }, 30000);

    it.each([
        "other",
        "member",
        "curator",
    ])("discloses candidate audience names only to a live audience or curator (%s)", async (actor) => {
        const meeting = await prepareMeeting("owner", {
            folderId: restrictedId,
            title: "Agenda",
            start: "2026-09-01T10:00:00Z",
            end: "2026-09-01T11:00:00Z",
        });
        if (actor === "other")
            await db.insert(itemShares).values({
                userId: "owner",
                receiverUserId: actor,
                itemId:
                    ("meetingItemId" in meeting.meeting
                        ? meeting.meeting.meetingItemId
                        : null) ?? "",
                state: "accepted",
            });
        await insertRecording(database.db, { id: "candidate", userId: actor });
        const candidates = await agendaCandidates(actor, "candidate");
        expect(candidates).toHaveLength(1);
        if (actor === "other")
            expect(candidates[0].audience).toEqual({
                organization: false,
                userIds: [],
                users: [],
            });
        else
            expect(candidates[0].audience.users).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        id: "owner",
                        name: "Jitka Dvořáková",
                    }),
                ]),
            );
    }, 30000);

    async function deactivate(kind: string) {
        if (kind === "suspended")
            await db
                .update(users)
                .set({ suspendedAt: new Date() })
                .where(eq(users.id, "member"));
        else {
            await db.insert(userAccessStates).values(
                ["owner", "member", "other", "curator"].map((userId) => ({
                    userId,
                    issuer: mockEnv.OIDC_ISSUER_URL,
                    subject: `${userId}-sub`,
                    capabilities: userId === "member" ? [] : ["use"],
                    status: "active" as const,
                    verifiedAt: new Date(),
                    source: "login" as const,
                })),
            );
            mockEnv.AUTHZ_MODE = "idp";
        }
    }
    it.each([
        "suspended",
        "use-less",
    ])("retains the %s member row without audience, preview, scope or filing access", async (kind) => {
        await db
            .update(restrictedFolderMembers)
            .set({ role: "manager" })
            .where(eq(restrictedFolderMembers.userId, "member"));
        await insertRecording(database.db, {
            id: "member-recording",
            userId: "member",
        });
        await addRecordingToFolder({
            userId: "member",
            recordingId: "member-recording",
            folderId: restrictedId,
        });
        await deactivate(kind);
        await expect(
            listRestrictedAudience("member", restrictedId),
        ).rejects.toMatchObject({
            code: ErrorCode.RESTRICTED_FOLDER_NO_ACCESS,
        });
        await expect(
            previewFolderLift("member", restrictedId),
        ).rejects.toMatchObject({
            code: ErrorCode.RESTRICTED_FOLDER_NO_ACCESS,
        });
        expect(
            (await listRestrictedAudience("owner", restrictedId)).members.map(
                (row) => row.userId,
            ),
        ).not.toContain("member");
        expect(
            (await listFolderOrganization("member")).folders.find(
                (row) => row.id === restrictedId,
            ),
        ).toMatchObject({ access: false });
        expect(
            (await restrictedItemReaders("owner", "recording")).readers.map(
                (row) => row.userId,
            ),
        ).not.toContain("member");
        expect(
            (
                await db.transaction((tx) =>
                    meetingItemAudienceInTx(tx, "recording", "owner", "org"),
                )
            ).userIds.has("member"),
        ).toBe(false);
        expect(
            await queryItemScopeFolderIds({
                itemId: "member-recording",
                ownerUserId: "member",
                orgUserId: "org",
                view: "private",
            }),
        ).not.toContain(restrictedId);
        expect(
            await folderKnowledgeContext({
                folderId: restrictedId,
                ownerId: "org",
                viewerId: "member",
                shared: false,
                restricted: true,
                allOwnedItems: false,
                scopes: ["member"],
            }),
        ).toMatchObject({ itemCount: 0 });
        await expect(
            addRecordingToFolder({
                userId: "member",
                recordingId: "member-recording",
                folderId: restrictedId,
            }),
        ).rejects.toMatchObject({
            code: ErrorCode.RESTRICTED_FOLDER_NO_ACCESS,
        });
        await expect(
            db.transaction((tx) =>
                shareItemToOrganizationFolderInTx(tx, {
                    ownerUserId: "member",
                    itemId: "member-recording",
                    folderId: restrictedId,
                    orgUserId: "org",
                }),
            ),
        ).rejects.toMatchObject({
            code: ErrorCode.RESTRICTED_FOLDER_NO_ACCESS,
        });
        expect(
            await db
                .select()
                .from(restrictedFolderMembers)
                .where(
                    and(
                        eq(restrictedFolderMembers.userId, "member"),
                        eq(restrictedFolderMembers.folderId, restrictedId),
                    ),
                ),
        ).toHaveLength(1);
    }, 30000);

    it.each([
        "suspended",
        "use-less",
    ])("revokes former audience reads after a gate-failing lift and restores them on return (%s)", async (kind) => {
        await db
            .update(restrictedFolderMembers)
            .set({ role: "manager" })
            .where(eq(restrictedFolderMembers.userId, "member"));
        await changeFolderRestriction("owner", restrictedId, "lift");
        await deactivate(kind);
        await expect(
            listRestrictedAudience("member", restrictedId),
        ).rejects.toMatchObject({ statusCode: 404 });
        await expect(
            previewFolderLift("member", restrictedId),
        ).rejects.toMatchObject({ statusCode: 403 });
        expect(
            (await listRestrictedAudience("owner", restrictedId)).members.map(
                (member) => member.userId,
            ),
        ).not.toContain("member");
        if (kind === "suspended")
            await db
                .update(users)
                .set({ suspendedAt: null })
                .where(eq(users.id, "member"));
        else
            await db
                .update(userAccessStates)
                .set({ capabilities: ["use"] })
                .where(eq(userAccessStates.userId, "member"));
        expect(
            (await listRestrictedAudience("member", restrictedId)).role,
        ).toBe("manager");
        expect(
            (await previewFolderLift("member", restrictedId)).items,
        ).toHaveLength(1);
    }, 30000);

    async function envelope() {
        const folder = await findFolderAddress(restrictedId);
        const mailbox = await ensureMailbox("other");
        if (!folder || !mailbox) throw new Error("missing addresses");
        const secret = await createSecretAddress({
            userId: "other",
            baseAddressId: mailbox.id,
            label: null,
        });
        const recipients = [folder, secret].map(
            (address) => `${address.localPart}@${mockEnv.MAIL_DOMAIN}`,
        );
        const raw = await signMessage(
            rawMessage(
                [
                    "From: member@example.com",
                    `To: ${recipients.join(", ")}`,
                    "Subject: Test delivery",
                    `Message-ID: <${crypto.randomUUID()}@example.com>`,
                    "Content-Type: text/plain; charset=utf-8",
                ],
                "A delivery.",
            ),
            signer,
        );
        return {
            raw,
            recipients,
            receivedAt: new Date(),
            spf: "pass",
            resolver,
        };
    }
    it.each([
        "suspended",
        "use-less",
    ])("refuses a stale %s mail sender for the restricted recipient and delivers the other recipient", async (kind) => {
        const input = await envelope();
        await deactivate(kind);
        const facts = await authenticateMessage(input.raw, {
            resolver,
            now: input.receivedAt,
        });
        expect(
            (await precheckMail({ recipients: input.recipients, facts }))
                .accepted,
        ).toEqual([input.recipients[1]]);
        expect(
            (await ingestMail(input)).outcomes.map((row) => row.outcome),
        ).toEqual(["refused", "accepted"]);
        expect(
            await db.select({ userId: mailMessages.userId }).from(mailMessages),
        ).toEqual([{ userId: "other" }]);
        expect(
            await db
                .select({ reason: mailDeliveryLog.reason })
                .from(mailDeliveryLog)
                .where(eq(mailDeliveryLog.outcome, "refused")),
        ).toEqual([{ reason: "not_a_user" }]);
    }, 30000);
    it.each([
        false,
        true,
    ])("isolates an owner's delivery failure and only retries transient errors (transient=%s)", async (transient) => {
        const input = await envelope();
        const error = new AppError(
            transient
                ? ErrorCode.SERVICE_UNAVAILABLE
                : ErrorCode.RESTRICTED_FOLDER_NO_ACCESS,
            "Delivery failed",
            transient ? 503 : 403,
        );
        vi.spyOn(mailStore, "storeMailForOwner").mockRejectedValueOnce(error);
        if (transient) await expect(ingestMail(input)).rejects.toBe(error);
        else
            expect(
                (await ingestMail(input)).outcomes.map((row) => row.outcome),
            ).toEqual(["refused", "accepted"]);
        expect(
            await db.select({ userId: mailMessages.userId }).from(mailMessages),
        ).toEqual([{ userId: "other" }]);
    }, 30000);
    it("rate-limits audience POST before adding anyone", async () => {
        vi.mocked(rateLimit.consumeRateLimitBucket).mockResolvedValue({
            allowed: false,
            limit: 60,
            remaining: 0,
            resetAt: new Date(Date.now() + 60000),
        });
        const response = await audiencePost(
            new Request(
                `http://localhost/api/folders/${restrictedId}/audience`,
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ userIds: ["other"] }),
                },
            ),
            { params: Promise.resolve({ id: restrictedId }) },
        );
        expect(response.status).toBe(429);
        expect(await response.json()).toMatchObject({
            code: ErrorCode.RATE_LIMITED,
        });
        expect(rateLimit.consumeRateLimitBucket).toHaveBeenCalledWith(
            "person-shares:POST:owner",
            { limit: 60, windowMs: 60000 },
        );
        expect(
            await db
                .select()
                .from(restrictedFolderMembers)
                .where(eq(restrictedFolderMembers.userId, "other")),
        ).toEqual([]);
    });
    it("excludes a withheld placement in an open folder from a co-editor's suggestion profile", async () => {
        const meeting = await prepareMeeting("owner", {
            folderId: openId,
            title: "Open agenda",
        });
        const itemId =
            ("meetingItemId" in meeting.meeting
                ? meeting.meeting.meetingItemId
                : null) ?? "";
        const withheldFolder = await createFolder({
            userId: "org",
            parentId: openId,
            name: "Withheld context",
            canCurate: true,
        });
        await db.insert(recordingFolderAssignments).values({
            itemId,
            userId: "owner",
            folderId: withheldFolder.id,
            withheld: true,
        });
        const resolve = vi
            .spyOn(profileResolution, "resolveProfileForPlacements")
            .mockResolvedValue({ status: "choose", candidates: [] });
        await expect(
            agendaSuggestionsProvider("other", meeting.id),
        ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
        expect(resolve).toHaveBeenCalledWith(
            expect.objectContaining({ folderIds: [openId] }),
        );
    }, 30000);
    it.each([
        false,
        true,
    ])("keeps releasedAt null when restoring a withheld row (archived withheld=%s)", async (withheld) => {
        await insertRecording(database.db, { id: "restore", userId: "member" });
        expect(
            await restoreWithheldPlacements(
                "member",
                [
                    {
                        itemId: "old",
                        folderId: restrictedId,
                        withheld,
                        releasedAt: "2026-10-01T00:00:00Z",
                        path: [],
                    },
                ],
                { old: "restore" },
            ),
        ).toEqual({ restored: 1, skipped: 0 });
        expect(
            await db
                .select({
                    withheld: recordingFolderAssignments.withheld,
                    releasedAt: recordingFolderAssignments.releasedAt,
                })
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.itemId, "restore")),
        ).toEqual([{ withheld: true, releasedAt: null }]);
    }, 30000);

    it("confirms absence once for multiple pending copies without discarding unresolved obligations", async () => {
        await db.insert(folderExportConfigurations).values({
            id: "drive",
            userId: "org",
            folderId: openId,
            provider: "google-drive",
        });
        await db.insert(googleDriveExportSettings).values({
            userId: "org",
            exportConfigurationId: "drive",
            accountSubject: "test",
            rootFolderId: "root",
            rootFolderName: "Exports",
        });
        await db.insert(folderExportMaterializations).values(
            ["one", "two"].map((id) => ({
                id,
                userId: "org",
                exportConfigurationId: "drive",
                itemId: "recording",
                placementFolderId: restrictedId,
                artifactType: "audio" as const,
                artifactId: id,
                format: "file" as const,
                artifactVersion: "v1",
                logicalPath: `root/${id}`,
                expectedSize: 1,
                revocationPending: true,
            })),
        );
        const ownedEntries = vi
            .fn()
            .mockResolvedValue(new Map([["root/two", "file"]]));
        vi.spyOn(exportProviders, "createExportProvider").mockResolvedValue({
            removeFile: vi.fn().mockResolvedValue(false),
            ownedEntries,
        } as unknown as Awaited<
            ReturnType<typeof exportProviders.createExportProvider>
        >);
        const work = vi.fn();
        await expect(
            withExportRevocationCleanup([{ id: "drive", userId: "org" }], work),
        ).rejects.toMatchObject({ code: ErrorCode.EXPORT_REVOCATION_PENDING });
        expect(ownedEntries).toHaveBeenCalledTimes(1);
        expect(work).not.toHaveBeenCalled();
        expect(
            await db
                .select({ id: folderExportMaterializations.id })
                .from(folderExportMaterializations),
        ).toEqual([{ id: "two" }]);
    }, 30000);

    it.each([
        "disconnected",
        "lost target",
        "construction",
        "missing configuration",
        "transient",
        "permanent removal",
    ])("retains the revocation obligation and classifies %s", async (kind) => {
        await db.insert(folderExportConfigurations).values({
            id: "drive",
            userId: "org",
            folderId: openId,
            provider: "google-drive",
        });
        if (kind !== "missing configuration")
            await db.insert(googleDriveExportSettings).values({
                userId: "org",
                exportConfigurationId: "drive",
                accountSubject: "test",
                rootFolderId: "root",
                rootFolderName: "Exports",
            });
        await db.insert(folderExportMaterializations).values(
            ["one", "two"].map((id) => ({
                id,
                userId: "org",
                exportConfigurationId: "drive",
                itemId: "recording",
                placementFolderId: restrictedId,
                artifactType: "audio" as const,
                artifactId: id,
                format: "file" as const,
                artifactVersion: "v1",
                logicalPath: `root/${id}`,
                expectedSize: 1,
                revocationPending: true,
            })),
        );
        const provider = vi.spyOn(exportProviders, "createExportProvider");
        const ownedEntries = vi.fn().mockResolvedValue(
            new Map([
                ["root/one", "file"],
                ["root/two", "file"],
            ]),
        );
        if (kind === "construction")
            provider.mockRejectedValue(
                new Error("Invalid provider configuration"),
            );
        else if (kind === "disconnected")
            provider.mockRejectedValue(
                new GoogleConnectionUnavailableError("needs_reconnect"),
            );
        else
            provider.mockResolvedValue({
                removeFile: vi
                    .fn()
                    .mockRejectedValue(
                        kind === "lost target"
                            ? new DriveTargetLostError("target gone")
                            : new GoogleApiError(
                                  kind === "transient" ? 503 : 403,
                                  "denied",
                                  "Provider refused",
                              ),
                    ),
                ownedEntries,
            } as unknown as Awaited<
                ReturnType<typeof exportProviders.createExportProvider>
            >);
        const work = vi.fn();
        let failure: unknown;
        try {
            await withExportRevocationCleanup(
                [{ id: "drive", userId: "org" }],
                work,
            );
        } catch (error) {
            failure = error;
        }
        expect(failure).toMatchObject({
            code:
                kind === "transient"
                    ? ErrorCode.EXPORT_REVOCATION_PENDING
                    : ErrorCode.EXPORT_REVOCATION_BLOCKED,
            details: { retryable: kind === "transient" },
        });
        expect(isExportErrorRetryable(failure)).toBe(kind === "transient");
        expect(work).not.toHaveBeenCalled();
        expect(
            await db.select().from(folderExportMaterializations),
        ).toHaveLength(2);
        if (kind === "disconnected")
            expect(failure).toMatchObject({
                details: { cause: "needs_reconnect" },
            });
        if (kind === "lost target")
            expect(failure).toMatchObject({
                details: { cause: "target_lost" },
            });
    }, 30000);
});
