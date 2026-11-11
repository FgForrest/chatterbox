import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { and, eq, type SQL, sql } from "drizzle-orm";
import unzipper from "unzipper";
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { PATCH as accessRequestPatch } from "@/app/api/folders/[id]/access-requests/[requestId]/route";
import {
    DELETE as accessRequestDelete,
    POST as accessRequestPost,
    GET as accessRequestsGet,
} from "@/app/api/folders/[id]/access-requests/route";
import {
    DELETE as audienceDelete,
    GET as audienceGet,
    POST as audiencePost,
} from "@/app/api/folders/[id]/audience/route";
import { GET as defaultsGet } from "@/app/api/folders/[id]/default-profiles/route";
import { GET as folderExportsGet } from "@/app/api/folders/[id]/exports/route";
import { GET as folderKnowledgeGet } from "@/app/api/folders/[id]/knowledge/route";
import {
    GET as liftGet,
    POST as liftPost,
} from "@/app/api/folders/[id]/lift/route";
import { GET as folderAddressesGet } from "@/app/api/folders/[id]/mail-addresses/route";
import {
    GET as restrictGet,
    POST as restrictPost,
} from "@/app/api/folders/[id]/restrict/route";
import { GET as publicFolderGet } from "@/app/api/folders/[id]/route";
import { POST as restoreRestrictionsRoute } from "@/app/api/folders/restrictions/restore/route";
import { POST as createFolderRoute } from "@/app/api/folders/route";
import { GET as readersGet } from "@/app/api/items/[id]/readers/route";
import { PATCH as acceptSuggestion } from "@/app/api/meetings/[id]/suggestions/[sid]/route";
import { POST as categorizePost } from "@/app/api/recordings/[id]/categorize/route";
import {
    PATCH as itemMove,
    DELETE as itemUnfile,
} from "@/app/api/recordings/[id]/folders/route";
import { PATCH as itemRename } from "@/app/api/recordings/[id]/route";
import { GET as recorderFolders } from "@/app/api/v1/recorder/folders/route";
import { db } from "@/db";
import { insertAudioItem } from "@/db/items";
import { duplicateEvidence } from "@/db/queries/almanac-duplicates";
import { almanacScopeUsage } from "@/db/queries/almanac-usage";
import { claimDueJobs } from "@/db/queries/async-jobs";
import { folderKnowledgeContext } from "@/db/queries/folder-knowledge";
import { queryItemScopeFolderIds } from "@/db/queries/folder-scope";
import { receivedItemCondition } from "@/db/queries/item-shares";
import { listMailReapCandidates } from "@/db/queries/mail-retention";
import { meetingItemAudienceInTx } from "@/db/queries/meeting-audience";
import { listMeetingRows } from "@/db/queries/meetings";
import { organizationRetentionCondition } from "@/db/queries/organization-retention";
import { agendaInputItemCondition } from "@/db/queries/restricted-agenda-sources";
import { listReapCandidates } from "@/db/queries/retention";
import { loadStatistics } from "@/db/queries/statistics";
import {
    ANY_TASK_ITEM,
    taskRecordingShared,
    taskVisible,
} from "@/db/queries/task-visibility";
import {
    accounts,
    agendaPoints,
    agendaSuggestions,
    asyncJobs,
    chatterItems,
    filesystemExportSettings,
    folderExportConfigurations,
    folderExportMaterializations,
    itemProcessing,
    knowledgeAliases,
    knowledgeEntities,
    knowledgeEntityTypes,
    knowledgeFactEvidence,
    knowledgeFacts,
    knowledgeRelationTypes,
    mailAddresses,
    mailMessages,
    mailPendingShares,
    people,
    processingProfiles,
    recordingFolderAssignments,
    recordingFolders,
    recordings,
    recordingTasks,
    restrictedFolderAccessRequests,
    restrictedFolderMembers,
    transcriptions,
    transcriptSpeakers,
    userAccessStates,
    userSettings,
    users,
} from "@/db/schema";
import { recordAccessState } from "@/lib/authz/access-state";
import {
    decryptText,
    encryptJsonField,
    encryptText,
} from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { mayReceiveOrganizationEvent } from "@/lib/events/visibility";
import type { ArchiveScope } from "@/lib/export/archive-scope";
import { archivedItemCondition } from "@/lib/export/archive-scope";
import { buildAndUploadExportArchive } from "@/lib/export/build-archive";
import { collectRestrictedFolderArchive } from "@/lib/export/restricted-folders";
import { assertExportableFolder } from "@/lib/folder-exports/configurations";
import {
    materializeFolderExport,
    reconcileFolderExport,
} from "@/lib/folder-exports/execution";
import { planFolderExport } from "@/lib/folder-exports/planner";
import * as exportProviders from "@/lib/folder-exports/provider-factory";
import {
    cancelRestrictedFolderAccessRequest,
    decideRestrictedFolderAccessRequest,
    listMyRestrictedAccessInvitations,
    listRestrictedFolderAccessRequests,
    requestRestrictedFolderAccess,
} from "@/lib/folders/access-requests";
import { folderRecordingCondition } from "@/lib/folders/condition";
import {
    addRecordingToFolder,
    assertCategorizableFolder,
    createFolder,
    deleteFolder,
    ensureRootFolders,
    listExportFolderOrganization,
    listFolderOrganization,
    listRecordingFolderTrees,
    moveFolder,
    moveRecordingBetweenFolders,
    removeRecordingFromFolder,
    resolveReadableFolder,
} from "@/lib/folders/folders";
import {
    restoreRestrictedFolderMetadata,
    restoreWithheldPlacements,
} from "@/lib/folders/restore-restrictions";
import {
    changeFolderRestriction,
    changeRestrictedAudience,
    listRestrictedAudience,
    previewFolderRestriction,
    processRestrictedFolderItem,
    type RestrictedFolderItemWork,
    restrictedItemReaders,
} from "@/lib/folders/restricted-folders";
import { domainLookupHash, lookupHash } from "@/lib/knowledge/lookup-hash";
import { recordingSharedCondition } from "@/lib/knowledge/org-people";
import { resolveMailAccess } from "@/lib/mail/access";
import { ensureFolderAddress } from "@/lib/mail/addresses";
import { loadMailDetail } from "@/lib/mail/detail";
import { loadFolderAddresses } from "@/lib/mail/folder-addresses";
import { precheckMail } from "@/lib/mail/ingest";
import { loadReceivedMailRows } from "@/lib/mail/list";
import {
    attendedRecordingCondition,
    callerFolderOrganization,
} from "@/lib/mcp/data/recordings";
import { mcpItemCondition } from "@/lib/mcp/scope";
import { MEETING_TOOLS } from "@/lib/mcp/tools/meetings";
import { RECORDING_TOOLS } from "@/lib/mcp/tools/recordings";
import { requireMeetingAccess } from "@/lib/meetings/access";
import { attachAgenda } from "@/lib/meetings/attachment";
import { restoreMeetings } from "@/lib/meetings/restore";
import {
    addPoint,
    decideSuggestion,
    getMeeting,
    listMeetings,
    prepareMeeting,
} from "@/lib/meetings/service";
import { sendPersonShareInvitation } from "@/lib/notifications/person-share";
import { requestArrivalInTx } from "@/lib/pipeline/arrival";
import { loadPrivateCategorizationPanel } from "@/lib/pipeline/categorization-presentation";
import { loadPrivateItemProcessing } from "@/lib/pipeline/presentation";
import {
    executeIntendedSharesWithOutcome,
    recordIntendedPlacementInTx,
} from "@/lib/pipeline/share-intent";
import { resolveChannelDefaultProfile } from "@/lib/profiles/resolve-for-placement";
import { ensureProfiles } from "@/lib/profiles/seed";
import { defaultProfileSettings } from "@/lib/profiles/settings";
import { createProfile } from "@/lib/profiles/store";
import { searchItems } from "@/lib/search/item-search";
import {
    requireRecordingView,
    resolveRecordingAccess,
} from "@/lib/sharing/access";
import { isRecordingShared, sharedItemCondition } from "@/lib/sharing/shared";
import { metricIndex } from "@/lib/statistics/data";
import * as storageProviders from "@/lib/storage/factory";
import type { StorageProvider } from "@/lib/storage/types";
import { taskClosable, taskEditable, taskViewer } from "@/lib/tasks/access";
import { countNewTasks, listCallerTasks } from "@/lib/tasks/tasks";
import { saveUploadedAudioFile } from "@/lib/uploads/save-uploaded-audio-file";
import { localActor } from "@/tests/helpers/session-actor";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";
import {
    insertRecording,
    insertTask,
    insertTranscript,
    serviceCaller,
    userCaller,
} from "@/tests/mcp/fixtures";

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
vi.mock("@/lib/uploads/audio-duration", () => ({
    readAudioFileDurationMs: async () => 1000,
}));
vi.mock("@/lib/audio/server-waveform", () => ({
    generateFileWaveform: async () => null,
}));
vi.mock("@/lib/recordings/storage-reconciliation-job", () => ({
    enqueueStorageReconciliationJob: async () => {},
}));
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
vi.mock("@/lib/recording-sessions/route-gate", () => ({
    gateRecordingSessionRequest: async (request: Request) => ({
        authn: { user: { id: request.headers.get("x-test-user") ?? "owner" } },
    }),
}));

type Handler = (
    request: Request,
    context?: { params: Promise<{ id: string }> },
) => Promise<Response> | Response;
const url = getTestDatabaseUrl();
const suite = url ? describe : describe.skip;

suite("restricted Organization folders (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    let exportRoot: string;
    let openId: string;
    let restrictedId: string;
    beforeAll(async () => {
        exportRoot = await mkdtemp(join(tmpdir(), "restricted-exports-"));
        mockEnv.FILESYSTEM_EXPORT_ROOT = exportRoot;
        database = await createMigratedTestDatabase(
            url ?? "",
            "restricted_folders",
        );
        ref.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120000);
    afterAll(async () => {
        ref.current = null;
        await database?.dispose();
        await rm(exportRoot, { recursive: true, force: true });
    }, 30000);
    beforeEach(async () => {
        authority.curator = true;
        mockEnv.SELF_HOST_MODE = "shared";
        mockEnv.IS_HOSTED = false;
        mockEnv.AUTHZ_MODE = "local";
        vi.mocked(sendPersonShareInvitation).mockClear();
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
    });
    function call(
        handler: unknown,
        id: string,
        user = "owner",
        body?: object,
        method = "GET",
        query = "",
    ) {
        return (handler as Handler)(
            new Request(`http://localhost/api/test${query}`, {
                method,
                headers: {
                    "x-test-user": user,
                    "content-type": "application/json",
                },
                ...(body ? { body: JSON.stringify(body) } : {}),
            }),
            { params: Promise.resolve({ id }) },
        );
    }
    async function ids(condition: SQL | undefined) {
        return (
            await db
                .select({ id: chatterItems.id })
                .from(chatterItems)
                .leftJoin(recordings, eq(recordings.id, chatterItems.id))
                .leftJoin(
                    recordingTasks,
                    eq(recordingTasks.itemId, chatterItems.id),
                )
                .where(condition)
        ).map((row) => row.id);
    }
    async function makeShareable() {
        await insertTranscript(database.db, "recording", "owner");
    }

    async function interleave<T>(
        action: () => Promise<T>,
        change: () => Promise<unknown>,
    ) {
        const gate = await database.sql.reserve();
        const key = 381002;
        await gate`select pg_advisory_lock(${key})`;
        const transaction = database.db.transaction.bind(database.db);
        const spy = vi.spyOn(database.db, "transaction");
        spy.mockImplementationOnce((run, options) =>
            transaction(async (tx) => {
                await tx.execute(sql`select pg_advisory_xact_lock(${key})`);
                return run(tx);
            }, options),
        );
        const result = action().then(
            (value) => ({ value }),
            (error) => ({ error }),
        );
        try {
            await expect
                .poll(
                    async () => {
                        const [row] =
                            await database.sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and objid = ${key} and not granted`;
                        return row.n;
                    },
                    { timeout: 10000 },
                )
                .toBe(1);
            await change();
        } finally {
            await gate`select pg_advisory_unlock(${key})`;
            gate.release();
            spy.mockRestore();
        }
        return result;
    }
    async function archive(scope: ArchiveScope) {
        const storage = new RestrictedArchiveStorage();
        await buildAndUploadExportArchive({
            scope,
            sourceStorage: storage,
            destinationStorage: storage,
            storageKey: "archive.zip",
        });
        const zip = await unzipper.Open.buffer(storage.uploaded);
        const values = new Map<string, string>();
        for (const file of zip.files)
            values.set(file.path, (await file.buffer()).toString("utf8"));
        return values;
    }
    it.each([
        "source",
        "destination",
    ])("serializes non-owner moves against restriction of the %s", async (side) => {
        await makeShareable();
        await changeFolderRestriction("owner", restrictedId, "lift");
        const destination = await createFolder({
            userId: "owner",
            parentId: openId,
            name: "Destination",
        });
        const result = await interleave(
            () =>
                moveRecordingBetweenFolders({
                    userId: "other",
                    recordingId: "recording",
                    fromFolderId: restrictedId,
                    toFolderId: destination.id,
                }),
            () =>
                changeFolderRestriction(
                    "curator",
                    side === "source" ? restrictedId : destination.id,
                    "restrict",
                    ["member"],
                ),
        );
        expect(result).toHaveProperty("error");
        const rows = await db
            .select()
            .from(recordingFolderAssignments)
            .where(eq(recordingFolderAssignments.itemId, "recording"));
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            folderId: restrictedId,
            withheld: side === "source",
        });
        expect(await isRecordingShared("recording", "org")).toBe(
            side !== "source",
        );
        expect(
            (
                await listRestrictedAudience(
                    "curator",
                    side === "source" ? restrictedId : destination.id,
                )
            ).members.map((row) => row.userId),
        ).toContain("member");
    });
    it.each([
        "remove",
        "private",
    ])("cancels a pending lift on %s before a stale share execution resumes", async (operation) => {
        await changeFolderRestriction("owner", restrictedId, "lift");
        await ensureRootFolders("owner");
        const [root] = await db
            .select()
            .from(recordingFolders)
            .where(
                and(
                    eq(recordingFolders.userId, "owner"),
                    eq(recordingFolders.kind, "private"),
                ),
            );
        const personal = await createFolder({
            userId: "owner",
            parentId: root.id,
            name: "Personal",
        });
        await makeShareable();
        const result = await interleave(
            () => executeIntendedSharesWithOutcome("owner", "recording"),
            () =>
                operation === "remove"
                    ? removeRecordingFromFolder({
                          userId: "owner",
                          recordingId: "recording",
                          folderId: restrictedId,
                      })
                    : moveRecordingBetweenFolders({
                          userId: "owner",
                          recordingId: "recording",
                          fromFolderId: restrictedId,
                          toFolderId: personal.id,
                      }),
        );
        expect(result).toMatchObject({
            value: { shared: false, remaining: false },
        });
        expect(await isRecordingShared("recording", "org")).toBe(false);
        expect(
            await db
                .select()
                .from(mailPendingShares)
                .where(eq(mailPendingShares.itemId, "recording")),
        ).toEqual([]);
        expect(
            await db
                .select()
                .from(recordingFolderAssignments)
                .where(
                    and(
                        eq(recordingFolderAssignments.itemId, "recording"),
                        eq(recordingFolderAssignments.folderId, restrictedId),
                    ),
                ),
        ).toEqual([]);
        expect(
            await db.select().from(people).where(eq(people.userId, "org")),
        ).toEqual([]);
    });
    it("keeps an ordinary requested share after cancelling a different pending release", async () => {
        await changeFolderRestriction("owner", restrictedId, "lift");
        await db.transaction((tx) =>
            recordIntendedPlacementInTx(tx, {
                canCurate: false,
                ownerUserId: "owner",
                itemId: "recording",
                folderId: openId,
            }),
        );
        await makeShareable();
        const result = await interleave(
            () => executeIntendedSharesWithOutcome("owner", "recording"),
            () =>
                removeRecordingFromFolder({
                    userId: "owner",
                    recordingId: "recording",
                    folderId: restrictedId,
                }),
        );
        expect(result).toMatchObject({
            value: { shared: true, remaining: false },
        });
        const placements = await db
            .select()
            .from(recordingFolderAssignments)
            .where(eq(recordingFolderAssignments.itemId, "recording"));
        expect(placements).toMatchObject([
            { folderId: openId, withheld: false },
        ]);
    });
    it.each([
        "source restriction",
        "agenda widening",
        "second restricted audience",
    ])("refuses stale suggestions after %s and retains accepted points", async (scenario) => {
        await makeShareable();
        if (scenario === "source restriction")
            await changeFolderRestriction("owner", restrictedId, "lift");
        const prepared = await prepareMeeting("owner", {
            folderId: scenario === "source restriction" ? openId : restrictedId,
            title: "Plan",
        });
        const detail = prepared.meeting;
        if (detail.unchanged || !detail.meetingItemId)
            throw new Error("missing agenda");
        const [accepted] = await db
            .insert(agendaSuggestions)
            .values({
                userId: "owner",
                agendaId: prepared.id,
                kind: "ai",
                text: encryptText("Already accepted"),
                sources: { itemIds: ["recording"], taskIds: [] },
            })
            .returning();
        await decideSuggestion("owner", prepared.id, accepted.id, "added");
        const [suggestion] = await db
            .insert(agendaSuggestions)
            .values({
                userId: "owner",
                agendaId: prepared.id,
                kind: "ai",
                text: encryptText("Source quote"),
                sources: { itemIds: ["recording"], taskIds: [] },
            })
            .returning();
        const result = await interleave(
            async () =>
                acceptSuggestion(
                    new Request("http://localhost/api/test", {
                        method: "PATCH",
                        headers: {
                            "content-type": "application/json",
                            "x-test-user":
                                scenario === "source restriction"
                                    ? "other"
                                    : "owner",
                        },
                        body: JSON.stringify({ state: "added" }),
                    }),
                    {
                        params: Promise.resolve({
                            id: prepared.id,
                            sid: suggestion.id,
                        }),
                    },
                ),
            async () => {
                if (scenario === "second restricted audience") {
                    const folder = await createFolder({
                        userId: "owner",
                        parentId: openId,
                        name: "Wider audience",
                        restricted: true,
                        audienceUserIds: ["other"],
                    });
                    return addRecordingToFolder({
                        userId: "owner",
                        recordingId: detail.meetingItemId ?? "",
                        folderId: folder.id,
                    });
                }
                return scenario === "source restriction"
                    ? changeFolderRestriction(
                          "curator",
                          restrictedId,
                          "restrict",
                          ["member"],
                      )
                    : addRecordingToFolder({
                          userId: "owner",
                          recordingId: detail.meetingItemId ?? "",
                          folderId: openId,
                      });
            },
        );
        if ("error" in result) throw result.error;
        expect(result.value.status).toBe(409);
        expect(await result.value.json()).toMatchObject({
            code: ErrorCode.STALE_AGENDA_SUGGESTION,
        });
        const points = await db
            .select()
            .from(agendaPoints)
            .where(eq(agendaPoints.agendaId, prepared.id));
        expect(points.map((point) => decryptText(point.text))).toEqual([
            "Already accepted",
        ]);
    });
    it("retains a confirmed pending lift through categorization and publishes once", async () => {
        await ensureProfiles("owner");
        await changeFolderRestriction("owner", restrictedId, "lift");
        const [before] = await db
            .select()
            .from(mailPendingShares)
            .where(eq(mailPendingShares.itemId, "recording"));
        const outcome = await interleave(
            () => executeIntendedSharesWithOutcome("owner", "recording"),
            async () => {
                const response = await call(
                    categorizePost,
                    "recording",
                    "owner",
                    { folderIds: [restrictedId], manualOnly: true },
                    "POST",
                );
                expect(response.status).toBe(200);
                const [after] = await db
                    .select()
                    .from(mailPendingShares)
                    .where(eq(mailPendingShares.itemId, "recording"));
                expect(after.confirmedAt).toEqual(before.confirmedAt);
                await makeShareable();
            },
        );
        expect(outcome).toMatchObject({ value: { shared: true } });
        expect(
            (await executeIntendedSharesWithOutcome("owner", "recording"))
                .shared,
        ).toBe(false);
    });
    it.each([
        "lift",
        "restrict",
        "audience removal",
    ])("rechecks arrival filing after concurrent %s", async (transition) => {
        const folder = await createFolder({
            userId: "owner",
            parentId: openId,
            name: "Arrival",
            restricted: transition !== "restrict",
            audienceUserIds: ["member"],
        });
        await ensureProfiles("member");
        await ensureProfiles("org");
        const personalProfile = await createProfile({
            ownerUserId: "member",
            actor: localActor("member"),
            scope: "personal",
            channel: "audio",
            name: "Private processing",
            settings: defaultProfileSettings("audio"),
            isDefault: true,
        });
        await db
            .insert(userSettings)
            .values({
                userId: "member",
                defaultAudioProfileId: personalProfile.id,
            })
            .onConflictDoUpdate({
                target: userSettings.userId,
                set: { defaultAudioProfileId: personalProfile.id },
            });
        const staleProfile = await resolveChannelDefaultProfile({
            ownerUserId: "org",
            view: "org",
            channel: "audio",
        });
        const target = await assertCategorizableFolder("member", folder.id);
        const result = await interleave(
            () =>
                insertAudioItem(
                    database.db,
                    {
                        id: "arrival",
                        userId: "member",
                        title: encryptText("Arrival"),
                        occurredAt: new Date(),
                        deviceSn: "local",
                        plaudFileId: "arrival",
                        fileMd5: "a".repeat(32),
                        plaudVersion: "1",
                        duration: 1000,
                        endTime: new Date(),
                        filesize: 20,
                        storagePath: "member/arrival.mp3",
                        storageType: "local",
                    },
                    {
                        pipeline: "arrival",
                        initializeInTx: (tx, input) =>
                            requestArrivalInTx(tx, {
                                ...input,
                                canCurate: false,
                                folder: target,
                                profile: staleProfile,
                            }),
                    },
                ),
            () =>
                transition === "audience removal"
                    ? changeRestrictedAudience("owner", folder.id, {
                          removeUserId: "member",
                      })
                    : changeFolderRestriction(
                          transition === "lift" ? "owner" : "curator",
                          folder.id,
                          transition === "lift" ? "lift" : "restrict",
                          ["member"],
                      ),
        );
        if (transition === "audience removal")
            expect(result).toHaveProperty("error");
        else {
            if ("error" in result) throw result.error;
            expect(result).toHaveProperty("value");
            const placements = await db
                .select()
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.itemId, "arrival"));
            const pending = await db
                .select()
                .from(mailPendingShares)
                .where(eq(mailPendingShares.itemId, "arrival"));
            expect(placements).toHaveLength(transition === "restrict" ? 1 : 0);
            expect(pending).toHaveLength(transition === "lift" ? 1 : 0);
        }
        if (transition === "restrict") {
            const [processing] = await db
                .select({ ownerId: processingProfiles.ownerUserId })
                .from(itemProcessing)
                .innerJoin(
                    processingProfiles,
                    eq(processingProfiles.id, itemProcessing.profileId),
                )
                .where(
                    and(
                        eq(itemProcessing.itemId, "arrival"),
                        eq(itemProcessing.userId, "member"),
                    ),
                );
            expect(processing.ownerId).toBe("member");
        }
        expect(await isRecordingShared("arrival", "org")).toBe(false);
    });
    it.each([
        false,
        true,
    ])("lists Organization-owned restricted agendas only after lift for a real service tool call (attached=%s)", async (attached) => {
        const prepared = await prepareMeeting("org", {
            folderId: restrictedId,
            title: "Organization plan",
        });
        if (attached) {
            await insertRecording(database.db, {
                id: "org-audio",
                userId: "org",
            });
            await insertTranscript(database.db, "org-audio", "org");
            await attachAgenda("org", prepared.id, "org-audio");
        }
        const tool = MEETING_TOOLS.find(
            (tool) => tool.name === "list_meetings",
        );
        if (!tool) throw new Error("missing tool");
        const run = () =>
            tool.run(
                { caller: serviceCaller("org", ["tasks:read"]), touched: [] },
                {},
            );
        expect(await run()).toMatchObject({ meetings: [] });
        for (const includeAbsorbed of [false, true])
            expect(
                await listMeetingRows("org", "org", {
                    organizationOnly: true,
                    includeAbsorbed,
                    includePast: true,
                }),
            ).toHaveLength(0);
        await changeFolderRestriction("owner", restrictedId, "lift");
        expect(await run()).toMatchObject({
            meetings: attached
                ? []
                : [expect.objectContaining({ id: prepared.id })],
        });
        if (attached)
            expect(
                await listMeetingRows("org", "org", {
                    organizationOnly: true,
                    includeAbsorbed: true,
                    includePast: true,
                }),
            ).toHaveLength(1);
    });
    it("round-trips Organization-owned restricted agenda content and keeps members' withheld content out", async () => {
        const prepared = await prepareMeeting("org", {
            folderId: restrictedId,
            title: "Organization plan",
        });
        await addPoint("org", prepared.id, { text: "Preserved point" });
        const values = await archive({
            kind: "organization",
            orgUserId: "org",
        });
        expect([...values.values()].join("\n")).not.toContain(
            "Restricted evidence",
        );
        const meetings = JSON.parse(
            values.get("meetings/agendas.json") ?? "[]",
        );
        expect(meetings[0].points[0].text).toBe("Preserved point");
        const metadata = JSON.parse(
            values.get("organization/restrictions.json") ?? "{}",
        );
        const folder = await createFolder({
            userId: "org",
            parentId: openId,
            name: "Restored organization plan",
        });
        await restoreRestrictedFolderMetadata("org", metadata.folders, {
            [restrictedId]: folder.id,
        });
        const restored = await restoreMeetings("org", {
            meetings,
            folderIdMap: { [restrictedId]: folder.id },
        });
        expect(restored.skipped).toEqual([]);
        expect(restored.restored).toHaveLength(1);
        const detail = await getMeeting("org", restored.restored[0].id);
        expect(detail).toMatchObject({
            shared: false,
            points: [expect.objectContaining({ text: "Preserved point" })],
        });
        const [placement] = await db
            .select()
            .from(recordingFolderAssignments)
            .where(
                eq(
                    recordingFolderAssignments.itemId,
                    restored.restored[0].meetingItemId,
                ),
            );
        expect(placement.withheld).toBe(true);
    });
    it("archives an Organization-owned agenda attached to a member's unpublished recording without the recording", async () => {
        const prepared = await prepareMeeting("org", {
            folderId: openId,
            title: "Organization-owned plan",
        });
        await addPoint("org", prepared.id, { text: "Owned planning text" });
        await attachAgenda("owner", prepared.id, "recording");
        expect(await isRecordingShared("recording", "org")).toBe(false);
        const values = await archive({
            kind: "organization",
            orgUserId: "org",
        });
        const meetings = JSON.parse(
            values.get("meetings/agendas.json") ?? "[]",
        );
        expect(meetings).toMatchObject([
            {
                id: prepared.id,
                recordingItemId: null,
                points: [
                    expect.objectContaining({ text: "Owned planning text" }),
                ],
            },
        ]);
        expect([...values.values()].join("\n")).not.toContain(
            "Restricted evidence",
        );
    });
    it("keeps a day-29 release timestamp through the archive and placement restore adapter", async () => {
        await makeShareable();
        await changeFolderRestriction("owner", restrictedId, "lift");
        const releasedAt = new Date(Date.now() - 29 * 86400000);
        await db
            .update(recordingFolderAssignments)
            .set({ releasedAt })
            .where(eq(recordingFolderAssignments.itemId, "recording"));
        const personal = await archive({ kind: "personal", userId: "owner" });
        const organization = await archive({
            kind: "organization",
            orgUserId: "org",
        });
        const { placements } = JSON.parse(
            personal.get("organization/restrictions.json") ?? "{}",
        );
        expect(placements[0]).toMatchObject({
            withheld: false,
            releasedAt: releasedAt.toISOString(),
        });
        const { assignments } = JSON.parse(
            organization.get("organization/folders.json") ?? "{}",
        );
        expect(assignments[0].releasedAt).toBe(releasedAt.toISOString());
        await removeRecordingFromFolder({
            userId: "owner",
            recordingId: "recording",
            folderId: restrictedId,
            withdraw: true,
        });
        expect(
            await restoreWithheldPlacements("owner", placements, {
                recording: "recording",
            }),
        ).toEqual({ restored: 1, skipped: 0 });
        expect(await ids(organizationRetentionCondition("org"))).toEqual([]);
        const [placement] = await db
            .select()
            .from(recordingFolderAssignments)
            .where(eq(recordingFolderAssignments.itemId, "recording"));
        expect(placement.releasedAt).toEqual(releasedAt);
    });
    it.each([
        "owner",
        "member",
        "curator",
        "org",
    ])("grants receiver reads without Organization publication to %s", async (user) => {
        const access = await resolveRecordingAccess(user, "recording");
        expect(access?.role).toBe(user === "owner" ? "owner" : "receiver");
        expect(access?.shared).toBe(false);
        if (user !== "owner")
            expect(
                (await requireRecordingView(user, "recording", "received"))
                    .view,
            ).toBe("received");
        expect(
            (await listRecordingFolderTrees(user)).some(
                (folder) => folder.id === restrictedId,
            ),
        ).toBe(true);
        expect((await listFolderOrganization(user)).assignments).toContainEqual(
            { recordingId: "recording", folderId: restrictedId },
        );
        const viewer = await taskViewer({
            id: user,
            email: `${user}@example.com`,
        });
        expect(
            await ids(
                mcpItemCondition(
                    {
                        ...userCaller(
                            user,
                            `${user}@example.com`,
                            ["transcripts:read"],
                            "org",
                        ),
                        isCurator: viewer.isCurator,
                    },
                    ["audio", "mail"],
                ),
            ),
        ).toContain("recording");
        expect(
            await ids(
                receivedItemCondition(user, chatterItems.id, viewer.isCurator),
            ),
        ).toEqual(user === "owner" ? [] : ["recording"]);
        expect(
            (
                await searchItems({
                    viewerUserId: user,
                    view: "private",
                    query: "evidence",
                })
            ).hits.map((hit) => hit.id),
        ).toContain("recording");
        expect(
            await mayReceiveOrganizationEvent(user, {
                type: "recording",
                recordingId: "recording",
            }),
        ).toBe(true);
    });
    it("publishes folder nodes while concealing content across metadata, search, events and services", async () => {
        expect(await resolveRecordingAccess("other", "recording")).toBeNull();
        await expect(
            resolveReadableFolder("other", restrictedId),
        ).rejects.toMatchObject({
            statusCode: 403,
            code: ErrorCode.RESTRICTED_FOLDER_NO_ACCESS,
        });
        expect(
            await mayReceiveOrganizationEvent("other", {
                type: "tree",
                folderId: restrictedId,
                structural: true,
            }),
        ).toBe(true);
        expect(
            await mayReceiveOrganizationEvent("member", {
                type: "tree",
                folderId: restrictedId,
            }),
        ).toBe(true);

        expect(
            await mayReceiveOrganizationEvent("other", {
                type: "tree",
                folderId: restrictedId,
            }),
        ).toBe(false);
        await expect(
            assertCategorizableFolder("other", restrictedId),
        ).rejects.toMatchObject({
            statusCode: 403,
            code: ErrorCode.RESTRICTED_FOLDER_NO_ACCESS,
        });
        expect(
            (await listRecordingFolderTrees("other")).some(
                (folder) => folder.id === restrictedId,
            ),
        ).toBe(true);
        expect(
            (
                await searchItems({
                    viewerUserId: "other",
                    view: "private",
                    query: "evidence",
                })
            ).hits,
        ).toEqual([]);
        expect(
            await mayReceiveOrganizationEvent("other", {
                type: "recording",
                recordingId: "recording",
            }),
        ).toBe(false);
        const service = serviceCaller("org", ["transcripts:read"]);
        expect(await ids(mcpItemCondition(service, ["audio", "mail"]))).toEqual(
            [],
        );
        expect(
            (await callerFolderOrganization(service)).folders.some(
                (folder) => folder.id === restrictedId,
            ),
        ).toBe(false);
        expect((await call(defaultsGet, restrictedId, "other")).status).toBe(
            403,
        );
        expect(
            (
                await call(
                    recorderFolders,
                    restrictedId,
                    "other",
                    undefined,
                    "GET",
                    `?id=${restrictedId}`,
                )
            ).status,
        ).toBe(404);
        const response = await call(
            recorderFolders,
            restrictedId,
            "member",
            undefined,
            "GET",
            `?id=${restrictedId}`,
        );
        expect(response.status).toBe(200);
        expect((await response.json()).data[0]).toMatchObject({
            id: restrictedId,
            restricted: true,
        });
        expect(
            (
                await loadFolderAddresses("other", openId, { subtree: true })
            )?.addresses.some((address) => address.folderId === restrictedId),
        ).toBe(false);
    });
    it("exposes only a public restricted node and excludes its items from ancestor totals", async () => {
        const tree = await listFolderOrganization("other");
        const node = tree.folders.find((folder) => folder.id === restrictedId);
        expect(node).toMatchObject({
            restricted: true,
            access: false,
            managers: [{ name: "Jitka Dvořáková" }],
            accessRequest: "none",
        });
        expect(node).not.toHaveProperty("restrictedRole");
        for (const key of [
            "members",
            "email",
            "counts",
            "address",
            "defaults",
            "exports",
        ])
            expect(node).not.toHaveProperty(key);
        expect(
            await ids(
                folderRecordingCondition(tree, "other", openId) ?? undefined,
            ),
        ).toEqual([]);
        expect(
            await ids(
                folderRecordingCondition(tree, "other", restrictedId) ??
                    undefined,
            ),
        ).toEqual([]);
        const response = await call(publicFolderGet, restrictedId, "other");
        expect(response.status).toBe(200);
        expect((await response.json()).folder).toEqual(node);
        for (const action of [
            () => loadFolderAddresses("other", restrictedId),
            () => listRestrictedAudience("other", restrictedId),
            () => assertExportableFolder("other", restrictedId),
        ])
            await expect(action()).rejects.toMatchObject({
                statusCode: 403,
                code: ErrorCode.RESTRICTED_FOLDER_NO_ACCESS,
            });
    });
    it.each([
        ["knowledge", folderKnowledgeGet],
        ["address", folderAddressesGet],
        ["defaults", defaultsGet],
        ["exports", folderExportsGet],
        ["audience", audienceGet],
        ["restrict preview", restrictGet],
        ["lift preview", liftGet],
    ])("returns the dedicated folder refusal for %s", async (_surface, handler) => {
        const response = await call(handler, restrictedId, "other");
        expect(response.status).toBe(403);
        expect((await response.json()).code).toBe(
            ErrorCode.RESTRICTED_FOLDER_NO_ACCESS,
        );
    });
    it("lists public restricted nodes for human MCP callers without permitting filing or content access", async () => {
        const tool = RECORDING_TOOLS.find(
            (tool) => tool.name === "list_folders",
        );
        if (!tool) throw new Error("missing tool");
        const result = (await tool.run(
            {
                caller: userCaller(
                    "other",
                    "other@example.com",
                    ["transcripts:read"],
                    "org",
                ),
                touched: [],
            },
            {},
        )) as {
            folders: {
                id: string;
                restricted?: boolean;
                access?: boolean;
                can_file_own_items: boolean;
                restricted_role?: string;
            }[];
        };
        const folder = result.folders.find(
            (folder) => folder.id === restrictedId,
        );
        expect(folder).toMatchObject({
            restricted: true,
            access: false,
            can_file_own_items: false,
        });
        expect(folder).not.toHaveProperty("restricted_role");
        const service = (await tool.run(
            { caller: serviceCaller("org", ["transcripts:read"]), touched: [] },
            {},
        )) as { folders: { id: string }[] };
        expect(
            service.folders.some((folder) => folder.id === restrictedId),
        ).toBe(false);
    });
    it("creates a request idempotently and notifies every audience member without notifying curators", async () => {
        const first = await requestRestrictedFolderAccess(
            "other",
            restrictedId,
        );
        const second = await requestRestrictedFolderAccess(
            "other",
            restrictedId,
        );
        expect(first.request.id).toBe(second.request.id);
        expect(
            await db.select().from(restrictedFolderAccessRequests),
        ).toHaveLength(1);
        expect(vi.mocked(sendPersonShareInvitation).mock.calls).toEqual([
            ["owner", "access-request"],
            ["member", "access-request"],
        ]);
        for (const user of ["owner", "member"])
            expect(await listMyRestrictedAccessInvitations(user)).toMatchObject(
                [
                    {
                        id: first.request.id,
                        kind: "folder-access",
                        state: "pending",
                    },
                ],
            );
        expect(await listMyRestrictedAccessInvitations("curator")).toEqual([]);
        expect(await listMyRestrictedAccessInvitations("other")).toEqual([]);
        expect(
            (await listRecordingFolderTrees("other")).find(
                (folder) => folder.id === restrictedId,
            )?.accessRequest,
        ).toBe("pending");
        await expect(
            listRestrictedFolderAccessRequests("other", restrictedId),
        ).rejects.toMatchObject({ statusCode: 403 });
        expect(
            (await listRestrictedFolderAccessRequests("curator", restrictedId))
                .requests,
        ).toMatchObject([{ id: first.request.id, userId: "other" }]);
    });
    it("cancels one's pending request and permits a new request", async () => {
        const first = await requestRestrictedFolderAccess(
            "other",
            restrictedId,
        );
        await cancelRestrictedFolderAccessRequest("other", restrictedId);
        expect(await listMyRestrictedAccessInvitations("member")).toEqual([]);
        const second = await requestRestrictedFolderAccess(
            "other",
            restrictedId,
        );
        expect(second.request.id).not.toBe(first.request.id);
        const rows = await db
            .select()
            .from(restrictedFolderAccessRequests)
            .where(eq(restrictedFolderAccessRequests.id, first.request.id));
        expect(rows[0].state).toBe("cancelled");
    });
    it.each([
        "member",
        "curator",
    ])("approves through %s and sends only the requester a decision notice", async (approver) => {
        const { request } = await requestRestrictedFolderAccess(
            "other",
            restrictedId,
        );
        vi.mocked(sendPersonShareInvitation).mockClear();
        await decideRestrictedFolderAccessRequest(
            approver,
            restrictedId,
            request.id,
            "approved",
        );
        expect(
            await resolveRecordingAccess("other", "recording"),
        ).toMatchObject({ role: "receiver" });
        expect(vi.mocked(sendPersonShareInvitation).mock.calls).toEqual([
            ["other", "access-approved"],
        ]);
        expect(await listMyRestrictedAccessInvitations("other")).toMatchObject([
            { id: request.id, notice: true, state: "approved" },
        ]);
        expect(
            (await listRecordingFolderTrees("other")).find(
                (folder) => folder.id === restrictedId,
            ),
        ).toMatchObject({
            access: true,
            restrictedRole: "member",
            accessRequest: "none",
        });
    });
    it("declines, retains the requester's private state, and permits re-requesting", async () => {
        const { request } = await requestRestrictedFolderAccess(
            "other",
            restrictedId,
        );
        await decideRestrictedFolderAccessRequest(
            "member",
            restrictedId,
            request.id,
            "declined",
        );
        expect(await resolveRecordingAccess("other", "recording")).toBeNull();
        expect(
            (await listRecordingFolderTrees("other")).find(
                (folder) => folder.id === restrictedId,
            ),
        ).toMatchObject({ access: false, accessRequest: "declined" });
        expect(await listMyRestrictedAccessInvitations("other")).toMatchObject([
            { notice: true, state: "declined" },
        ]);
        expect(sendPersonShareInvitation).toHaveBeenCalledWith(
            "other",
            "access-declined",
        );
        const next = await requestRestrictedFolderAccess("other", restrictedId);
        expect(next.request.id).not.toBe(request.id);
        await db
            .update(restrictedFolderAccessRequests)
            .set({ createdAt: new Date(0) })
            .where(eq(restrictedFolderAccessRequests.id, next.request.id));
        expect(
            (await listRecordingFolderTrees("other")).find(
                (folder) => folder.id === restrictedId,
            )?.accessRequest,
        ).toBe("pending");
        await cancelRestrictedFolderAccessRequest("other", restrictedId);
        expect(
            (await listRecordingFolderTrees("other")).find(
                (folder) => folder.id === restrictedId,
            )?.accessRequest,
        ).toBe("none");
    });
    it("decides concurrent approve and decline exactly once", async () => {
        const { request } = await requestRestrictedFolderAccess(
            "other",
            restrictedId,
        );
        vi.mocked(sendPersonShareInvitation).mockClear();
        const decisions = await Promise.allSettled([
            decideRestrictedFolderAccessRequest(
                "member",
                restrictedId,
                request.id,
                "approved",
            ),
            decideRestrictedFolderAccessRequest(
                "owner",
                restrictedId,
                request.id,
                "declined",
            ),
        ]);
        expect(
            decisions.filter((result) => result.status === "fulfilled"),
        ).toHaveLength(1);
        const failure = decisions.find(
            (result) => result.status === "rejected",
        );
        expect(failure).toMatchObject({
            reason: {
                statusCode: 409,
                code: ErrorCode.RESTRICTED_FOLDER_REQUEST_NOT_PENDING,
            },
        });
        expect(sendPersonShareInvitation).toHaveBeenCalledTimes(1);
        const [decided] = await db
            .select()
            .from(restrictedFolderAccessRequests)
            .where(eq(restrictedFolderAccessRequests.id, request.id));
        expect(!!(await resolveRecordingAccess("other", "recording"))).toBe(
            decided.state === "approved",
        );
    });
    it("rechecks a concurrently removed approver under the tree lock", async () => {
        const { request } = await requestRestrictedFolderAccess(
            "other",
            restrictedId,
        );
        const outcome = await interleave(
            () =>
                decideRestrictedFolderAccessRequest(
                    "member",
                    restrictedId,
                    request.id,
                    "approved",
                ),
            () =>
                changeRestrictedAudience("owner", restrictedId, {
                    removeUserId: "member",
                }),
        );
        expect(outcome).toMatchObject({ error: { statusCode: 403 } });
        const [pending] = await db
            .select()
            .from(restrictedFolderAccessRequests)
            .where(eq(restrictedFolderAccessRequests.id, request.id));
        expect(pending.state).toBe("pending");
        expect(await resolveRecordingAccess("other", "recording")).toBeNull();
    });
    it("allows members to add people directly, closes their request, and reserves removal for managers", async () => {
        const { request } = await requestRestrictedFolderAccess(
            "other",
            restrictedId,
        );
        await changeRestrictedAudience("member", restrictedId, {
            addUserIds: ["other"],
        });
        const [decided] = await db
            .select()
            .from(restrictedFolderAccessRequests)
            .where(eq(restrictedFolderAccessRequests.id, request.id));
        expect(decided).toMatchObject({
            state: "approved",
            decidedByUserId: "member",
        });
        expect(sendPersonShareInvitation).toHaveBeenCalledWith(
            "other",
            "access-approved",
        );
        await expect(
            changeRestrictedAudience("member", restrictedId, {
                removeUserId: "other",
            }),
        ).rejects.toMatchObject({ statusCode: 403 });
        await changeRestrictedAudience("owner", restrictedId, {
            removeUserId: "other",
        });
        expect(await resolveRecordingAccess("other", "recording")).toBeNull();
    });
    it("cancels pending requests when lifted and does not archive requests", async () => {
        await requestRestrictedFolderAccess("other", restrictedId);
        const archive = await collectRestrictedFolderArchive({
            kind: "organization",
            orgUserId: "org",
        });
        expect(archive).not.toHaveProperty("requests");
        expect(JSON.stringify(archive)).not.toContain("pending");
        await changeFolderRestriction("owner", restrictedId, "lift");
        expect(
            (await db.select().from(restrictedFolderAccessRequests))[0].state,
        ).toBe("cancelled");
        expect(await listMyRestrictedAccessInvitations("member")).toEqual([]);
    });
    it("cascades requests when the folder is deleted", async () => {
        await requestRestrictedFolderAccess("other", restrictedId);
        await deleteFolder("curator", restrictedId, { canCurate: true });
        expect(await db.select().from(restrictedFolderAccessRequests)).toEqual(
            [],
        );
    });
    it.each([
        "disabled",
        "lost use",
    ])("cancels requests on requester deactivation: %s", async (reason) => {
        await requestRestrictedFolderAccess("other", restrictedId);
        await recordAccessState({
            userId: "other",
            issuer: "https://identity.example.com",
            subject: "other-sub",
            capabilities: [],
            status: reason === "disabled" ? "disabled" : "active",
            source: "access-change",
        });
        expect(
            (await db.select().from(restrictedFolderAccessRequests))[0].state,
        ).toBe("cancelled");
        expect(await listMyRestrictedAccessInvitations("member")).toEqual([]);
    });
    it.each([
        "owner",
        "member",
        "curator",
        "org",
    ])("refuses requests by existing readers: %s", async (user) => {
        await expect(
            requestRestrictedFolderAccess(user, restrictedId),
        ).rejects.toMatchObject({ statusCode: 403 });
    });
    it("serializes requester deactivation with new requests and leaves no pending row", async () => {
        mockEnv.AUTHZ_MODE = "idp";
        await db.insert(userAccessStates).values(
            ["owner", "member", "other"].map((userId) => ({
                userId,
                issuer: "https://identity.example.com",
                subject: `${userId}-sub`,
                capabilities: ["use"],
                status: "active" as const,
                source: "login" as const,
                verifiedAt: new Date(),
            })),
        );
        const results = await Promise.allSettled([
            requestRestrictedFolderAccess("other", restrictedId),
            recordAccessState({
                userId: "other",
                issuer: "https://identity.example.com",
                subject: "other-sub",
                capabilities: [],
                status: "disabled",
                source: "access-change",
            }),
        ]);
        expect(results[1].status).toBe("fulfilled");
        expect(
            await db
                .select()
                .from(restrictedFolderAccessRequests)
                .where(eq(restrictedFolderAccessRequests.state, "pending")),
        ).toEqual([]);
        expect(await listMyRestrictedAccessInvitations("member")).toEqual([]);
    });
    it.each([
        "local",
        "hosted",
    ])("refuses access requests in %s deployment mode", async (mode) => {
        if (mode === "local") mockEnv.SELF_HOST_MODE = "local";
        else mockEnv.IS_HOSTED = true;
        expect(
            (await call(accessRequestPost, restrictedId, "other", {}, "POST"))
                .status,
        ).toBe(403);
    });
    it("refuses requests to an open folder", async () => {
        await expect(
            requestRestrictedFolderAccess("other", openId),
        ).rejects.toMatchObject({ statusCode: 403 });
    });
    it("gates and serves the request HTTP endpoints and requester decision dismissal", async () => {
        const response = await call(
            accessRequestPost,
            restrictedId,
            "other",
            {},
            "POST",
        );
        expect(response.status).toBe(200);
        const { request } = await response.json();
        expect(
            (await call(accessRequestsGet, restrictedId, "member")).status,
        ).toBe(200);
        expect(
            (await call(accessRequestsGet, restrictedId, "other")).status,
        ).toBe(403);
        expect(
            (
                await call(
                    accessRequestDelete,
                    restrictedId,
                    "other",
                    undefined,
                    "DELETE",
                )
            ).status,
        ).toBe(200);
        const { request: next } = await requestRestrictedFolderAccess(
            "other",
            restrictedId,
        );
        const patch = (user: string, state: string, service = false) =>
            accessRequestPatch(
                new Request("http://localhost/api/test", {
                    method: "PATCH",
                    headers: {
                        "x-test-user": user,
                        ...(service ? { "x-test-service": "true" } : {}),
                        "content-type": "application/json",
                    },
                    body: JSON.stringify({ state }),
                }),
                {
                    params: Promise.resolve({
                        id: restrictedId,
                        requestId: next.id,
                    }),
                },
            );
        expect((await patch("member", "approved", true)).status).toBe(403);
        expect((await patch("member", "approved")).status).toBe(200);
        expect((await patch("owner", "dismissed")).status).toBe(200);
        expect(await listMyRestrictedAccessInvitations("other")).toHaveLength(
            1,
        );
        expect((await patch("other", "dismissed")).status).toBe(200);
        expect(await listMyRestrictedAccessInvitations("other")).toEqual([]);
        const serviceCreate = await accessRequestPost(
            new Request("http://localhost/api/test", {
                method: "POST",
                headers: { "x-test-user": "other", "x-test-service": "true" },
            }),
            { params: Promise.resolve({ id: restrictedId }) },
        );
        expect(serviceCreate.status).toBe(403);
        expect(request.state).toBe("pending");
    });
    it("excludes withheld placements from every shared predicate and publishes no knowledge", async () => {
        expect(await isRecordingShared("recording", "org")).toBe(false);
        expect(await ids(sharedItemCondition("org"))).toEqual([]);
        expect(await ids(recordingSharedCondition(chatterItems.id))).toEqual(
            [],
        );
        const viewer = await taskViewer({
            id: "member",
            email: "member@example.com",
        });
        expect(await ids(taskRecordingShared(viewer, ANY_TASK_ITEM))).toEqual(
            [],
        );
        for (const table of [
            people,
            knowledgeFacts,
            knowledgeAliases,
            knowledgeEntities,
            knowledgeEntityTypes,
            knowledgeRelationTypes,
        ]) {
            const [count] = await db
                .select({ n: sql<number>`count(*)::int` })
                .from(table)
                .where(eq(table.userId, "org"));
            expect(count.n).toBe(0);
        }
        expect(
            await db
                .select()
                .from(asyncJobs)
                .where(eq(asyncJobs.userId, "org")),
        ).toEqual([]);
    });
    it("keeps populated private knowledge private until release and withdraws its evidence on restriction", async () => {
        const transcriptId = await insertTranscript(
            database.db,
            "recording",
            "owner",
        );
        const typeKey = "u_restricted_project",
            relationKey = "u_restricted_status";
        await db.insert(knowledgeEntityTypes).values({
            userId: "owner",
            key: typeKey,
            label: encryptText("Project"),
            labelHmac: domainLookupHash("entity-type-label", "Project"),
        });
        await db.insert(knowledgeRelationTypes).values({
            userId: "owner",
            key: relationKey,
            label: encryptText("Status"),
            labelHmac: domainLookupHash("relation-type-label", "Status"),
            subjectTypes: [typeKey],
            objectTypes: [],
            objectKind: "literal",
            cardinality: "one",
        });
        const [entity] = await db
            .insert(knowledgeEntities)
            .values({
                userId: "owner",
                typeKey,
                name: encryptText("Acme"),
                nameHmac: domainLookupHash("entity-name", "Acme"),
            })
            .returning();
        await db.insert(knowledgeAliases).values({
            userId: "owner",
            entityId: entity.id,
            kind: "alias",
            text: encryptText("Beta"),
            textHmac: domainLookupHash("alias", "Beta"),
        });
        const [fact] = await db
            .insert(knowledgeFacts)
            .values({
                userId: "owner",
                subjectEntityId: entity.id,
                subjectKey: `e:${entity.id}`,
                relationKey,
                objectLiteral: encryptText("Ready"),
                objectKey: `l:${domainLookupHash("fact-literal", "Ready")}`,
                origin: "recording",
            })
            .returning();
        await db.insert(knowledgeFactEvidence).values({
            userId: "owner",
            factId: fact.id,
            itemId: "recording",
            transcriptionId: transcriptId,
            transcriptRevision: 0,
            startMs: 0,
            endMs: 1000,
            quote: encryptText("Hello."),
            status: "supported",
        });
        await addRecordingToFolder({
            userId: "owner",
            recordingId: "recording",
            folderId: restrictedId,
        });
        for (const table of [
            knowledgeEntities,
            knowledgeAliases,
            knowledgeEntityTypes,
            knowledgeRelationTypes,
            knowledgeFacts,
            knowledgeFactEvidence,
        ])
            expect(
                await db.select().from(table).where(eq(table.userId, "org")),
            ).toHaveLength(0);
        await changeFolderRestriction("owner", restrictedId, "lift");
        expect(
            await db
                .select()
                .from(knowledgeFacts)
                .where(eq(knowledgeFacts.userId, "org")),
        ).toHaveLength(1);
        await changeFolderRestriction("curator", restrictedId, "restrict", [
            "member",
        ]);
        expect(
            await db
                .select()
                .from(knowledgeFactEvidence)
                .where(eq(knowledgeFactEvidence.userId, "org")),
        ).toHaveLength(0);
        expect(
            await db
                .select()
                .from(knowledgeFacts)
                .where(eq(knowledgeFacts.userId, "owner")),
        ).toHaveLength(1);
    });
    it("does not let access-management-like capability bypass current curator checks", async () => {
        authority.curator = false;
        expect(await resolveRecordingAccess("curator", "recording")).toBeNull();
        await expect(
            resolveReadableFolder("curator", restrictedId),
        ).rejects.toMatchObject({
            statusCode: 403,
            code: ErrorCode.RESTRICTED_FOLDER_NO_ACCESS,
        });
    });
    it("enforces the independent leaf guard for create, move and restrict", async () => {
        await expect(
            createFolder({
                userId: "member",
                parentId: restrictedId,
                name: "Child",
            }),
        ).rejects.toMatchObject({
            code: ErrorCode.RESTRICTED_FOLDER_LEAF,
            statusCode: 409,
        });
        const child = await createFolder({
            userId: "owner",
            parentId: openId,
            name: "Sibling",
        });
        await expect(
            moveFolder({
                userId: "org",
                folderId: child.id,
                parentId: restrictedId,
                canCurate: true,
            }),
        ).rejects.toMatchObject({ code: ErrorCode.RESTRICTED_FOLDER_LEAF });
        await expect(
            changeFolderRestriction("curator", openId, "restrict"),
        ).rejects.toMatchObject({
            code: ErrorCode.RESTRICTED_FOLDER_HAS_CHILDREN,
        });
    });
    it("refuses a look-alike restricted sibling with the ordinary name conflict before and after lift", async () => {
        for (const lift of [false, true]) {
            if (lift) {
                await makeShareable();
                await changeFolderRestriction("owner", restrictedId, "lift");
            }
            const response = await call(
                createFolderRoute,
                "",
                "other",
                { parentId: openId, name: "Beta" },
                "POST",
            );
            expect(response.status).toBe(409);
            expect((await response.json()).code).toBe(
                ErrorCode.UNIQUE_CONSTRAINT_VIOLATION,
            );
        }
    });
    it("ignores soft-deleted items when reporting restricted audience ownership", async () => {
        await insertRecording(database.db, {
            id: "member-item",
            userId: "member",
        });
        await addRecordingToFolder({
            userId: "member",
            recordingId: "member-item",
            folderId: restrictedId,
        });
        const before = await listRestrictedAudience("owner", restrictedId);
        expect(
            before.members.find((member) => member.userId === "member"),
        ).toMatchObject({ ownsItems: true });
        await db
            .update(chatterItems)
            .set({ deletedAt: new Date() })
            .where(
                and(
                    eq(chatterItems.id, "member-item"),
                    eq(chatterItems.userId, "member"),
                ),
            );
        const after = await listRestrictedAudience("owner", restrictedId);
        expect(
            after.members.find((member) => member.userId === "member"),
        ).toMatchObject({ ownsItems: false });
        expect(
            after.members.find((member) => member.userId === "owner"),
        ).toMatchObject({ ownsItems: true });
        expect(
            await db
                .select()
                .from(recordingFolderAssignments)
                .where(
                    and(
                        eq(recordingFolderAssignments.itemId, "member-item"),
                        eq(recordingFolderAssignments.userId, "member"),
                        eq(recordingFolderAssignments.folderId, restrictedId),
                    ),
                ),
        ).toHaveLength(1);
    });
    it("removes a contributor without unfiling and exposes audience data only to readers", async () => {
        expect(
            (await listRestrictedAudience("member", restrictedId)).members.find(
                (member) => member.userId === "owner",
            ),
        ).toMatchObject({ role: "manager", ownsItems: true });
        await changeRestrictedAudience("member", restrictedId, {
            addUserIds: ["other"],
        });
        await expect(
            changeRestrictedAudience("member", restrictedId, {
                removeUserId: "other",
            }),
        ).rejects.toMatchObject({ statusCode: 403 });
        await changeRestrictedAudience("owner", restrictedId, {
            addUserIds: ["other"],
        });
        expect((await resolveRecordingAccess("other", "recording"))?.role).toBe(
            "receiver",
        );
        const removed = await call(
            audienceDelete,
            restrictedId,
            "owner",
            { userId: "owner" },
            "DELETE",
        );
        expect(removed.status).toBe(200);
        expect(
            await db
                .select()
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.itemId, "recording")),
        ).toMatchObject([
            { userId: "owner", folderId: restrictedId, withheld: true },
        ]);
        expect(
            await resolveRecordingAccess("member", "recording"),
        ).toMatchObject({ role: "receiver", shared: false });
        expect(
            await resolveRecordingAccess("owner", "recording"),
        ).toMatchObject({ role: "owner", shared: false });
    });
    it.each([
        "manager",
        "curator",
    ])("%s removes an owner while preserving owner access and only their public placement", async (manager) => {
        if (manager === "manager")
            await db
                .update(restrictedFolderMembers)
                .set({ role: "manager" })
                .where(
                    and(
                        eq(restrictedFolderMembers.folderId, restrictedId),
                        eq(restrictedFolderMembers.userId, "member"),
                    ),
                );
        await insertRecording(database.db, {
            id: "colleague-item",
            userId: "member",
        });
        await addRecordingToFolder({
            userId: "member",
            recordingId: "colleague-item",
            folderId: restrictedId,
        });
        expect(
            (
                await call(
                    audienceDelete,
                    restrictedId,
                    manager === "manager" ? "member" : manager,
                    { userId: "owner" },
                    "DELETE",
                )
            ).status,
        ).toBe(200);
        const tree = await listFolderOrganization("owner");
        const node = tree.folders.find((folder) => folder.id === restrictedId);
        expect(node).toMatchObject({
            restricted: true,
            access: false,
            accessRequest: "none",
        });
        expect(node).not.toHaveProperty("restrictedRole");
        expect(node).not.toHaveProperty("counts");
        expect(
            tree.assignments.filter(
                (placement) => placement.folderId === restrictedId,
            ),
        ).toEqual([{ recordingId: "recording", folderId: restrictedId }]);
        expect(
            await ids(
                folderRecordingCondition(tree, "owner", restrictedId) ??
                    undefined,
            ),
        ).toEqual([]);
        expect(
            await ids(
                folderRecordingCondition(tree, "owner", openId) ?? undefined,
            ),
        ).toEqual([]);
        expect((await call(audienceGet, restrictedId, "owner")).status).toBe(
            403,
        );
        expect(
            await resolveRecordingAccess("owner", "colleague-item"),
        ).toBeNull();
        expect(
            await requireRecordingView("owner", "recording", "private"),
        ).toMatchObject({ role: "owner", shared: false });
        const storageSpy = vi
            .spyOn(storageProviders, "createUserStorageProvider")
            .mockResolvedValue(new RestrictedArchiveStorage());
        try {
            const renamed = await call(
                itemRename,
                "recording",
                "owner",
                { filename: "Owner revision" },
                "PATCH",
            );
            expect(renamed.status).toBe(200);
            expect(await renamed.json()).toMatchObject({
                filename: "Owner revision",
            });
        } finally {
            storageSpy.mockRestore();
        }
        const readers = await call(readersGet, "recording", "owner");
        expect(readers.status).toBe(200);
        expect(await readers.json()).toMatchObject({
            restricted: true,
            organization: false,
            curatorsCanRead: true,
            readers: [{ userId: "owner" }],
        });
        const processing = await loadPrivateItemProcessing(
            "owner",
            "recording",
        );
        expect(processing?.placements).toContainEqual(
            expect.objectContaining({
                id: restrictedId,
                restricted: true,
                access: false,
                path: "Organization › Acme › Beta",
            }),
        );
        const picker = await loadPrivateCategorizationPanel(
            "owner",
            "recording",
        );
        expect(picker?.selectedFolderIds).toContain(restrictedId);
        expect(picker?.folders).toContainEqual(
            expect.objectContaining({
                id: restrictedId,
                restricted: true,
                access: false,
            }),
        );
    }, 30000);
    it("lets a removed owner unfile through HTTP, revokes audience reads and permits another request", async () => {
        await changeRestrictedAudience("curator", restrictedId, {
            removeUserId: "owner",
        });
        expect(
            await resolveRecordingAccess("member", "recording"),
        ).toMatchObject({ role: "receiver" });
        expect(
            (
                await call(
                    itemUnfile,
                    "recording",
                    "owner",
                    { folderId: restrictedId },
                    "DELETE",
                )
            ).status,
        ).toBe(200);
        expect(await resolveRecordingAccess("member", "recording")).toBeNull();
        expect(
            await resolveRecordingAccess("owner", "recording"),
        ).toMatchObject({ role: "owner" });
        const requested = await requestRestrictedFolderAccess(
            "owner",
            restrictedId,
        );
        expect(requested.request.state).toBe("pending");
        await decideRestrictedFolderAccessRequest(
            "member",
            restrictedId,
            requested.request.id,
            "approved",
        );
        expect(
            (await listRecordingFolderTrees("owner")).find(
                (folder) => folder.id === restrictedId,
            )?.access,
        ).toBe(true);
    }, 30000);
    it.each([
        "personal",
        "open",
        "restricted",
    ])("lets a removed owner move their placement to an accessible %s folder", async (destination) => {
        await ensureRootFolders("owner");
        const [root] = await db
            .select()
            .from(recordingFolders)
            .where(
                and(
                    eq(recordingFolders.userId, "owner"),
                    eq(recordingFolders.kind, "private"),
                ),
            );
        const target =
            destination === "open"
                ? openId
                : (
                      await createFolder({
                          userId: "owner",
                          parentId:
                              destination === "personal" ? root.id : openId,
                          name: "Destination",
                          restricted: destination === "restricted",
                      })
                  ).id;
        if (destination === "open") await makeShareable();
        await changeRestrictedAudience("curator", restrictedId, {
            removeUserId: "owner",
        });
        const moved = await call(
            itemMove,
            "recording",
            "owner",
            { fromFolderId: restrictedId, toFolderId: target },
            "PATCH",
        );
        expect(moved.status).toBe(200);
        expect(
            await db
                .select()
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.itemId, "recording")),
        ).toMatchObject([
            {
                userId: "owner",
                folderId: target,
                withheld: destination === "restricted",
            },
        ]);
        expect(await resolveRecordingAccess("member", "recording")).toEqual(
            destination === "open"
                ? expect.objectContaining({ shared: true })
                : null,
        );
    }, 30000);
    it("refuses new filings and other owners' exits after removal", async () => {
        await insertRecording(database.db, {
            id: "colleague-item",
            userId: "member",
        });
        await addRecordingToFolder({
            userId: "member",
            recordingId: "colleague-item",
            folderId: restrictedId,
        });
        await insertRecording(database.db, { id: "new-item", userId: "owner" });
        await changeRestrictedAudience("curator", restrictedId, {
            removeUserId: "owner",
        });
        for (const itemId of ["recording", "new-item"])
            await expect(
                addRecordingToFolder({
                    userId: "owner",
                    recordingId: itemId,
                    folderId: restrictedId,
                }),
            ).rejects.toMatchObject({
                code: ErrorCode.RESTRICTED_FOLDER_NO_ACCESS,
            });
        await expect(
            removeRecordingFromFolder({
                userId: "owner",
                recordingId: "colleague-item",
                folderId: restrictedId,
            }),
        ).rejects.toMatchObject({
            code: ErrorCode.RESTRICTED_FOLDER_NO_ACCESS,
        });
        await expect(
            moveRecordingBetweenFolders({
                userId: "owner",
                recordingId: "colleague-item",
                fromFolderId: restrictedId,
                toFolderId: openId,
            }),
        ).rejects.toMatchObject({
            code: ErrorCode.RESTRICTED_FOLDER_NO_ACCESS,
        });
        for (const actor of ["member", "curator"])
            await expect(
                removeRecordingFromFolder({
                    userId: actor,
                    recordingId: "recording",
                    folderId: restrictedId,
                }),
            ).rejects.toBeInstanceOf(AppError);
        expect(
            await db
                .select()
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.folderId, restrictedId)),
        ).toHaveLength(2);
    }, 30000);
    it("retains an existing locked placement through categorization and allows replacing it with a personal folder", async () => {
        await ensureProfiles("owner");
        await ensureRootFolders("owner");
        const [root] = await db
            .select()
            .from(recordingFolders)
            .where(
                and(
                    eq(recordingFolders.userId, "owner"),
                    eq(recordingFolders.kind, "private"),
                ),
            );
        const target = await createFolder({
            userId: "owner",
            parentId: root.id,
            name: "Personal",
        });
        await changeRestrictedAudience("curator", restrictedId, {
            removeUserId: "owner",
        });
        expect(
            (
                await call(
                    categorizePost,
                    "recording",
                    "owner",
                    { folderIds: [restrictedId], manualOnly: true },
                    "POST",
                )
            ).status,
        ).toBe(200);
        expect((await call(audienceGet, restrictedId, "owner")).status).toBe(
            403,
        );
        expect(
            (
                await call(
                    categorizePost,
                    "recording",
                    "owner",
                    { folderIds: [target.id], manualOnly: true },
                    "POST",
                )
            ).status,
        ).toBe(200);
        expect(
            await db
                .select()
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.itemId, "recording")),
        ).toMatchObject([{ folderId: target.id, userId: "owner" }]);
        expect(await resolveRecordingAccess("member", "recording")).toBeNull();
        expect(
            (
                await call(
                    categorizePost,
                    "recording",
                    "owner",
                    { folderIds: [restrictedId], manualOnly: true },
                    "POST",
                )
            ).status,
        ).toBe(403);
    }, 30000);
    it("rechecks the owned source placement under the tree lock", async () => {
        await changeRestrictedAudience("curator", restrictedId, {
            removeUserId: "owner",
        });
        const outcome = await interleave(
            () =>
                removeRecordingFromFolder({
                    userId: "owner",
                    recordingId: "recording",
                    folderId: restrictedId,
                }),
            () =>
                db
                    .delete(recordingFolderAssignments)
                    .where(eq(recordingFolderAssignments.itemId, "recording")),
        );
        expect(outcome).toMatchObject({
            error: { code: ErrorCode.RESTRICTED_FOLDER_NO_ACCESS },
        });
    }, 30000);
    it("rechecks removal authority after a manager loses their own audience membership", async () => {
        const outcome = await interleave(
            () =>
                changeRestrictedAudience("owner", restrictedId, {
                    removeUserId: "member",
                }),
            () =>
                changeRestrictedAudience("curator", restrictedId, {
                    removeUserId: "owner",
                }),
        );
        expect(outcome).toMatchObject({ error: { statusCode: 403 } });
        expect(
            await resolveRecordingAccess("member", "recording"),
        ).toMatchObject({ role: "receiver" });
    }, 30000);
    it.each([
        false,
        true,
    ])("lifts a removed owner's placement using their share gate (ready=%s)", async (ready) => {
        await changeRestrictedAudience("curator", restrictedId, {
            removeUserId: "owner",
        });
        if (ready) await makeShareable();
        await changeFolderRestriction("curator", restrictedId, "lift");
        expect(await isRecordingShared("recording", "org")).toBe(ready);
        if (!ready) {
            expect(
                await resolveRecordingAccess("member", "recording"),
            ).toMatchObject({ role: "receiver" });
            await ensureProfiles("owner");
            expect(
                (
                    await call(
                        categorizePost,
                        "recording",
                        "owner",
                        { folderIds: [restrictedId], manualOnly: true },
                        "POST",
                    )
                ).status,
            ).toBe(200);
            expect(
                await db
                    .select()
                    .from(mailPendingShares)
                    .where(eq(mailPendingShares.itemId, "recording")),
            ).toMatchObject([
                { folderId: restrictedId, confirmedAt: expect.any(Date) },
            ]);
            await makeShareable();
            expect(
                (await executeIntendedSharesWithOutcome("owner", "recording"))
                    .shared,
            ).toBe(true);
        }
        expect(
            await resolveRecordingAccess("other", "recording"),
        ).toMatchObject({ shared: true });
    }, 30000);
    it("preserves a confirmed release when a locked categorization selection races with lift", async () => {
        await ensureProfiles("owner");
        await changeRestrictedAudience("curator", restrictedId, {
            removeUserId: "owner",
        });
        const outcome = await interleave(
            async () =>
                call(
                    categorizePost,
                    "recording",
                    "owner",
                    { folderIds: [restrictedId], manualOnly: true },
                    "POST",
                ),
            () => changeFolderRestriction("curator", restrictedId, "lift"),
        );
        if ("error" in outcome) throw outcome.error;
        expect(outcome.value.status).toBe(200);
        expect(
            await db
                .select()
                .from(mailPendingShares)
                .where(eq(mailPendingShares.itemId, "recording")),
        ).toMatchObject([{ confirmedAt: expect.any(Date) }]);
        await makeShareable();
        expect(
            (await executeIntendedSharesWithOutcome("owner", "recording"))
                .shared,
        ).toBe(true);
    }, 30000);
    it("keeps tasks and agenda sources with the audience after removing their owner", async () => {
        await insertTask(database.db, {
            recordingId: "recording",
            userId: "owner",
        });
        const meeting = await prepareMeeting("owner", {
            folderId: restrictedId,
            title: "Planning",
        });
        if (meeting.meeting.unchanged || !meeting.meeting.meetingItemId)
            throw new Error("Missing agenda");
        await changeRestrictedAudience("curator", restrictedId, {
            removeUserId: "owner",
        });
        const viewer = await taskViewer({
            id: "member",
            email: "member@example.com",
        });
        expect(await ids(taskVisible(viewer, ANY_TASK_ITEM))).toContain(
            "recording",
        );
        expect(
            await ids(agendaInputItemCondition(meeting.meeting.meetingItemId)),
        ).toContain("recording");
        expect(await getMeeting("member", meeting.id)).toMatchObject({
            permissions: { edit: false },
        });
        const ownerDetail = await getMeeting("owner", meeting.id);
        expect(ownerDetail).toMatchObject({
            folders: [
                expect.objectContaining({
                    id: restrictedId,
                    restricted: true,
                    access: false,
                }),
            ],
            permissions: { edit: true },
        });
        expect(
            (await listMeetings("owner")).find(
                (entry) => entry.id === meeting.id,
            )?.folders,
        ).toContainEqual(
            expect.objectContaining({
                id: restrictedId,
                restricted: true,
                access: false,
            }),
        );
        expect(
            (
                await call(
                    itemUnfile,
                    meeting.meeting.meetingItemId,
                    "owner",
                    { folderId: restrictedId },
                    "DELETE",
                )
            ).status,
        ).toBe(200);
    }, 30000);
    it("refuses a removed contributor's folder mail and saves their deferred capture unfiled", async () => {
        const address = await ensureFolderAddress(restrictedId, "owner");
        await changeRestrictedAudience("curator", restrictedId, {
            removeUserId: "owner",
        });
        const recipient = `${address?.localPart}@mail.example.com`;
        const at = new Date();
        const result = await precheckMail({
            recipients: [recipient],
            facts: {
                fromHeaders: 1,
                fromAddresses: ["owner@example.com"],
                receivedAt: at,
                dkim: [
                    {
                        domain: "example.com",
                        selector: "test",
                        result: "pass",
                        comment: "",
                        signedRecipients: [recipient],
                        signedAt: at,
                    },
                ],
            },
        });
        expect(result.accepted).toEqual([]);
        const filePath = join(exportRoot, "removed-owner-capture.wav");
        await writeFile(filePath, "audio");
        const saved = await saveUploadedAudioFile({
            userId: "owner",
            fileId: "capture",
            basename: "Capture",
            extension: ".wav",
            filePath,
            storage: new RestrictedArchiveStorage(),
            recordedAt: at,
            folderId: restrictedId,
            deferredFolderFallback: {
                kind: "recording session",
                id: "session",
            },
        });
        expect(
            await db
                .select()
                .from(recordingFolderAssignments)
                .where(
                    eq(recordingFolderAssignments.itemId, saved.recordingId),
                ),
        ).toEqual([]);
        const [processing] = await db
            .select()
            .from(itemProcessing)
            .where(eq(itemProcessing.itemId, saved.recordingId));
        expect(processing.profileId).toBeNull();
    }, 30000);
    it("keeps owner retention and archive content but skips restoring the removed owner's withheld reference", async () => {
        await db
            .update(recordings)
            .set({
                downloadedAt: new Date("2025-01-01"),
                storagePath: "owner/recording.mp3",
            })
            .where(eq(recordings.id, "recording"));
        const reap = () =>
            listReapCandidates(
                {
                    userId: "owner",
                    remoteOriginalDays: null,
                    audioDays: 1,
                    transcriptDays: null,
                    summaryDays: null,
                    isOrg: false,
                },
                new Date(),
                100,
                "org",
            );
        const before = await reap();
        await changeRestrictedAudience("curator", restrictedId, {
            removeUserId: "owner",
        });
        expect(await reap()).toEqual(before);
        expect(before.map((item) => item.id)).toContain("recording");
        const personal = await collectRestrictedFolderArchive({
            kind: "personal",
            userId: "owner",
        });
        expect(personal.placements).toContainEqual(
            expect.objectContaining({
                itemId: "recording",
                folderId: restrictedId,
                withheld: true,
            }),
        );
        expect(
            await restoreWithheldPlacements("owner", personal.placements, {
                recording: "recording",
            }),
        ).toEqual({ restored: 0, skipped: 1 });
        expect(
            await db
                .select()
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.itemId, "recording")),
        ).toHaveLength(1);
    }, 30000);
    it("retains contributor membership rows when suspension removes effective access", async () => {
        const before = await db
            .select()
            .from(restrictedFolderMembers)
            .where(
                and(
                    eq(restrictedFolderMembers.folderId, restrictedId),
                    eq(restrictedFolderMembers.userId, "owner"),
                ),
            );
        await db
            .update(users)
            .set({ suspendedAt: new Date() })
            .where(eq(users.id, "owner"));
        expect(
            await db
                .select()
                .from(restrictedFolderMembers)
                .where(
                    and(
                        eq(restrictedFolderMembers.folderId, restrictedId),
                        eq(restrictedFolderMembers.userId, "owner"),
                    ),
                ),
        ).toEqual(before);
        await expect(
            resolveReadableFolder("owner", restrictedId),
        ).rejects.toMatchObject({
            code: ErrorCode.RESTRICTED_FOLDER_NO_ACCESS,
        });
        await db
            .update(users)
            .set({ suspendedAt: null })
            .where(eq(users.id, "owner"));
        expect(await resolveReadableFolder("owner", restrictedId)).toBeTruthy();
    }, 30000);
    it("restricts an open folder as a human curator, withdraws and enrolls item owners", async () => {
        await makeShareable();
        await addRecordingToFolder({
            userId: "owner",
            recordingId: "recording",
            folderId: openId,
        });
        await deleteFolder("org", restrictedId, { canCurate: true });
        const preview = await previewFolderRestriction("curator", openId);
        expect(preview.withdrawnItems.map((item) => item.id)).toContain(
            "recording",
        );
        await db.insert(asyncJobs).values({
            userId: "org",
            kind: "summary",
            subjectId: "org:recording",
        });
        await changeFolderRestriction("curator", openId, "restrict", [
            "member",
        ]);
        expect(await isRecordingShared("recording", "org")).toBe(false);
        expect(
            (await listRestrictedAudience("member", openId)).members.some(
                (member) => member.userId === "owner" && member.ownsItems,
            ),
        ).toBe(true);
        expect(await resolveRecordingAccess("other", "recording")).toBeNull();
    });
    it("lifts gate-passing items, publishes and starts release grace", async () => {
        await makeShareable();
        await changeFolderRestriction("owner", restrictedId, "lift");
        expect(await isRecordingShared("recording", "org")).toBe(true);
        const [placement] = await db
            .select()
            .from(recordingFolderAssignments)
            .where(eq(recordingFolderAssignments.itemId, "recording"));
        expect(placement.withheld).toBe(false);
        expect(placement.releasedAt).toBeInstanceOf(Date);
        expect(
            await db
                .select()
                .from(restrictedFolderMembers)
                .where(eq(restrictedFolderMembers.folderId, restrictedId)),
        ).toEqual([]);
    });
    it("keeps gate failures withheld with the former audience until a later gate pass", async () => {
        await changeFolderRestriction("owner", restrictedId, "lift");
        expect(await isRecordingShared("recording", "org")).toBe(false);
        expect(
            (await resolveRecordingAccess("member", "recording"))?.role,
        ).toBe("receiver");
        expect(await resolveRecordingAccess("other", "recording")).toBeNull();
        const [intent] = await db
            .select()
            .from(mailPendingShares)
            .where(eq(mailPendingShares.itemId, "recording"));
        expect(intent.confirmedAt).toBeInstanceOf(Date);
        expect(
            await queryItemScopeFolderIds({
                itemId: "recording",
                view: "org",
                ownerUserId: "owner",
                orgUserId: "org",
            }),
        ).toEqual([]);
        await makeShareable();
        expect(
            (await executeIntendedSharesWithOutcome("owner", "recording"))
                .shared,
        ).toBe(true);
        expect(await isRecordingShared("recording", "org")).toBe(true);
    });
    it("re-restricts with the chosen audience while retaining contributors", async () => {
        await changeFolderRestriction("owner", restrictedId, "lift");
        expect(
            (await resolveRecordingAccess("member", "recording"))?.role,
        ).toBe("receiver");
        await changeFolderRestriction("curator", restrictedId, "restrict", []);
        expect(await resolveRecordingAccess("member", "recording")).toBeNull();
        expect(
            (
                await listRestrictedAudience("curator", restrictedId)
            ).members.some((member) => member.userId === "owner"),
        ).toBe(true);
    });
    it.each([
        29, 30, 31,
    ])("applies Organization retention at release day %s", async (day) => {
        await makeShareable();
        await changeFolderRestriction("owner", restrictedId, "lift");
        const release = new Date("2026-01-01T00:00:00Z");
        await db
            .update(recordingFolderAssignments)
            .set({ releasedAt: release })
            .where(eq(recordingFolderAssignments.itemId, "recording"));
        expect(
            await ids(
                organizationRetentionCondition(
                    "org",
                    chatterItems.id,
                    release.getTime() + day * 86400000,
                ),
            ),
        ).toEqual(day >= 30 ? ["recording"] : []);
    });
    it("preserves retention grace across extra open placements and deleted-folder root fallback", async () => {
        await makeShareable();
        await changeFolderRestriction("owner", restrictedId, "lift");
        await addRecordingToFolder({
            userId: "owner",
            recordingId: "recording",
            folderId: openId,
        });
        expect(
            await ids(
                organizationRetentionCondition(
                    "org",
                    chatterItems.id,
                    Date.now() + 29 * 86400000,
                ),
            ),
        ).toEqual([]);
        await deleteFolder("org", openId, { canCurate: true });
        expect(
            await ids(
                organizationRetentionCondition(
                    "org",
                    chatterItems.id,
                    Date.now() + 29 * 86400000,
                ),
            ),
        ).toEqual([]);
        expect(
            await ids(
                organizationRetentionCondition(
                    "org",
                    chatterItems.id,
                    Date.now() + 31 * 86400000,
                ),
            ),
        ).toEqual(["recording"]);
    });
    it("preserves the established authority of an older open destination placement", async () => {
        await makeShareable();
        await addRecordingToFolder({
            userId: "owner",
            recordingId: "recording",
            folderId: openId,
        });
        await db
            .update(recordingFolderAssignments)
            .set({ releasedAt: null })
            .where(eq(recordingFolderAssignments.folderId, openId));
        await changeFolderRestriction("owner", restrictedId, "lift");
        await moveRecordingBetweenFolders({
            userId: "owner",
            recordingId: "recording",
            fromFolderId: restrictedId,
            toFolderId: openId,
        });
        const [placement] = await db
            .select()
            .from(recordingFolderAssignments)
            .where(eq(recordingFolderAssignments.itemId, "recording"));
        expect(placement).toMatchObject({ folderId: openId, releasedAt: null });
        expect(await ids(organizationRetentionCondition("org"))).toEqual([
            "recording",
        ]);
    });
    it("hides withheld placements when another open placement makes the item public", async () => {
        await makeShareable();
        await addRecordingToFolder({
            userId: "owner",
            recordingId: "recording",
            folderId: openId,
        });
        const otherReaders = await restrictedItemReaders("other", "recording");
        expect(otherReaders).toMatchObject({
            restricted: false,
            organization: true,
        });
        expect(otherReaders.readers.map((reader) => reader.userId)).toEqual([
            "owner",
        ]);
        const audienceReaders = await restrictedItemReaders(
            "member",
            "recording",
        );
        expect(audienceReaders.restricted).toBe(true);
        expect(audienceReaders.readers.map((reader) => reader.userId)).toEqual(
            expect.arrayContaining(["owner", "member"]),
        );
        const other = await loadPrivateItemProcessing(
            "owner",
            "recording",
            "other",
            "en",
            "org",
        );
        expect(other?.placements.map((folder) => folder.id)).not.toContain(
            restrictedId,
        );
        const member = await loadPrivateItemProcessing(
            "owner",
            "recording",
            "member",
            "en",
            "org",
        );
        expect(member?.placements.map((folder) => folder.id)).toContain(
            restrictedId,
        );
        expect(
            (await listFolderOrganization("other")).assignments,
        ).not.toContainEqual({
            recordingId: "recording",
            folderId: restrictedId,
        });
    });
    it("allows owner moves through restriction boundaries and withdraws the last open placement", async () => {
        await expect(
            moveRecordingBetweenFolders({
                userId: "member",
                recordingId: "recording",
                fromFolderId: restrictedId,
                toFolderId: openId,
            }),
        ).rejects.toBeInstanceOf(AppError);
        await expect(
            moveRecordingBetweenFolders({
                userId: "owner",
                recordingId: "recording",
                fromFolderId: restrictedId,
                toFolderId: openId,
            }),
        ).rejects.toMatchObject({ code: ErrorCode.SHARE_REQUIREMENTS_UNMET });
        await makeShareable();
        await moveRecordingBetweenFolders({
            userId: "owner",
            recordingId: "recording",
            fromFolderId: restrictedId,
            toFolderId: openId,
        });
        expect(await isRecordingShared("recording", "org")).toBe(true);
        await moveRecordingBetweenFolders({
            userId: "owner",
            recordingId: "recording",
            fromFolderId: openId,
            toFolderId: restrictedId,
        });
        expect(await isRecordingShared("recording", "org")).toBe(false);
        await removeRecordingFromFolder({
            userId: "owner",
            recordingId: "recording",
            folderId: restrictedId,
        });
        expect(
            await db
                .select()
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.itemId, "recording")),
        ).toEqual([]);
    });
    it.each([
        "leaf",
        "ancestor",
    ])("deleting the %s never refiles withheld items to the Organization root", async (kind) => {
        await deleteFolder("org", kind === "leaf" ? restrictedId : openId, {
            canCurate: true,
        });
        expect(
            await db
                .select()
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.itemId, "recording")),
        ).toEqual([]);
        expect((await resolveRecordingAccess("owner", "recording"))?.role).toBe(
            "owner",
        );
        expect(await resolveRecordingAccess("member", "recording")).toBeNull();
    });
    it("uses restricted audience for agenda access and prevents wider source reuse", async () => {
        const audience = await db.transaction((tx) =>
            meetingItemAudienceInTx(tx, "recording", "owner", "org"),
        );
        expect(audience.organization).toBe(false);
        expect(audience.userIds).toContain("member");
        await db.insert(chatterItems).values({
            id: "agenda",
            userId: "owner",
            kind: "meeting",
            title: encryptText("Agenda"),
            occurredAt: new Date(),
        });
        await db.insert(recordingFolderAssignments).values({
            userId: "owner",
            itemId: "agenda",
            folderId: restrictedId,
            withheld: true,
        });
        expect(await ids(agendaInputItemCondition("agenda"))).toContain(
            "recording",
        );
        await db
            .insert(recordingFolderAssignments)
            .values({ userId: "owner", itemId: "agenda", folderId: openId });
        expect(await ids(agendaInputItemCondition("agenda"))).not.toContain(
            "recording",
        );
    });
    it("gives task receivers read and assignee-close rights, with no curator edits", async () => {
        const [person] = await db
            .insert(people)
            .values({
                userId: "owner",
                displayName: encryptText("Member"),
                primaryEmail: encryptText("member@example.com"),
                primaryEmailHash: lookupHash("member@example.com"),
            })
            .returning();
        await insertTask(database.db, {
            recordingId: "recording",
            userId: "owner",
            assigneePersonId: person.id,
        });
        for (const user of ["owner", "member", "other", "curator", "org"]) {
            const viewer = await taskViewer({
                id: user,
                email: `${user}@example.com`,
            });
            expect(
                (await ids(taskVisible(viewer, ANY_TASK_ITEM))).includes(
                    "recording",
                ),
            ).toBe(user !== "other");
            expect(
                (await ids(taskEditable(viewer, ANY_TASK_ITEM))).includes(
                    "recording",
                ),
            ).toBe(user === "owner");
            expect(
                (await ids(taskClosable(viewer, ANY_TASK_ITEM))).includes(
                    "recording",
                ),
            ).toBe(["owner", "member"].includes(user));
        }
        const member = await taskViewer({
            id: "member",
            email: "member@example.com",
        });
        expect(
            (
                await listCallerTasks(member, {
                    status: "all",
                    assigneePersonId: null,
                    recordingId: null,
                    dueBefore: null,
                    recordingCondition: null,
                    after: null,
                    limit: 50,
                })
            ).length,
        ).toBe(1);
        expect(
            await countNewTasks(
                await taskViewer({ id: "other", email: "other@example.com" }),
            ),
        ).toBe(0);
        await db.insert(userSettings).values({
            userId: "member",
            tasksSeenAt: new Date(Date.now() - 86400000),
        });
        expect(await countNewTasks(member)).toBe(1);
        await db
            .update(people)
            .set({
                primaryEmail: encryptText("other@example.com"),
                primaryEmailHash: lookupHash("other@example.com"),
            })
            .where(eq(people.id, person.id));
        const outsideAssignee = await taskViewer({
            id: "other",
            email: "other@example.com",
        });
        expect(await ids(taskVisible(outsideAssignee, ANY_TASK_ITEM))).toEqual(
            [],
        );
        expect(await ids(taskClosable(outsideAssignee, ANY_TASK_ITEM))).toEqual(
            [],
        );
    });
    it("excludes withheld items from exports and archives and round-trips owner references", async () => {
        expect((await listExportFolderOrganization("org")).assignments).toEqual(
            [],
        );
        await expect(
            assertExportableFolder("org", restrictedId),
        ).rejects.toMatchObject({ code: ErrorCode.RESTRICTED_FOLDER_EXPORT });
        expect(
            await ids(
                archivedItemCondition({
                    kind: "organization",
                    orgUserId: "org",
                }),
            ),
        ).toEqual([]);
        expect(
            await ids(
                archivedItemCondition({ kind: "personal", userId: "owner" }),
            ),
        ).toEqual(["recording"]);
        const personal = await collectRestrictedFolderArchive({
            kind: "personal",
            userId: "owner",
        });
        expect(personal.placements[0]).toMatchObject({
            itemId: "recording",
            folderId: restrictedId,
            path: ["Organization", "Acme", "Beta"],
        });
        const organization = await collectRestrictedFolderArchive({
            kind: "organization",
            orgUserId: "org",
        });
        expect(organization.placements).toEqual([]);
        expect(
            organization.folders[0].audience.some(
                (member) => member.email === "member@example.com",
            ),
        ).toBe(true);
        await removeRecordingFromFolder({
            userId: "owner",
            recordingId: "recording",
            folderId: restrictedId,
        });
        expect(
            await restoreWithheldPlacements("owner", personal.placements, {
                recording: "recording",
            }),
        ).toEqual({ restored: 1, skipped: 0 });
        await removeRecordingFromFolder({
            userId: "owner",
            recordingId: "recording",
            folderId: restrictedId,
        });
        await changeRestrictedAudience("owner", restrictedId, {
            removeUserId: "owner",
        });
        expect(
            await restoreWithheldPlacements("owner", personal.placements, {
                recording: "recording",
            }),
        ).toEqual({ restored: 0, skipped: 1 });
    });
    it("omits withheld contributions from a non-member's ancestor knowledge aggregation", async () => {
        const input = {
            folderId: openId,
            ownerId: "org",
            viewerId: "other",
            shared: true,
            allOwnedItems: false,
            scopes: ["org"],
        };
        expect((await folderKnowledgeContext(input)).itemCount).toBe(0);
        expect(
            (await folderKnowledgeContext({ ...input, viewerId: "member" }))
                .itemCount,
        ).toBe(1);
    });
    it("permits inbound mail only from the restricted audience", async () => {
        const address = await ensureFolderAddress(restrictedId, "owner");
        const recipient = `${address?.localPart}@mail.example.com`;
        const at = new Date();
        for (const user of ["member", "other", "curator"]) {
            const result = await precheckMail({
                recipients: [recipient],
                facts: {
                    fromHeaders: 1,
                    fromAddresses: [`${user}@example.com`],
                    receivedAt: at,
                    dkim: [
                        {
                            domain: "example.com",
                            selector: "test",
                            result: "pass",
                            comment: "",
                            signedRecipients: [recipient],
                            signedAt: at,
                        },
                    ],
                },
            });
            expect(result.accepted).toEqual(
                user === "member" ? [recipient] : [],
            );
        }
    });
    it("keeps mail receiver reads and folder ids inside the audience", async () => {
        await db.insert(chatterItems).values({
            id: "mail",
            userId: "owner",
            kind: "mail",
            title: encryptText("Mail"),
            occurredAt: new Date(),
        });
        await db.insert(mailMessages).values({
            id: "mail",
            userId: "owner",
            rawHash: "a".repeat(64),
            receivedAt: new Date(),
            sizeBytes: 20,
            auth: encryptJsonField({}),
            senderVerified: true,
        });
        await addRecordingToFolder({
            userId: "owner",
            recordingId: "mail",
            folderId: restrictedId,
        });
        expect((await resolveMailAccess("member", "mail"))?.role).toBe(
            "receiver",
        );
        expect(await resolveMailAccess("other", "mail")).toBeNull();
        expect(
            (await loadReceivedMailRows("curator")).some(
                (mail) => mail.id === "mail",
            ),
        ).toBe(true);
        await addRecordingToFolder({
            userId: "owner",
            recordingId: "mail",
            folderId: openId,
        });
        expect(
            (await loadMailDetail("other", "mail"))?.folderIds,
        ).not.toContain(restrictedId);
        await changeRestrictedAudience("curator", restrictedId, {
            removeUserId: "owner",
        });
        expect((await loadMailDetail("owner", "mail"))?.folderIds).toContain(
            restrictedId,
        );
        expect(
            (await loadMailDetail("other", "mail"))?.folderIds,
        ).not.toContain(restrictedId);
    });
    it("publishes confirmed people only when lifted and keeps prior Almanac additions after restriction", async () => {
        await makeShareable();
        const [transcript] = await db
            .select()
            .from(transcriptions)
            .where(eq(transcriptions.recordingId, "recording"));
        await db
            .update(transcriptions)
            .set({
                text: encryptText("speaker_0: Hello."),
                turns: encryptJsonField([
                    {
                        speaker: "speaker_0",
                        startMs: 0,
                        endMs: 1000,
                        text: "Hello.",
                    },
                ]),
            })
            .where(eq(transcriptions.id, transcript.id));
        const [person] = await db
            .insert(people)
            .values({
                userId: "owner",
                displayName: encryptText("Jitka Dvořáková"),
            })
            .returning();
        await db.insert(transcriptSpeakers).values({
            userId: "owner",
            transcriptionId: transcript.id,
            label: "speaker_0",
            personId: person.id,
            status: "confirmed",
            source: "user",
            confirmedByUserId: "owner",
        });
        expect(
            await db.select().from(people).where(eq(people.userId, "org")),
        ).toHaveLength(0);
        await changeFolderRestriction("owner", restrictedId, "lift");
        expect(
            await db.select().from(people).where(eq(people.userId, "org")),
        ).toHaveLength(1);
        const preview = await previewFolderRestriction("curator", restrictedId);
        expect(preview.retainedAlmanacAdditions).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: "person" }),
            ]),
        );
        await changeFolderRestriction("curator", restrictedId, "restrict", [
            "member",
        ]);
        expect(
            await db.select().from(people).where(eq(people.userId, "org")),
        ).toHaveLength(1);
        expect(await isRecordingShared("recording", "org")).toBe(false);
        const orgPeople = await db
            .select({ id: people.id })
            .from(people)
            .where(eq(people.userId, "org"));
        expect(
            await duplicateEvidence(
                "org",
                "person",
                orgPeople.map((person) => person.id),
            ),
        ).toHaveLength(0);
        expect(
            await almanacScopeUsage({
                ownerUserId: "owner",
                orgUserId: "org",
                view: "org",
                scopeFolderIds: [restrictedId],
                recentSince: new Date(0),
            }),
        ).toHaveLength(0);
        expect(
            await queryItemScopeFolderIds({
                ownerUserId: "owner",
                orgUserId: "org",
                itemId: "recording",
                view: "org",
            }),
        ).toEqual([]);
    });
    it("withdraws each item atomically before completing a durable restriction larger than one request", async () => {
        const folder = await createFolder({
            userId: "owner",
            parentId: openId,
            name: "Batch",
        });
        for (let index = 0; index < 26; index++) {
            const id = `batch-${index}`;
            await insertRecording(database.db, { id, userId: "owner" });
            await db
                .insert(recordingFolderAssignments)
                .values({ userId: "owner", itemId: id, folderId: folder.id });
        }
        const result = await changeFolderRestriction(
            "curator",
            folder.id,
            "restrict",
            ["member"],
        );
        expect(result).toMatchObject({
            restricted: false,
            restricting: true,
            processed: 25,
            queued: 1,
        });
        const jobs = await db
            .select({ payload: asyncJobs.payload })
            .from(asyncJobs)
            .where(eq(asyncJobs.kind, "folder.restriction"));
        for (const job of jobs)
            await processRestrictedFolderItem(
                job.payload as unknown as RestrictedFolderItemWork,
            );
        const [state] = await db
            .select()
            .from(recordingFolders)
            .where(eq(recordingFolders.id, folder.id));
        expect(state.restrictedAt).toBeInstanceOf(Date);
        expect(state.restrictingAt).toBeNull();
        expect(
            (await ids(sharedItemCondition("org"))).filter((id) =>
                id.startsWith("batch-"),
            ),
        ).toEqual([]);
        await processRestrictedFolderItem(
            jobs[0].payload as unknown as RestrictedFolderItemWork,
        );
        expect(await resolveRecordingAccess("other", "batch-0")).toBeNull();
    }, 30000);
    it("builds ZIP metadata and restores both sides of the archive boundary", async () => {
        async function archive(scope: ArchiveScope) {
            const storage = new RestrictedArchiveStorage();
            await buildAndUploadExportArchive({
                scope,
                sourceStorage: storage,
                destinationStorage: storage,
                storageKey: "archive.zip",
            });
            const zip = await unzipper.Open.buffer(storage.uploaded);
            const values = new Map<string, string>();
            for (const file of zip.files)
                values.set(file.path, (await file.buffer()).toString("utf8"));
            return {
                text: [...values.values()].join("\n"),
                restrictions: JSON.parse(
                    values.get("organization/restrictions.json") ?? "{}",
                ),
            };
        }
        const personal = await archive({ kind: "personal", userId: "owner" });
        const organization = await archive({
            kind: "organization",
            orgUserId: "org",
        });
        expect(personal.restrictions.placements).toHaveLength(1);
        expect(organization.text).not.toContain("Restricted evidence");
        expect(organization.restrictions.folders).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: restrictedId }),
            ]),
        );
        const restored = await createFolder({
            userId: "curator",
            parentId: openId,
            name: "Restored",
        });
        expect(
            await restoreRestrictedFolderMetadata(
                "curator",
                organization.restrictions.folders,
                { [restrictedId]: restored.id },
            ),
        ).toEqual({ restored: 1 });
        expect(
            (await listRestrictedAudience("member", restored.id)).members.some(
                (member) =>
                    member.userId === "owner" && member.role === "manager",
            ),
        ).toBe(true);
        const entry = {
            ...personal.restrictions.placements[0],
            folderId: restored.id,
        };
        expect(
            await restoreWithheldPlacements("owner", [entry], {
                recording: "recording",
            }),
        ).toEqual({ restored: 1, skipped: 0 });
        expect(
            (
                await call(
                    restoreRestrictionsRoute,
                    "unused",
                    "other",
                    { scope: "organization", folders: [], folderIds: {} },
                    "POST",
                )
            ).status,
        ).toBe(403);
        expect(
            (
                await call(
                    restoreRestrictionsRoute,
                    "unused",
                    "owner",
                    {
                        scope: "personal",
                        placements: [entry],
                        itemIds: { recording: "recording" },
                    },
                    "POST",
                )
            ).status,
        ).toBe(200);
    });
    it("counts withheld recordings only in their owner's statistics", async () => {
        const owner = await loadStatistics("owner", "mine", "UTC");
        const other = await loadStatistics("other", "mine", "UTC");
        const org = await loadStatistics("org", "organization", "UTC");
        const total = (data: typeof owner) =>
            data.daily[metricIndex.recordings].reduce((sum, n) => sum + n, 0) +
            data.baseline[metricIndex.recordings];
        expect(total(owner)).toBe(1);
        expect(total(other)).toBe(0);
        expect(total(org)).toBe(0);
    });
    it("uses owner retention candidates until release grace expires for audio and mail", async () => {
        await makeShareable();
        await db
            .update(recordings)
            .set({
                downloadedAt: new Date("2025-01-01"),
                storagePath: "owner/recording.mp3",
            })
            .where(eq(recordings.id, "recording"));
        await db
            .update(chatterItems)
            .set({ occurredAt: new Date("2025-01-01") })
            .where(eq(chatterItems.id, "recording"));
        await db.insert(chatterItems).values({
            id: "retention-mail",
            userId: "owner",
            kind: "mail",
            title: encryptText("Retention"),
            occurredAt: new Date("2025-01-01"),
        });
        await db.insert(mailMessages).values({
            id: "retention-mail",
            userId: "owner",
            rawHash: "b".repeat(64),
            rawStoragePath: "owner/mail.eml",
            receivedAt: new Date("2025-01-01"),
            sizeBytes: 20,
            auth: encryptJsonField({}),
            senderVerified: true,
        });
        await addRecordingToFolder({
            userId: "owner",
            recordingId: "retention-mail",
            folderId: restrictedId,
        });
        await changeFolderRestriction("owner", restrictedId, "lift");
        const releasedAt = new Date("2026-01-01");
        await db.update(recordingFolderAssignments).set({ releasedAt });
        for (const recordingId of ["recording", "retention-mail"])
            await moveRecordingBetweenFolders({
                userId: "owner",
                recordingId,
                fromFolderId: restrictedId,
                toFolderId: openId,
            });
        for (const day of [29, 30, 31]) {
            const at = new Date(releasedAt.getTime() + day * 86400000);
            for (const isOrg of [false, true]) {
                const userId = isOrg ? "org" : "owner";
                const audio = await listReapCandidates(
                    {
                        userId,
                        remoteOriginalDays: null,
                        audioDays: 1,
                        transcriptDays: null,
                        summaryDays: null,
                        isOrg,
                    },
                    at,
                    100,
                    "org",
                );
                const mail = await listMailReapCandidates(
                    {
                        userId,
                        rawDays: 1,
                        contentDays: null,
                        summaryDays: null,
                        isOrg,
                    },
                    at,
                    100,
                    "org",
                );
                expect(audio.map((item) => item.id).includes("recording")).toBe(
                    isOrg === day >= 30,
                );
                expect(
                    mail.map((item) => item.id).includes("retention-mail"),
                ).toBe(isOrg === day >= 30);
            }
        }
    });
    it("loads restricted agendas for receivers while denying content edits and outsider discovery", async () => {
        const result = await prepareMeeting("owner", {
            folderId: restrictedId,
            title: "Restricted agenda",
        });
        expect(await getMeeting("member", result.id)).toMatchObject({
            permissions: { edit: false, manage: false },
        });
        await expect(
            requireMeetingAccess("curator", result.id, "edit"),
        ).rejects.toMatchObject({ statusCode: 403 });
        await expect(getMeeting("other", result.id)).rejects.toMatchObject({
            statusCode: 404,
        });
        const meeting = await getMeeting("owner", result.id);
        if (meeting.unchanged || !meeting.meetingItemId)
            throw new Error("MISSING_MEETING");
        await addRecordingToFolder({
            userId: "owner",
            recordingId: meeting.meetingItemId,
            folderId: openId,
        });
        const serviceDetail = await getMeeting(
            "org",
            result.id,
            undefined,
            false,
            true,
        );
        expect(
            serviceDetail.unchanged
                ? []
                : serviceDetail.folders.map((folder) => folder.id),
        ).not.toContain(restrictedId);
        const serviceList = await listMeetings("org", { isCurator: false });
        expect(
            serviceList.flatMap((meeting) =>
                meeting.folders.map((folder) => folder.id),
            ),
        ).not.toContain(restrictedId);
    });
    it("claims restriction work fairly with one running item per owner", async () => {
        for (const userId of ["owner", "member"])
            for (let index = 0; index < 3; index++)
                await db.insert(asyncJobs).values({
                    userId,
                    kind: "folder.restriction",
                    subjectId: `fair-${userId}-${index}`,
                });
        const claimed = await claimDueJobs("folder.restriction", 4);
        expect(new Set(claimed.map((job) => job.userId))).toEqual(
            new Set(["owner", "member"]),
        );
        expect(claimed).toHaveLength(2);
        expect(await claimDueJobs("folder.restriction", 4)).toEqual([]);
    });
    it("blocks attendance discovery through confirmed speaker email until an open placement shares the item", async () => {
        const transcriptId = await insertTranscript(
            database.db,
            "recording",
            "owner",
            { text: "speaker_0: Hello." },
        );
        await db
            .update(transcriptions)
            .set({
                turns: encryptJsonField([
                    {
                        speaker: "speaker_0",
                        startMs: 0,
                        endMs: 1000,
                        text: "Hello.",
                    },
                ]),
            })
            .where(eq(transcriptions.id, transcriptId));
        const [person] = await db
            .insert(people)
            .values({
                userId: "owner",
                displayName: encryptText("Jitka Dvořáková"),
                primaryEmail: encryptText("other@example.com"),
                primaryEmailHash: lookupHash("other@example.com"),
            })
            .returning();
        await db.insert(transcriptSpeakers).values({
            userId: "owner",
            transcriptionId: transcriptId,
            label: "speaker_0",
            personId: person.id,
            status: "confirmed",
            source: "user",
        });
        const condition = attendedRecordingCondition(
            "other",
            lookupHash("other@example.com"),
            new Date(0),
            {
                from: null,
                to: null,
                folderId: null,
                personId: null,
                entityId: null,
            },
        );
        expect(await ids(condition)).toEqual([]);
        await addRecordingToFolder({
            userId: "owner",
            recordingId: "recording",
            folderId: openId,
        });
        expect(await ids(condition)).toEqual(["recording"]);
    });
    it("plans an ancestor export without withheld content and refuses a queued withheld materialization", async () => {
        await db.insert(folderExportConfigurations).values({
            id: "export",
            userId: "org",
            folderId: openId,
            provider: "filesystem",
        });
        await db.insert(filesystemExportSettings).values({
            exportConfigurationId: "export",
            userId: "org",
            targetPath: "acme",
        });
        await db.insert(folderExportMaterializations).values({
            id: "withheld-export",
            userId: "org",
            exportConfigurationId: "export",
            itemId: "recording",
            placementFolderId: restrictedId,
            artifactType: "audio",
            artifactId: "recording",
            artifactVersion: "a".repeat(64),
            logicalPath: "acme/withheld.mp3",
            expectedSize: 20,
        });
        expect(await materializeFolderExport("org", "withheld-export")).toBe(
            false,
        );
        expect(await planFolderExport("org", "export")).toBe(0);
        expect(
            await db
                .select()
                .from(folderExportMaterializations)
                .where(eq(folderExportMaterializations.expected, true)),
        ).toHaveLength(0);
    });
    it.each([
        ["before write", false],
        ["during write", false],
        ["before write", true],
        ["during write", true],
    ] as const)("handles revocation %s during export materialization (direct=%s)", async (boundary, direct) => {
        await makeShareable();
        await changeFolderRestriction("owner", restrictedId, "lift");
        await db
            .update(recordings)
            .set({
                storagePath: "owner/audio.mp3",
                filesize: 5,
                downloadedAt: new Date(),
            })
            .where(eq(recordings.id, "recording"));
        await db.insert(folderExportConfigurations).values({
            id: "inflight",
            userId: "org",
            folderId: direct ? restrictedId : openId,
            provider: "filesystem",
            exportAudio: true,
            exportTranscript: false,
            exportSummary: false,
        });
        await db.insert(filesystemExportSettings).values({
            exportConfigurationId: "inflight",
            userId: "org",
            targetPath: "inflight",
        });
        await planFolderExport("org", "inflight");
        const [state] = await db
            .select()
            .from(folderExportMaterializations)
            .where(
                eq(
                    folderExportMaterializations.exportConfigurationId,
                    "inflight",
                ),
            );
        expect(state).toBeDefined();
        let entered = () => {};
        let release = () => {};
        const paused = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const resume = new Promise<void>((resolve) => {
            release = resolve;
        });
        const storage = new RestrictedArchiveStorage();
        vi.spyOn(storage, "downloadStream").mockImplementation(async () => {
            if (boundary === "before write") {
                entered();
                await resume;
            }
            return Readable.from(Buffer.from("audio"));
        });
        const storageSpy = vi
            .spyOn(storageProviders, "createUserStorageProvider")
            .mockResolvedValue(storage);
        const createProvider = exportProviders.createExportProvider;
        const providerSpy = vi
            .spyOn(exportProviders, "createExportProvider")
            .mockImplementation(async (target) => {
                const provider = await createProvider(target);
                if (boundary === "during write") {
                    const materialize = provider.materialize.bind(provider);
                    provider.materialize = async (...args) => {
                        entered();
                        await resume;
                        return materialize(...args);
                    };
                }
                return provider;
            });
        const running = materializeFolderExport("org", state.id);
        try {
            await paused;
            await changeFolderRestriction("curator", restrictedId, "restrict", [
                "member",
            ]);
            release();
            expect(await running).toBe(boundary === "during write");
        } finally {
            release();
            await running;
            providerSpy.mockRestore();
            storageSpy.mockRestore();
        }
        const file = join(exportRoot, state.logicalPath);
        if (boundary === "during write")
            await expect(access(file)).resolves.toBeUndefined();
        else await expect(access(file)).rejects.toBeDefined();
        await reconcileFolderExport("org", restrictedId);
        await expect(access(file)).rejects.toBeDefined();
        expect(
            await db
                .select()
                .from(folderExportMaterializations)
                .where(
                    eq(
                        folderExportMaterializations.exportConfigurationId,
                        "inflight",
                    ),
                ),
        ).toEqual([]);
    });
    it("classifies and gates every new route method", async () => {
        expect((await call(audienceGet, restrictedId, "member")).status).toBe(
            200,
        );
        expect((await call(audienceGet, restrictedId, "other")).status).toBe(
            403,
        );
        expect(
            (
                await call(
                    audiencePost,
                    restrictedId,
                    "member",
                    { userIds: ["other"] },
                    "POST",
                )
            ).status,
        ).toBe(200);
        expect(
            (
                await call(
                    audiencePost,
                    restrictedId,
                    "owner",
                    { userIds: ["other"] },
                    "POST",
                )
            ).status,
        ).toBe(200);
        expect(
            (
                await call(
                    audienceDelete,
                    restrictedId,
                    "owner",
                    { userId: "owner" },
                    "DELETE",
                )
            ).status,
        ).toBe(200);
        expect(
            (
                await call(
                    audienceDelete,
                    restrictedId,
                    "curator",
                    { userId: "other" },
                    "DELETE",
                )
            ).status,
        ).toBe(200);
        expect((await call(readersGet, "recording", "member")).status).toBe(
            200,
        );
        expect((await call(readersGet, "recording", "other")).status).toBe(404);
        expect((await call(liftGet, restrictedId, "member")).status).toBe(403);
        expect((await call(liftGet, restrictedId, "curator")).status).toBe(200);
        expect(
            (await call(liftPost, restrictedId, "curator", {}, "POST")).status,
        ).toBe(200);
        expect((await call(restrictGet, restrictedId, "other")).status).toBe(
            403,
        );
        expect((await call(restrictGet, restrictedId, "curator")).status).toBe(
            200,
        );
        expect(
            (
                await call(
                    restrictPost,
                    restrictedId,
                    "curator",
                    { audienceUserIds: ["member"] },
                    "POST",
                )
            ).status,
        ).toBe(200);
    });
});

class RestrictedArchiveStorage implements StorageProvider {
    uploaded = Buffer.alloc(0);
    async uploadFile(key: string): Promise<string> {
        return key;
    }
    async downloadFile(): Promise<Buffer> {
        throw new Error("not found");
    }
    async downloadStream(): Promise<Readable> {
        throw new Error("not found");
    }
    async uploadStream(key: string, stream: Readable): Promise<string> {
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        this.uploaded = Buffer.concat(chunks);
        return key;
    }
    async exists(): Promise<boolean> {
        return false;
    }
    async getSignedUrl(): Promise<string> {
        return "";
    }
    async deleteFile(): Promise<void> {}
    async testConnection(): Promise<boolean> {
        return true;
    }
}
