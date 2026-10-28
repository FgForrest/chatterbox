import { DELETE as deleteRecording } from "@/app/api/recordings/[id]/route";
import {
    folderDefaultProfiles,
    processingProfileRevisions,
    processingProfiles,
    userSettings,
} from "@/db/schema";
import { AppError, ErrorCode } from "@/lib/errors";
import {
    agendaSuggestionsAvailability,
    agendaSuggestionsProvider,
} from "@/lib/meetings/suggestions-provider";
import { resolveProfileForPlacements } from "@/lib/profiles/resolve-for-placement";
import { defaultProfileSettings } from "@/lib/profiles/settings";
import { createProfile, getDefaultProfile } from "@/lib/profiles/store";
import { localActor } from "@/tests/helpers/session-actor";

const providers = vi.hoisted(() => ({
    resolve: vi.fn(async () => ({
        kind: "credential",
        credential: { id: "mock" },
    })),
}));
vi.mock("@/lib/profiles/providers", () => ({
    resolveStepProviderSelection: providers.resolve,
}));
vi.mock("@/lib/ai/enhancement-provider", () => ({
    enhancementChatModel: () => "model",
}));

import { and, eq } from "drizzle-orm";
import type * as NextServer from "next/server";
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
    aiEnhancements,
    chatterItems,
    folderShares,
    meetingAgendas,
    recordingFolderAssignments,
    recordingFolders,
    recordingTasks,
    users,
} from "@/db/schema";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { requireRecordingAccess } from "@/lib/sharing/access";
import { insertRecordings } from "@/tests/integration/items";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const background = vi.hoisted(() => ({ jobs: [] as (() => Promise<void>)[] }));
vi.mock("next/server", async (original) => ({
    ...(await original<typeof NextServer>()),
    after: (job: () => Promise<void>) => background.jobs.push(job),
}));
vi.mock("@/lib/mcp/audit", () => ({ recordMcpAccess: vi.fn() }));
const { ref, proxy } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    return {
        ref,
        proxy: new Proxy(
            {},
            {
                get(_target, key) {
                    if (!ref.current) throw new Error("Database not ready");
                    const value = ref.current[key];
                    return typeof value === "function"
                        ? value.bind(ref.current)
                        : value;
                },
            },
        ),
    };
});
vi.mock("@/db", () => ({ db: proxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({
    env: {
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        BETTER_AUTH_SECRET: "meeting-test",
        AUTHZ_MODE: "local",
        IS_HOSTED: false,
        GOOGLE_CLIENT_ID: "test",
        GOOGLE_CLIENT_SECRET: "test",
        APP_URL: "https://example.com",
    },
}));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: async () => "org",
    isOrgAccount: async (id: string) => id === "org",
    isOrgScopeVisible: () => true,
    isOrgScopeEnabled: () => true,
    assertOrgScopeWritable: () => undefined,
    assertNotOrgAccount: async () => undefined,
}));
vi.mock("@/lib/authz/curator", () => ({
    userCuratesOrganizationNow: async (id: string) =>
        id === "curator" || id === "org",
    actsForOrganization: async () => false,
}));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: async () => undefined,
}));
const calendar = vi.hoisted(() => ({
    read: vi.fn(),
    upcoming: vi.fn(),
    connection: vi.fn(),
}));
vi.mock("@/lib/integrations/google/calendar-events", () => ({
    getCalendarEvent: calendar.read,
    listUpcomingCalendarEvents: calendar.upcoming,
}));
vi.mock("@/lib/integrations/google/connection", () => ({
    getGoogleConnectionStatus: calendar.connection,
}));
const eventFor = (userId: string, id: string) => ({
    id,
    title: "Acme meeting",
    start: "2026-11-03T10:00:00Z",
    end: "2026-11-03T11:00:00Z",
    recurringEventId: "series",
    attendees: [{ name: "Jitka Dvořáková", email: "jitka@example.com" }],
    organizer: { self: userId === "owner", email: "marek@example.com" },
    meetingCode: "abc-defg-hij",
});
const principal = vi.hoisted(() => ({ userId: "owner" }));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async () => ({ user: { id: principal.userId } }),
}));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));
vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: async () => ({
        deleteFile: async () => undefined,
    }),
}));
vi.mock("@/lib/webhooks/emit", () => ({ emitEvent: async () => undefined }));
vi.mock("@/lib/events/personal", () => ({
    notifyPersonShareChanged: async () => undefined,
}));
vi.mock("@/lib/notifications/person-share", () => ({
    sendPersonShareInvitation: async () => undefined,
}));
vi.mock("@/lib/export/document-sidecars", () => ({
    refreshExistingRecordingSidecars: async () => undefined,
    exportRecordingSidecarsIfEnabled: async () => undefined,
}));
vi.mock("@/lib/recording-sessions/route-gate", () => ({
    gateRecordingSessionRequest: async () => ({
        authn: { user: { id: principal.userId }, apiKeyId: "key" },
    }),
}));
vi.mock("@/lib/recording-sessions/finalize-job", () => ({
    enqueueRecordingSessionFinalize: async () => ({ job: { id: "job" } }),
}));

import { db } from "@/db";
import { writeSummaryAgenda } from "@/db/queries/agenda-pipeline";
import { collectArchivedMeetings } from "@/lib/export/meetings";
import { attachAgenda, detachAgenda } from "@/lib/meetings/attachment";
import { restoreMeetings } from "@/lib/meetings/restore";
import {
    addPoint,
    changeAgendaTask,
    getMeeting,
    patchMeeting,
    prepareMeeting,
    removeMeetingFromFolder,
} from "@/lib/meetings/service";
import { tasksForArchive } from "@/lib/tasks/archive";

const databaseUrl = getTestDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const start = new Date("2026-11-03T10:00:00Z");

suite("meeting planning server (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            databaseUrl ?? "",
            "meeting_planning",
        );
        ref.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120000);
    afterAll(async () => {
        ref.current = null;
        await database?.dispose();
    }, 60000);
    beforeEach(async () => {
        principal.userId = "owner";
        calendar.read
            .mockReset()
            .mockImplementation(async (userId: string, id: string) =>
                eventFor(userId, id),
            );
        calendar.upcoming.mockReset().mockResolvedValue([]);
        calendar.connection
            .mockReset()
            .mockImplementation(async (userId: string) => ({
                status: "active",
                email: `${userId}@example.com`,
                scopes: [
                    "https://www.googleapis.com/auth/calendar.events.readonly",
                ],
            }));
        await db.delete(users);
        await db.insert(users).values(
            ["owner", "other", "curator", "stranger", "org"].map((id) => ({
                id,
                email: `${id}@example.com`,
                name: id,
                role: id === "org" ? ("org" as const) : ("user" as const),
            })),
        );
        await db.insert(recordingFolders).values(
            ["owner", "org", "other"].flatMap((userId) => [
                {
                    id: `${userId}-root`,
                    userId,
                    parentId: null,
                    kind:
                        userId === "org"
                            ? ("public" as const)
                            : ("private" as const),
                    name: encryptText("Root"),
                    nameHash: lookupHash("Root"),
                },
                {
                    id: `${userId}-folder`,
                    userId,
                    parentId: `${userId}-root`,
                    kind: "custom" as const,
                    name: encryptText("Acme"),
                    nameHash: lookupHash("Acme"),
                },
            ]),
        );
    });
    const create = (folderId = "owner-folder", title = "Acme") =>
        prepareMeeting("owner", {
            folderId,
            title,
            start: start.toISOString(),
            end: new Date(start.getTime() + 3600000).toISOString(),
        });
    async function recording(id: string, folderId?: string, userId = "owner") {
        await insertRecordings(database.db, {
            id,
            userId,
            filename: encryptText("Recording"),
            startTime: start,
            endTime: new Date(start.getTime() + 3600000),
            duration: 3600000,
            filesize: 1,
            fileMd5: "a".repeat(32),
            storageType: "local",
            storagePath: `${id}.ogg`,
            deviceSn: "test",
            plaudFileId: id,
            plaudVersion: "1",
        });
        if (folderId)
            await db
                .insert(recordingFolderAssignments)
                .values({ userId, itemId: id, folderId });
    }

    it.each([
        "detach",
        "delete",
    ] as const)("clears private recording outcomes when restoring an agenda through %s", async (path) => {
        const meeting = await create("org-folder");
        const point = await addPoint("owner", meeting.id, { text: "Plan" });
        await recording(
            "rec",
            undefined,
            path === "delete" ? "curator" : "owner",
        );
        await attachAgenda(
            path === "delete" ? "curator" : "owner",
            meeting.id,
            "rec",
        );
        const [agenda] = await db.select().from(meetingAgendas);
        await db.insert(aiEnhancements).values({
            id: "summary",
            itemId: "rec",
            userId: path === "delete" ? "curator" : "owner",
            source: "riffado",
            provider: "test",
            model: "test",
            summary: encryptText("Summary"),
        });
        await db.transaction((tx) =>
            writeSummaryAgenda(
                tx,
                {
                    id: agenda.id,
                    userId: agenda.userId,
                    version: agenda.version,
                    outcome: {
                        covered: [point.id],
                        notCovered: [],
                        unplanned: ["Confidential transcript topic"],
                    },
                },
                "summary",
            ),
        );
        expect(await getMeeting("other", meeting.id)).not.toHaveProperty(
            "outcomeUnplanned",
        );
        if (path === "delete") {
            principal.userId = "curator";
            const response = await deleteRecording(
                new Request("https://example.com/api/recordings/rec", {
                    method: "DELETE",
                }),
                { params: Promise.resolve({ id: "rec" }) },
            );
            expect(response.status).toBe(200);
        } else {
            await detachAgenda("owner", "rec");
            const [summary] = await db
                .select()
                .from(aiEnhancements)
                .where(eq(aiEnhancements.id, "summary"));
            expect(decryptText(summary.summary ?? "")).toBe("Summary");
        }
        await expect(
            requireRecordingAccess("other", "rec"),
        ).rejects.toMatchObject({ statusCode: 404 });
        expect(await getMeeting("other", meeting.id)).toMatchObject({
            recordingItemId: null,
            outcomeUnplanned: [],
            outcomeSummaryId: null,
            points: [{ summaryOutcome: null }],
        });
    });

    it("excludes private task notes and source pointers from a colleague's personal archive", async () => {
        await recording("private-task-recording");
        await db.insert(recordingTasks).values({
            id: "private-task",
            userId: "owner",
            itemId: "private-task-recording",
            text: encryptText("Confidential task"),
            status: "open",
            source: "manual",
            position: 0,
        });
        await db.insert(folderShares).values({
            userId: "owner",
            receiverUserId: "other",
            folderId: "owner-folder",
            state: "accepted",
        });
        const meeting = await create();
        await patchMeeting("owner", meeting.id, {
            taskSourceItemId: "private-task-recording",
        });
        await changeAgendaTask("owner", meeting.id, "private-task", {
            note: "Confidential agenda task note",
        });
        await recording("colleague-recording", undefined, "other");
        await attachAgenda("other", meeting.id, "colleague-recording");
        expect(await getMeeting("other", meeting.id)).toMatchObject({
            tasks: [],
        });
        await expect(
            requireRecordingAccess("other", "private-task-recording"),
        ).rejects.toMatchObject({ statusCode: 404 });
        const archive = await collectArchivedMeetings({
            kind: "personal",
            userId: "other",
        });
        expect(archive).toMatchObject([
            { tasks: [], taskSourceItemId: null, snapshotSourceItemId: null },
        ]);
    });

    it("excludes private task notes and source pointers from an Organization archive", async () => {
        await recording("private-task-recording");
        await db.insert(recordingTasks).values({
            id: "private-task",
            userId: "owner",
            itemId: "private-task-recording",
            text: encryptText("Confidential task"),
            status: "open",
            source: "manual",
            position: 0,
        });
        const meeting = await create("org-folder");
        await patchMeeting("owner", meeting.id, {
            taskSourceItemId: "private-task-recording",
        });
        await changeAgendaTask("owner", meeting.id, "private-task", {
            note: "Confidential agenda task note",
        });
        expect(await getMeeting("org", meeting.id)).toMatchObject({
            tasks: [],
        });
        const archive = await collectArchivedMeetings({
            kind: "organization",
            orgUserId: "org",
        });
        expect(archive).toMatchObject([
            { tasks: [], taskSourceItemId: null, snapshotSourceItemId: null },
        ]);
    });
    it("uses the clicking contributor's local profile and preserves the folder owner's binding", async () => {
        const localSettings = defaultProfileSettings("audio");
        localSettings.steps.summary.provider = {
            scope: "personal",
            credentialId: "own-local-provider",
        };
        const own = await createProfile({
            ownerUserId: "owner",
            actor: localActor("owner"),
            scope: "personal",
            channel: "audio",
            name: "Own local profile",
            settings: localSettings,
            isDefault: true,
        });
        await db
            .insert(userSettings)
            .values({ userId: "owner", defaultAudioProfileId: own.id })
            .onConflictDoUpdate({
                target: userSettings.userId,
                set: { defaultAudioProfileId: own.id },
            });
        const cloudSettings = defaultProfileSettings("audio");
        cloudSettings.steps.summary.provider = {
            scope: "organization",
            credentialId: "org-cloud-provider",
        };
        await db.insert(processingProfiles).values({
            id: "org-profile",
            ownerUserId: "org",
            scope: "organization",
            channel: "audio",
            name: encryptText("Org cloud profile"),
            currentRevisionId: "org-revision",
            createdBy: "org",
            updatedBy: "org",
        });
        await db.insert(processingProfileRevisions).values({
            id: "org-revision",
            profileId: "org-profile",
            settings: encryptText(JSON.stringify(cloudSettings)),
            createdBy: "org",
        });
        await db.insert(folderDefaultProfiles).values({
            folderId: "other-folder",
            channel: "audio",
            profileId: "org-profile",
        });
        await db.insert(folderShares).values({
            userId: "other",
            receiverUserId: "owner",
            folderId: "other-folder",
            state: "accepted",
        });
        const meeting = await create("other-folder");
        expect(
            await getDefaultProfile("owner", "audio", "owner", { seed: false }),
        ).toMatchObject({
            id: own.id,
            settings: {
                steps: {
                    summary: {
                        provider: { credentialId: "own-local-provider" },
                    },
                },
            },
        });
        expect(
            await agendaSuggestionsProvider("owner", meeting.id),
        ).toMatchObject({
            pin: { scope: "personal", credentialId: "own-local-provider" },
        });
        await db
            .delete(folderDefaultProfiles)
            .where(eq(folderDefaultProfiles.folderId, "other-folder"));
        expect(
            await agendaSuggestionsProvider("owner", meeting.id),
        ).toMatchObject({
            pin: { scope: "personal", credentialId: "own-local-provider" },
        });
        await db.insert(folderDefaultProfiles).values([
            {
                folderId: "other-folder",
                channel: "audio",
                profileId: "org-profile",
            },
            {
                folderId: "org-folder",
                channel: "audio",
                profileId: "org-profile",
            },
        ]);
        const orgMeeting = await create("org-folder");
        expect(
            await agendaSuggestionsProvider("owner", orgMeeting.id),
        ).toMatchObject({
            pin: { scope: "organization", credentialId: "org-cloud-provider" },
        });
        const ownerMeeting = await prepareMeeting("other", {
            folderId: "other-folder",
            title: "Owner meeting",
        });
        expect(
            await agendaSuggestionsProvider("other", ownerMeeting.id),
        ).toMatchObject({
            pin: { scope: "organization", credentialId: "org-cloud-provider" },
        });
    });

    it("uses the owner's configured private summary profile after the last folder is removed", async () => {
        const settings = defaultProfileSettings("audio");
        settings.steps.summary.provider = {
            scope: "personal",
            credentialId: "owner-local",
        };
        const own = await createProfile({
            ownerUserId: "owner",
            actor: localActor("owner"),
            scope: "personal",
            channel: "audio",
            name: "Local profile",
            settings,
            isDefault: true,
        });
        await db
            .insert(userSettings)
            .values({ userId: "owner", defaultAudioProfileId: own.id })
            .onConflictDoUpdate({
                target: userSettings.userId,
                set: { defaultAudioProfileId: own.id },
            });
        const meeting = await create();
        await addPoint("owner", meeting.id, { text: "Keep this plan" });
        await removeMeetingFromFolder("owner", meeting.id, "owner-folder");
        const unfiledRecording = await resolveProfileForPlacements({
            ownerUserId: "owner",
            itemId: "unfiled-audio",
            channel: "audio",
            folderIds: [],
            view: "private",
            seedProfiles: false,
            executor: db,
            organizationUserId: "org",
            ignoreItemAssignment: true,
        });
        expect(unfiledRecording).toMatchObject({
            status: "resolved",
            profile: { id: own.id },
        });
        const provider = await agendaSuggestionsProvider("owner", meeting.id);
        expect(provider).toMatchObject({
            folders: [],
            pin: settings.steps.summary.provider,
        });
        expect(
            await agendaSuggestionsAvailability("owner", meeting.id),
        ).toEqual({ available: true, reason: null });
        await expect(
            agendaSuggestionsProvider("other", meeting.id),
        ).rejects.toMatchObject({ statusCode: 404 });
        providers.resolve.mockClear();
        providers.resolve.mockRejectedValueOnce(
            new AppError(
                ErrorCode.AI_PROVIDER_NOT_CONFIGURED,
                "Pinned provider unavailable",
                400,
            ),
        );
        expect(
            await agendaSuggestionsAvailability("owner", meeting.id),
        ).toMatchObject({
            available: false,
            reason: "Pinned provider unavailable",
        });
        expect(providers.resolve).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                actorUserId: "owner",
                pin: settings.steps.summary.provider,
            }),
        );
    });
    it("keeps unfiled suggestions unavailable when no usable profile remains", async () => {
        const meeting = await create();
        await removeMeetingFromFolder("owner", meeting.id, "owner-folder");
        await db.update(processingProfiles).set({ archivedAt: new Date() });
        providers.resolve.mockClear();
        expect(
            await agendaSuggestionsAvailability("owner", meeting.id),
        ).toMatchObject({
            available: false,
            errorCode: ErrorCode.CONFLICT,
        });
        expect(providers.resolve).not.toHaveBeenCalled();
    });
    it.each([
        "personal",
        "organization",
    ] as const)("round-trips task notes and source pointers included in the %s archive", async (kind) => {
        await recording("task-recording", "org-folder");
        await db.insert(recordingTasks).values([
            {
                id: "own-task",
                userId: "owner",
                createdByUserId: "owner",
                itemId: "task-recording",
                text: encryptText("Own task"),
                status: "open",
                source: "manual",
                position: 0,
            },
            {
                id: "org-task",
                userId: "owner",
                createdByUserId: "org",
                itemId: "task-recording",
                text: encryptText("Organization task"),
                status: "open",
                source: "manual",
                position: 1,
            },
        ]);
        const meeting = await create("org-folder");
        await patchMeeting("owner", meeting.id, {
            taskSourceItemId: "task-recording",
        });
        await changeAgendaTask("owner", meeting.id, "own-task", {
            note: "Retain this note",
        });
        await changeAgendaTask("owner", meeting.id, "org-task", {
            note: "Organization note",
            removed: true,
        });
        const scope =
            kind === "personal"
                ? ({ kind, userId: "owner" } as const)
                : ({ kind, orgUserId: "org" } as const);
        const archive = await collectArchivedMeetings(scope);
        const taskIds = (
            await tasksForArchive(scope, ["task-recording"], {
                proposals: true,
            })
        )
            .get("task-recording")
            ?.map((task) => task.id);
        expect(archive).toMatchObject([
            {
                taskSourceItemId: "task-recording",
                snapshotSourceItemId: "task-recording",
            },
        ]);
        expect(archive[0].tasks.map((task) => task.taskId)).toEqual(taskIds);
        expect(taskIds).toEqual(
            kind === "personal" ? ["own-task"] : ["own-task", "org-task"],
        );
        await db
            .delete(meetingAgendas)
            .where(
                and(
                    eq(meetingAgendas.id, meeting.id),
                    eq(meetingAgendas.userId, "owner"),
                ),
            );
        await db
            .delete(chatterItems)
            .where(
                and(
                    eq(chatterItems.id, archive[0].meetingItemId ?? ""),
                    eq(chatterItems.userId, "owner"),
                ),
            );
        const restored = await restoreMeetings(
            kind === "personal" ? "owner" : "org",
            {
                meetings: archive,
                itemIdMap: { "task-recording": "task-recording" },
                folderIdMap:
                    kind === "organization"
                        ? { "org-folder": "org-folder" }
                        : {},
                taskIdMap: { "own-task": "own-task", "org-task": "org-task" },
            },
        );
        expect(restored.skipped).toEqual([]);
        expect(restored.restored).toHaveLength(1);
        const result = await collectArchivedMeetings(scope);
        expect(result).toMatchObject([
            {
                taskSourceItemId: "task-recording",
                snapshotSourceItemId: "task-recording",
                tasks: archive[0].tasks.map(
                    ({ taskId, note, removedAt, origin, position }) => ({
                        taskId,
                        note,
                        removedAt,
                        origin,
                        position,
                    }),
                ),
            },
        ]);
    });
});
