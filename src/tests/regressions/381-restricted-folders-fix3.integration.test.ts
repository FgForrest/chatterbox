import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
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
import { POST as audiencePost } from "@/app/api/folders/[id]/audience/route";
import { db } from "@/db";
import * as schema from "@/db/schema";
import {
    accounts,
    asyncJobs,
    folderExportConfigurations,
    folderExportMaterializations,
    googleDriveExportSettings,
    itemProcessing,
    mailAddresses,
    mailPendingShares,
    meetingAgendas,
    people,
    recordingFolderAssignments,
    recordingFolders,
    recordings,
    restrictedFolderAccessRequests,
    restrictedFolderMembers,
    userAccessStates,
    users,
} from "@/db/schema";
import { recordAccessState } from "@/lib/authz/access-state";
import { encryptText } from "@/lib/encryption/fields";
import { ErrorCode } from "@/lib/errors";
import type { ArchiveScope } from "@/lib/export/archive-scope";
import { buildAndUploadExportArchive } from "@/lib/export/build-archive";
import { deleteFolderExport } from "@/lib/folder-exports/configurations";
import { DbDriveNodeStore } from "@/lib/folder-exports/drive-nodes";
import { DriveExportProvider } from "@/lib/folder-exports/drive-provider";
import { exportPlanJobHandler } from "@/lib/folder-exports/job-handlers";
import { enqueueExportPlan } from "@/lib/folder-exports/jobs";
import { planFolderExport } from "@/lib/folder-exports/planner";
import * as exportProviders from "@/lib/folder-exports/provider-factory";
import { requestRestrictedFolderAccess } from "@/lib/folders/access-requests";
import {
    addRecordingToFolder,
    createFolder,
    deleteFolder,
    ensureRootFolders,
} from "@/lib/folders/folders";
import {
    restoreRestrictedFolderMetadata,
    restoreWithheldPlacements,
    withheldPlacementArchiveSchema,
} from "@/lib/folders/restore-restrictions";
import {
    changeFolderRestriction,
    changeRestrictedAudience,
    processRestrictedFolderItem,
    type RestrictedFolderItemWork,
} from "@/lib/folders/restricted-folders";
import { clearJobHandlers, registerJobHandler } from "@/lib/jobs/registry";
import { tick, waitForIdle } from "@/lib/jobs/worker";
import { MEETING_TOOLS } from "@/lib/mcp/tools/meetings";
import { prepareMeeting } from "@/lib/meetings/service";
import { executeIntendedSharesWithOutcome } from "@/lib/pipeline/share-intent";
import { ensureProfiles } from "@/lib/profiles/seed";
import { resolveRecordingAccess } from "@/lib/sharing/access";
import { isRecordingShared } from "@/lib/sharing/shared";
import * as storageProviders from "@/lib/storage/factory";
import type { StorageProvider } from "@/lib/storage/types";
import { saveUploadedAudio } from "@/lib/uploads/save-uploaded-audio";
import { saveUploadedAudioFile } from "@/lib/uploads/save-uploaded-audio-file";
import { videoExtractionJobHandler } from "@/lib/uploads/video-extraction-job-handler";
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
    userCaller,
} from "@/tests/mcp/fixtures";

vi.mock("@/lib/jobs/housekeeping", () => ({
    runHousekeeping: async () => ({}),
}));
vi.mock("node:child_process", () => ({
    spawn(command: string, args: string[]) {
        const child = Object.assign(new EventEmitter(), {
            stdout: new PassThrough(),
            stderr: new PassThrough(),
        });
        queueMicrotask(async () => {
            if (command === "ffprobe")
                child.stdout.end(
                    JSON.stringify({ streams: [{ duration: "1" }] }),
                );
            else {
                await writeFile(args.at(-1) ?? "", "audio");
                child.stdout.end();
            }
            child.emit("close", 0);
        });
        return child;
    },
}));
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
vi.mock("@/lib/recording-sessions/route-gate", () => ({
    gateRecordingSessionRequest: async (request: Request) => ({
        authn: { user: { id: request.headers.get("x-test-user") ?? "owner" } },
    }),
}));

const url = getTestDatabaseUrl();
const suite = url ? describe : describe.skip;

suite("restricted folders review 3 (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    let exportRoot: string;
    let openId: string;
    let restrictedId: string;
    beforeAll(async () => {
        exportRoot = await mkdtemp(join(tmpdir(), "restricted-exports-"));
        mockEnv.FILESYSTEM_EXPORT_ROOT = exportRoot;
        database = await createMigratedTestDatabase(
            url ?? "",
            "restricted_fix3",
        );
        sqlRef.current = database.sql;
        ref.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120000);
    afterAll(async () => {
        sqlRef.current = null;
        ref.current = null;
        await database?.dispose();
        await rm(exportRoot, { recursive: true, force: true });
    }, 30000);
    beforeEach(async () => {
        clearJobHandlers();
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
    });
    async function makeShareable() {
        await insertTranscript(database.db, "recording", "owner");
    }

    async function interleave<T>(
        action: () => Promise<T>,
        change: () => Promise<unknown>,
    ) {
        const gate = await database.sql.reserve();
        const key = 381003;
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
                            await database.sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and objid = ${key} and not granted and database = (select oid from pg_database where datname = current_database())`;
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

    function _barrier() {
        let release = () => {};
        const promise = new Promise<void>((resolve) => {
            release = resolve;
        });
        return { promise, release };
    }
    async function _treeWaiters() {
        const [row] = await database.sql`select count(*)::int as n from pg_locks
            where locktype = 'advisory' and objid = (hashtext('riffado:org-tree')::bigint & 4294967295)
              and not granted and database = (select oid from pg_database where datname = current_database())`;
        return row.n as number;
    }
    it.each([
        ["recorder", "restrict"],
        ["recorder", "remove"],
        ["video", "restrict"],
        ["video", "remove"],
        ["upload", "restrict"],
        ["upload", "remove"],
    ])("rechecks deferred %s save after preflight and concurrent %s", async (kind, transition) => {
        const folder = await createFolder({
            userId: "owner",
            parentId: openId,
            name: "Arrival",
            restricted: transition === "remove",
            audienceUserIds: ["member"],
        });
        await ensureProfiles("member");
        const file = join(exportRoot, "capture.wav");
        await writeFile(file, "audio");
        const storage = new RestrictedArchiveStorage();
        const source = "member/video-uploads/source";
        storage.files.set(source, Buffer.from("video"));
        const storageSpy = vi
            .spyOn(storageProviders, "createUserStorageProvider")
            .mockResolvedValue(storage);
        const start = async () => {
            if (kind === "recorder")
                return saveUploadedAudioFile({
                    userId: "member",
                    fileId: "capture",
                    basename: "Capture",
                    extension: ".wav",
                    filePath: file,
                    storage,
                    recordedAt: new Date(),
                    folderId: folder.id,
                    deferredFolderFallback: {
                        kind: "recording session",
                        id: "session",
                    },
                });
            if (kind === "video")
                return videoExtractionJobHandler.run({
                    userId: "member",
                    jobId: "video",
                    attempt: 1,
                    maxAttempts: 3,
                    signal: new AbortController().signal,
                    reportProgress: () => {},
                    payload: {
                        uploadId: "video",
                        sourceStorageKey: source,
                        encryptedFilename: encryptText("meeting.mp4"),
                        sourceSize: 5,
                        folderId: folder.id,
                    },
                });
            return saveUploadedAudio({
                userId: "member",
                fileId: "upload",
                basename: "Upload",
                extension: ".wav",
                buffer: Buffer.from("audio"),
                storage,
                sourceExtension: ".wav",
                convertedFromVideo: false,
                folderId: folder.id,
            });
        };
        try {
            const outcome = await interleave(start, () =>
                transition === "remove"
                    ? changeRestrictedAudience("owner", folder.id, {
                          removeUserId: "member",
                      })
                    : changeFolderRestriction("curator", folder.id, "restrict"),
            );
            if (kind === "upload") {
                expect(outcome).toMatchObject({
                    error: { code: ErrorCode.RESTRICTED_FOLDER_NO_ACCESS },
                });
                expect(
                    await db
                        .select()
                        .from(recordings)
                        .where(eq(recordings.userId, "member")),
                ).toEqual([]);
                return;
            }
            if ("error" in outcome) throw outcome.error;
            expect(outcome.value).toBeDefined();
            const [recording] = await db
                .select()
                .from(recordings)
                .where(eq(recordings.userId, "member"));
            expect(recording).toBeDefined();
            expect(await storage.exists(recording.storagePath ?? "")).toBe(
                true,
            );
            expect(
                await db
                    .select()
                    .from(recordingFolderAssignments)
                    .where(eq(recordingFolderAssignments.itemId, recording.id)),
            ).toEqual([]);
            expect(
                await db
                    .select()
                    .from(mailPendingShares)
                    .where(eq(mailPendingShares.itemId, recording.id)),
            ).toEqual([]);
            const [processing] = await db
                .select()
                .from(itemProcessing)
                .where(eq(itemProcessing.itemId, recording.id));
            expect(processing.profileId).toBeNull();
            expect(await isRecordingShared(recording.id, "org")).toBe(false);
            if (kind === "video") {
                expect(storage.sourceDeletedWithRecording).toBe(true);
                expect(storage.deleted).toEqual([source]);
            } else {
                expect(await readFile(file, "utf8")).toBe("audio");
                expect(storage.deleted).toEqual([]);
            }
        } finally {
            storageSpy.mockRestore();
        }
    });

    async function idpStates() {
        mockEnv.AUTHZ_MODE = "idp";
        await db.insert(userAccessStates).values(
            ["owner", "member", "other", "curator"].map((userId) => ({
                userId,
                issuer: mockEnv.OIDC_ISSUER_URL,
                subject: `${userId}-sub`,
                capabilities:
                    userId === "curator" ? ["use", "org.curate"] : ["use"],
                status: "active" as const,
                source: "login" as const,
                verifiedAt: new Date(),
            })),
        );
    }
    it.each([
        ["restrict", "curator", "curate"],
        ["lift", "curator", "curate"],
        ["lift", "owner", "use"],
        ["lift", "owner", "disabled"],
    ] as const)("refuses %s by %s after stored loss of %s", async (operation, actor, loss) => {
        await makeShareable();
        if (operation === "restrict")
            await changeFolderRestriction("owner", restrictedId, "lift");
        else await requestRestrictedFolderAccess("other", restrictedId);
        await idpStates();
        const beforeFolder = await db
            .select()
            .from(recordingFolders)
            .where(eq(recordingFolders.id, restrictedId));
        const beforeRequests = await db
            .select()
            .from(restrictedFolderAccessRequests);
        const beforeJobs = await db.select().from(asyncJobs);
        const beforeIntents = await db.select().from(mailPendingShares);
        const outcome = await interleave(
            () => changeFolderRestriction(actor, restrictedId, operation),
            () =>
                recordAccessState({
                    userId: actor,
                    issuer: mockEnv.OIDC_ISSUER_URL,
                    subject: `${actor}-sub`,
                    capabilities: loss === "curate" ? ["use"] : [],
                    status: loss === "disabled" ? "disabled" : "active",
                    source: "access-change",
                }),
        );
        expect(outcome).toMatchObject({ error: { statusCode: 403 } });
        expect(
            await db
                .select()
                .from(recordingFolders)
                .where(eq(recordingFolders.id, restrictedId)),
        ).toEqual(beforeFolder);
        expect(await db.select().from(asyncJobs)).toEqual(beforeJobs);
        expect(await db.select().from(restrictedFolderAccessRequests)).toEqual(
            beforeRequests,
        );
        expect(await db.select().from(mailPendingShares)).toEqual(
            beforeIntents,
        );
        expect(await isRecordingShared("recording", "org")).toBe(
            operation === "restrict",
        );
        expect(
            await db.select().from(people).where(eq(people.userId, "org")),
        ).toEqual([]);
    });
    it.each([
        "disabled",
        "use",
        "suspended",
    ])("skips and reports a selected recipient who loses %s during addition", async (loss) => {
        await idpStates();
        const outcome = await interleave(
            () =>
                changeRestrictedAudience("member", restrictedId, {
                    addUserIds: ["other"],
                }),
            () =>
                loss === "suspended"
                    ? db
                          .update(users)
                          .set({ suspendedAt: new Date() })
                          .where(eq(users.id, "other"))
                    : recordAccessState({
                          userId: "other",
                          issuer: mockEnv.OIDC_ISSUER_URL,
                          subject: "other-sub",
                          capabilities: [],
                          status: loss === "disabled" ? "disabled" : "active",
                          source: "access-change",
                      }),
        );
        expect(outcome).toMatchObject({
            value: { addedUserIds: [], skippedUserIds: ["other"] },
        });
        expect(
            await db
                .select()
                .from(restrictedFolderMembers)
                .where(
                    and(
                        eq(restrictedFolderMembers.folderId, restrictedId),
                        eq(restrictedFolderMembers.userId, "other"),
                    ),
                ),
        ).toEqual([]);
    });

    it("filters human and service list_meetings by the withheld placement during a large lift", async () => {
        for (let index = 0; index < 27; index++) {
            const meeting = await prepareMeeting("owner", {
                folderId: restrictedId,
                title: `Plan ${index}`,
            });
            if (meeting.meeting.unchanged) throw new Error("missing meeting");
            await addRecordingToFolder({
                userId: "owner",
                recordingId: meeting.meeting.meetingItemId ?? "",
                folderId: openId,
            });
        }
        const lifted = await changeFolderRestriction(
            "owner",
            restrictedId,
            "lift",
        );
        expect(lifted.queued).toBeGreaterThan(0);
        const [remaining] = await db
            .select({
                itemId: recordingFolderAssignments.itemId,
                agendaId: meetingAgendas.id,
            })
            .from(recordingFolderAssignments)
            .innerJoin(
                meetingAgendas,
                eq(
                    meetingAgendas.meetingItemId,
                    recordingFolderAssignments.itemId,
                ),
            )
            .where(
                and(
                    eq(recordingFolderAssignments.folderId, restrictedId),
                    eq(recordingFolderAssignments.withheld, true),
                ),
            );
        expect(remaining).toBeDefined();
        const tool = MEETING_TOOLS.find(
            (tool) => tool.name === "list_meetings",
        );
        if (!tool) throw new Error("missing tool");
        const callers = [
            userCaller("other", "other@example.com", ["tasks:read"], "org"),
            serviceCaller("org", ["tasks:read"]),
        ];
        for (const caller of callers) {
            const unfiltered = await tool.run({ caller, touched: [] }, {});
            expect(JSON.stringify(unfiltered)).toContain(remaining.agendaId);
            const filtered = await tool.run(
                { caller, touched: [] },
                { folderId: restrictedId },
            );
            expect(JSON.stringify(filtered)).not.toContain(remaining.agendaId);
        }
        const [job] = await db
            .select()
            .from(asyncJobs)
            .where(
                and(
                    eq(asyncJobs.kind, "folder.restriction"),
                    sql`${asyncJobs.payload}->>'itemId' = ${remaining.itemId}`,
                ),
            );
        await processRestrictedFolderItem(
            job.payload as unknown as RestrictedFolderItemWork,
        );
        for (const caller of callers)
            expect(
                JSON.stringify(
                    await tool.run(
                        { caller, touched: [] },
                        { folderId: restrictedId },
                    ),
                ),
            ).toContain(remaining.agendaId);
    });

    async function exportedDrive(extra = 0, direct = false) {
        await makeShareable();
        await changeFolderRestriction("owner", restrictedId, "lift");
        for (let index = 0; index < extra; index++) {
            const id = `extra-${index}`;
            await insertRecording(database.db, { id, userId: "owner" });
            await db.insert(recordingFolderAssignments).values({
                userId: "owner",
                itemId: id,
                folderId: restrictedId,
            });
        }
        await db.insert(folderExportConfigurations).values({
            id: "drive",
            userId: "org",
            folderId: direct ? restrictedId : openId,
            provider: "google-drive",
            exportAudio: true,
            exportTranscript: false,
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
        const spy = vi
            .spyOn(exportProviders, "createExportProvider")
            .mockImplementation(async () => provider());
        await planFolderExport("org", "drive");
        const states = await db
            .select()
            .from(folderExportMaterializations)
            .where(
                eq(folderExportMaterializations.exportConfigurationId, "drive"),
            );
        for (const state of states)
            await provider().materialize(
                state.logicalPath,
                Buffer.from("copy"),
                { version: state.artifactVersion, format: state.format },
            );
        await db
            .update(folderExportMaterializations)
            .set({ status: "exported", exportedAt: new Date() })
            .where(
                eq(folderExportMaterializations.exportConfigurationId, "drive"),
            );
        const owned = (await nodes.list())
            .filter((node) => node.kind !== "folder")
            .map((node) => node.driveFileId);
        const file = await drive.getItem(owned[0]);
        if (!file?.parents[0]) throw new Error("missing copy");
        const foreign = drive.userAddFile(file.parents[0], "notes.txt");
        return { drive, nodes, owned, foreign, spy };
    }
    it("retries a failed revocation plan through the worker without another trigger", async () => {
        const fixture = await exportedDrive();
        try {
            await changeFolderRestriction("curator", restrictedId, "restrict");
            await db
                .delete(asyncJobs)
                .where(eq(asyncJobs.kind, "folder-export-plan"));
            const { job } = await enqueueExportPlan("org", "drive");
            registerJobHandler(exportPlanJobHandler);
            const fail = vi
                .spyOn(fixture.drive, "updateItem")
                .mockRejectedValue(new Error("transient trash failure"));
            await tick();
            await waitForIdle();
            fail.mockRestore();
            const [retry] = await db
                .select()
                .from(asyncJobs)
                .where(eq(asyncJobs.id, job.id));
            expect(retry).toMatchObject({
                status: "pending",
                attempts: 1,
                errorCode: ErrorCode.EXPORT_REVOCATION_PENDING,
            });
            expect(retry.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
            expect(
                (await db.select().from(folderExportConfigurations))[0]
                    .lastError,
            ).toBeTruthy();
            expect(await fixture.nodes.list()).not.toEqual([]);
            await db
                .update(asyncJobs)
                .set({ nextAttemptAt: new Date(0) })
                .where(eq(asyncJobs.id, job.id));
            await tick();
            await waitForIdle();
            expect(
                (
                    await db
                        .select()
                        .from(asyncJobs)
                        .where(eq(asyncJobs.id, job.id))
                )[0],
            ).toMatchObject({ status: "completed", attempts: 2 });
            for (const id of fixture.owned)
                expect(fixture.drive.isTrashed(id)).toBe(true);
            expect(fixture.drive.isTrashed(fixture.foreign)).toBe(false);
            expect(
                await db.select().from(folderExportMaterializations),
            ).toEqual([]);
            expect(
                (await db.select().from(folderExportConfigurations))[0]
                    .lastError,
            ).toBeNull();
        } finally {
            fixture.spy.mockRestore();
            clearJobHandlers();
        }
    });
    it.each([
        ["configuration", false],
        ["configuration", true],
        ["restricted configuration", false],
        ["restricted configuration", true],
        ["root", false],
        ["root", true],
        ["ancestor", false],
        ["ancestor", true],
    ])("cleans revocations before deleting the configured %s (failed first trash=%s)", async (kind, failed) => {
        const fixture = await exportedDrive(
            0,
            kind === "restricted configuration",
        );
        try {
            await changeFolderRestriction("curator", restrictedId, "restrict");
            let target = openId;
            if (kind === "ancestor") {
                const [root] = await db
                    .select()
                    .from(recordingFolders)
                    .where(
                        and(
                            eq(recordingFolders.userId, "org"),
                            eq(recordingFolders.kind, "public"),
                        ),
                    );
                const ancestor = await createFolder({
                    userId: "org",
                    parentId: root.id,
                    name: "Ancestor",
                    canCurate: true,
                });
                await db
                    .update(recordingFolders)
                    .set({ parentId: ancestor.id })
                    .where(eq(recordingFolders.id, openId));
                target = ancestor.id;
            }
            const remove = () =>
                kind.includes("configuration")
                    ? deleteFolderExport(
                          "org",
                          kind === "restricted configuration"
                              ? restrictedId
                              : openId,
                          "drive",
                      )
                    : deleteFolder("org", target, { canCurate: true });
            if (failed) {
                const fail = vi
                    .spyOn(fixture.drive, "updateItem")
                    .mockRejectedValue(new Error("transient trash failure"));
                await expect(remove()).rejects.toMatchObject({
                    statusCode: 409,
                    code: ErrorCode.EXPORT_REVOCATION_PENDING,
                    details: { retryable: true },
                });
                fail.mockRestore();
                expect(
                    await db.select().from(folderExportConfigurations),
                ).toHaveLength(1);
                expect(
                    await db.select().from(folderExportMaterializations),
                ).not.toEqual([]);
                expect(
                    await db
                        .select()
                        .from(recordingFolders)
                        .where(eq(recordingFolders.id, target)),
                ).toHaveLength(1);
            }
            await remove();
            for (const id of fixture.owned)
                expect(fixture.drive.isTrashed(id)).toBe(true);
            expect(fixture.drive.isTrashed(fixture.foreign)).toBe(false);
            expect(await db.select().from(folderExportConfigurations)).toEqual(
                [],
            );
            expect(
                await db.select().from(folderExportMaterializations),
            ).toEqual([]);
        } finally {
            fixture.spy.mockRestore();
        }
    });
    it.each([
        "configuration",
        "root",
    ])("refuses a %s deletion when restriction marks revocations after cleanup", async (kind) => {
        const fixture = await exportedDrive();
        try {
            const remove = () =>
                kind === "configuration"
                    ? deleteFolderExport("org", openId, "drive")
                    : deleteFolder("org", openId, { canCurate: true });
            const result = await interleave(remove, () =>
                changeFolderRestriction("curator", restrictedId, "restrict"),
            );
            expect(result).toMatchObject({
                error: {
                    code: ErrorCode.EXPORT_REVOCATION_PENDING,
                    statusCode: 409,
                },
            });
            expect(
                await db.select().from(folderExportConfigurations),
            ).toHaveLength(1);
            expect(
                (await db.select().from(folderExportMaterializations))[0]
                    .revocationPending,
            ).toBe(true);
            await remove();
            for (const id of fixture.owned)
                expect(fixture.drive.isTrashed(id)).toBe(true);
            expect(fixture.drive.isTrashed(fixture.foreign)).toBe(false);
        } finally {
            fixture.spy.mockRestore();
        }
    });
    it("does not regenerate revoked copies while a large restriction still has open placements", async () => {
        const fixture = await exportedDrive(27);
        try {
            const result = await changeFolderRestriction(
                "curator",
                restrictedId,
                "restrict",
            );
            expect(result.queued).toBe(3);
            expect(
                (await db.select().from(folderExportMaterializations)).every(
                    (row) => row.revocationPending,
                ),
            ).toBe(true);
            await planFolderExport("org", "drive");
            await planFolderExport("org", "drive");
            expect(
                await db.select().from(folderExportMaterializations),
            ).toEqual([]);
            await deleteFolderExport("org", openId, "drive");
            for (const id of fixture.owned)
                expect(fixture.drive.isTrashed(id)).toBe(true);
            expect(fixture.drive.isTrashed(fixture.foreign)).toBe(false);
        } finally {
            fixture.spy.mockRestore();
        }
    });
    it("cleans multiple configurations on a two-connection pool", async () => {
        const fixture = await exportedDrive();
        await db.insert(folderExportConfigurations).values({
            id: "second",
            userId: "org",
            folderId: openId,
            provider: "google-drive",
        });
        await changeFolderRestriction("curator", restrictedId, "restrict");
        const client = postgres(database.url, { max: 2 });
        ref.current = drizzle(client, { schema }) as unknown as Record<
            PropertyKey,
            unknown
        >;
        sqlRef.current = client;
        try {
            await deleteFolder("org", openId, { canCurate: true });
            for (const id of fixture.owned)
                expect(fixture.drive.isTrashed(id)).toBe(true);
            expect(fixture.drive.isTrashed(fixture.foreign)).toBe(false);
        } finally {
            ref.current = database.db as unknown as Record<
                PropertyKey,
                unknown
            >;
            sqlRef.current = database.sql;
            await client.end({ timeout: 1 });
            fixture.spy.mockRestore();
        }
    });
    it("reports skipped recipients through the audience POST response", async () => {
        await idpStates();
        const result = await interleave(
            async () =>
                audiencePost(
                    new Request("http://localhost/api/test", {
                        method: "POST",
                        headers: {
                            "content-type": "application/json",
                            "x-test-user": "member",
                        },
                        body: JSON.stringify({ userIds: ["other"] }),
                    }),
                    { params: Promise.resolve({ id: restrictedId }) },
                ),
            () =>
                recordAccessState({
                    userId: "other",
                    issuer: mockEnv.OIDC_ISSUER_URL,
                    subject: "other-sub",
                    capabilities: [],
                    status: "disabled",
                    source: "access-change",
                }),
        );
        if ("error" in result) throw result.error;
        expect(result.value.status).toBe(200);
        expect(await result.value.json()).toEqual({
            updated: true,
            addedUserIds: [],
            skippedUserIds: ["other"],
        });
    });
    it("preserves ordinary copies when removing an export without revocations", async () => {
        const fixture = await exportedDrive();
        try {
            await deleteFolderExport("org", openId, "drive");
            for (const id of fixture.owned)
                expect(fixture.drive.isTrashed(id)).toBe(false);
            expect(fixture.drive.isTrashed(fixture.foreign)).toBe(false);
        } finally {
            fixture.spy.mockRestore();
        }
    });
    it("restores a gate-failing-lift ZIP as a pending share without former-audience access", async () => {
        await changeFolderRestriction("owner", restrictedId, "lift");
        const personal = await archive({ kind: "personal", userId: "owner" });
        const organization = await archive({
            kind: "organization",
            orgUserId: "org",
        });
        const placements = z
            .array(withheldPlacementArchiveSchema)
            .parse(
                JSON.parse(
                    personal.get("organization/restrictions.json") ?? "{}",
                ).placements,
            );
        expect(placements[0]).toMatchObject({
            withheld: true,
            folderId: restrictedId,
        });
        const { folders } = JSON.parse(
            organization.get("organization/restrictions.json") ?? "{}",
        );
        expect(folders[0].restrictedAt).toBeNull();
        const restored = await createFolder({
            userId: "org",
            parentId: openId,
            name: "Restored",
            canCurate: true,
        });
        await restoreRestrictedFolderMetadata("org", folders, {
            [restrictedId]: restored.id,
        });
        expect(
            await db
                .select()
                .from(restrictedFolderMembers)
                .where(eq(restrictedFolderMembers.folderId, restored.id)),
        ).toEqual([]);
        await insertRecording(database.db, { id: "restored", userId: "owner" });
        const result = await restoreWithheldPlacements(
            "owner",
            placements.map((entry) => ({ ...entry, folderId: restored.id })),
            { recording: "restored" },
        );
        expect(result).toEqual({ restored: 1, skipped: 0 });
        expect(
            await db
                .select()
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.itemId, "restored")),
        ).toEqual([]);
        expect(await resolveRecordingAccess("member", "restored")).toBeNull();
        expect(
            await db
                .select()
                .from(mailPendingShares)
                .where(eq(mailPendingShares.itemId, "restored")),
        ).toMatchObject([
            { folderId: restored.id, confirmedAt: expect.any(Date) },
        ]);
        expect(
            (await executeIntendedSharesWithOutcome("owner", "restored"))
                .shared,
        ).toBe(false);
        await insertTranscript(database.db, "restored", "owner");
        expect(
            (await executeIntendedSharesWithOutcome("owner", "restored"))
                .shared,
        ).toBe(true);
        expect(
            await db
                .select()
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.itemId, "restored")),
        ).toMatchObject([{ folderId: restored.id, withheld: false }]);
        expect(await isRecordingShared("restored", "org")).toBe(true);
    });
});
class RestrictedArchiveStorage implements StorageProvider {
    uploaded = Buffer.alloc(0);
    files = new Map<string, Buffer>();
    deleted: string[] = [];
    sourceDeletedWithRecording = false;
    async uploadFile(key: string, data: Buffer): Promise<string> {
        this.files.set(key, data);
        return key;
    }
    async downloadFile(key: string): Promise<Buffer> {
        const data = this.files.get(key);
        if (!data) throw new Error("not found");
        return data;
    }
    async downloadStream(key: string): Promise<Readable> {
        return Readable.from(await this.downloadFile(key));
    }
    async uploadStream(key: string, stream: Readable): Promise<string> {
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        this.uploaded = Buffer.concat(chunks);
        this.files.set(key, this.uploaded);
        return key;
    }
    async exists(key: string): Promise<boolean> {
        return this.files.has(key);
    }
    async getSignedUrl(): Promise<string> {
        return "";
    }
    async deleteFile(key: string): Promise<void> {
        if (key.includes("/video-uploads/")) {
            const rows = await db
                .select()
                .from(recordings)
                .where(eq(recordings.userId, "member"));
            this.sourceDeletedWithRecording = rows.length > 0;
        }
        this.deleted.push(key);
        this.files.delete(key);
    }
    async testConnection(): Promise<boolean> {
        return true;
    }
}
