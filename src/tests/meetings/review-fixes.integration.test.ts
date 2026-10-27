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
    agendaPoints,
    agendaSuggestions,
    aiEnhancements,
    chatterItems,
    folderShares,
    meetingAgendas,
    recordingFolderAssignments,
    recordingFolders,
    recordings,
    users,
} from "@/db/schema";
import { encryptText } from "@/lib/encryption/fields";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
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

import { GET as readMeeting } from "@/app/api/meetings/[id]/route";
import { GET as readRecorder } from "@/app/api/v1/recorder/agendas/[id]/route";
import { GET as matchRoute } from "@/app/api/v1/recorder/agendas/match/route";
import { db } from "@/db";
import { insertAudioItem } from "@/db/items";
import { writeSummaryAgenda } from "@/db/queries/agenda-pipeline";
import {
    recordingAgendaCandidateCount,
    recordingHasAgenda,
} from "@/db/queries/agenda-presence";
import { MEETING_TOOLS } from "@/lib/mcp/tools/meetings";
import { requireMeetingAccess } from "@/lib/meetings/access";
import {
    attachAgenda,
    attachArrivingRecordingInTx,
} from "@/lib/meetings/attachment";
import { nextMeeting } from "@/lib/meetings/calendar";
import {
    addPoint,
    changePoint,
    getMeeting,
    listMeetings,
    patchMeeting,
    prepareMeeting,
    reminderMeetings,
} from "@/lib/meetings/service";
import { cancelIntendedPlacement } from "@/lib/pipeline/share-intent";

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
        false,
        true,
    ])("hides outcomes from web, recorder and MCP before publication (withdrawn=%s)", async (withdrawn) => {
        const meeting = await create("org-folder");
        const point = await addPoint("owner", meeting.id, { text: "Plan" });
        await recording("rec");
        await attachAgenda("owner", meeting.id, "rec");
        if (withdrawn)
            await cancelIntendedPlacement("owner", "rec", "org-folder");
        const [agenda] = await db.select().from(meetingAgendas);
        await db.insert(aiEnhancements).values({
            id: "summary",
            itemId: "rec",
            userId: "owner",
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
        principal.userId = "other";
        const context = { params: Promise.resolve({ id: meeting.id }) };
        const web = await (
            await readMeeting(
                new Request("https://example.com/api/meetings/agenda"),
                context,
            )
        ).json();
        const recorder = await (
            await readRecorder(
                new Request(
                    "https://example.com/api/v1/recorder/agendas/agenda",
                ),
                context,
            )
        ).json();
        const tool = MEETING_TOOLS.find(
            (entry) => entry.name === "get_meeting",
        );
        if (!tool) throw new Error("Tool missing");
        const mcp = await tool.run(
            {
                caller: {
                    kind: "user",
                    userId: "other",
                    email: "other@example.com",
                    subject: "other",
                    clientId: "test",
                    orgUserId: "org",
                    roles: new Set(["tasks:read"]),
                },
                touched: [],
            },
            { meetingId: meeting.id },
        );
        for (const detail of [
            web,
            recorder,
            (mcp as { meeting: unknown }).meeting,
        ]) {
            expect(detail).toMatchObject({
                attachedRecording: { visible: false },
            });
            expect(detail).not.toHaveProperty("outcomeUnplanned");
            expect(detail).not.toHaveProperty("outcomeSummaryId");
            expect(JSON.stringify(detail)).not.toContain(
                "Confidential transcript topic",
            );
        }
        expect(recorder.points[0]).not.toHaveProperty("summaryOutcome");
        for (const detail of [web, (mcp as { meeting: unknown }).meeting])
            expect(detail).toMatchObject({
                points: [{ summaryOutcome: null }],
            });
        expect(await getMeeting("owner", meeting.id)).toMatchObject({
            outcomeUnplanned: ["Confidential transcript topic"],
            points: [{ summaryOutcome: "covered" }],
        });
        if (!withdrawn) {
            await db.insert(recordingFolderAssignments).values({
                userId: "owner",
                itemId: "rec",
                folderId: "org-folder",
            });
            expect(await getMeeting("other", meeting.id)).toMatchObject({
                outcomeUnplanned: ["Confidential transcript topic"],
                points: [{ summaryOutcome: "covered" }],
            });
        }
    });
    it("does not carry a narrower folder's series agenda into an Organization folder", async () => {
        await db.insert(folderShares).values({
            userId: "other",
            receiverUserId: "owner",
            folderId: "other-folder",
            state: "accepted",
        });
        const first = await prepareMeeting("other", {
            folderId: "other-folder",
            calendarEventId: "e1",
        });
        await addPoint("other", first.id, { text: "Narrow audience topic" });
        await patchMeeting("other", first.id, { state: "held" });
        await expect(
            requireMeetingAccess("curator", first.id),
        ).rejects.toMatchObject({ statusCode: 404 });
        calendar.read.mockImplementationOnce(
            async (userId: string, id: string) => ({
                ...eventFor(userId, id),
                start: "2026-11-10T10:00:00Z",
                end: "2026-11-10T11:00:00Z",
            }),
        );
        const second = await prepareMeeting("owner", {
            folderId: "org-folder",
            calendarEventId: "e2",
        });
        const seen = await getMeeting("curator", second.id);
        expect(seen).toMatchObject({ suggestions: [] });
    });
    it("falls back to the previous held agenda in the same folder when its series has no predecessor", async () => {
        const first = await create();
        const point = await addPoint("owner", first.id, { text: "Carry me" });
        await patchMeeting("owner", first.id, { state: "held" });
        calendar.read.mockImplementationOnce(
            async (userId: string, id: string) => ({
                ...eventFor(userId, id),
                start: "2026-11-10T10:00:00Z",
                end: "2026-11-10T11:00:00Z",
            }),
        );
        const second = await prepareMeeting("owner", {
            folderId: "owner-folder",
            calendarEventId: "new-series",
        });
        expect(
            await db
                .select()
                .from(agendaSuggestions)
                .where(eq(agendaSuggestions.agendaId, second.id)),
        ).toMatchObject([{ originPointId: point.id }]);
    });
    it("starts and ends idempotently despite a concurrent point edit, preserving legacy metadata conflicts", async () => {
        const meeting = await create("org-folder");
        await addPoint("other", meeting.id, { text: "Concurrent" });
        const live = await patchMeeting("owner", meeting.id, {
            state: "live",
            version: 0,
        });
        expect(
            await patchMeeting("owner", meeting.id, {
                state: "live",
                version: 0,
            }),
        ).toMatchObject({
            liveStartedAt: !live.unchanged ? live.liveStartedAt : null,
        });
        const held = await patchMeeting("owner", meeting.id, {
            state: "held",
            version: 0,
        });
        expect(
            await patchMeeting("owner", meeting.id, {
                state: "held",
                version: 0,
            }),
        ).toMatchObject({
            liveEndedAt: !held.unchanged ? held.liveEndedAt : null,
        });
        await expect(
            patchMeeting("owner", meeting.id, { title: "Legacy", version: 0 }),
        ).rejects.toMatchObject({ statusCode: 409 });
        const current = await getMeeting("owner", meeting.id);
        await expect(
            patchMeeting("owner", meeting.id, {
                title: "Legacy",
                version: current.version,
            }),
        ).resolves.toMatchObject({ title: "Legacy" });
    });
    it("compares only previous values of changed metadata fields", async () => {
        const meeting = await create("org-folder");
        await addPoint("other", meeting.id, { text: "Tick" });
        await expect(
            patchMeeting("owner", meeting.id, {
                title: "New title",
                previous: { title: "Acme" },
                version: 0,
            }),
        ).resolves.toMatchObject({ title: "New title" });
        await expect(
            patchMeeting("owner", meeting.id, {
                title: "Stale title",
                previous: { title: "Acme" },
            }),
        ).rejects.toMatchObject({ statusCode: 409 });
        await expect(
            patchMeeting("owner", meeting.id, {
                start: "2026-11-03T10:15:00Z",
                previous: { start: start.toISOString() },
            }),
        ).resolves.toMatchObject({ title: "New title" });
        await expect(
            patchMeeting("owner", meeting.id, {
                title: "No base",
                previous: {},
            }),
        ).rejects.toThrow();
    });
    it("serves a stale match immediately and defers the Google refresh", async () => {
        background.jobs.length = 0;
        const meeting = await prepareMeeting("owner", {
            folderId: "owner-folder",
            calendarEventId: "e1",
        });
        await db
            .update(meetingAgendas)
            .set({ calendarRefreshedAt: new Date(0) })
            .where(eq(meetingAgendas.id, meeting.id));
        calendar.read.mockClear();
        calendar.read.mockImplementation(() => new Promise(() => {}));
        const response = await matchRoute(
            new Request(
                `https://example.com/api/v1/recorder/agendas/match?at=${start.toISOString()}&meetCode=abc-defg-hij`,
            ),
        );
        expect((await response.json()).data).toMatchObject([
            { id: meeting.id },
        ]);
        expect(calendar.read).not.toHaveBeenCalled();
        expect(background.jobs).toHaveLength(1);
    });
    it("invalidates the detail cursor when a background Calendar refresh changes invitees", async () => {
        background.jobs.length = 0;
        const meeting = await prepareMeeting("owner", {
            folderId: "owner-folder",
            calendarEventId: "e1",
        });
        const before = await getMeeting("owner", meeting.id);
        await db
            .update(meetingAgendas)
            .set({ calendarRefreshedAt: new Date(0) })
            .where(eq(meetingAgendas.id, meeting.id));
        calendar.read.mockImplementation(
            async (userId: string, id: string) => ({
                ...eventFor(userId, id),
                attendees: [
                    { name: "Marek Dvořák", email: "marek@example.com" },
                ],
            }),
        );
        await matchRoute(
            new Request(
                `https://example.com/api/v1/recorder/agendas/match?at=${start.toISOString()}&meetCode=abc-defg-hij`,
            ),
        );
        await Promise.all(background.jobs.map((run) => run()));
        expect(
            await getMeeting("owner", meeting.id, before.cursor),
        ).toMatchObject({
            unchanged: false,
            invitees: [{ name: "Marek Dvořák" }],
        });
    });
    it("does not call Google for next-meeting without an attached agenda", async () => {
        await recording("rec");
        await db
            .update(recordings)
            .set({ calendarSeriesId: "series" })
            .where(eq(recordings.id, "rec"));
        await expect(nextMeeting("owner", "rec")).rejects.toMatchObject({
            statusCode: 404,
        });
        expect(calendar.read).not.toHaveBeenCalled();
        expect(calendar.upcoming).not.toHaveBeenCalled();
    });
    it("returns indexed presence and owner-visible candidate counts", async () => {
        await recording("rec");
        const projection = () =>
            db
                .select({
                    hasAgenda: recordingHasAgenda(),
                    agendaCandidateCount: recordingAgendaCandidateCount(
                        "owner",
                        "org",
                    ),
                })
                .from(recordings)
                .innerJoin(chatterItems, eq(chatterItems.id, recordings.id))
                .where(
                    and(
                        eq(recordings.id, "rec"),
                        eq(recordings.userId, "owner"),
                    ),
                );
        expect(await projection()).toEqual([
            { hasAgenda: false, agendaCandidateCount: 0 },
        ]);
        await prepareMeeting("other", {
            folderId: "other-folder",
            title: "Invisible",
            start: start.toISOString(),
            end: new Date(start.getTime() + 3600000).toISOString(),
        });
        expect(await projection()).toEqual([
            { hasAgenda: false, agendaCandidateCount: 0 },
        ]);
        const meeting = await create();
        expect(await projection()).toEqual([
            { hasAgenda: false, agendaCandidateCount: 1 },
        ]);
        await attachAgenda("owner", meeting.id, "rec");
        expect(await projection()).toEqual([
            { hasAgenda: true, agendaCandidateCount: 0 },
        ]);
    });
    it("answers unchanged after absorption without refreshing Calendar and changes the cursor at publication", async () => {
        const meeting = await prepareMeeting("owner", {
            folderId: "org-folder",
            calendarEventId: "e1",
        });
        await recording("rec");
        await attachAgenda("owner", meeting.id, "rec");
        await db
            .update(meetingAgendas)
            .set({ calendarRefreshedAt: new Date(0) })
            .where(eq(meetingAgendas.id, meeting.id));
        calendar.read.mockClear();
        const hidden = await getMeeting("other", meeting.id);
        expect(
            await getMeeting("other", meeting.id, hidden.cursor),
        ).toMatchObject({ unchanged: true });
        expect(calendar.read).not.toHaveBeenCalled();
        await db
            .insert(recordingFolderAssignments)
            .values({ userId: "owner", itemId: "rec", folderId: "org-folder" });
        const visible = await getMeeting("other", meeting.id, hidden.cursor);
        expect(visible).toMatchObject({
            unchanged: false,
            attachedRecording: { visible: true },
        });
        expect(visible.cursor).not.toBe(hidden.cursor);
        principal.userId = "other";
        const response = await readRecorder(
            new Request(
                `https://example.com/api/v1/recorder/agendas/agenda?since=${visible.cursor}`,
            ),
            { params: Promise.resolve({ id: meeting.id }) },
        );
        expect(await response.json()).toMatchObject({ unchanged: true });
    });
    it("retains upcoming meetings when there are more than 500 older meetings", async () => {
        await db.insert(chatterItems).values(
            Array.from({ length: 501 }, (_, i) => ({
                id: `past-${i}`,
                userId: "owner",
                kind: "meeting" as const,
                title: encryptText("Past"),
                occurredAt: new Date(0),
            })),
        );
        await db.insert(meetingAgendas).values(
            Array.from({ length: 501 }, (_, i) => ({
                userId: "owner",
                meetingItemId: `past-${i}`,
                plannedStart: new Date(0),
                timeSet: true,
                state: "held" as const,
            })),
        );
        const upcoming = await create();
        expect(
            (await listMeetings("owner", { includePast: true })).some(
                (row) => row.id === upcoming.id,
            ),
        ).toBe(true);
    });
    it("filters reminders to authors, point/tick/note editors and stored invitees", async () => {
        const meeting = await create("org-folder");
        const point = await addPoint("owner", meeting.id, { text: "Point" });
        expect(await reminderMeetings("other", { includePast: true })).toEqual(
            [],
        );
        await changePoint("other", meeting.id, point.id, {
            version: 0,
            note: "Editor's note",
        });
        expect(
            await reminderMeetings("other", { includePast: true }),
        ).toMatchObject([{ id: meeting.id }]);
        await changePoint("curator", meeting.id, point.id, {
            version: 1,
            discussed: true,
        });
        expect(
            await reminderMeetings("other", { includePast: true }),
        ).toMatchObject([{ id: meeting.id }]);
        expect(
            await reminderMeetings("stranger", { includePast: true }),
        ).toEqual([]);
        await patchMeeting("owner", meeting.id, {
            calendarEventId: "editor-event",
        });
        await db
            .update(meetingAgendas)
            .set({ calendarRefreshedAt: new Date(0) })
            .where(eq(meetingAgendas.id, meeting.id));
        await getMeeting("owner", meeting.id);
        expect(
            await reminderMeetings("other", { includePast: true }),
        ).toMatchObject([{ id: meeting.id }]);
        const linked = await prepareMeeting("owner", {
            folderId: "org-folder",
            calendarEventId: "invitee-event",
        });
        calendar.connection.mockResolvedValue({
            status: "active",
            email: " JITKA@example.com ",
            scopes: [],
        });
        calendar.read.mockClear();
        expect(
            await reminderMeetings("stranger", { includePast: true }),
        ).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: linked.id }),
            ]),
        );
        expect(calendar.read).not.toHaveBeenCalled();
    });
    it("rolls back failed attachment to a savepoint and still creates the recording", async () => {
        const meeting = await create();
        const log = vi.spyOn(console, "error").mockImplementation(() => {});
        await db.transaction(async (tx) => {
            await insertAudioItem(
                tx,
                {
                    id: "arrival",
                    userId: "owner",
                    title: encryptText("Arrival"),
                    occurredAt: start,
                    endTime: new Date(start.getTime() + 3600000),
                    duration: 3600000,
                    filesize: 1,
                    fileMd5: "a".repeat(32),
                    storageType: "local",
                    storagePath: "arrival.ogg",
                    deviceSn: "test",
                    plaudFileId: "arrival",
                    plaudVersion: "1",
                },
                { pipeline: "legacy" },
            );
            const broken = new Proxy(tx, {
                get(target, key) {
                    if (key === "transaction")
                        return (
                            _run: (savepoint: typeof tx) => Promise<void>,
                        ) =>
                            target.transaction(async (savepoint) => {
                                await savepoint.insert(agendaPoints).values({
                                    id: "partial-attachment",
                                    agendaId: meeting.id,
                                    userId: "owner",
                                    text: encryptText("Partial write"),
                                });
                                await savepoint.insert(agendaPoints).values({
                                    agendaId: "missing-agenda",
                                    userId: "owner",
                                    text: encryptText(
                                        "Private content must not be logged",
                                    ),
                                });
                            });
                    const value = Reflect.get(target, key);
                    return typeof value === "function"
                        ? value.bind(target)
                        : value;
                },
            });
            await attachArrivingRecordingInTx(
                broken,
                "owner",
                "arrival",
                "arrival",
            );
        });
        expect(
            await db
                .select()
                .from(recordings)
                .where(eq(recordings.id, "arrival")),
        ).toHaveLength(1);
        expect(
            await db
                .select()
                .from(agendaPoints)
                .where(eq(agendaPoints.id, "partial-attachment")),
        ).toHaveLength(0);
        expect(log).toHaveBeenCalled();
        expect(JSON.stringify(log.mock.calls)).not.toContain("Private content");
        log.mockRestore();
    });
});
