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
    meetingAgendas,
    recordingFolderAssignments,
    recordingFolders,
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
vi.mock("@/lib/integrations/google/calendar-events", () => ({
    getCalendarEvent: async (_userId: string, id: string) => ({
        id,
        title: "Acme meeting",
        start: "2026-11-03T10:00:00Z",
        end: "2026-11-03T11:00:00Z",
        recurringEventId: "series",
        attendees: [],
        organizer: { self: true },
    }),
}));

import { db } from "@/db";
import { markRecordingDeleted } from "@/db/items";
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
import { meetingMarkdown } from "@/lib/meetings/export";
import {
    addPoint,
    changePoint,
    decideSuggestion,
    getMeeting,
    patchMeeting,
    prepareMeeting,
} from "@/lib/meetings/service";
import { requestAdvance } from "@/lib/pipeline/trigger";
import {
    createRecordingSession,
    markRecordingSessionCompleting,
} from "@/lib/recording-sessions/store";
import { searchApp } from "@/lib/search/app-search";
import { taskViewerById } from "@/lib/tasks/access";

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
    });
    beforeEach(async () => {
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
        await create("owner-folder", "Another");
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
        await expect(
            markRecordingSessionCompleting({ ...input, agendaId: "missing" }),
        ).rejects.toMatchObject({ statusCode: 404 });
        const completing = await markRecordingSessionCompleting({
            ...input,
            agendaId: meeting.id,
        });
        expect(completing?.metadata).toEqual({
            channelLayout: ["system"],
            agendaId: meeting.id,
        });
        await recording("session-recording", undefined, "other");
        await db.transaction((tx) =>
            attachArrivingRecordingInTx(
                tx,
                "other",
                "session-recording",
                "meeting-capture",
            ),
        );
        expect(
            (await requireMeetingAccess("owner", meeting.id)).agenda
                .recordingItemId,
        ).toBe("session-recording");
        await db.transaction((tx) =>
            attachArrivingRecordingInTx(
                tx,
                "other",
                "session-recording",
                "meeting-capture",
            ),
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
});
