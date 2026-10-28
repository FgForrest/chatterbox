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
    agendaPoints,
    agendaSuggestions,
    agendaTasks,
    apiKeys,
    chatterItems,
    folderShares,
    itemProcessing,
    itemShares,
    mailPendingShares,
    meetingAgendas,
    receivedFolderAttachments,
    recordingFolderAssignments,
    recordingFolders,
    recordingSessionChunks,
    recordingSessions,
    recordings,
    recordingTasks,
    users,
} from "@/db/schema";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { restoreMeetings } from "@/lib/meetings/restore";
import { insertRecordings } from "@/tests/integration/items";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

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

import { GET as readMeeting } from "@/app/api/meetings/[id]/route";
import { DELETE as deleteRecording } from "@/app/api/recordings/[id]/route";
import { POST as completeSession } from "@/app/api/v1/recording-sessions/[id]/complete/route";
import { GET as meetingLink } from "@/app/meetings/[id]/route";
import { db } from "@/db";
import { markRecordingDeleted } from "@/db/items";
import { folderKnowledgeContext } from "@/db/queries/folder-knowledge";
import {
    isItemReceived,
    receivedItemCondition,
} from "@/db/queries/item-shares";
import { holdOverdueMeetings } from "@/db/queries/meetings";
import { readItemContent } from "@/lib/content/read-item-content";
import { collectArchivedMeetings } from "@/lib/export/meetings";
import { addRecordingToFolder } from "@/lib/folders/folders";
import { requireMeetingAccess } from "@/lib/meetings/access";
import {
    agendaCandidates,
    attachAgenda,
    attachArrivingRecordingInTx,
    detachAgenda,
} from "@/lib/meetings/attachment";
import {
    matchRecorderAgendas,
    meetingCalendarEvents,
} from "@/lib/meetings/calendar";
import { readMeetingCalendarSnapshot } from "@/lib/meetings/calendar-snapshot";
import { meetingMarkdown } from "@/lib/meetings/export";
import {
    addPoint,
    changeAgendaTask,
    changePoint,
    decideSuggestion,
    getMeeting,
    listMeetings,
    meetingFolderPaths,
    patchMeeting,
    prepareMeeting,
} from "@/lib/meetings/service";
import { requestArrivalInTx } from "@/lib/pipeline/arrival";
import { requestAdvance } from "@/lib/pipeline/trigger";
import {
    createRecordingSession,
    markRecordingSessionCompleted,
    markRecordingSessionCompleting,
} from "@/lib/recording-sessions/store";
import { searchApp } from "@/lib/search/app-search";
import {
    changePersonShare,
    inviteToItem,
    listMyInvitations,
} from "@/lib/sharing/person-shares";
import { restoreArchivedItemShares } from "@/lib/sharing/restore-shares";
import { taskViewerById } from "@/lib/tasks/access";
import { mergeTaskIntoTask, updateTask } from "@/lib/tasks/tasks";

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

    it("keeps private meetings private and encrypts their content", async () => {
        const meeting = await create();
        expect(
            (await requireMeetingAccess("owner", meeting.id, "manage"))
                .permissions.manage,
        ).toBe(true);
        await expect(
            requireMeetingAccess("stranger", meeting.id),
        ).rejects.toMatchObject({ statusCode: 404 });
        const point = await addPoint("owner", meeting.id, {
            text: "Jitka Dvořáková",
        });
        const [stored] = await db
            .select()
            .from(agendaPoints)
            .where(eq(agendaPoints.id, point.id));
        expect(stored.text).not.toContain("Jitka");
        expect(decryptText(stored.text)).toBe("Jitka Dvořáková");
        const results = await searchApp(
            await taskViewerById("owner"),
            "chatter",
            "Acme",
        );
        const meetingItemId = (await requireMeetingAccess("owner", meeting.id))
            .item.id;
        expect(
            results.chatter.find((hit) => hit.id === meetingItemId)?.href,
        ).toBe(`/meetings/${meetingItemId}`);
        expect(
            await readItemContent(
                "owner",
                (await requireMeetingAccess("owner", meeting.id)).item.id,
            ),
        ).toBeNull();
    });

    it("co-edits Organization meetings, reserves management for the author and curators", async () => {
        const meeting = await create("org-folder");
        expect(
            (await requireMeetingAccess("other", meeting.id, "edit"))
                .permissions.manage,
        ).toBe(false);
        await expect(
            requireMeetingAccess("other", meeting.id, "manage"),
        ).rejects.toMatchObject({ statusCode: 403 });
        expect(
            (await requireMeetingAccess("curator", meeting.id, "manage"))
                .permissions.manage,
        ).toBe(true);
        const own = await addPoint("other", meeting.id, { text: "Own point" });
        await expect(
            changePoint("stranger", meeting.id, own.id, {
                text: "Wrong author",
                version: 0,
            }),
        ).rejects.toMatchObject({ statusCode: 403 });
        await changePoint("other", meeting.id, own.id, {
            text: "Updated",
            version: 0,
        });
        await expect(
            changePoint("other", meeting.id, own.id, {
                text: "Stale",
                version: 0,
            }),
        ).rejects.toMatchObject({
            statusCode: 409,
            details: { point: { text: "Updated", version: 1 } },
        });
        await changePoint("owner", meeting.id, own.id, {
            discussed: true,
            note: "A hint",
            version: 1,
        });
    });

    it("uses accepted direct-folder person sharing and revokes edits immediately", async () => {
        const meeting = await create();
        await db.insert(folderShares).values({
            userId: "owner",
            receiverUserId: "other",
            folderId: "owner-folder",
            state: "accepted",
        });
        await addPoint("other", meeting.id, { text: "Shared point" });
        await expect(
            requireMeetingAccess("other", meeting.id, "manage"),
        ).rejects.toMatchObject({ statusCode: 403 });
        await db
            .update(folderShares)
            .set({ state: "removed" })
            .where(eq(folderShares.receiverUserId, "other"));
        await expect(
            addPoint("other", meeting.id, { text: "After revocation" }),
        ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("rejects cycles and moves of subtrees beyond three levels", async () => {
        const meeting = await create();
        const a = await addPoint("owner", meeting.id, { text: "a" });
        const b = await addPoint("owner", meeting.id, {
            text: "b",
            parentId: a.id,
        });
        const c = await addPoint("owner", meeting.id, {
            text: "c",
            parentId: b.id,
        });
        await expect(
            changePoint("owner", meeting.id, a.id, {
                parentId: c.id,
                version: 0,
            }),
        ).rejects.toMatchObject({ statusCode: 400 });
        await expect(
            addPoint("owner", meeting.id, { text: "d", parentId: c.id }),
        ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("deduplicates concurrent visible Calendar event creates", async () => {
        const results = await Promise.all([
            prepareMeeting("owner", {
                folderId: "owner-folder",
                calendarEventId: "event",
            }),
            prepareMeeting("owner", {
                folderId: "owner-folder",
                calendarEventId: "event",
            }),
        ]);
        expect(results[0].id).toBe(results[1].id);
        expect(results.filter((result) => result.existing)).toHaveLength(1);
    });

    it("returns an existing absorbed agenda for its visible event", async () => {
        const meeting = await prepareMeeting("owner", {
            folderId: "owner-folder",
            calendarEventId: "event",
        });
        await recording("rec", "owner-folder");
        await attachAgenda("owner", meeting.id, "rec");
        const result = await prepareMeeting("owner", {
            folderId: "owner-folder",
            calendarEventId: "event",
        });
        expect(result.id).toBe(meeting.id);
        expect(result.existing).toBe(true);
    });

    it("snapshots open and done tasks and resnapshots only on a source switch", async () => {
        await recording("old", "owner-folder");
        await db
            .update(chatterItems)
            .set({ occurredAt: new Date(start.getTime() - 86400000) })
            .where(eq(chatterItems.id, "old"));
        await db.insert(recordingTasks).values(
            ["open", "done"].map((status) => ({
                id: status,
                itemId: "old",
                userId: "owner",
                status: status as "open" | "done",
                source: "manual" as const,
                text: encryptText(status),
            })),
        );
        const meeting = await create();
        expect(await db.select().from(agendaTasks)).toHaveLength(2);
        await db.insert(recordingTasks).values({
            id: "later",
            itemId: "old",
            userId: "owner",
            status: "open",
            source: "manual",
            text: encryptText("Later"),
        });
        expect(await db.select().from(agendaTasks)).toHaveLength(2);
        await patchMeeting("owner", meeting.id, { taskSourceItemId: "old" });
        expect(await db.select().from(agendaTasks)).toHaveLength(3);
        await db.insert(recordingTasks).values({
            id: "after-switch",
            itemId: "old",
            userId: "owner",
            status: "open",
            source: "manual",
            text: encryptText("After switch"),
        });
        await patchMeeting("owner", meeting.id, {
            taskSourceItemId: "old",
            title: "Renamed",
        });
        expect(await db.select().from(agendaTasks)).toHaveLength(3);
        const before = await getMeeting("owner", meeting.id);
        if (before.unchanged) throw new Error("Missing detail");
        await db
            .update(recordingTasks)
            .set({ status: "done", updatedAt: new Date(Date.now() + 10) })
            .where(eq(recordingTasks.id, "later"));
        const refreshed = await getMeeting("owner", meeting.id, before.version);
        expect(refreshed.unchanged).toBe(false);
        if (!refreshed.unchanged)
            expect(
                refreshed.tasks.find((task) => task.id === "later")?.status,
            ).toBe("done");
    });

    it("auto-attaches a single owned match in the same folder and detaches it", async () => {
        const meeting = await create();
        await recording("rec", "owner-folder");
        await db.transaction((tx) =>
            attachArrivingRecordingInTx(tx, "owner", "rec", "rec"),
        );
        const access = await requireMeetingAccess("owner", meeting.id);
        expect(access.agenda.recordingItemId).toBe("rec");
        await expect(
            addPoint("owner", meeting.id, { text: "Read only" }),
        ).rejects.toMatchObject({ statusCode: 409 });
        expect((await getMeeting("owner", meeting.id)).unchanged).toBe(false);
        await detachAgenda("owner", "rec");
        expect(
            (await requireMeetingAccess("owner", meeting.id)).agenda
                .recordingItemId,
        ).toBeNull();
    });

    it("never auto-shares an unfiled recording into an Organization folder", async () => {
        const meeting = await create("org-folder");
        await recording("rec");
        await db.transaction((tx) =>
            attachArrivingRecordingInTx(tx, "owner", "rec", "rec"),
        );
        expect(
            (await requireMeetingAccess("owner", meeting.id)).agenda
                .recordingItemId,
        ).toBeNull();
        expect((await agendaCandidates("owner", "rec"))[0]).toMatchObject({
            widensSharing: true,
            audience: { organization: true },
        });
        await expect(
            addRecordingToFolder({
                userId: "owner",
                recordingId: "rec",
                folderId: "org-folder",
            }),
        ).rejects.toMatchObject({ statusCode: 409 });
        await attachAgenda("owner", meeting.id, "rec");
        expect(
            (await requireMeetingAccess("other", meeting.id)).agenda
                .recordingItemId,
        ).toBe("rec");
    });

    it("never auto-shares into a private folder with accepted person invitations", async () => {
        const meeting = await create();
        await db.insert(folderShares).values({
            userId: "owner",
            receiverUserId: "other",
            folderId: "owner-folder",
            state: "accepted",
        });
        await recording("rec");
        await db.transaction((tx) =>
            attachArrivingRecordingInTx(tx, "owner", "rec", "rec"),
        );
        expect(
            (await requireMeetingAccess("owner", meeting.id)).agenda
                .recordingItemId,
        ).toBeNull();
    });

    it("lets a co-editor explicitly attach their own recording without bypassing folder revocation", async () => {
        const meeting = await create();
        await db.insert(folderShares).values(
            ["other", "stranger"].map((receiverUserId) => ({
                userId: "owner",
                receiverUserId,
                folderId: "owner-folder",
                state: "accepted" as const,
            })),
        );
        await recording("colleague-rec", undefined, "other");
        await attachAgenda("other", meeting.id, "colleague-rec");
        expect(await getMeeting("owner", meeting.id)).toMatchObject({
            redirectTo: "/dashboard?recording=colleague-rec&view=received",
        });
        expect(await getMeeting("stranger", meeting.id)).toMatchObject({
            redirectTo: "/dashboard?recording=colleague-rec&view=received",
        });
        expect(
            (await requireMeetingAccess("owner", meeting.id)).agenda
                .recordingItemId,
        ).toBe("colleague-rec");
        expect(
            (await requireMeetingAccess("stranger", meeting.id)).agenda
                .recordingItemId,
        ).toBe("colleague-rec");
        await db
            .update(folderShares)
            .set({ state: "removed" })
            .where(eq(folderShares.receiverUserId, "stranger"));
        await expect(
            requireMeetingAccess("stranger", meeting.id),
        ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("does not auto-attach ambiguous windows or a colleague's recording", async () => {
        const first = await create();
        const second = await create("owner-folder", "Another");
        if (second.meeting.unchanged || !second.meeting.meetingItemId)
            throw new Error("Missing meeting item");
        await db
            .delete(recordingFolderAssignments)
            .where(
                eq(
                    recordingFolderAssignments.itemId,
                    second.meeting.meetingItemId,
                ),
            );
        await recording("rec", "owner-folder");
        await db.transaction((tx) =>
            attachArrivingRecordingInTx(tx, "owner", "rec", "rec"),
        );
        expect(
            (await requireMeetingAccess("owner", first.id)).agenda
                .recordingItemId,
        ).toBeNull();
        await expect(
            attachAgenda("other", first.id, "rec"),
        ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("claims overdue held transitions exactly once across concurrent sweepers", async () => {
        const meeting = await create();
        const at = new Date("2026-11-04T00:01:00Z");
        expect(
            (
                await Promise.all([
                    holdOverdueMeetings(10, at),
                    holdOverdueMeetings(10, at),
                ])
            ).reduce((a, b) => a + b),
        ).toBe(1);
        expect(
            (await requireMeetingAccess("owner", meeting.id)).agenda.state,
        ).toBe("held");
    });

    it("keeps dismissed carry-over suggestions dismissed", async () => {
        const first = await create();
        await addPoint("owner", first.id, { text: "Carry over" });
        await patchMeeting("owner", first.id, { state: "held" });
        await prepareMeeting("owner", {
            folderId: "owner-folder",
            title: "Future",
            start: "2026-11-17T10:00:00Z",
        });
        const next = await prepareMeeting("owner", {
            folderId: "owner-folder",
            title: "Next",
            start: "2026-11-10T10:00:00Z",
        });
        const [suggestion] = await db
            .select()
            .from(agendaSuggestions)
            .where(eq(agendaSuggestions.agendaId, next.id));
        expect(suggestion.kind).toBe("carry_over");
        await decideSuggestion("owner", next.id, suggestion.id, "dismissed");
        await decideSuggestion("owner", next.id, suggestion.id, "added");
        expect(
            await db
                .select()
                .from(agendaPoints)
                .where(eq(agendaPoints.agendaId, next.id)),
        ).toHaveLength(0);
    });

    it("exports Markdown without assignee or live notes", async () => {
        const meeting = await create();
        const point = await addPoint("owner", meeting.id, {
            text: "Discussion",
        });
        await changePoint("owner", meeting.id, point.id, {
            note: "Private live note",
            version: 0,
        });
        const detail = await getMeeting("owner", meeting.id);
        if (detail.unchanged) throw new Error("Missing detail");
        expect(meetingMarkdown(detail)).toContain("- Discussion");
        expect(meetingMarkdown(detail)).not.toContain("Private live note");
    });

    it("round-trips standalone and absorbed agendas while preserving scoped task references", async () => {
        const first = await create();
        const point = await addPoint("owner", first.id, { text: "Root" });
        await addPoint("owner", first.id, {
            text: "Child",
            parentId: point.id,
        });
        await recording("rec", "owner-folder");
        await db
            .update(chatterItems)
            .set({ occurredAt: new Date(start.getTime() - 86400000) })
            .where(eq(chatterItems.id, "rec"));
        await db.insert(recordingTasks).values({
            id: "archived-task",
            itemId: "rec",
            userId: "owner",
            createdByUserId: "owner",
            status: "open",
            source: "manual",
            text: encryptText("Archived task"),
        });
        const second = await create("owner-folder", "Absorbed");
        await attachAgenda("owner", second.id, "rec");
        const archive = await collectArchivedMeetings({
            kind: "personal",
            userId: "owner",
        });
        expect(archive).toHaveLength(2);
        await db.delete(meetingAgendas);
        await db.delete(chatterItems).where(eq(chatterItems.kind, "meeting"));
        const result = await restoreMeetings("owner", {
            meetings: archive,
            itemIdMap: { rec: "rec" },
            folderIdMap: { "owner-folder": "owner-folder" },
            taskIdMap: { "archived-task": "archived-task" },
        });
        expect(result.restored).toHaveLength(2);
        expect(result.skipped).toHaveLength(0);
        const restored = await collectArchivedMeetings({
            kind: "personal",
            userId: "owner",
        });
        expect(
            restored.flatMap((entry) => entry.tasks.map((task) => task.taskId)),
        ).toEqual(["archived-task"]);
        expect(restored.map((entry) => entry.title).sort()).toEqual([
            "Absorbed",
            "Acme",
        ]);
        expect(
            restored
                .flatMap((entry) => entry.points.map((entry) => entry.text))
                .sort(),
        ).toEqual(["Child", "Root"]);
    });

    it("validates completion agenda access, preserves metadata and absorbs the explicit choice on arrival", async () => {
        const meeting = await create("org-folder");
        await db.insert(apiKeys).values({
            id: "key",
            userId: "other",
            name: "Recorder",
            keyHash: "hash",
            keyPrefix: "test",
            scopes: ["record"],
        });
        const { session } = await createRecordingSession({
            userId: "other",
            apiKeyId: "key",
            clientRecordingId: "capture",
            mimeType: "audio/webm",
            metadata: { channelLayout: ["system"] },
            startedAt: start,
            noticeAcknowledgedAt: start,
            folderId: null,
        });
        const input = {
            sessionId: session.id,
            userId: "other",
            endedAt: new Date(start.getTime() + 3600000),
            stopReason: "user",
            expectedChunkCount: 0,
            truncatedAtChunk: null,
        };
        const completing = await markRecordingSessionCompleting({
            ...input,
            agendaId: meeting.id,
        });
        expect(completing?.metadata).toEqual({
            channelLayout: ["system"],
            agendaId: meeting.id,
            agendaOutcome: { attached: true },
        });
        await recording("session-recording", undefined, "other");
        await db
            .update(recordings)
            .set({ plaudFileId: "meeting-capture" })
            .where(
                and(
                    eq(recordings.id, "session-recording"),
                    eq(recordings.userId, "other"),
                ),
            );
        await db.transaction((tx) =>
            requestArrivalInTx(tx, {
                userId: "other",
                itemId: "session-recording",
            }),
        );
        expect(
            (await requireMeetingAccess("owner", meeting.id)).agenda
                .recordingItemId,
        ).toBe("session-recording");
        await db.transaction((tx) =>
            requestArrivalInTx(tx, {
                userId: "other",
                itemId: "session-recording",
            }),
        );
    });

    it("keeps the arriving recording when explicit agenda access was revoked after completion", async () => {
        const meeting = await create();
        await db.insert(folderShares).values({
            userId: "owner",
            receiverUserId: "other",
            folderId: "owner-folder",
            state: "accepted",
        });
        await db.insert(apiKeys).values({
            id: "key",
            userId: "other",
            name: "Recorder",
            keyHash: "hash",
            keyPrefix: "test",
            scopes: ["record"],
        });
        const { session } = await createRecordingSession({
            userId: "other",
            apiKeyId: "key",
            clientRecordingId: "revoked-capture",
            mimeType: "audio/webm",
            metadata: { channelLayout: ["system"] },
            startedAt: start,
            noticeAcknowledgedAt: start,
            folderId: null,
        });
        await markRecordingSessionCompleting({
            sessionId: session.id,
            userId: "other",
            endedAt: new Date(start.getTime() + 3600000),
            stopReason: "user",
            expectedChunkCount: 0,
            truncatedAtChunk: null,
            agendaId: meeting.id,
        });
        await db
            .update(folderShares)
            .set({ state: "removed" })
            .where(eq(folderShares.receiverUserId, "other"));
        await recording("revoked-rec", undefined, "other");
        await db.transaction((tx) =>
            attachArrivingRecordingInTx(
                tx,
                "other",
                "revoked-rec",
                "meeting-revoked-capture",
            ),
        );
        expect(
            (await requireMeetingAccess("owner", meeting.id)).agenda
                .recordingItemId,
        ).toBeNull();
        expect(
            await db
                .select()
                .from(chatterItems)
                .where(
                    and(
                        eq(chatterItems.id, "revoked-rec"),
                        eq(chatterItems.userId, "other"),
                    ),
                ),
        ).toHaveLength(1);
    });

    it("deletes an absorbed agenda only with its caller-owned recording", async () => {
        const meeting = await create();
        await addPoint("owner", meeting.id, { text: "Discussion" });
        await recording("rec", "owner-folder");
        await attachAgenda("owner", meeting.id, "rec");
        await markRecordingDeleted(db, {
            id: "rec",
            userId: "stranger",
            at: new Date(),
        });
        expect(
            (await requireMeetingAccess("owner", meeting.id)).agenda.id,
        ).toBe(meeting.id);
        await markRecordingDeleted(db, {
            id: "rec",
            userId: "owner",
            at: new Date(),
        });
        expect(await db.select().from(meetingAgendas)).toHaveLength(0);
        expect(await db.select().from(agendaPoints)).toHaveLength(0);
    });

    it("never creates processing rows for a planned meeting", async () => {
        const meeting = await create();
        const access = await requireMeetingAccess("owner", meeting.id);
        expect(
            await requestAdvance({
                userId: "owner",
                itemId: access.item.id,
                view: "private",
                reason: "arrival",
            }),
        ).toBeNull();
        expect(
            await db
                .select()
                .from(itemProcessing)
                .where(
                    and(
                        eq(itemProcessing.userId, "owner"),
                        eq(itemProcessing.itemId, access.item.id),
                    ),
                ),
        ).toHaveLength(0);
    });
    it("inserts outline points in a stable order without overwriting existing authors", async () => {
        const meeting = await create("org-folder");
        await addPoint("owner", meeting.id, { text: "First", position: 0 });
        await addPoint("other", meeting.id, { text: "Last", position: 1 });
        await addPoint("owner", meeting.id, { text: "Middle", position: 1 });
        const value = await getMeeting("owner", meeting.id);
        if (value.unchanged) throw new Error("Missing detail");
        expect(value.points.map((entry) => entry.text)).toEqual([
            "First",
            "Middle",
            "Last",
        ]);
        expect(value.authors.map((author) => author.id).sort()).toEqual([
            "other",
            "owner",
        ]);
        const rows = await listMeetings("owner", { includePast: true });
        expect(rows[0].editors.map((editor) => editor.id).sort()).toEqual([
            "other",
            "owner",
        ]);
    });
    it("reports Calendar export authority without Google calls on repeated non-author loads", async () => {
        const meeting = await prepareMeeting("owner", {
            folderId: "org-folder",
            calendarEventId: "event",
        });
        const owner = await getMeeting("owner", meeting.id);
        const colleague = await getMeeting("other", meeting.id);
        if (owner.unchanged || colleague.unchanged)
            throw new Error("Missing detail");
        expect(owner.canExportCalendar).toBe(true);
        expect(colleague.canExportCalendar).toBe(false);
        await getMeeting("other", meeting.id);
        await getMeeting("other", meeting.id, colleague.version);
        expect(calendar.read).toHaveBeenCalledTimes(1);
    });
    it.each([
        [" MAREK@example.com ", "active", true],
        ["other@example.com", "active", false],
        [undefined, "active", null],
        ["marek@example.com", "needs_reconnect", null],
    ])("uses connected email %s (%s) for cached organizer permission", async (email, status, expected) => {
        const meeting = await prepareMeeting("owner", {
            folderId: "org-folder",
            calendarEventId: "event",
        });
        calendar.connection.mockResolvedValue({ email, status });
        expect(await getMeeting("other", meeting.id)).toMatchObject({
            canExportCalendar: expected,
        });
        expect(await getMeeting("owner", meeting.id)).toMatchObject({
            canExportCalendar: true,
        });
        expect(calendar.read).toHaveBeenCalledTimes(1);
    });
    it("defers organizer permission when the snapshot has no organizer email", async () => {
        calendar.read.mockResolvedValueOnce({
            ...eventFor("owner", "event"),
            organizer: { self: true },
        });
        const meeting = await prepareMeeting("owner", {
            folderId: "org-folder",
            calendarEventId: "event",
        });
        expect(await getMeeting("other", meeting.id)).toMatchObject({
            canExportCalendar: null,
        });
        expect(calendar.read).toHaveBeenCalledTimes(1);
    });
    it("merges an empty outline line upward without deleting its children", async () => {
        const meeting = await create();
        const parent = await addPoint("owner", meeting.id, { text: "Parent" });
        const child = await addPoint("owner", meeting.id, {
            text: "Child",
            parentId: parent.id,
        });
        await changePoint(
            "owner",
            meeting.id,
            parent.id,
            { version: 0, mergeUp: true },
            true,
        );
        const value = await getMeeting("owner", meeting.id);
        if (value.unchanged) throw new Error("Missing detail");
        expect(value.points).toMatchObject([
            { id: child.id, parentId: null, text: "Child", version: 1 },
        ]);
    });
    it.each([
        "owner",
        "other",
    ])("never counts %s's attached own recording as received, and keeps task edits and merges", async (recordingOwner) => {
        const meeting = await create();
        await db.insert(folderShares).values({
            userId: "owner",
            receiverUserId: "other",
            folderId: "owner-folder",
            state: "accepted",
        });
        await recording("rec", undefined, recordingOwner);
        await attachAgenda(recordingOwner, meeting.id, "rec");
        expect(await isItemReceived(recordingOwner, "rec")).toBe(false);
        expect(
            await db
                .select({ id: chatterItems.id })
                .from(chatterItems)
                .where(receivedItemCondition(recordingOwner)),
        ).not.toContainEqual({ id: "rec" });
        const viewer = await taskViewerById(recordingOwner);
        const result = await searchApp(viewer, "chatter", "");
        expect(result.chatter.find((hit) => hit.id === "rec")?.href).toBe(
            "/dashboard?recording=rec",
        );
        await db.insert(recordingTasks).values(
            ["first", "second"].map((id) => ({
                id,
                userId: recordingOwner,
                itemId: "rec",
                status: "open" as const,
                source: "manual" as const,
                text: encryptText(id),
            })),
        );
        expect(
            (await updateTask(viewer, "first", { version: 0, text: "Changed" }))
                .text,
        ).toBe("Changed");
        expect(
            (await mergeTaskIntoTask(viewer, "first", "second")).text,
        ).toContain("Changed");
    });
    it("refuses direct meeting shares and survives a stray invitation", async () => {
        const meeting = await create();
        if (meeting.meeting.unchanged)
            throw new Error("Missing meeting detail");
        const itemId = meeting.meeting.meetingItemId;
        if (!itemId) throw new Error("Missing meeting item");
        await expect(
            inviteToItem("owner", itemId, ["other"]),
        ).rejects.toMatchObject({ statusCode: 404 });
        await db.insert(itemShares).values({
            id: "stray",
            userId: "owner",
            itemId,
            receiverUserId: "other",
        });
        expect(await listMyInvitations("other")).toEqual([]);
        await expect(
            changePersonShare("other", "stray", {
                action: "accept",
                version: 0,
                folderId: "other-folder",
            }),
        ).rejects.toMatchObject({ statusCode: 404 });
        const restored = await restoreArchivedItemShares(
            "owner",
            [
                {
                    itemId: "old",
                    receiverEmail: "stranger@example.com",
                    state: "accepted",
                },
            ],
            new Map([["old", itemId]]),
        );
        expect(restored.restored).toBe(0);
        await db
            .update(itemShares)
            .set({ state: "accepted" })
            .where(eq(itemShares.id, "stray"));
        await expect(
            requireMeetingAccess("other", meeting.id),
        ).rejects.toMatchObject({ statusCode: 404 });
    });
    it("keeps Organization colleagues on the read-only agenda until gated publication", async () => {
        const meeting = await create("org-folder");
        await addPoint("owner", meeting.id, { text: "Plan" });
        await recording("rec");
        await attachAgenda("owner", meeting.id, "rec");
        expect(await db.select().from(mailPendingShares)).toMatchObject([
            { itemId: "rec", folderId: "org-folder" },
        ]);
        expect(
            await db
                .select()
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.itemId, "rec")),
        ).toEqual([]);
        expect(await getMeeting("other", meeting.id)).toMatchObject({
            attachedRecording: { visible: false },
            redirectTo: null,
            permissions: { edit: false, manage: false },
            points: [{ text: "Plan" }],
        });
        principal.userId = "other";
        const context = { params: Promise.resolve({ id: meeting.id }) };
        expect(
            await (
                await readMeeting(
                    new Request(
                        `https://example.com/api/meetings/${meeting.id}`,
                    ),
                    context,
                )
            ).json(),
        ).toMatchObject({
            attachedRecording: { visible: false },
            redirectTo: null,
        });
        const pendingLink = await meetingLink(
            new Request(`https://example.com/meetings/${meeting.id}`),
            context,
        );
        expect(pendingLink.headers.get("location")).toContain("?meeting=");
        await db
            .insert(recordingFolderAssignments)
            .values({ userId: "owner", itemId: "rec", folderId: "org-folder" });
        expect(await getMeeting("other", meeting.id)).toMatchObject({
            attachedRecording: { visible: true },
            redirectTo: "/dashboard?recording=rec&view=org",
        });
        const publishedLink = await meetingLink(
            new Request(`https://example.com/meetings/${meeting.id}`),
            context,
        );
        expect(publishedLink.headers.get("location")).toBe(
            "https://example.com/dashboard?recording=rec&view=org",
        );
    });
    it.each([
        "owner",
        "other",
    ])("recording DELETE applies the agenda lifecycle for %s", async (recordingOwner) => {
        const meeting = await create();
        await addPoint("owner", meeting.id, {
            text: "Keep only if another author",
        });
        await db.insert(folderShares).values({
            userId: "owner",
            receiverUserId: "other",
            folderId: "owner-folder",
            state: "accepted",
        });
        await recording("rec", undefined, recordingOwner);
        await attachAgenda(recordingOwner, meeting.id, "rec");
        principal.userId = recordingOwner;
        const response = await deleteRecording(
            new Request("https://example.com/api/recordings/rec", {
                method: "DELETE",
            }),
            { params: Promise.resolve({ id: "rec" }) },
        );
        expect(response.status).toBe(200);
        if (recordingOwner === "owner") {
            expect(await db.select().from(meetingAgendas)).toEqual([]);
            expect(await db.select().from(agendaPoints)).toEqual([]);
        } else {
            expect(await getMeeting("owner", meeting.id)).toMatchObject({
                recordingItemId: null,
                state: "planned",
                permissions: { edit: true },
            });
        }
    });
    it("attach and detach preserve Learn identifiers and remove a co-editor's assignment", async () => {
        const meeting = await prepareMeeting("owner", {
            folderId: "owner-folder",
            calendarEventId: "event",
        });
        await db.insert(folderShares).values({
            userId: "owner",
            receiverUserId: "other",
            folderId: "owner-folder",
            state: "accepted",
        });
        await recording("rec", undefined, "other");
        await db
            .update(recordings)
            .set({
                calendarEventId: "learn-event",
                calendarSeriesId: "learn-series",
            })
            .where(eq(recordings.id, "rec"));
        await attachAgenda("other", meeting.id, "rec");
        expect(
            await db.select().from(recordings).where(eq(recordings.id, "rec")),
        ).toMatchObject([
            {
                calendarEventId: "learn-event",
                calendarSeriesId: "learn-series",
            },
        ]);
        await detachAgenda("other", "rec");
        expect(
            await db.select().from(recordings).where(eq(recordings.id, "rec")),
        ).toMatchObject([
            {
                calendarEventId: "learn-event",
                calendarSeriesId: "learn-series",
            },
        ]);
        expect(
            await db
                .select()
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.itemId, "rec")),
        ).toEqual([]);
    });
    it("detach clears only agenda identifiers and preserves the owner's filing", async () => {
        const meeting = await prepareMeeting("owner", {
            folderId: "owner-folder",
            calendarEventId: "event",
        });
        await recording("rec");
        await attachAgenda("owner", meeting.id, "rec");
        await db
            .update(recordings)
            .set({ calendarSeriesId: "later-series" })
            .where(eq(recordings.id, "rec"));
        await detachAgenda("owner", "rec");
        expect(
            await db.select().from(recordings).where(eq(recordings.id, "rec")),
        ).toMatchObject([
            { calendarEventId: null, calendarSeriesId: "later-series" },
        ]);
        expect(
            await db
                .select()
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.itemId, "rec")),
        ).toHaveLength(1);
    });
    it("uses encrypted Calendar snapshots and a single database TTL refresh", async () => {
        const meeting = await prepareMeeting("owner", {
            folderId: "owner-folder",
            calendarEventId: "event",
        });
        expect(calendar.read).toHaveBeenCalledTimes(1);
        await getMeeting("owner", meeting.id);
        expect(calendar.read).toHaveBeenCalledTimes(1);
        const [agenda] = await db
            .update(meetingAgendas)
            .set({ calendarRefreshedAt: new Date(Date.now() - 11 * 60000) })
            .where(eq(meetingAgendas.id, meeting.id))
            .returning();
        expect(JSON.stringify(agenda.calendarSnapshot)).not.toContain(
            "abc-defg-hij",
        );
        await Promise.all(
            Array.from({ length: 8 }, () =>
                readMeetingCalendarSnapshot(agenda),
            ),
        );
        expect(calendar.read).toHaveBeenCalledTimes(2);
        const detail = await getMeeting("owner", meeting.id);
        expect(JSON.stringify(detail)).not.toContain("abc-defg-hij");
        expect(detail).not.toHaveProperty("calendarSnapshot");
        expect(
            await matchRecorderAgendas(
                "owner",
                new Date(start.getTime() + 60000),
                "abc-defg-hij",
            ),
        ).toMatchObject([{ id: meeting.id }]);
        expect(calendar.read).toHaveBeenCalledTimes(2);
    });
    it("counts a colleague's overlapping agenda when deciding auto-attachment", async () => {
        const first = await create();
        await prepareMeeting("other", {
            folderId: "other-folder",
            title: "Other agenda",
            start: start.toISOString(),
        });
        await db.insert(folderShares).values({
            userId: "other",
            receiverUserId: "owner",
            folderId: "other-folder",
            state: "accepted",
        });
        await recording("rec", "owner-folder");
        await db.transaction((tx) =>
            attachArrivingRecordingInTx(tx, "owner", "rec", "rec"),
        );
        expect(
            (await requireMeetingAccess("owner", first.id)).agenda
                .recordingItemId,
        ).toBeNull();
    });
    it.each([
        "organization",
        "intent",
        "person",
        "folder",
    ])("does not auto-widen a private agenda's audience through %s", async (sharing) => {
        const meeting = await create();
        await recording("rec");
        if (sharing === "organization")
            await db.insert(recordingFolderAssignments).values({
                userId: "owner",
                itemId: "rec",
                folderId: "org-folder",
            });
        if (sharing === "intent")
            await db.insert(mailPendingShares).values({
                userId: "owner",
                itemId: "rec",
                folderId: "org-folder",
            });
        if (sharing === "person")
            await db.insert(itemShares).values({
                userId: "owner",
                itemId: "rec",
                receiverUserId: "other",
                state: "accepted",
            });
        if (sharing === "folder") {
            await db.insert(folderShares).values({
                userId: "other",
                receiverUserId: "stranger",
                folderId: "other-folder",
                state: "accepted",
            });
            await db.insert(recordingFolderAssignments).values({
                userId: "owner",
                itemId: "rec",
                folderId: "other-folder",
            });
        }
        await db.transaction((tx) =>
            attachArrivingRecordingInTx(tx, "owner", "rec", "rec"),
        );
        expect(
            (await requireMeetingAccess("owner", meeting.id)).agenda
                .recordingItemId,
        ).toBeNull();
    });
    it("resnapshot preserves older selections and retained task notes", async () => {
        await recording("old", "owner-folder");
        await db
            .update(chatterItems)
            .set({ occurredAt: new Date(start.getTime() - 86400000) })
            .where(eq(chatterItems.id, "old"));
        await db.insert(recordingTasks).values(
            ["retain", "older"].map((id) => ({
                id,
                itemId: "old",
                userId: "owner",
                status: "open" as const,
                source: "manual" as const,
                text: encryptText(id),
            })),
        );
        const meeting = await create();
        await changeAgendaTask("owner", meeting.id, "retain", {
            note: "Keep note",
        });
        await db
            .update(agendaTasks)
            .set({ origin: "older" })
            .where(eq(agendaTasks.taskId, "older"));
        await patchMeeting("owner", meeting.id, { taskSourceItemId: "old" });
        expect(
            (await db.select().from(agendaTasks)).map((row) => ({
                id: row.taskId,
                origin: row.origin,
                note: row.note ? decryptText(row.note) : null,
            })),
        ).toEqual(
            expect.arrayContaining([
                { id: "retain", origin: "last_meeting", note: "Keep note" },
                { id: "older", origin: "older", note: null },
            ]),
        );
    });
    it("restores idempotently, skips a bad tree, and tolerates an already absorbed recording", async () => {
        const standalone = await create();
        await addPoint("owner", standalone.id, { text: "Point" });
        const archive = await collectArchivedMeetings({
            kind: "personal",
            userId: "owner",
        });
        const input = {
            meetings: archive,
            folderIdMap: { "owner-folder": "owner-folder" },
        };
        const first = await restoreMeetings("owner", input);
        expect((await restoreMeetings("owner", input)).restored).toEqual(
            first.restored,
        );
        expect(await db.select().from(meetingAgendas)).toHaveLength(2);
        const bad = {
            ...archive[0],
            id: "bad",
            points: archive[0].points.map((point) => ({
                ...point,
                parentId: "missing",
            })),
        };
        const result = await restoreMeetings("owner", {
            ...input,
            meetings: [bad, { ...archive[0], id: "good" }],
        });
        expect(result.skipped).toMatchObject([{ id: "bad" }]);
        expect(result.restored).toHaveLength(1);
        await recording("rec");
        await attachAgenda("owner", standalone.id, "rec");
        const absorbed = (
            await collectArchivedMeetings({ kind: "personal", userId: "owner" })
        ).find((row) => row.recordingItemId === "rec");
        const skipped = await restoreMeetings("owner", {
            ...input,
            meetings: [absorbed],
            itemIdMap: { rec: "rec" },
        });
        expect(skipped.skipped).toHaveLength(1);
    });
    it("excludes meeting items from folder knowledge counts", async () => {
        await create();
        expect(
            (
                await folderKnowledgeContext({
                    folderId: "owner-folder",
                    ownerId: "owner",
                    viewerId: "owner",
                    shared: false,
                    allOwnedItems: false,
                    scopes: ["owner"],
                })
            ).itemCount,
        ).toBe(0);
    });
    it("uses only receiver-visible ancestry in the batched reminder path", async () => {
        const meeting = await create();
        const [share] = await db
            .insert(folderShares)
            .values({
                userId: "owner",
                receiverUserId: "other",
                folderId: "owner-folder",
                state: "accepted",
            })
            .returning();
        await db.insert(receivedFolderAttachments).values({
            userId: "other",
            shareId: share.id,
            name: encryptText("Shared preparation"),
            parentId: "other-folder",
        });
        const path = await meetingFolderPaths("other");
        if (meeting.meeting.unchanged)
            throw new Error("Missing meeting detail");
        expect(path(meeting.meeting.folders)).toBe(
            "Root / Acme / Shared preparation",
        );
    });
    async function capture() {
        await db
            .insert(apiKeys)
            .values({
                id: "key",
                userId: "owner",
                name: "Recorder",
                keyHash: "hash",
                keyPrefix: "test",
                scopes: ["record"],
            })
            .onConflictDoNothing();
        const { session } = await createRecordingSession({
            userId: "owner",
            apiKeyId: "key",
            clientRecordingId: crypto.randomUUID(),
            mimeType: "audio/webm",
            metadata: { channelLayout: ["system"], clientVersion: "0.7.0" },
            startedAt: start,
            noticeAcknowledgedAt: start,
            folderId: null,
        });
        await db.insert(recordingSessionChunks).values({
            sessionId: session.id,
            index: 0,
            size: 1,
            sha256: "a".repeat(64),
            storageKey: "chunk",
        });
        return session;
    }
    function finish(id: string, extra: Record<string, unknown> = {}) {
        return completeSession(
            new Request(
                `https://example.com/api/v1/recording-sessions/${id}/complete`,
                {
                    method: "POST",
                    body: JSON.stringify({
                        chunkCount: 1,
                        endedAt: "2026-11-03T11:00:00Z",
                        ...extra,
                    }),
                },
            ),
            { params: Promise.resolve({ id }) },
        );
    }
    it.each([
        "unknown",
        "absorbed",
        "inaccessible",
    ])("complete tolerates an %s agenda", async (state) => {
        let agendaId = "missing";
        if (state === "absorbed") {
            const meeting = await create();
            agendaId = meeting.id;
            await recording("rec");
            await attachAgenda("owner", meeting.id, "rec");
        }
        if (state === "inaccessible")
            agendaId = (
                await prepareMeeting("other", {
                    folderId: "other-folder",
                    title: "Private",
                })
            ).id;
        const session = await capture();
        const response = await finish(session.id, { agendaId });
        expect(response.status).toBe(202);
        expect(await response.json()).toMatchObject({
            status: "completing",
            agenda: { attached: false, reason: "unavailable" },
        });
        expect(
            (
                await db
                    .select()
                    .from(recordingSessions)
                    .where(eq(recordingSessions.id, session.id))
            )[0].metadata,
        ).not.toHaveProperty("agendaId");
    });
    it.each([
        3,
        "x".repeat(256),
        "",
        " ",
        {},
        [],
        false,
    ])("complete rejects malformed agendaId %j", async (agendaId) => {
        const session = await capture();
        const response = await finish(session.id, { agendaId });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
            code: "INVALID_INPUT",
            details: { field: "agendaId" },
        });
    });
    it("preserves the released 0.7.0 complete response shape when agendaId is omitted", async () => {
        const session = await capture();
        const response = await finish(session.id);
        expect(response.status).toBe(202);
        const body = await response.json();
        expect(body).not.toHaveProperty("agenda");
        expect(body.metadata).toEqual({
            channelLayout: ["system"],
            clientVersion: "0.7.0",
        });
        expect((await finish(session.id)).status).toBe(200);
    });
    it("does not replace an unavailable explicit choice with an automatic candidate at finalize", async () => {
        const candidate = await create();
        const session = await capture();
        expect((await finish(session.id, { agendaId: "lost" })).status).toBe(
            202,
        );
        await recording("finalized", undefined, "owner");
        await db.transaction((tx) =>
            attachArrivingRecordingInTx(
                tx,
                "owner",
                "finalized",
                `meeting-${session.clientRecordingId}`,
            ),
        );
        expect(
            (await requireMeetingAccess("owner", candidate.id)).agenda
                .recordingItemId,
        ).toBeNull();
    });

    it.each([
        null,
        undefined,
    ])("persists agendaId=%s and respects the choice at finalize and repeated arrival", async (agendaId) => {
        const candidate = await create();
        const session = await capture();
        const response = await finish(
            session.id,
            agendaId === undefined ? {} : { agendaId },
        );
        expect(response.status).toBe(202);
        const body = await response.json();
        expect(body).not.toHaveProperty("agenda");
        expect(body.metadata).toEqual({
            channelLayout: ["system"],
            clientVersion: "0.7.0",
            ...(agendaId === null ? { agendaId: null } : {}),
        });
        expect(
            (await finish(session.id, { agendaId: candidate.id })).status,
        ).toBe(200);
        const fileId = `meeting-${session.clientRecordingId}`;
        await recording("finalized");
        await db
            .update(recordings)
            .set({ plaudFileId: fileId })
            .where(eq(recordings.id, "finalized"));
        expect(await agendaCandidates("owner", "finalized")).toHaveLength(1);
        await db.transaction((tx) =>
            requestArrivalInTx(tx, { userId: "owner", itemId: "finalized" }),
        );
        expect(
            (await requireMeetingAccess("owner", candidate.id)).agenda
                .recordingItemId,
        ).toBe(agendaId === null ? null : "finalized");
        await markRecordingSessionCompleted(session.id, "owner", "finalized");
        await db.transaction((tx) =>
            requestArrivalInTx(tx, { userId: "owner", itemId: "finalized" }),
        );
        expect(
            (await requireMeetingAccess("owner", candidate.id)).agenda
                .recordingItemId,
        ).toBe(agendaId === null ? null : "finalized");
    });

    it("detaching an Organization agenda withdraws attach-created publication and cancels its intent", async () => {
        const meeting = await create("org-folder");
        await recording("rec");
        await attachAgenda("owner", meeting.id, "rec");
        await db
            .insert(recordingFolderAssignments)
            .values({ userId: "owner", itemId: "rec", folderId: "org-folder" });
        await detachAgenda("owner", "rec");
        expect(
            await db
                .select()
                .from(mailPendingShares)
                .where(eq(mailPendingShares.itemId, "rec")),
        ).toEqual([]);
        expect(
            await db
                .select()
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.itemId, "rec")),
        ).toEqual([]);
        expect(await getMeeting("other", meeting.id)).toMatchObject({
            recordingItemId: null,
            permissions: { edit: true },
        });
    });
    it("annotates an upcoming event even with more than 500 older visible agendas", async () => {
        const now = Date.now();
        const ids = Array.from({ length: 501 }, (_, index) => `old-${index}`);
        await db.insert(chatterItems).values(
            ids.map((id) => ({
                id,
                userId: "owner",
                kind: "meeting" as const,
                title: encryptText("Past meeting"),
                occurredAt: new Date(now - 30 * 86400000),
            })),
        );
        await db.insert(meetingAgendas).values(
            ids.map((id) => ({
                id,
                userId: "owner",
                meetingItemId: id,
                timeSet: true,
                plannedStart: new Date(now - 30 * 86400000),
            })),
        );
        const upcoming = {
            ...eventFor("owner", "upcoming"),
            start: new Date(now + 3600000).toISOString(),
            end: new Date(now + 7200000).toISOString(),
        };
        calendar.read.mockResolvedValueOnce(upcoming);
        calendar.upcoming.mockResolvedValueOnce([upcoming]);
        const meeting = await prepareMeeting("owner", {
            folderId: "owner-folder",
            calendarEventId: "upcoming",
        });
        const events = await meetingCalendarEvents("owner", "owner-folder");
        expect(events.other).toMatchObject([
            { id: "upcoming", visibleAgenda: { id: meeting.id } },
        ]);
    });
    it("restores an overdue colleague's meeting as held through recording DELETE", async () => {
        const meeting = await create();
        await db.insert(folderShares).values({
            userId: "owner",
            receiverUserId: "other",
            folderId: "owner-folder",
            state: "accepted",
        });
        await recording("rec", undefined, "other");
        await attachAgenda("other", meeting.id, "rec");
        await db
            .update(meetingAgendas)
            .set({
                plannedStart: new Date(Date.now() - 2 * 86400000),
                plannedEnd: null,
            })
            .where(eq(meetingAgendas.id, meeting.id));
        principal.userId = "other";
        expect(
            (
                await deleteRecording(
                    new Request("https://example.com/api/recordings/rec", {
                        method: "DELETE",
                    }),
                    { params: Promise.resolve({ id: "rec" }) },
                )
            ).status,
        ).toBe(200);
        expect(await getMeeting("owner", meeting.id)).toMatchObject({
            recordingItemId: null,
            state: "held",
        });
    });
});
