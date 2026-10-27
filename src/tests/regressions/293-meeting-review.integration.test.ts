import { PgDialect } from "drizzle-orm/pg-core";
import { agendaMailDerivedContent } from "@/db/queries/agenda-mail-sources";
import { agendaSuggestionInputs } from "@/db/queries/agenda-suggestions";
import { notifyFolderReceiversInTx } from "@/db/queries/item-shares";
import * as meetingQueries from "@/db/queries/meetings";
import {
    archivedMeetingSchema,
    collectArchivedMeetings,
} from "@/lib/export/meetings";
import {
    addRecordingToFolder,
    assertCategorizableFolders,
    moveRecordingBetweenFolders,
} from "@/lib/folders/folders";
import { resolveMeetingRoster } from "@/lib/integrations/google/meeting-roster";
import { learnJobHandler } from "@/lib/learn/learn-job-handler";
import type { McpCaller } from "@/lib/mcp/caller";
import { MEETING_TOOLS } from "@/lib/mcp/tools/meetings";
import { RECORDING_TOOLS } from "@/lib/mcp/tools/recordings";
import { exportMeetingCalendar, meetingMarkdown } from "@/lib/meetings/export";
import {
    agendaPlanBlock,
    loadRecordingAgenda,
} from "@/lib/meetings/pipeline-context";
import { restoreMeetings } from "@/lib/meetings/restore";
import { changeFolderShare } from "@/lib/sharing/folder-shares";
import { taskViewerById } from "@/lib/tasks/access";
import { upsertEnhancement } from "@/lib/transcription/persist";
import { seededAudioProfileSettings } from "@/tests/profiles/seeded-profile-fixture";

vi.mock("@/lib/integrations/google/meet-speaker-candidates", () => ({
    getMeetSpeakerCandidates: async () => [],
}));
const learn = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock("@/lib/learn/chat-clients", () => ({
    learnChatClients: async () => ({
        chat: { complete: learn.complete },
        provider: "Custom",
        model: "test",
        payerUserId: "other",
    }),
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));

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
    agendaPoints,
    agendaSuggestions,
    agendaTasks,
    aiEnhancements,
    chatterItems,
    folderShares,
    itemProcessing,
    itemShares,
    learnRuns,
    mailPendingShares,
    meetingAgendas,
    processingProfileRevisions,
    processingProfiles,
    receivedFolderAttachments,
    recordingFolderAssignments,
    recordingFolders,
    recordings,
    recordingTasks,
    taskMentions,
    transcriptions,
    users,
} from "@/db/schema";
import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
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
        SELF_HOST_MODE: "shared",
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
    assertOrgScopeWritable: () => {
        if (principal.frozen)
            throw new AppError(
                ErrorCode.FORBIDDEN,
                "Organization is read-only",
                403,
            );
    },
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
    roster: vi.fn(),
    write: vi.fn(),
    upcoming: vi.fn(),
    connection: vi.fn(),
}));
vi.mock("@/lib/integrations/google/calendar-events", () => ({
    getCalendarEvent: calendar.read,
    listUpcomingCalendarEvents: calendar.upcoming,
    listCalendarEventsForRecording: calendar.roster,
    writeCalendarAgenda: calendar.write,
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
const principal = vi.hoisted(() => ({ userId: "owner", frozen: false }));
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
import {
    agendaCandidates,
    attachAgenda,
    attachArrivingRecordingInTx,
    detachAgenda,
} from "@/lib/meetings/attachment";
import {
    addPoint,
    changeAgendaTask,
    changePoint,
    decideSuggestion,
    getMeeting,
    listMeetings,
    patchMeeting,
    prepareMeeting,
    removeMeetingFromFolder,
} from "@/lib/meetings/service";

const databaseUrl = getTestDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const start = new Date("2026-11-03T10:00:00Z");

suite("meeting planning server (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            databaseUrl ?? "",
            "meeting_review",
        );
        ref.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120000);
    afterAll(async () => {
        ref.current = null;
        await database?.dispose();
    }, 60000);
    beforeEach(async () => {
        principal.userId = "owner";
        principal.frozen = false;
        calendar.roster.mockReset().mockResolvedValue([]);
        calendar.write.mockReset().mockResolvedValue({ eventId: "event" });
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

    async function share(
        folderId = "owner-folder",
        userId = "owner",
        receiverUserId = "other",
    ) {
        await db.insert(folderShares).values({
            id: `${folderId}-${receiverUserId}`,
            userId,
            receiverUserId,
            folderId,
            state: "accepted",
        });
    }
    async function direct(
        itemId: string,
        userId = "owner",
        receiverUserId = "stranger",
    ) {
        await db
            .insert(itemShares)
            .values({ userId, itemId, receiverUserId, state: "accepted" });
    }
    const summary = (
        agenda: NonNullable<Awaited<ReturnType<typeof loadRecordingAgenda>>>,
        outcome = {
            covered: agenda.points.map((point) => point.id),
            notCovered: [] as string[],
            unplanned: ["Transcript topic"],
        } as {
            covered: string[];
            notCovered: string[];
            unplanned: string[];
        } | null,
        view: "private" | "org" = "private",
    ) =>
        upsertEnhancement({
            userId: "owner",
            recordingId: "rec",
            transcriptionId: null,
            summary: "Current summary",
            keyPoints: [],
            actionItems: [],
            source: "riffado",
            provider: "test",
            model: "test",
            pipeline: "legacy",
            view,
            agenda: { ...agenda, outcome },
        });

    it.each([
        "organization",
        "person",
        "folder",
    ])("does not auto-attach an in-folder recording exposed more broadly through %s", async (exposure) => {
        const meeting = await create();
        await recording("rec", "owner-folder");
        if (exposure === "organization")
            await db.insert(recordingFolderAssignments).values({
                itemId: "rec",
                userId: "owner",
                folderId: "org-folder",
            });
        else if (exposure === "person") await direct("rec");
        else {
            await share("other-folder", "other", "owner");
            await db.insert(recordingFolderAssignments).values({
                itemId: "rec",
                userId: "owner",
                folderId: "other-folder",
            });
        }
        await db.transaction((tx) =>
            attachArrivingRecordingInTx(tx, "owner", "rec", "rec"),
        );
        expect(await getMeeting("owner", meeting.id)).toMatchObject({
            recordingItemId: null,
        });
        expect(await agendaCandidates("owner", "rec")).toMatchObject([
            { id: meeting.id },
        ]);
    });
    it("does not auto-publish a recording when an agenda also has a broader placement", async () => {
        const meeting = await create();
        await db.insert(recordingFolderAssignments).values({
            itemId: meeting.meeting.unchanged
                ? ""
                : (meeting.meeting.meetingItemId ?? ""),
            userId: "owner",
            folderId: "org-folder",
        });
        await recording("rec", "owner-folder");
        await db.transaction((tx) =>
            attachArrivingRecordingInTx(tx, "owner", "rec", "rec"),
        );
        expect(await getMeeting("owner", meeting.id)).toMatchObject({
            recordingItemId: null,
        });
    });
    it.each([
        "organization",
        "person",
        "folder",
    ])("refuses a non-author's explicit attach with a wider %s audience", async (exposure) => {
        await share();
        const meeting = await create();
        await recording("rec", undefined, "other");
        if (exposure === "organization")
            await db.insert(recordingFolderAssignments).values({
                itemId: "rec",
                userId: "other",
                folderId: "org-folder",
            });
        else if (exposure === "person") await direct("rec", "other");
        else {
            await share("other-folder", "other", "stranger");
            await db.insert(recordingFolderAssignments).values({
                itemId: "rec",
                userId: "other",
                folderId: "other-folder",
            });
        }
        await db
            .update(users)
            .set({ uiLocale: "cs-CZ" })
            .where(eq(users.id, "other"));
        await expect(
            attachAgenda("other", meeting.id, "rec"),
        ).rejects.toMatchObject({
            statusCode: 409,
            details: { reason: "recording_audience_exceeds_agenda" },
            message:
                "Tato nahrávka je sdílena s lidmi, kteří nevidí agendu. Před připojením omezte její sdílení.",
        });
        expect(await getMeeting("owner", meeting.id)).toMatchObject({
            recordingItemId: null,
        });
        expect(
            await db
                .select()
                .from(recordingFolderAssignments)
                .where(
                    and(
                        eq(recordingFolderAssignments.itemId, "rec"),
                        eq(recordingFolderAssignments.folderId, "owner-folder"),
                    ),
                ),
        ).toEqual([]);
    });
    it("allows a non-author's recording within the agenda audience and preserves author attachment", async () => {
        await share();
        const meeting = await create();
        await recording("rec", undefined, "other");
        await attachAgenda("other", meeting.id, "rec");
        expect(await getMeeting("other", meeting.id)).toMatchObject({
            recordingItemId: "rec",
        });
        await detachAgenda("other", "rec");
        await recording("owner-rec", "org-folder");
        await attachAgenda("owner", meeting.id, "owner-rec");
        expect(await getMeeting("owner", meeting.id)).toMatchObject({
            recordingItemId: "owner-rec",
        });
    });
    it("conceals hidden recording and task-source identifiers while retaining the hidden signal", async () => {
        const meeting = await create("org-folder");
        await recording("source");
        await patchMeeting("owner", meeting.id, { taskSourceItemId: "source" });
        await recording("rec");
        await attachAgenda("owner", meeting.id, "rec");
        expect(await getMeeting("other", meeting.id)).toMatchObject({
            attachedRecording: { visible: false },
            recordingItemId: null,
            taskSourceItemId: null,
            snapshotSourceItemId: null,
            taskSource: null,
            redirectTo: null,
        });
        expect(await getMeeting("owner", meeting.id)).toMatchObject({
            recordingItemId: "rec",
            taskSourceItemId: "source",
            snapshotSourceItemId: "source",
        });
    });
    it("refuses notes and membership changes for invisible agenda tasks", async () => {
        await share();
        await recording("source");
        await db.insert(recordingTasks).values({
            id: "task",
            itemId: "source",
            userId: "owner",
            status: "open",
            text: encryptText("Private task"),
            source: "manual",
        });
        const meeting = await create();
        await patchMeeting("owner", meeting.id, { taskSourceItemId: "source" });
        for (const change of [
            { note: "Foreign note" },
            { removed: true },
            { removed: false },
        ])
            await expect(
                changeAgendaTask("other", meeting.id, "task", change),
            ).rejects.toMatchObject({ statusCode: 404 });
        expect(await db.select().from(agendaTasks)).toMatchObject([
            { note: null, removedAt: null },
        ]);
        await changeAgendaTask("owner", meeting.id, "task", {
            note: "Own note",
        });
    });
    it.each([
        "owner",
        "other",
    ])("unfiles and bumps the agenda version under edit access for %s", async (actor) => {
        await share();
        const meeting = await prepareMeeting("other", {
            folderId: "owner-folder",
            title: "Contributed plan",
        });
        const before = await getMeeting("other", meeting.id);
        if (before.unchanged) throw new Error("Missing detail");
        await removeMeetingFromFolder(actor, meeting.id, "owner-folder");
        expect(await getMeeting("other", meeting.id)).toMatchObject({
            version: before.version + 1,
            folders: [],
        });
        expect(
            await db
                .select()
                .from(chatterItems)
                .where(eq(chatterItems.id, before.meetingItemId ?? "")),
        ).toHaveLength(1);
    });
    it("refuses absorbed and frozen Organization meeting unfiling", async () => {
        const meeting = await create("org-folder");
        principal.frozen = true;
        await expect(
            removeMeetingFromFolder("owner", meeting.id, "org-folder"),
        ).rejects.toThrow("read-only");
        principal.frozen = false;
        await recording("rec");
        await attachAgenda("owner", meeting.id, "rec");
        await expect(
            removeMeetingFromFolder("owner", meeting.id, "org-folder"),
        ).rejects.toMatchObject({ statusCode: 409 });
    });
    it("Learn reads only points authored by the recording owner and omits unattributed notes", async () => {
        await share();
        const meeting = await create();
        const foreign = await addPoint("owner", meeting.id, {
            text: "Author topic",
        });
        const own = await addPoint("other", meeting.id, {
            text: "Recorder topic",
            parentId: foreign.id,
        });
        await changePoint("owner", meeting.id, own.id, {
            version: own.version,
            note: "Author's live note",
        });
        await recording("rec", undefined, "other");
        await attachAgenda("other", meeting.id, "rec");
        const learn = await loadRecordingAgenda("other", "rec", {
            authoredByUserId: "other",
        });
        expect(learn?.points).toMatchObject([
            { id: own.id, parentId: null, text: "Recorder topic", note: null },
        ]);
        expect(agendaPlanBlock(learn)).not.toContain("Author topic");
        const normal = await loadRecordingAgenda("other", "rec");
        expect(normal?.points).toHaveLength(2);
        expect(agendaPlanBlock(normal)).toContain("Author's live note");
    });
    it.each([
        "tick",
        "edit",
        "deleted-point",
    ])("commits summary coverage by current point id after a concurrent %s", async (change) => {
        const meeting = await create();
        const point = await addPoint("owner", meeting.id, { text: "Topic" });
        await recording("rec");
        await attachAgenda("owner", meeting.id, "rec");
        const loaded = await loadRecordingAgenda("owner", "rec");
        if (!loaded) throw new Error("Missing plan");
        await db
            .update(meetingAgendas)
            .set({ version: loaded.version + 1 })
            .where(eq(meetingAgendas.id, loaded.id));
        if (change === "deleted-point")
            await db.delete(agendaPoints).where(eq(agendaPoints.id, point.id));
        else
            await db
                .update(agendaPoints)
                .set(
                    change === "tick"
                        ? { discussedAt: start }
                        : { text: encryptText("Edited topic") },
                )
                .where(eq(agendaPoints.id, point.id));
        expect(await summary(loaded)).toEqual({ committed: true });
        expect(await db.select().from(aiEnhancements)).toHaveLength(1);
        expect(await getMeeting("owner", meeting.id)).toMatchObject({
            outcomeUnplanned: ["Transcript topic"],
            points:
                change === "deleted-point"
                    ? []
                    : [{ id: point.id, summaryOutcome: "covered" }],
        });
    });
    it("preserves previous outcomes on a full summary regeneration without agendaOutcome", async () => {
        const meeting = await create();
        await addPoint("owner", meeting.id, { text: "Topic" });
        await recording("rec");
        await attachAgenda("owner", meeting.id, "rec");
        const agenda = await loadRecordingAgenda("owner", "rec");
        if (!agenda) throw new Error("Missing agenda");
        await summary(agenda);
        const before = await getMeeting("owner", meeting.id);
        if (before.unchanged) throw new Error("Missing detail");
        expect(await summary(agenda, null)).toEqual({ committed: true });
        expect(await getMeeting("owner", meeting.id)).toMatchObject({
            outcomeSummaryId: before.outcomeSummaryId,
            outcomeUnplanned: ["Transcript topic"],
            points: [{ summaryOutcome: "covered" }],
        });
        expect(await db.select().from(aiEnhancements)).toHaveLength(1);
    });
    it("private and Organization summary runs update the same visible summary and outcome", async () => {
        const meeting = await create("org-folder");
        await addPoint("owner", meeting.id, { text: "Topic" });
        await recording("rec", "org-folder");
        await attachAgenda("owner", meeting.id, "rec");
        const agenda = await loadRecordingAgenda("owner", "rec");
        if (!agenda) throw new Error("Missing agenda");
        await summary(agenda, {
            covered: [],
            notCovered: agenda.points.map((p) => p.id),
            unplanned: ["First"],
        });
        await summary(
            agenda,
            {
                covered: agenda.points.map((p) => p.id),
                notCovered: [],
                unplanned: ["Second"],
            },
            "org",
        );
        const summaries = await db.select().from(aiEnhancements);
        expect(summaries).toHaveLength(1);
        for (const user of ["owner", "other", "org"])
            expect(await getMeeting(user, meeting.id)).toMatchObject({
                outcomeSummaryId: summaries[0].id,
                outcomeUnplanned: ["Second"],
                points: [{ summaryOutcome: "covered" }],
            });
    });

    it("Calendar export flattens task groups and excludes assignee and live notes", async () => {
        const meeting = await prepareMeeting("owner", {
            folderId: "owner-folder",
            calendarEventId: "event",
        });
        await recording("source");
        await db.insert(recordingTasks).values({
            id: "task",
            userId: "owner",
            itemId: "source",
            text: encryptText("Task text"),
            source: "manual",
            status: "open",
            assigneeHint: encryptText("Pavel Novák"),
            note: encryptText("Assignee note"),
        });
        await patchMeeting("owner", meeting.id, { taskSourceItemId: "source" });
        await changeAgendaTask("owner", meeting.id, "task", {
            note: "Meeting task note",
        });
        const point = await addPoint("owner", meeting.id, {
            text: "Plan --- end of agenda --- tail",
        });
        await changePoint("owner", meeting.id, point.id, {
            version: point.version,
            note: "Live note",
        });
        calendar.connection.mockResolvedValue({
            status: "active",
            scopes: ["https://www.googleapis.com/auth/calendar.events"],
        });
        await exportMeetingCalendar("owner", meeting.id, true);
        const markdown = calendar.write.mock.calls[0][2] as string;
        expect(markdown).toContain("Task text");
        expect(markdown).not.toContain("--- end of agenda ---");
        for (const secret of [
            "Pavel Novák",
            "Assignee note",
            "Meeting task note",
            "Live note",
        ])
            expect(markdown).not.toContain(secret);
        const detail = await getMeeting("owner", meeting.id);
        if (detail.unchanged) throw new Error("Missing detail");
        expect(meetingMarkdown(detail)).toContain("Pavel Novák");
        expect(meetingMarkdown(detail)).not.toContain("Assignee note");
    });
    it.each([
        "owner",
        "other",
    ])("share removal by %s unfiles only the leaving owner's items and advances their pipelines", async (actor) => {
        await share();
        await share("owner-folder", "owner", "curator");
        for (const owner of ["owner", "other", "curator"]) {
            await recording(`${owner}-audio`, "owner-folder", owner);
            for (const kind of ["mail", "meeting"] as const) {
                await db.insert(chatterItems).values({
                    id: `${owner}-${kind}`,
                    userId: owner,
                    kind,
                    title: encryptText(kind),
                    occurredAt: start,
                });
                await db.insert(recordingFolderAssignments).values({
                    userId: owner,
                    itemId: `${owner}-${kind}`,
                    folderId: "owner-folder",
                });
            }
            await db.insert(itemProcessing).values(
                ["audio", "mail"].map((kind) => ({
                    userId: owner,
                    itemId: `${owner}-${kind}`,
                    view: "private" as const,
                    requestedGeneration: 2,
                    processedGeneration: 2,
                })),
            );
        }
        await changeFolderShare(actor, "owner-folder-other", {
            action: "remove",
            version: 0,
        });
        const placements = await db
            .select()
            .from(recordingFolderAssignments)
            .where(eq(recordingFolderAssignments.folderId, "owner-folder"));
        expect(placements.map((row) => row.itemId).sort()).toEqual(
            [
                "owner-audio",
                "owner-mail",
                "owner-meeting",
                "curator-audio",
                "curator-mail",
                "curator-meeting",
            ].sort(),
        );
        const items = await db.select().from(chatterItems);
        expect(items).toHaveLength(9);
        const processing = await db.select().from(itemProcessing);
        expect(
            processing
                .filter((row) => row.userId === "other")
                .map((row) => row.requestedGeneration),
        ).toEqual([3, 3]);
        expect(
            processing
                .filter((row) => row.userId !== "other")
                .map((row) => row.requestedGeneration),
        ).toEqual([2, 2, 2, 2]);
    });
    it("uses selective notification recipients and notifies the correct contributor when pruning an ancestor", async () => {
        await share();
        await share("owner-folder", "owner", "curator");
        await db.insert(recordingFolders).values({
            id: "nested",
            userId: "owner",
            parentId: "owner-folder",
            name: encryptText("Nested"),
            nameHash: lookupHash("Nested"),
            kind: "custom",
        });
        await share("nested", "owner", "other");
        await recording("rec", "owner-folder", "other");
        await db.insert(users).values(
            Array.from({ length: 1000 }, (_, i) => ({
                id: `unrelated-${i}`,
                email: `unrelated-${i}@example.com`,
            })),
        );
        const notifications: unknown[] = [];
        const listener = await database.sql.listen(
            "riffado_personal",
            (payload) => notifications.push(JSON.parse(payload)),
        );
        try {
            await addRecordingToFolder({
                userId: "other",
                recordingId: "rec",
                folderId: "nested",
            });
            await vi.waitFor(() =>
                expect(notifications).toContainEqual({
                    type: "share",
                    userId: "curator",
                }),
            );
            expect(notifications).not.toContainEqual({
                type: "share",
                userId: "other",
            });
            expect(
                await db
                    .select()
                    .from(recordingFolderAssignments)
                    .where(eq(recordingFolderAssignments.itemId, "rec")),
            ).toMatchObject([{ folderId: "nested", userId: "other" }]);
            await db.transaction(async (tx) => {
                const captured = vi.spyOn(tx, "execute");
                await notifyFolderReceiversInTx(tx, "other", "rec", "nested");
                const statement = captured.mock.calls[0]?.[0];
                if (!statement || typeof statement === "string")
                    throw new Error("Missing notification query");
                const query = new PgDialect().sqlToQuery(statement.getSQL());
                const result = await database.sql.unsafe(
                    `explain (analyze, format json) ${query.sql}`,
                    query.params as string[],
                );
                const plan = result[0]["QUERY PLAN"] as {
                    Plan: Record<string, unknown>;
                }[];
                function visit(node: Record<string, unknown>) {
                    if (
                        String(node["Subplan Name"] ?? "").startsWith("SubPlan")
                    )
                        expect(Number(node["Actual Loops"])).toBeLessThan(5);
                    for (const child of (node.Plans ?? []) as Record<
                        string,
                        unknown
                    >[])
                        visit(child);
                }
                visit(plan[0].Plan);
                captured.mockRestore();
            });
        } finally {
            await listener.unlisten();
        }
    });
    it("mail scope filters direct, task and merged-mail suggestion sources and accepted points", async () => {
        const meeting = await create();
        await db.insert(chatterItems).values({
            id: "mail",
            userId: "other",
            kind: "mail",
            title: encryptText("Private mail"),
            occurredAt: start,
        });
        await recording("audio");
        await db.insert(recordingTasks).values([
            {
                id: "mail-task",
                userId: "other",
                itemId: "mail",
                status: "open",
                source: "manual",
                text: encryptText("Mail task"),
            },
            {
                id: "merged-task",
                userId: "owner",
                itemId: "audio",
                status: "open",
                source: "manual",
                text: encryptText("Merged task"),
                note: encryptText("Mail note"),
            },
        ]);
        await db.insert(taskMentions).values({
            userId: "other",
            taskId: "merged-task",
            itemId: "mail",
            view: "private",
            statementAt: start,
            matchDecision: "accepted",
        });
        await db.insert(agendaSuggestions).values(
            [
                {
                    id: "mail-item",
                    sources: { itemIds: ["mail"], taskIds: [] },
                },
                {
                    id: "mail-task",
                    sources: { itemIds: [], taskIds: ["mail-task"] },
                },
                {
                    id: "merged-task",
                    sources: { itemIds: [], taskIds: ["merged-task"] },
                },
                {
                    id: "mixed",
                    sources: { itemIds: ["audio", "mail"], taskIds: [] },
                },
                { id: "audio", sources: { itemIds: ["audio"], taskIds: [] } },
            ].map((suggestion) => ({
                ...suggestion,
                agendaId: meeting.id,
                userId: "owner",
                kind: "ai" as const,
                text: encryptText(`${suggestion.id} topic`),
            })),
        );
        await decideSuggestion("owner", meeting.id, "mail-item", "added");
        let currentPoint = (
            await db
                .select()
                .from(agendaPoints)
                .where(eq(agendaPoints.agendaId, meeting.id))
        )[0];
        await changePoint("owner", meeting.id, currentPoint.id, {
            version: currentPoint.version,
            text: "Reworded confidential topic",
        });
        expect(
            (
                await db
                    .select()
                    .from(agendaPoints)
                    .where(eq(agendaPoints.id, currentPoint.id))
            )[0].sources,
        ).toEqual({ itemIds: ["mail"], taskIds: [] });
        const filtered = await agendaMailDerivedContent(
            "owner",
            "org",
            meeting.id,
        );
        expect([...filtered.suggestionIds].sort()).toEqual([
            "mail-item",
            "mail-task",
            "merged-task",
            "mixed",
        ]);
        expect(filtered.pointIds.size).toBe(1);
        expect(
            await agendaMailDerivedContent("stranger", "org", meeting.id),
        ).toEqual({ suggestionIds: new Set(), pointIds: new Set() });
        const tool = MEETING_TOOLS.find((tool) => tool.name === "get_meeting");
        if (!tool) throw new Error("Missing MCP tool");
        const caller: McpCaller = {
            kind: "user",
            userId: "owner",
            orgUserId: "org",
            email: "owner@example.com",
            subject: "owner",
            clientId: "test",
            roles: new Set(["tasks:read"]),
        };
        const result = await tool.run(
            { caller, touched: [] },
            { meetingId: meeting.id },
        );
        expect(JSON.stringify(result)).not.toContain(
            "Reworded confidential topic",
        );
        expect(JSON.stringify(result)).not.toContain("mail-item topic");
        expect(JSON.stringify(result)).not.toContain("merged-task topic");
        expect(JSON.stringify(result)).toContain("audio topic");
        expect(
            JSON.stringify(
                await tool.run(
                    {
                        caller: {
                            ...caller,
                            roles: new Set(["tasks:read", "mail:read"]),
                        },
                        touched: [],
                    },
                    { meetingId: meeting.id },
                ),
            ),
        ).toContain("Reworded confidential topic");
        let previousId = meeting.id;
        for (const days of [7, 14]) {
            await patchMeeting("owner", previousId, { state: "held" });
            const next = await prepareMeeting("owner", {
                folderId: "owner-folder",
                title: "Follow-up",
                start: new Date(
                    start.getTime() + days * 86400000,
                ).toISOString(),
                end: new Date(
                    start.getTime() + days * 86400000 + 3600000,
                ).toISOString(),
            });
            const detail = await getMeeting("owner", next.id);
            if (detail.unchanged) throw new Error("Missing follow-up");
            expect(detail.suggestions).toHaveLength(1);
            expect(detail.suggestions[0].sources.itemIds).toContain("mail");
            expect(
                JSON.stringify(
                    await tool.run(
                        { caller, touched: [] },
                        { meetingId: next.id },
                    ),
                ),
            ).not.toContain("Reworded confidential topic");
            await decideSuggestion(
                "owner",
                next.id,
                detail.suggestions[0].id,
                "added",
            );
            expect(
                (await agendaMailDerivedContent("owner", "org", next.id))
                    .pointIds.size,
            ).toBe(1);
            currentPoint = (
                await db
                    .select()
                    .from(agendaPoints)
                    .where(eq(agendaPoints.agendaId, next.id))
            )[0];
            await changePoint("owner", next.id, currentPoint.id, {
                version: currentPoint.version,
                text: `Reworded confidential topic ${days}`,
            });
            const edited = JSON.stringify(
                await tool.run({ caller, touched: [] }, { meetingId: next.id }),
            );
            expect(edited).not.toContain("Reworded confidential topic");
            previousId = next.id;
        }
    });
    it("uses the UTC previous-agenda cutoff under a non-UTC process timezone", async () => {
        const previous = await create();
        await patchMeeting("owner", previous.id, { state: "held" });
        const meeting = await prepareMeeting("owner", {
            folderId: "owner-folder",
            title: "Next",
            start: "2026-11-04T10:00:00Z",
        });
        await recording("before", "owner-folder");
        await recording("after", "owner-folder");
        for (const [itemId, createdAt] of [
            ["before", "2026-11-03T09:30:00Z"],
            ["after", "2026-11-03T10:30:00Z"],
        ]) {
            await db
                .update(recordingFolderAssignments)
                .set({ createdAt: new Date(createdAt) })
                .where(eq(recordingFolderAssignments.itemId, itemId));
            await db.insert(aiEnhancements).values({
                userId: "owner",
                itemId,
                source: "riffado",
                provider: "test",
                model: "test",
                summary: encryptText(itemId),
            });
        }
        const [agenda] = await db
            .select()
            .from(meetingAgendas)
            .where(eq(meetingAgendas.id, meeting.id));
        const timezone = process.env.TZ;
        try {
            process.env.TZ = "Europe/Prague";
            const inputs = await agendaSuggestionInputs({
                agenda,
                folderId: "owner-folder",
                userId: "owner",
                orgUserId: "org",
                viewer: await taskViewerById("owner"),
            });
            expect(inputs.summaries.map((row) => row.itemId)).toEqual([
                "after",
            ]);
        } finally {
            if (timezone === undefined) delete process.env.TZ;
            else process.env.TZ = timezone;
        }
    });
    it("fills only empty calendar IDs under concurrent writes, preserves manual choices and keeps detach recognizable", async () => {
        const meeting = await prepareMeeting("owner", {
            folderId: "owner-folder",
            calendarEventId: "attached",
        });
        await recording("rec");
        await attachAgenda("owner", meeting.id, "rec");
        const event = {
            ...eventFor("owner", "other-event"),
            recurringEventId: "other-series",
            attendees: [],
        };
        calendar.read.mockResolvedValue(event);
        calendar.roster.mockResolvedValue([event]);
        await resolveMeetingRoster({
            ownerUserId: "owner",
            itemId: "rec",
            calendarEventId: "other-event",
        });
        expect(
            await db.select().from(recordings).where(eq(recordings.id, "rec")),
        ).toMatchObject([
            { calendarEventId: "attached", calendarSeriesId: "series" },
        ]);
        await detachAgenda("owner", "rec");
        expect(
            await db.select().from(recordings).where(eq(recordings.id, "rec")),
        ).toMatchObject([{ calendarEventId: null, calendarSeriesId: null }]);
        calendar.roster.mockImplementationOnce(async () => {
            await db
                .update(recordings)
                .set({
                    calendarEventId: "concurrent",
                    calendarSeriesId: "concurrent-series",
                })
                .where(eq(recordings.id, "rec"));
            return [event];
        });
        await resolveMeetingRoster({
            ownerUserId: "owner",
            itemId: "rec",
            calendarEventId: "other-event",
        });
        expect(
            await db.select().from(recordings).where(eq(recordings.id, "rec")),
        ).toMatchObject([
            {
                calendarEventId: "concurrent",
                calendarSeriesId: "concurrent-series",
            },
        ]);
        await db
            .update(recordings)
            .set({ calendarEventId: null, calendarSeriesId: null })
            .where(eq(recordings.id, "rec"));
        await resolveMeetingRoster({
            ownerUserId: "owner",
            itemId: "rec",
            calendarEventId: "other-event",
        });
        expect(
            await db.select().from(recordings).where(eq(recordings.id, "rec")),
        ).toMatchObject([
            {
                calendarEventId: "other-event",
                calendarSeriesId: "other-series",
            },
        ]);
        const before =
            await database.sql`select xmin::text as revision from recordings where id = 'rec'`;
        for (let i = 0; i < 3; i++)
            await resolveMeetingRoster({ ownerUserId: "owner", itemId: "rec" });
        expect(
            await database.sql`select xmin::text as revision from recordings where id = 'rec'`,
        ).toEqual(before);
    });
    it("rejects an end without a start in both service and database and has all six deletion indexes", async () => {
        await create();
        expect(
            await database.sql`select count(*)::int as invalid from meeting_agendas where planned_end is not null and planned_start is null`,
        ).toMatchObject([{ invalid: 0 }]);
        await expect(
            prepareMeeting("owner", {
                folderId: "owner-folder",
                title: "Invalid",
                end: "2026-11-03T11:00:00Z",
            }),
        ).rejects.toMatchObject({ statusCode: 400 });
        await expect(
            db
                .insert(meetingAgendas)
                .values({ userId: "owner", plannedEnd: start }),
        ).rejects.toThrow();
        const indexes =
            await database.sql`select indexname from pg_indexes where schemaname = 'public' and tablename in ('meeting_agendas', 'agenda_points', 'agenda_suggestions')`;
        for (const index of [
            "meeting_agendas_task_source_idx",
            "meeting_agendas_snapshot_source_idx",
            "meeting_agendas_outcome_summary_idx",
            "agenda_points_origin_point_idx",
            "agenda_suggestions_parent_point_idx",
            "agenda_suggestions_origin_point_idx",
        ])
            expect(indexes.map((row) => row.indexname)).toContain(index);
    });
    it.each([
        "person-invitation",
        "organization-intent",
    ])("does not bypass pending %s exposure checks for an in-folder recording", async (pending) => {
        const meeting = await create();
        await recording("rec", "owner-folder");
        if (pending === "person-invitation")
            await db.insert(itemShares).values({
                userId: "owner",
                itemId: "rec",
                receiverUserId: "other",
                state: "pending",
            });
        else
            await db.insert(mailPendingShares).values({
                userId: "owner",
                itemId: "rec",
                folderId: "org-folder",
            });
        await db.transaction((tx) =>
            attachArrivingRecordingInTx(tx, "owner", "rec", "rec"),
        );
        expect(await getMeeting("owner", meeting.id)).toMatchObject({
            recordingItemId: null,
        });
    });
    it.each([
        "private",
        "org",
    ] as const)("the %s Learn job feeds only the recorder's authored points to its prompt", async (view) => {
        await share();
        const meeting = await create();
        const foreign = await addPoint("owner", meeting.id, {
            text: "Foreign agenda topic",
        });
        const own = await addPoint("other", meeting.id, {
            text: "Recorder agenda topic",
            parentId: foreign.id,
        });
        await changePoint("owner", meeting.id, own.id, {
            version: own.version,
            note: "Foreign live note",
        });
        await recording("rec", undefined, "other");
        await attachAgenda("other", meeting.id, "rec");
        if (view === "org")
            await db.insert(recordingFolderAssignments).values({
                userId: "other",
                itemId: "rec",
                folderId: "org-folder",
            });
        const settings = seededAudioProfileSettings();
        settings.steps.learn.correctAfterLearn = false;
        await db.insert(processingProfiles).values({
            id: "learn-profile",
            ownerUserId: view === "org" ? "org" : "other",
            scope: view === "org" ? "organization" : "personal",
            channel: "audio",
            name: encryptText("Learn profile"),
            currentRevisionId: "learn-revision",
        });
        await db.insert(processingProfileRevisions).values({
            id: "learn-revision",
            profileId: "learn-profile",
            settings: encryptText(JSON.stringify(settings)),
        });
        const [transcript] = await db
            .insert(transcriptions)
            .values({
                recordingId: "rec",
                userId: "other",
                text: encryptText("A recorded statement."),
                turns: encryptJsonField([
                    {
                        speaker: "speaker_0",
                        startMs: 0,
                        endMs: 1000,
                        text: "A recorded statement.",
                    },
                ]),
                source: "riffado",
                provider: "test",
                model: "test",
                detectedLanguage: "en",
            })
            .returning();
        await db.insert(learnRuns).values({
            id: "run",
            userId: "other",
            scopeUserId: view === "org" ? "org" : "other",
            itemId: "rec",
            transcriptionId: transcript.id,
            transcriptRevision: 0,
            vocabularyVersion: 0,
            trigger: "manual",
            actorUserId: view === "org" ? "curator" : "other",
            view,
            profileRevisionId: "learn-revision",
        });
        learn.complete
            .mockReset()
            .mockResolvedValueOnce('{"mentions":[]}')
            .mockResolvedValue(
                JSON.stringify({
                    speakers: [],
                    newRecords: [],
                    corrections: [],
                    facts: [],
                    relationPhrases: [],
                }),
            );
        await learnJobHandler.run({
            userId: "other",
            payload: { runId: "run" },
            jobId: "test",
            attempt: 1,
            maxAttempts: 1,
            signal: new AbortController().signal,
            reportProgress: vi.fn(),
        });
        const prompts = JSON.stringify(learn.complete.mock.calls);
        expect(prompts).toContain("Recorder agenda topic");
        expect(prompts).not.toContain("Foreign agenda topic");
        expect(prompts).not.toContain("Foreign live note");
    });
    it("manual points have no lineage even when their text matches a mail suggestion", async () => {
        const meeting = await create();
        await db.insert(agendaSuggestions).values({
            id: "mail-suggestion",
            userId: "owner",
            agendaId: meeting.id,
            kind: "ai",
            text: encryptText("Same topic"),
            sources: { itemIds: ["deleted-mail"], taskIds: [] },
        });
        const manual = await addPoint("owner", meeting.id, {
            text: "Same topic",
        });
        await decideSuggestion("owner", meeting.id, "mail-suggestion", "added");
        await db
            .delete(agendaSuggestions)
            .where(eq(agendaSuggestions.id, "mail-suggestion"));
        const stored = await db
            .select()
            .from(agendaPoints)
            .where(eq(agendaPoints.agendaId, meeting.id));
        expect(
            stored.find((point) => point.id === manual.id)?.sources,
        ).toBeNull();
        const derived = await agendaMailDerivedContent(
            "owner",
            "org",
            meeting.id,
        );
        expect([...derived.pointIds]).toEqual(
            stored
                .filter((point) => point.id !== manual.id)
                .map((point) => point.id),
        );
        expect(derived.suggestionIds.size).toBe(0);
    });

    it("backup export and restore preserve point lineage, map imported sources and keep missing sources restrictive", async () => {
        const meeting = await create();
        await recording("audio");
        await recording("imported-audio");
        await db.insert(chatterItems).values(
            ["mail", "imported-mail"].map((id) => ({
                id,
                userId: "owner",
                kind: "mail" as const,
                title: encryptText("Mail"),
                occurredAt: start,
            })),
        );
        await db.insert(recordingTasks).values(
            ["mail-task", "imported-task"].map((id) => ({
                id,
                itemId: id === "mail-task" ? "mail" : "imported-mail",
                userId: "owner",
                status: "open" as const,
                source: "manual" as const,
                text: encryptText("Mail task"),
            })),
        );
        await db.insert(agendaSuggestions).values({
            id: "source",
            userId: "owner",
            agendaId: meeting.id,
            kind: "ai",
            text: encryptText("Original mail topic"),
            sources: {
                itemIds: ["audio", "mail", "missing-mail"],
                taskIds: ["mail-task", "missing-task"],
            },
        });
        await decideSuggestion("owner", meeting.id, "source", "added");
        const point = (
            await db
                .select()
                .from(agendaPoints)
                .where(eq(agendaPoints.agendaId, meeting.id))
        )[0];
        await changePoint("owner", meeting.id, point.id, {
            version: point.version,
            text: "Reworded archived topic",
        });
        await addPoint("owner", meeting.id, { text: "Manual archived topic" });
        const archive = archivedMeetingSchema.array().parse(
            JSON.parse(
                JSON.stringify(
                    await collectArchivedMeetings({
                        kind: "personal",
                        userId: "owner",
                    }),
                ),
            ),
        );
        expect(archive[0].points[0].sources).toEqual(point.sources);
        const result = await restoreMeetings("owner", {
            meetings: archive,
            folderIdMap: { "owner-folder": "owner-folder" },
            itemIdMap: { audio: "imported-audio", mail: "imported-mail" },
            taskIdMap: { "mail-task": "imported-task" },
        });
        expect(result.skipped).toEqual([]);
        expect(result.restored).toHaveLength(1);
        const restored = await db
            .select()
            .from(agendaPoints)
            .where(eq(agendaPoints.agendaId, result.restored[0].id));
        const sourced = restored.find((point) => point.sources);
        expect(sourced?.sources).toEqual({
            itemIds: ["imported-audio", "imported-mail", "missing-mail"],
            taskIds: ["imported-task", "missing-task"],
        });
        expect(restored.find((point) => !point.sources)).toBeDefined();
        expect([
            ...(
                await agendaMailDerivedContent(
                    "owner",
                    "org",
                    result.restored[0].id,
                )
            ).pointIds,
        ]).toEqual([sourced?.id]);
        const tool = MEETING_TOOLS.find((tool) => tool.name === "get_meeting");
        if (!tool) throw new Error("Missing tool");
        const caller: McpCaller = {
            kind: "user",
            userId: "owner",
            orgUserId: "org",
            subject: "owner",
            email: "owner@example.com",
            clientId: "test",
            roles: new Set(["tasks:read"]),
        };
        const detail = JSON.stringify(
            await tool.run(
                { caller, touched: [] },
                { meetingId: result.restored[0].id },
            ),
        );
        expect(detail).not.toContain("Reworded archived topic");
        expect(detail).toContain("Manual archived topic");
    });

    it("listMeetings gates recording IDs per row but retains agenda calendar IDs", async () => {
        const meeting = await prepareMeeting("owner", {
            folderId: "org-folder",
            calendarEventId: "event",
        });
        await recording("rec");
        await attachAgenda("owner", meeting.id, "rec");
        const originalRows = await meetingQueries.listMeetingRows(
            "owner",
            "org",
            { includePast: true, includeAbsorbed: true },
        );
        expect(originalRows).toHaveLength(1);
        const selection = vi.spyOn(meetingQueries, "listMeetingRows");
        try {
            for (const actor of ["owner", "other"]) {
                selection.mockResolvedValueOnce(originalRows);
                const [listed] = await listMeetings(actor, {
                    includePast: true,
                    includeAbsorbed: true,
                });
                expect(listed).toMatchObject({
                    recordingItemId: actor === "owner" ? "rec" : null,
                    calendarEventId: "event",
                    calendarSeriesId: "series",
                });
                expect(await getMeeting(actor, meeting.id)).toMatchObject({
                    recordingItemId: listed.recordingItemId,
                    calendarEventId: listed.calendarEventId,
                    calendarSeriesId: listed.calendarSeriesId,
                });
            }
        } finally {
            selection.mockRestore();
        }
    });

    it("refuses a revoked participant's move into an Organization folder", async () => {
        await share();
        await recording("contribution", "owner-folder", "other");
        await db
            .update(folderShares)
            .set({ state: "removed" })
            .where(eq(folderShares.id, "owner-folder-other"));
        await expect(
            moveRecordingBetweenFolders({
                userId: "other",
                recordingId: "contribution",
                fromFolderId: "owner-folder",
                toFolderId: "org-folder",
            }),
        ).rejects.toMatchObject({ statusCode: 404 });
        expect(
            await db
                .select()
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.itemId, "contribution")),
        ).toMatchObject([{ folderId: "owner-folder", userId: "other" }]);
    });

    it("keeps both released recorder attachment IDs and canonical folder IDs resolvable, and revokes both", async () => {
        await share();
        await db.insert(receivedFolderAttachments).values({
            id: "old-recorder-id",
            userId: "other",
            shareId: "owner-folder-other",
            name: encryptText("Shared Acme"),
            parentId: "other-root",
        });
        for (const id of ["old-recorder-id", "owner-folder"])
            expect(await assertCategorizableFolders("other", [id])).toEqual([
                {
                    folderId: "owner-folder",
                    ownerId: "owner",
                    scope: "personal",
                },
            ]);
        await db
            .update(folderShares)
            .set({ state: "removed" })
            .where(eq(folderShares.id, "owner-folder-other"));
        for (const id of ["old-recorder-id", "owner-folder"])
            await expect(
                assertCategorizableFolders("other", [id]),
            ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("MCP advertises filing only where the ordinary categorization check permits it, including neither root", async () => {
        const tool = RECORDING_TOOLS.find(
            (tool) => tool.name === "list_folders",
        );
        if (!tool) throw new Error("Missing tool");
        const caller: McpCaller = {
            kind: "user",
            userId: "owner",
            orgUserId: "org",
            subject: "owner",
            email: "owner@example.com",
            clientId: "test",
            roles: new Set(["tasks:read"]),
        };
        const result = await tool.run({ caller, touched: [] }, {});
        expect(result).toMatchObject({
            folders: expect.arrayContaining([
                expect.objectContaining({
                    id: "owner-root",
                    can_file_own_items: false,
                }),
                expect.objectContaining({
                    id: "org-root",
                    can_file_own_items: false,
                }),
                expect.objectContaining({
                    id: "owner-folder",
                    can_file_own_items: true,
                }),
                expect.objectContaining({
                    id: "org-folder",
                    can_file_own_items: true,
                }),
            ]),
        });
        principal.frozen = true;
        const frozen = await tool.run({ caller, touched: [] }, {});
        expect(frozen).toMatchObject({
            folders: expect.arrayContaining([
                expect.objectContaining({
                    id: "org-folder",
                    can_file_own_items: false,
                }),
                expect.objectContaining({
                    id: "owner-folder",
                    can_file_own_items: true,
                }),
            ]),
        });
    });

    it("explicit attachment into a person-shared folder matches ordinary filing without an Organization publish intent", async () => {
        await share();
        const meeting = await create();
        await recording("ordinary", undefined, "other");
        await recording("attached", undefined, "other");
        await addRecordingToFolder({
            userId: "other",
            recordingId: "ordinary",
            folderId: "owner-folder",
        });
        await attachAgenda("other", meeting.id, "attached");
        for (const itemId of ["ordinary", "attached"]) {
            expect(
                await db
                    .select()
                    .from(recordingFolderAssignments)
                    .where(eq(recordingFolderAssignments.itemId, itemId)),
            ).toMatchObject([{ userId: "other", folderId: "owner-folder" }]);
            expect(
                await db
                    .select()
                    .from(mailPendingShares)
                    .where(eq(mailPendingShares.itemId, itemId)),
            ).toEqual([]);
        }
        expect(await getMeeting("owner", meeting.id)).toMatchObject({
            recordingItemId: "attached",
        });
    });
});
