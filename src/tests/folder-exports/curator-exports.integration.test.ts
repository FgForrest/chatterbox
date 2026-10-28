import { Readable } from "node:stream";
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
    PATCH as changeExport,
    DELETE as removeExport,
} from "@/app/api/folders/[id]/exports/[exportId]/route";
import {
    POST as addExport,
    GET as listExports,
} from "@/app/api/folders/[id]/exports/route";
import {
    asyncJobs,
    chatterItems,
    driveExportNodes,
    folderExportConfigurations,
    folderExportMaterializations,
    googleDriveExportSettings,
    recordingFolderAssignments,
    recordingFolders,
    transcriptCorrections,
    transcriptions,
    userAccessStates,
    users,
} from "@/db/schema";
import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import { resolveArchiveScope } from "@/lib/export/resolve-archive-scope";
import {
    createFolderExport,
    listFolderExports,
} from "@/lib/folder-exports/configurations";
import {
    materializeFolderExport,
    reconcileFolderExport,
} from "@/lib/folder-exports/execution";
import { enqueueExportPlansForUser } from "@/lib/folder-exports/jobs";
import { planFolderExport } from "@/lib/folder-exports/planner";
import {
    ensureRootFolders,
    listPersonalFolderOrganization,
} from "@/lib/folders/folders";
import {
    __resetGoogleAccessTokensForTests,
    saveGoogleConnection,
} from "@/lib/integrations/google/connection";
import type * as DriveClientModule from "@/lib/integrations/google/drive-client";
import type { FetchDriveClientOptions } from "@/lib/integrations/google/drive-client";
import { domainLookupHash, lookupHash } from "@/lib/knowledge/lookup-hash";
import { insertRecordings } from "@/tests/integration/items";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";
import { FakeDrive } from "@/tests/integrations/google/fake-drive";

const { dbProxy, sqlProxy, dbRef, sqlRef, mockEnv, driveRef, clientOptions } =
    vi.hoisted(() => {
        function lazy(ref: { current: Record<PropertyKey, unknown> | null }) {
            return new Proxy(
                {},
                {
                    get: (_target, property: string | symbol) => {
                        const current = ref.current;
                        if (!current) {
                            throw new Error(
                                "test database was not initialized",
                            );
                        }
                        const value = current[property];
                        return typeof value === "function"
                            ? value.bind(current)
                            : value;
                    },
                },
            );
        }
        const dbRef: { current: Record<PropertyKey, unknown> | null } = {
            current: null,
        };
        const sqlRef: { current: Record<PropertyKey, unknown> | null } = {
            current: null,
        };
        return {
            dbProxy: lazy(dbRef),
            sqlProxy: lazy(sqlRef),
            dbRef,
            sqlRef,
            driveRef: { current: null as unknown },
            clientOptions: [] as FetchDriveClientOptions[],
            mockEnv: {
                IS_HOSTED: false,
                SELF_HOST_MODE: "shared",
                ORG_ACCOUNT_EMAIL: "org@example.test",
                ORG_ACCOUNT_PASSWORD: "test-password",
                AUTHZ_MODE: "idp",
                OIDC_ISSUER_URL: "https://identity.example.test/realms/test",
                OIDC_CLIENT_ID: "chatterbox",
                OIDC_CLIENT_SECRET: "test-secret",
                AUTHZ_VERIFICATION_MAX_AGE: 1800,
                FILESYSTEM_EXPORT_ROOT: "",
                APP_URL: "https://riffado.example",
                GOOGLE_CLIENT_ID: "client",
                GOOGLE_CLIENT_SECRET: "secret",
                GOOGLE_PICKER_API_KEY: "picker",
                GOOGLE_CLOUD_PROJECT_NUMBER: "1234",
                GOOGLE_WORKSPACE_DOMAINS: [] as string[],
                ENCRYPTION_KEY:
                    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
                DATABASE_URL: "postgres://unused",
            },
        };
    });

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: sqlProxy }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: vi.fn(async () => ({
        downloadStream: vi.fn(async () =>
            Readable.from(Buffer.from("audio bytes!")),
        ),
    })),
}));
vi.mock("@/lib/integrations/google/drive-client", async (importOriginal) => ({
    ...(await importOriginal<typeof DriveClientModule>()),
    createDriveClient: (options: FetchDriveClientOptions) => {
        clientOptions.push(options);
        return driveRef.current;
    },
}));

vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async (request: Request) => ({
        user: { id: request.headers.get("x-test-user") ?? "member" },
    }),
}));

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const selection = {
    provider: "google-drive" as const,
    rootFolderId: "picked",
    transcriptFormat: "markdown" as const,
    summaryFormat: "markdown" as const,
    exportAudio: true,
    exportTranscript: true,
    exportSummary: false,
};

type Handler = (
    request: Request,
    context: { params: Promise<Record<string, string>> },
) => Promise<Response>;
function call(
    handler: unknown,
    user: string,
    method: string,
    exportId?: string,
    body?: unknown,
    folderId = "team",
) {
    return (handler as Handler)(
        new Request("http://localhost/api/test", {
            method,
            headers: {
                "x-test-user": user,
                "content-type": "application/json",
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        }),
        {
            params: Promise.resolve({
                id: folderId,
                ...(exportId ? { exportId } : {}),
            }),
        },
    );
}

describeWithDatabase("curator Organization folder exports (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    let drive: FakeDrive;
    const db = () => database.db;

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "curator_exports",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        sqlRef.current = database.sql as unknown as Record<
            PropertyKey,
            unknown
        >;
    }, 120_000);
    afterAll(async () => {
        dbRef.current = null;
        sqlRef.current = null;
        await database?.dispose();
    }, 30_000);
    beforeEach(async () => {
        drive = new FakeDrive();
        drive.addRoot("picked", "Internal projects");
        drive.addRoot("otherpicked", "Another destination");
        driveRef.current = drive;
        clientOptions.length = 0;
        __resetGoogleAccessTokensForTests();
        await db().delete(users);
        await db()
            .insert(users)
            .values([
                {
                    id: "org",
                    email: "org@example.test",
                    role: "org",
                    name: "Organization",
                },
                {
                    id: "curator",
                    email: "curator@example.test",
                    name: "Jitka Dvořáková",
                },
                {
                    id: "other",
                    email: "other@example.test",
                    name: "Marek Novotný",
                },
                {
                    id: "member",
                    email: "member@example.test",
                    name: "Pavel Malý",
                },
            ]);
        await db()
            .insert(userAccessStates)
            .values(
                ["curator", "other", "member"].map((userId) => ({
                    userId,
                    issuer: mockEnv.OIDC_ISSUER_URL,
                    subject: userId,
                    capabilities:
                        userId === "member" ? ["use"] : ["use", "org.curate"],
                    verifiedAt: new Date(),
                    source: "login" as const,
                })),
            );
        await db()
            .insert(recordingFolders)
            .values([
                {
                    id: "orgroot",
                    userId: "org",
                    name: encryptText("Organization"),
                    nameHash: lookupHash("organization"),
                    kind: "public",
                },
                {
                    id: "team",
                    userId: "org",
                    parentId: "orgroot",
                    name: encryptText("Projects"),
                    nameHash: lookupHash("projects"),
                    kind: "custom",
                },
                {
                    id: "nested",
                    userId: "org",
                    parentId: "team",
                    name: encryptText("Nested"),
                    nameHash: lookupHash("nested"),
                    kind: "custom",
                },
                {
                    id: "outside",
                    userId: "org",
                    parentId: "orgroot",
                    name: encryptText("Outside"),
                    nameHash: lookupHash("outside"),
                    kind: "custom",
                },
            ]);
        for (const id of ["inside", "outside", "private"]) {
            await insertRecordings(db(), {
                id,
                userId: "member",
                deviceSn: "SN-1",
                plaudFileId: id,
                filename: encryptText(`Meeting ${id}`),
                duration: 60_000,
                startTime: new Date("2026-10-01T10:00:00Z"),
                endTime: new Date("2026-10-01T10:01:00Z"),
                filesize: 12,
                fileMd5: "0".repeat(32),
                storageType: "local",
                storagePath: `member/${id}.mp3`,
                storageFilename: `${id}.mp3`,
                plaudVersion: "1",
            });
            const [transcript] = await db()
                .insert(transcriptions)
                .values({
                    recordingId: id,
                    userId: "member",
                    text: encryptText(`words of ${id}`),
                    turns: encryptJsonField([
                        {
                            speaker: "speaker_0",
                            startMs: 0,
                            endMs: 60_000,
                            text: `words of ${id}`,
                        },
                    ]),
                    provider: "test",
                    model: "test",
                    source: "riffado",
                })
                .returning();
            if (id === "inside" && transcript) {
                await db()
                    .insert(transcriptCorrections)
                    .values({
                        userId: "org",
                        transcriptionId: transcript.id,
                        createdByUserId: "other",
                        kind: "fix",
                        transcriptRevision: 0,
                        turnIndex: 0,
                        charStart: 0,
                        charEnd: 5,
                        heardHmac: domainLookupHash(
                            "correction-heard",
                            "words",
                        ),
                        heard: encryptText("words"),
                        replacement: encryptText("Organization correction"),
                    });
            }
        }
        await db()
            .insert(recordingFolderAssignments)
            .values([
                { userId: "member", itemId: "inside", folderId: "nested" },
                { userId: "member", itemId: "outside", folderId: "outside" },
            ]);
        for (const userId of ["curator", "other", "org", "member"]) {
            await saveGoogleConnection(
                userId,
                {
                    subject: `subject-${userId}`,
                    email: `${userId}@example.test`,
                    emailVerified: true,
                    hostedDomain: "example.test",
                },
                {
                    accessToken: `token-${userId}`,
                    expiresInSeconds: 3600,
                    refreshToken: `refresh-${userId}`,
                    scopes: [
                        "openid",
                        "email",
                        "https://www.googleapis.com/auth/drive.file",
                    ],
                    idToken: null,
                },
            );
        }
    });

    async function states(exportId: string) {
        return db()
            .select()
            .from(folderExportMaterializations)
            .where(
                eq(
                    folderExportMaterializations.exportConfigurationId,
                    exportId,
                ),
            );
    }
    async function run(writer: string, exportId: string) {
        await planFolderExport(writer, exportId);
        for (const state of await states(exportId))
            await materializeFolderExport(writer, state.id);
    }

    it("refuses a member adding, changing or removing an Organization export (403)", async () => {
        const configuration = await createFolderExport(
            "curator",
            "team",
            selection,
        );
        expect(
            (await call(addExport, "member", "POST", undefined, selection))
                .status,
        ).toBe(403);
        expect(
            (
                await call(
                    changeExport,
                    "member",
                    "PATCH",
                    configuration.id,
                    selection,
                )
            ).status,
        ).toBe(403);
        expect(
            (await call(removeExport, "member", "DELETE", configuration.id))
                .status,
        ).toBe(403);
        expect(
            await db().select().from(folderExportConfigurations),
        ).toHaveLength(1);
    });

    it("adds through the API and writes a colleague's subtree through the writer's My Drive connection", async () => {
        const response = await call(
            addExport,
            "curator",
            "POST",
            undefined,
            selection,
        );
        expect(response.status).toBe(201);
        const { configuration } = await response.json();
        expect(configuration).toMatchObject({
            writer: { id: "curator", name: "Jitka Dvořáková" },
            canEdit: true,
            googleDrive: { driveId: null },
        });
        await run("curator", configuration.id);
        expect(
            new Set(
                (await states(configuration.id)).map((state) => state.itemId),
            ),
        ).toEqual(new Set(["inside"]));
        expect(drive.tree("picked")).toEqual([
            "Nested/",
            "Nested/Meeting inside/",
            "Nested/Meeting inside/audio.mp3",
            "Nested/Meeting inside/riffado.transcript.md",
        ]);
        expect(
            drive.contentAt(
                "picked",
                "Nested/Meeting inside/riffado.transcript.md",
            ),
        ).toContain("Organization correction");
        expect(await clientOptions.at(-1)?.getAccessToken()).toBe(
            "token-curator",
        );
        const settings = await db().select().from(googleDriveExportSettings);
        expect(settings[0]).toMatchObject({
            userId: "curator",
            accountSubject: "subject-curator",
            driveId: null,
        });
        expect(
            (await db().select().from(driveExportNodes)).every(
                (node) => node.userId === "curator",
            ),
        ).toBe(true);
        const content = [...drive.items.values()]
            .map((item) => item.content?.toString() ?? "")
            .join("\n");
        expect(content).not.toContain("words of private");
        expect(content).not.toContain("words of outside");
    });

    it("lists all writers to members, allows editing only one's own target, and curator removal preserves files", async () => {
        const configuration = await createFolderExport(
            "other",
            "team",
            selection,
        );
        await run("other", configuration.id);
        const tree = drive.tree("picked");
        const response = await call(listExports, "member", "GET");
        expect(response.status).toBe(200);
        expect((await response.json()).configured[0]).toMatchObject({
            writer: { id: "other", name: "Marek Novotný" },
            canEdit: false,
            canRemove: false,
        });
        await db()
            .update(users)
            .set({ name: null })
            .where(eq(users.id, "other"));
        expect(
            (await listFolderExports("member", "team")).configured[0]?.writer,
        ).toEqual({
            id: "other",
            name: "other@example.test",
        });
        const curatorView = await listFolderExports("curator", "team");
        expect(curatorView.configured[0]).toMatchObject({
            canEdit: false,
            canRemove: true,
        });
        expect(curatorView.applicableIds).toEqual([configuration.id]);
        expect(curatorView.synchronizableIds).toEqual([]);
        expect(
            (await listFolderExports("other", "team")).synchronizableIds,
        ).toEqual([configuration.id]);
        expect(
            (
                await call(changeExport, "curator", "PATCH", configuration.id, {
                    ...selection,
                    rootFolderId: "otherpicked",
                })
            ).status,
        ).toBe(404);
        expect(
            (
                await call(
                    changeExport,
                    "other",
                    "PATCH",
                    configuration.id,
                    selection,
                )
            ).status,
        ).toBe(200);
        const callsBefore = drive.calls.length;
        expect(
            (await call(removeExport, "curator", "DELETE", configuration.id))
                .status,
        ).toBe(200);
        expect(drive.calls).toHaveLength(callsBefore);
        expect(drive.tree("picked")).toEqual(tree);
        expect(await states(configuration.id)).toEqual([]);
        expect(await planFolderExport("other", configuration.id)).toBe(0);
    });

    it.each([
        "revoked",
        "left",
        "disabled",
    ])("stops planning, queued writes and reconciliation when the writer is %s", async (reason) => {
        const configuration = await createFolderExport(
            "curator",
            "team",
            selection,
        );
        await planFolderExport("curator", configuration.id);
        const pending = await states(configuration.id);
        expect(pending.length).toBeGreaterThan(0);
        const written = pending.find((state) => state.artifactType === "audio");
        expect(
            await materializeFolderExport("curator", written?.id ?? ""),
        ).toBe(true);
        const treeBefore = drive.tree("picked");
        const queued = pending.find(
            (state) => state.artifactType === "transcript",
        );
        if (reason === "left")
            await db()
                .delete(userAccessStates)
                .where(eq(userAccessStates.userId, "curator"));
        else
            await db()
                .update(userAccessStates)
                .set({
                    capabilities:
                        reason === "revoked" ? ["use"] : ["use", "org.curate"],
                    status: reason === "disabled" ? "disabled" : "active",
                })
                .where(eq(userAccessStates.userId, "curator"));
        const callsBefore = drive.calls.length;
        await expect(
            materializeFolderExport("curator", queued?.id ?? ""),
        ).rejects.toMatchObject({ statusCode: 403 });
        await expect(
            planFolderExport("curator", configuration.id),
        ).rejects.toMatchObject({ statusCode: 403 });
        await expect(
            reconcileFolderExport("curator", "team"),
        ).rejects.toMatchObject({ statusCode: 403 });
        expect(drive.calls).toHaveLength(callsBefore);
        expect(
            (await listFolderExports("other", "team")).configured[0],
        ).toMatchObject({
            stoppedReason: "writer_no_longer_curator",
            canEdit: false,
            canRemove: true,
        });
        expect(
            (await listFolderExports("member", "team")).configured[0]
                ?.stoppedReason,
        ).toBeNull();
        expect(drive.tree("picked")).toEqual(treeBefore);
        expect(drive.tree("picked")).toContain(
            "Nested/Meeting inside/audio.mp3",
        );
        expect(drive.tree("picked")).not.toContain(
            "Nested/Meeting inside/riffado.transcript.md",
        );
    });

    it("rechecks placement at write time when an item moves out of the subtree", async () => {
        const configuration = await createFolderExport(
            "curator",
            "team",
            selection,
        );
        await planFolderExport("curator", configuration.id);
        await db()
            .update(recordingFolderAssignments)
            .set({ folderId: "outside" })
            .where(
                and(
                    eq(recordingFolderAssignments.userId, "member"),
                    eq(recordingFolderAssignments.itemId, "inside"),
                ),
            );
        const callsBefore = drive.calls.length;
        for (const state of await states(configuration.id))
            expect(await materializeFolderExport("curator", state.id)).toBe(
                false,
            );
        expect(drive.calls).toHaveLength(callsBefore);
    });

    it("keeps Organization-account scope and personal owner-only scope", async () => {
        expect(await resolveArchiveScope("curator")).toEqual({
            kind: "personal",
            userId: "curator",
        });
        expect(await resolveArchiveScope("org")).toEqual({
            kind: "organization",
            orgUserId: "org",
        });
        const orgExport = await createFolderExport("org", "team", selection);
        await run("org", orgExport.id);
        expect(
            drive.contentAt(
                "picked",
                "Nested/Meeting inside/riffado.transcript.md",
            ),
        ).toContain("Organization correction");
        await ensureRootFolders("member");
        const personal = await listPersonalFolderOrganization("member");
        const root = personal.folders.find(
            (folder) => folder.kind === "private",
        );
        const personalExport = await createFolderExport(
            "member",
            root?.id ?? "",
            { ...selection, rootFolderId: "otherpicked" },
        );
        await run("member", personalExport.id);
        expect(
            drive.contentAt(
                "otherpicked",
                "Meeting inside/riffado.transcript.md",
            ),
        ).toContain("words of inside");
        expect(
            drive.contentAt(
                "otherpicked",
                "Meeting inside/riffado.transcript.md",
            ),
        ).not.toContain("Organization correction");
        expect(
            new Set(
                (await states(personalExport.id)).map((state) => state.itemId),
            ),
        ).toEqual(new Set(["inside", "outside", "private"]));
    });

    it("queues curator exports with Organization changes and isolates private configuration reads", async () => {
        const configuration = await createFolderExport(
            "curator",
            "team",
            selection,
        );
        await db().delete(asyncJobs);
        await enqueueExportPlansForUser("org");
        expect(await db().select().from(asyncJobs)).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    userId: "curator",
                    payload: { exportId: configuration.id },
                }),
            ]),
        );
        await ensureRootFolders("other");
        const personal = await listPersonalFolderOrganization("other");
        const rootId =
            personal.folders.find((folder) => folder.kind === "private")?.id ??
            "";
        expect(
            (
                await call(
                    listExports,
                    "curator",
                    "GET",
                    undefined,
                    undefined,
                    rootId,
                )
            ).status,
        ).toBe(404);
        expect(
            (
                await call(
                    addExport,
                    "curator",
                    "POST",
                    undefined,
                    selection,
                    rootId,
                )
            ).status,
        ).toBe(404);
        await db()
            .update(chatterItems)
            .set({ deletedAt: new Date() })
            .where(eq(chatterItems.id, "inside"));
        await planFolderExport("curator", configuration.id);
        expect(await states(configuration.id)).toEqual([]);
    });
});
