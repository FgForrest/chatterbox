import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
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
import { z } from "zod";
import { POST as categorizePost } from "@/app/api/recordings/[id]/categorize/route";
import { DELETE as cancelPlacementDelete } from "@/app/api/recordings/[id]/intended-placements/[folderId]/route";
import { db } from "@/db";
import { insertAudioItem } from "@/db/items";
import { meetingItemAudienceInTx } from "@/db/queries/meeting-audience";
import { lockOrgTree } from "@/db/queries/organization-tree";
import * as withheldQueries from "@/db/queries/withheld-placement";
import * as schema from "@/db/schema";
import {
    accounts,
    agendaSuggestions,
    chatterItems,
    folderExportConfigurations,
    folderExportMaterializations,
    googleDriveExportSettings,
    mailAddresses,
    mailContents,
    mailMessages,
    meetingAgendas,
    people,
    recordingFolderAssignments,
    recordingFolders,
    recordings,
    restrictedFolderMembers,
    users,
} from "@/db/schema";
import {
    decryptText,
    encryptJsonField,
    encryptText,
} from "@/lib/encryption/fields";
import { AppError } from "@/lib/errors";
import type { ArchiveScope } from "@/lib/export/archive-scope";
import { buildAndUploadExportArchive } from "@/lib/export/build-archive";
import { archivedMeetingSchema } from "@/lib/export/meetings";
import { DbDriveNodeStore } from "@/lib/folder-exports/drive-nodes";
import { DriveExportProvider } from "@/lib/folder-exports/drive-provider";
import { planFolderExport } from "@/lib/folder-exports/planner";
import * as exportProviders from "@/lib/folder-exports/provider-factory";
import * as folderFunctions from "@/lib/folders/folders";
import {
    addRecordingToFolder,
    assertCategorizableFolder,
    createFolder,
    deleteFolder,
    ensureRootFolders,
    moveRecordingBetweenFolders,
    removeRecordingFromFolder,
} from "@/lib/folders/folders";
import {
    restoreWithheldPlacements,
    withheldPlacementArchiveSchema,
} from "@/lib/folders/restore-restrictions";
import {
    changeFolderRestriction,
    changeRestrictedAudience,
    listRestrictedAudience,
} from "@/lib/folders/restricted-folders";
import type { ArchivedMail } from "@/lib/mail/archive";
import { parseMessage } from "@/lib/mail/parse";
import { storeMailForOwner } from "@/lib/mail/store";
import { MEETING_TOOLS } from "@/lib/mcp/tools/meetings";
import { attachAgenda, detachAgenda } from "@/lib/meetings/attachment";
import { restoreMeetings } from "@/lib/meetings/restore";
import {
    addPoint,
    decideSuggestion,
    getMeeting,
    listMeetings,
    patchMeeting,
    prepareMeeting,
} from "@/lib/meetings/service";
import { requestArrivalInTx } from "@/lib/pipeline/arrival";
import * as intendedPlacements from "@/lib/pipeline/share-intent";
import { executeIntendedSharesWithOutcome } from "@/lib/pipeline/share-intent";
import { resolveChannelDefaultProfile } from "@/lib/profiles/resolve-for-placement";
import { ensureProfiles } from "@/lib/profiles/seed";
import type { ProfileRecord } from "@/lib/profiles/store";
import { isRecordingShared } from "@/lib/sharing/shared";
import type { StorageProvider } from "@/lib/storage/types";
import { saveUploadedAudio } from "@/lib/uploads/save-uploaded-audio";
import { saveUploadedAudioFile } from "@/lib/uploads/save-uploaded-audio-file";
import { localActor } from "@/tests/helpers/session-actor";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";
import { FakeDrive } from "@/tests/integrations/google/fake-drive";
import {
    insertRecording,
    insertTranscript,
    serviceCaller,
} from "@/tests/mcp/fixtures";

vi.mock("@/lib/mail/raw-storage", () => ({
    storeRawMail: async (_user: string, item: string) => `mail/${item}`,
    deleteRawMail: async () => {},
}));
vi.mock("@/lib/uploads/audio-duration", () => ({
    readAudioDurationMs: async () => 1000,
    readAudioFileDurationMs: async () => 1000,
}));
vi.mock("@/lib/audio/ingest-waveform", () => ({
    generateIngestWaveform: async () => null,
}));
vi.mock("@/lib/audio/server-waveform", () => ({
    generateFileWaveform: async () => null,
}));
vi.mock("@/lib/recordings/storage-reconciliation-job", () => ({
    enqueueStorageReconciliationJob: async () => {},
}));
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
vi.mock("@/lib/recording-sessions/route-gate", () => ({
    gateRecordingSessionRequest: async (request: Request) => ({
        authn: { user: { id: request.headers.get("x-test-user") ?? "owner" } },
    }),
}));

const url = getTestDatabaseUrl();
const suite = url ? describe : describe.skip;

suite("restricted folders review 2 (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    let exportRoot: string;
    let openId: string;
    let restrictedId: string;
    beforeAll(async () => {
        exportRoot = await mkdtemp(join(tmpdir(), "restricted-exports-"));
        mockEnv.FILESYSTEM_EXPORT_ROOT = exportRoot;
        database = await createMigratedTestDatabase(
            url ?? "",
            "restricted_fix2",
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

    function barrier() {
        let release = () => {};
        const promise = new Promise<void>((resolve) => {
            release = resolve;
        });
        return { promise, release };
    }
    async function treeWaiters() {
        const [row] = await database.sql`select count(*)::int as n from pg_locks
            where locktype = 'advisory' and objid = (hashtext('riffado:org-tree')::bigint & 4294967295)
              and not granted and database = (select oid from pg_database where datname = current_database())`;
        return row.n as number;
    }
    async function arrive(
        id: string,
        folderId?: string,
        profile?: ProfileRecord,
    ) {
        const folder = folderId
            ? await assertCategorizableFolder("member", folderId)
            : null;
        return insertAudioItem(
            db,
            {
                id,
                userId: "member",
                title: encryptText("Arrival"),
                occurredAt: new Date(),
                deviceSn: "local",
                plaudFileId: id,
                duration: 1000,
                endTime: new Date(),
                filesize: 1,
                fileMd5: "0".repeat(32),
                storageType: "local",
                storagePath: id,
                plaudVersion: "1",
            },
            {
                pipeline: "arrival",
                lockOrganizationTree: folder?.scope === "org",
                initializeInTx: (tx, input) =>
                    requestArrivalInTx(tx, { ...input, folder, profile }),
            },
        );
    }
    it("filters real carry-over service detail sources independently of Organization ownership", async () => {
        const sourceFolder = await createFolder({
            userId: "org",
            parentId: openId,
            name: "Source",
        });
        const destination = await createFolder({
            userId: "org",
            parentId: openId,
            name: "Public",
        });
        const a = await prepareMeeting("org", {
            folderId: sourceFolder.id,
            title: "Agenda A",
        });
        await addPoint("org", a.id, { text: "Unaccepted secret" });
        await addPoint("org", a.id, { text: "Accepted historical point" });
        await patchMeeting("org", a.id, { state: "held" });
        if (a.meeting.unchanged) throw new Error("missing agenda A");
        const b = await prepareMeeting("org", {
            folderId: sourceFolder.id,
            title: "Agenda B",
        });
        if (b.meeting.unchanged) throw new Error("missing agenda B");
        const [accepted] = await db
            .select()
            .from(agendaSuggestions)
            .where(
                and(
                    eq(agendaSuggestions.agendaId, b.id),
                    sql`${agendaSuggestions.text} is not null`,
                ),
            );
        const suggestions = await db
            .select()
            .from(agendaSuggestions)
            .where(eq(agendaSuggestions.agendaId, b.id));
        expect(suggestions).toHaveLength(2);
        const historical =
            suggestions.find(
                (s) => decryptText(s.text) === "Accepted historical point",
            ) ?? accepted;
        await decideSuggestion("org", b.id, historical.id, "added");
        await moveRecordingBetweenFolders({
            userId: "org",
            recordingId: b.meeting.meetingItemId ?? "",
            fromFolderId: sourceFolder.id,
            toFolderId: destination.id,
        });
        const tool = MEETING_TOOLS.find((tool) => tool.name === "get_meeting");
        if (!tool) throw new Error("missing tool");
        const run = () =>
            tool.run(
                { caller: serviceCaller("org", ["tasks:read"]), touched: [] },
                { meetingId: b.id },
            );
        const before = JSON.stringify(await run());
        expect(before).toContain("Unaccepted secret");
        expect(before).toContain(a.meeting.meetingItemId);
        await changeFolderRestriction("curator", sourceFolder.id, "restrict");
        const after = JSON.stringify(await run());
        expect(after).not.toContain("Unaccepted secret");
        expect(after).not.toContain(a.meeting.meetingItemId);
        expect(after).toContain("Accepted historical point");
    });

    it("hides withheld task-source metadata and an Organization-owned attached recording in service detail", async () => {
        const meeting = await prepareMeeting("org", {
            folderId: openId,
            title: "Public plan",
        });
        await insertRecording(database.db, {
            id: "org-hidden-source",
            userId: "org",
        });
        await addRecordingToFolder({
            userId: "org",
            recordingId: "org-hidden-source",
            folderId: restrictedId,
        });
        await db
            .update(meetingAgendas)
            .set({
                taskSourceItemId: "org-hidden-source",
                snapshotSourceItemId: "org-hidden-source",
            })
            .where(eq(meetingAgendas.id, meeting.id));
        const tool = MEETING_TOOLS.find((tool) => tool.name === "get_meeting");
        if (!tool) throw new Error("missing tool");
        const run = () =>
            tool.run(
                { caller: serviceCaller("org", ["tasks:read"]), touched: [] },
                { meetingId: meeting.id },
            );
        expect(JSON.stringify(await run())).not.toContain("org-hidden-source");
        await attachAgenda("org", meeting.id, "org-hidden-source");
        expect(JSON.stringify(await run())).not.toContain("org-hidden-source");
        expect(
            await getMeeting("org", meeting.id, undefined, false, true),
        ).toMatchObject({
            recordingItemId: null,
            attachedRecording: { visible: false },
            taskSourceItemId: null,
            snapshotSourceItemId: null,
        });
    });
    it("omits a withheld absorbed original's identity, title and folder from service detail of its published recording", async () => {
        const meeting = await prepareMeeting("org", {
            folderId: restrictedId,
            title: "Hidden original title",
        });
        if (meeting.meeting.unchanged) throw new Error("missing agenda");
        await addPoint("org", meeting.id, { text: "Accepted agenda text" });
        await insertRecording(database.db, {
            id: "public-recording",
            userId: "org",
        });
        await db.insert(recordingFolderAssignments).values({
            userId: "org",
            itemId: "public-recording",
            folderId: openId,
        });
        await attachAgenda("org", meeting.id, "public-recording");
        const detail = await getMeeting(
            "org",
            meeting.id,
            undefined,
            true,
            true,
        );
        expect(detail).toMatchObject({
            meetingItemId: null,
            recordingItemId: "public-recording",
            attachedRecording: { visible: true },
            points: [{ text: "Accepted agenda text" }],
            folders: [],
        });
        const serialized = JSON.stringify(detail);
        expect(serialized).not.toContain("Hidden original title");
        expect(serialized).not.toContain(meeting.meeting.meetingItemId);
        expect(serialized).not.toContain(restrictedId);
        const listed = await listMeetings("org", {
            organizationOnly: true,
            includeAbsorbed: true,
            includePast: true,
        });
        expect(listed.find((row) => row.id === meeting.id)).toMatchObject({
            meetingItemId: null,
            recordingItemId: "public-recording",
        });
        expect(JSON.stringify(listed)).not.toContain(
            meeting.meeting.meetingItemId,
        );
    });

    it.each([
        false,
        true,
    ])("initializes with one connection without pool recursion (restricted=%s)", async (restricted) => {
        await ensureProfiles("member");
        const profile = await resolveChannelDefaultProfile({
            ownerUserId: "member",
            channel: "audio",
            view: "private",
        });
        const client = postgres(database.url, { max: 1 });
        ref.current = drizzle(client, { schema }) as unknown as Record<
            PropertyKey,
            unknown
        >;
        try {
            await arrive(
                "single",
                restricted ? restrictedId : undefined,
                profile ?? undefined,
            );
        } finally {
            ref.current = database.db as unknown as Record<
                PropertyKey,
                unknown
            >;
            await client.end({ timeout: 1 });
        }
        expect(
            await database.db
                .select()
                .from(recordings)
                .where(eq(recordings.id, "single")),
        ).toHaveLength(1);
    });
    it("lets the tree holder finish when another arrival saturates a two-connection pool", async () => {
        await ensureProfiles("member");
        const profile = await resolveChannelDefaultProfile({
            ownerUserId: "member",
            channel: "audio",
            view: "private",
        });
        const folder = await assertCategorizableFolder("member", restrictedId);
        const client = postgres(database.url, { max: 2 });
        const pooled = drizzle(client, { schema });
        ref.current = pooled as unknown as Record<PropertyKey, unknown>;
        const read = barrier();
        const resume = barrier();
        const lockFolder = folderFunctions.lockCategorizableFolderInTx;
        const spy = vi
            .spyOn(folderFunctions, "lockCategorizableFolderInTx")
            .mockImplementationOnce(async (...args) => {
                const result = await lockFolder(...args);
                read.release();
                await resume.promise;
                return result;
            });
        const start = (id: string) =>
            insertAudioItem(
                db,
                {
                    id,
                    userId: "member",
                    title: encryptText("Pool"),
                    occurredAt: new Date(),
                    deviceSn: "local",
                    plaudFileId: id,
                    duration: 1,
                    endTime: new Date(),
                    filesize: 1,
                    fileMd5: "0".repeat(32),
                    storageType: "local",
                    storagePath: id,
                    plaudVersion: "1",
                },
                {
                    pipeline: "arrival",
                    lockOrganizationTree: true,
                    initializeInTx: (tx, input) =>
                        requestArrivalInTx(tx, { ...input, folder, profile }),
                },
            );
        const first = start("pool-first");
        await read.promise;
        const second = start("pool-second");
        try {
            await expect.poll(treeWaiters).toBe(1);
            resume.release();
            await Promise.all([first, second]);
        } finally {
            resume.release();
            spy.mockRestore();
            ref.current = database.db as unknown as Record<
                PropertyKey,
                unknown
            >;
            await client.end({ timeout: 1 });
        }
    });
    it.each([
        "lift",
        "restrict",
        "remove audience",
    ])("holds the production tree lock after reading arrival state against %s", async (transition) => {
        const folder = await createFolder({
            userId: "owner",
            parentId: openId,
            name: "Arrival state",
            restricted: transition !== "restrict",
            audienceUserIds: ["member"],
        });
        const read = barrier();
        const resume = barrier();
        const lockFolder = folderFunctions.lockCategorizableFolderInTx;
        const spy = vi
            .spyOn(folderFunctions, "lockCategorizableFolderInTx")
            .mockImplementationOnce(async (...args) => {
                const result = await lockFolder(...args);
                read.release();
                await resume.promise;
                return result;
            });
        const arriving = arrive("state-arrival", folder.id);
        await read.promise;
        const changing =
            transition === "remove audience"
                ? changeRestrictedAudience("owner", folder.id, {
                      removeUserId: "member",
                  })
                : changeFolderRestriction(
                      "curator",
                      folder.id,
                      transition === "lift" ? "lift" : "restrict",
                  );
        try {
            await expect.poll(treeWaiters).toBe(1);
            resume.release();
            await arriving;
            if (transition === "remove audience")
                await expect(changing).rejects.toBeInstanceOf(AppError);
            else await changing;
        } finally {
            resume.release();
            spy.mockRestore();
        }
        expect(
            await db
                .select()
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.itemId, "state-arrival")),
        ).toHaveLength(transition === "restrict" ? 0 : 1);
    });
    it.each([
        "unfiled",
        "private",
        "local",
    ])("commits %s creation while another transaction holds the tree lock", async (mode) => {
        let folderId: string | undefined;
        if (mode === "private") {
            await ensureRootFolders("member");
            const [root] = await db
                .select()
                .from(recordingFolders)
                .where(eq(recordingFolders.userId, "member"));
            folderId = (
                await createFolder({
                    userId: "member",
                    parentId: root.id,
                    name: "Private arrival",
                })
            ).id;
        }
        if (mode === "local") mockEnv.SELF_HOST_MODE = "local";
        const held = barrier();
        const release = barrier();
        const holder = database.db.transaction(async (tx) => {
            await lockOrgTree(tx);
            held.release();
            await release.promise;
        });
        await held.promise;
        try {
            await arrive("independent", folderId);
            expect(await treeWaiters()).toBe(0);
        } finally {
            release.release();
            await holder;
            mockEnv.SELF_HOST_MODE = "shared";
        }
    });
    it("withdraws a pending lift through DELETE before a stale executor resumes", async () => {
        await changeFolderRestriction("owner", restrictedId, "lift");
        await makeShareable();
        const result = await interleave(
            () => executeIntendedSharesWithOutcome("owner", "recording"),
            async () => {
                const response = await cancelPlacementDelete(
                    new Request("http://localhost/api/test", {
                        method: "DELETE",
                        headers: { "x-test-user": "owner" },
                    }),
                    {
                        params: Promise.resolve({
                            id: "recording",
                            folderId: restrictedId,
                        }),
                    },
                );
                expect(response.status).toBe(200);
            },
        );
        expect(result).toMatchObject({
            value: { shared: false, remaining: false },
        });
        expect(
            await db
                .select()
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.itemId, "recording")),
        ).toEqual([]);
        expect(
            await db
                .select()
                .from(restrictedFolderMembers)
                .where(eq(restrictedFolderMembers.folderId, restrictedId)),
        ).toEqual([]);
        expect(await isRecordingShared("recording", "org")).toBe(false);
    });
    it.each([
        "upload",
        "recorder",
        "deferred recorder",
        "categorize",
    ])("files a human curator outside the audience via %s without publication", async (path) => {
        await ensureProfiles("curator");
        const storage = new RestrictedArchiveStorage();
        let itemId: string;
        if (path === "categorize") {
            await insertRecording(database.db, {
                id: "curator-item",
                userId: "curator",
            });
            itemId = "curator-item";
            const response = await categorizePost(
                new Request("http://localhost/api/test", {
                    method: "POST",
                    headers: {
                        "x-test-user": "curator",
                        "content-type": "application/json",
                    },
                    body: JSON.stringify({ folderIds: [restrictedId] }),
                }),
                { params: Promise.resolve({ id: itemId }) },
            );
            expect(response.status).toBe(200);
        } else if (path === "upload") {
            itemId = (
                await saveUploadedAudio({
                    userId: "curator",
                    fileId: "upload",
                    basename: "Upload",
                    extension: ".wav",
                    buffer: Buffer.from("audio"),
                    storage,
                    sourceExtension: ".wav",
                    convertedFromVideo: false,
                    folderId: restrictedId,
                })
            ).recordingId;
        } else {
            const file = join(exportRoot, "recorder.wav");
            await writeFile(file, "audio");
            itemId = (
                await saveUploadedAudioFile({
                    userId: "curator",
                    fileId: "recorder",
                    basename: "Recorder",
                    extension: ".wav",
                    filePath: file,
                    storage,
                    recordedAt: new Date(),
                    folderId: restrictedId,
                    ...(path === "deferred recorder"
                        ? {
                              deferredFolderFallback: {
                                  kind: "recording session" as const,
                                  id: "capture",
                              },
                          }
                        : {}),
                })
            ).recordingId;
        }
        expect(
            await db
                .select()
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.itemId, itemId)),
        ).toMatchObject([{ folderId: restrictedId, withheld: true }]);
        expect(
            (await listRestrictedAudience("curator", restrictedId)).members.map(
                (m) => m.userId,
            ),
        ).toContain("curator");
        expect(await isRecordingShared(itemId, "org")).toBe(false);
        expect(
            await db.select().from(people).where(eq(people.userId, "org")),
        ).toEqual([]);
    });
    it("round-trips an owner's absorbed restricted agenda placement before detach", async () => {
        const meeting = await prepareMeeting("owner", {
            folderId: restrictedId,
            title: "Retained agenda",
        });
        if (meeting.meeting.unchanged) throw new Error("missing agenda");
        await addPoint("owner", meeting.id, { text: "Retained point" });
        const releasedAt = new Date("2026-10-10T10:00:00Z");
        await db
            .update(recordingFolderAssignments)
            .set({ releasedAt })
            .where(
                eq(
                    recordingFolderAssignments.itemId,
                    meeting.meeting.meetingItemId ?? "",
                ),
            );
        await attachAgenda("owner", meeting.id, "recording");
        await db.insert(chatterItems).values({
            id: "genuinely-deleted-agenda",
            userId: "owner",
            kind: "meeting",
            title: encryptText("Deleted agenda"),
            occurredAt: new Date(),
            deletedAt: new Date(),
        });
        await db.insert(recordingFolderAssignments).values({
            itemId: "genuinely-deleted-agenda",
            userId: "owner",
            folderId: restrictedId,
            withheld: true,
        });
        const zip = await archive({ kind: "personal", userId: "owner" });
        expect([...zip.values()].join("\n")).not.toContain(
            "genuinely-deleted-agenda",
        );
        const meetings = z
            .array(archivedMeetingSchema)
            .parse(JSON.parse(zip.get("meetings/agendas.json") ?? "[]"));
        const metadata = JSON.parse(
            zip.get("organization/restrictions.json") ?? "{}",
        );
        const placements = z
            .array(withheldPlacementArchiveSchema)
            .parse(metadata.placements);
        expect(placements).toContainEqual(
            expect.objectContaining({
                itemId: meeting.meeting.meetingItemId,
                folderId: restrictedId,
                withheld: true,
                releasedAt: releasedAt.toISOString(),
            }),
        );
        expect(
            (await archive({ kind: "organization", orgUserId: "org" })).get(
                "meetings/agendas.json",
            ) ?? "",
        ).not.toContain("Retained agenda");
        await db
            .delete(meetingAgendas)
            .where(eq(meetingAgendas.id, meeting.id));
        await insertRecording(database.db, {
            id: "restored-audio",
            userId: "owner",
        });
        const restored = await restoreMeetings("owner", {
            meetings,
            itemIdMap: { recording: "restored-audio" },
        });
        expect(restored.skipped).toEqual([]);
        expect(
            await restoreWithheldPlacements(
                "owner",
                placements,
                restored.itemIdMap,
            ),
        ).toMatchObject({ restored: 2, skipped: 0 });
        await detachAgenda("owner", "restored-audio");
        const agendaId = restored.restored[0].meetingItemId;
        expect(
            await db
                .select()
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.itemId, agendaId)),
        ).toMatchObject([
            { folderId: restrictedId, withheld: true, releasedAt },
        ]);
        const audience = await db.transaction((tx) =>
            meetingItemAudienceInTx(tx, agendaId, "owner", "org"),
        );
        expect([...audience.userIds]).toContain("member");
    });
    it.each([
        "unfile",
        "move",
        "delete item",
        "delete folder",
        "failed removal",
        "move into restricted",
    ])("durably revokes ancestor Drive copies after %s before reconciliation", async (operation) => {
        await makeShareable();
        await changeFolderRestriction("owner", restrictedId, "lift");
        await db.insert(folderExportConfigurations).values({
            id: "drive",
            userId: "org",
            folderId: openId,
            provider: "google-drive",
            exportAudio: true,
            exportTranscript: true,
            exportSummary: false,
        });
        await db.insert(googleDriveExportSettings).values({
            userId: "org",
            exportConfigurationId: "drive",
            accountSubject: "test",
            rootFolderId: "drive-root",
            rootFolderName: "Exports",
        });
        const drive = new FakeDrive();
        drive.addRoot("drive-root", "Exports");
        const nodes = new DbDriveNodeStore("org", "drive");
        const provider = () =>
            new DriveExportProvider({
                exportId: "drive",
                rootFolderId: "drive-root",
                client: drive,
                nodes,
            });
        const providerSpy = vi
            .spyOn(exportProviders, "createExportProvider")
            .mockImplementation(async () => provider());
        try {
            await planFolderExport("org", "drive");
            const states = await db
                .select()
                .from(folderExportMaterializations)
                .where(
                    eq(
                        folderExportMaterializations.exportConfigurationId,
                        "drive",
                    ),
                );
            expect(states.length).toBeGreaterThan(0);
            for (const state of states) {
                await provider().materialize(
                    state.logicalPath,
                    Buffer.from("copy"),
                    { version: state.artifactVersion, format: state.format },
                );
            }
            await db
                .update(folderExportMaterializations)
                .set({ status: "exported", exportedAt: new Date() })
                .where(
                    eq(
                        folderExportMaterializations.exportConfigurationId,
                        "drive",
                    ),
                );
            const ownedIds = (await nodes.list())
                .filter((n) => n.kind !== "folder")
                .map((n) => n.driveFileId);
            const foreignId = drive.userAddFile("drive-root", "foreign.txt");
            const [firstOwned] = ownedIds;
            const ownedFile = await drive.getItem(firstOwned);
            if (!ownedFile?.parents[0])
                throw new Error("missing exported parent");
            const foreignChildId = drive.userAddFile(
                ownedFile.parents[0],
                "notes.txt",
            );
            if (operation === "move into restricted") {
                const destination = await createFolder({
                    userId: "owner",
                    parentId: openId,
                    name: "Restricted destination",
                    restricted: true,
                });
                await moveRecordingBetweenFolders({
                    userId: "owner",
                    recordingId: "recording",
                    fromFolderId: restrictedId,
                    toFolderId: destination.id,
                });
                await removeRecordingFromFolder({
                    userId: "owner",
                    recordingId: "recording",
                    folderId: destination.id,
                });
            } else {
                await changeFolderRestriction(
                    "curator",
                    restrictedId,
                    "restrict",
                    ["member"],
                );
            }
            expect(
                await db
                    .select()
                    .from(folderExportMaterializations)
                    .where(
                        eq(
                            folderExportMaterializations.revocationPending,
                            true,
                        ),
                    ),
            ).toHaveLength(states.length);
            if (operation === "failed removal") {
                const fail = vi
                    .spyOn(drive, "updateItem")
                    .mockRejectedValue(new Error("unavailable"));
                await expect(
                    planFolderExport("org", "drive"),
                ).rejects.toMatchObject({ code: "EXPORT_REVOCATION_PENDING" });
                fail.mockRestore();
                expect(
                    await db
                        .select()
                        .from(folderExportMaterializations)
                        .where(
                            eq(
                                folderExportMaterializations.revocationPending,
                                true,
                            ),
                        ),
                ).toHaveLength(states.length);
            }
            if (operation === "move") {
                const target = await createFolder({
                    userId: "owner",
                    parentId: openId,
                    name: "Second restricted",
                    restricted: true,
                });
                await moveRecordingBetweenFolders({
                    userId: "owner",
                    recordingId: "recording",
                    fromFolderId: restrictedId,
                    toFolderId: target.id,
                });
            } else if (operation === "delete item")
                await db
                    .delete(chatterItems)
                    .where(eq(chatterItems.id, "recording"));
            else if (operation === "delete folder")
                await deleteFolder("org", restrictedId, { canCurate: true });
            else if (operation !== "move into restricted")
                await removeRecordingFromFolder({
                    userId: "owner",
                    recordingId: "recording",
                    folderId: restrictedId,
                });
            await planFolderExport("org", "drive");
            for (const id of ownedIds) expect(drive.isTrashed(id)).toBe(true);
            expect(drive.isTrashed(foreignId)).toBe(false);
            expect(drive.isTrashed(foreignChildId)).toBe(false);
            await planFolderExport("org", "drive");
            expect(drive.isTrashed(foreignChildId)).toBe(false);
            expect(
                await db
                    .select()
                    .from(folderExportMaterializations)
                    .where(
                        eq(
                            folderExportMaterializations.exportConfigurationId,
                            "drive",
                        ),
                    ),
            ).toEqual([]);
        } finally {
            providerSpy.mockRestore();
        }
    });

    async function deliverMail(pendingShareFolderIds: string[] = []) {
        const raw = Buffer.from(
            "From: member@example.com\r\nTo: mailbox@example.com\r\nSubject: Arrival mail\r\n\r\nBody",
        );
        const receivedAt = new Date();
        return storeMailForOwner({
            delivery: {
                ownerUserId: "member",
                senderVerified: true,
                folderIds: [],
                pendingShareFolderIds,
                addresses: [],
                recipients: [],
            },
            raw,
            parsed: await parseMessage(raw),
            facts: {
                fromHeaders: 1,
                fromAddresses: ["member@example.com"],
                dkim: [],
                receivedAt,
            },
            spf: null,
            receivedAt,
        });
    }
    it.each([
        false,
        true,
    ])("serializes the new/duplicate mail folder-state read with lift (duplicate=%s)", async (duplicate) => {
        if (duplicate) await deliverMail();
        const read = barrier();
        const resume = barrier();
        const record = withheldQueries.recordWithheldPlacementInTx;
        const spy = vi
            .spyOn(withheldQueries, "recordWithheldPlacementInTx")
            .mockImplementationOnce(async (...args) => {
                await record(...args);
                read.release();
                await resume.promise;
            });
        const incoming = deliverMail([restrictedId]);
        await read.promise;
        const lifting = changeFolderRestriction("owner", restrictedId, "lift");
        try {
            await expect.poll(treeWaiters).toBe(1);
            resume.release();
            const item = await incoming;
            await lifting;
            expect(item.duplicate).toBe(duplicate);
            expect(
                await db
                    .select()
                    .from(recordingFolderAssignments)
                    .where(eq(recordingFolderAssignments.itemId, item.itemId)),
            ).toHaveLength(1);
        } finally {
            resume.release();
            spy.mockRestore();
        }
    });
    it("commits personal mailbox mail while the tree lock is held", async () => {
        const held = barrier();
        const release = barrier();
        const holder = database.db.transaction(async (tx) => {
            await lockOrgTree(tx);
            held.release();
            await release.promise;
        });
        await held.promise;
        try {
            expect((await deliverMail()).duplicate).toBe(false);
            expect(await treeWaiters()).toBe(0);
        } finally {
            release.release();
            await holder;
        }
    });
    it("locks explicit Organization agenda attachment before unfiled upload creation", async () => {
        const agenda = await prepareMeeting("member", {
            folderId: restrictedId,
            title: "Explicit attachment",
        });
        const read = barrier();
        const resume = barrier();
        const record = intendedPlacements.recordIntendedPlacementInTx;
        const spy = vi
            .spyOn(intendedPlacements, "recordIntendedPlacementInTx")
            .mockImplementationOnce(async (...args) => {
                await record(...args);
                read.release();
                await resume.promise;
            });
        const incoming = saveUploadedAudio({
            userId: "member",
            fileId: "explicit",
            basename: "Capture",
            extension: ".wav",
            buffer: Buffer.from("audio"),
            storage: new RestrictedArchiveStorage(),
            sourceExtension: ".wav",
            convertedFromVideo: false,
            agendaId: agenda.id,
        });
        await read.promise;
        const lifting = changeFolderRestriction("owner", restrictedId, "lift");
        try {
            await expect.poll(treeWaiters).toBe(1);
            resume.release();
            const result = await incoming;
            await lifting;
            const [attached] = await db
                .select()
                .from(meetingAgendas)
                .where(eq(meetingAgendas.id, agenda.id));
            expect(attached.recordingItemId).toBe(result.recordingId);
        } finally {
            resume.release();
            spy.mockRestore();
        }
    });
    it("includes Organization-owned unfiled and withheld mail content in its ZIP", async () => {
        for (const id of ["org-unfiled-mail", "org-withheld-mail"]) {
            await db.insert(chatterItems).values({
                id,
                userId: "org",
                kind: "mail",
                title: encryptText(id),
                occurredAt: new Date(),
            });
            await db.insert(mailMessages).values({
                id,
                userId: "org",
                rawHash: id,
                receivedAt: new Date(),
                sizeBytes: 0,
                senderVerified: true,
                auth: encryptJsonField({}),
            });
            await db.insert(mailContents).values({
                itemId: id,
                userId: "org",
                parserVersion: 2,
                segments: encryptJsonField([
                    { text: "Organization mail body" },
                ]),
            });
        }
        await addRecordingToFolder({
            userId: "org",
            recordingId: "org-withheld-mail",
            folderId: restrictedId,
        });
        const zip = await archive({ kind: "organization", orgUserId: "org" });
        const all = [...zip.values()].join("\n");
        expect(all).toContain("org-unfiled-mail");
        expect(all).toContain("org-withheld-mail");
        expect(all).toContain("Organization mail body");
        const mails: ArchivedMail[] = [...zip]
            .filter(([name]) => name.endsWith("/mail.json"))
            .map(([, json]) => JSON.parse(json));
        expect(mails).toHaveLength(2);
        const metadata = JSON.parse(
            zip.get("organization/restrictions.json") ?? "{}",
        );
        await db.delete(chatterItems).where(eq(chatterItems.userId, "org"));
        for (const mail of mails) {
            await db.insert(chatterItems).values({
                id: mail.id,
                userId: "org",
                kind: "mail",
                title: encryptText(mail.subject),
                occurredAt: new Date(mail.occurredAt),
            });
            await db.insert(mailMessages).values({
                id: mail.id,
                userId: "org",
                rawHash: mail.id,
                receivedAt: new Date(mail.receivedAt),
                sizeBytes: mail.sizeBytes,
                senderVerified: mail.senderVerified,
                auth: encryptJsonField(mail.auth ?? {}),
            });
            await db.insert(mailContents).values({
                itemId: mail.id,
                userId: "org",
                parserVersion: 2,
                segments: encryptJsonField(mail.segments),
            });
        }
        await restoreWithheldPlacements(
            "org",
            metadata.placements,
            Object.fromEntries(mails.map((mail) => [mail.id, mail.id])),
        );
        const restored = await archive({
            kind: "organization",
            orgUserId: "org",
        });
        const restoredMails: ArchivedMail[] = [...restored]
            .filter(([name]) => name.endsWith("/mail.json"))
            .map(([, json]) => JSON.parse(json));
        expect(
            restoredMails.map(({ id, subject, segments }) => ({
                id,
                subject,
                segments,
            })),
        ).toEqual(
            mails.map(({ id, subject, segments }) => ({
                id,
                subject,
                segments,
            })),
        );
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
