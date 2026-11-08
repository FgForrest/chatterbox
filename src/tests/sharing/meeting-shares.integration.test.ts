import { eq } from "drizzle-orm";
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
    POST as itemShareRoute,
    GET as shareDetail,
} from "@/app/api/items/[id]/shares/route";
import { POST as attachRoute } from "@/app/api/meetings/[id]/attach/route";
import { POST as recordingShareRoute } from "@/app/api/meetings/[id]/recording-shares/route";
import { GET as matchRoute } from "@/app/api/v1/recorder/agendas/match/route";
import { db } from "@/db";
import { isItemReceived } from "@/db/queries/item-shares";
import type * as MeetingQueries from "@/db/queries/meetings";
import {
    chatterItems,
    itemShares,
    meetingAgendas,
    recordingFolderAssignments,
    recordingFolders,
    users,
} from "@/db/schema";
import { encryptText } from "@/lib/encryption/fields";
import { ErrorCode } from "@/lib/errors";
import { collectArchivedItemShares } from "@/lib/export/item-shares";
import { collectArchivedMeetings } from "@/lib/export/meetings";
import {
    addRecordingToFolder,
    removeRecordingFromFolder,
} from "@/lib/folders/folders";
import { MEETING_TOOLS } from "@/lib/mcp/tools/meetings";
import { requireMeetingAccess } from "@/lib/meetings/access";
import {
    agendaCandidates,
    attachAgenda,
    attachArrivingRecordingInTx,
    detachAgenda,
} from "@/lib/meetings/attachment";
import { matchRecorderAgendas } from "@/lib/meetings/calendar";
import type * as CalendarSnapshot from "@/lib/meetings/calendar-snapshot";
import { AGENDA_EVENT_CHANNEL } from "@/lib/meetings/event-protocol";
import type * as PersonSharing from "@/lib/meetings/person-sharing";
import {
    agendaRecordingShareOffer,
    agendaTaskShareDisclosure,
    inviteAgendaPeopleToRecording,
} from "@/lib/meetings/person-sharing";
import { restoreMeetings } from "@/lib/meetings/restore";
import {
    addPoint,
    changePoint,
    deleteMeeting,
    getMeeting,
    listMeetings,
    patchMeeting,
    prepareMeeting,
    reminderMeetings,
} from "@/lib/meetings/service";
import { agendaSuggestionsProvider } from "@/lib/meetings/suggestions-provider";
import { changeFolderShare, inviteToFolder } from "@/lib/sharing/folder-shares";
import {
    changePersonShare,
    inviteToItem,
    listItemShares,
    listMyInvitations,
} from "@/lib/sharing/person-shares";
import { restoreArchivedItemShares } from "@/lib/sharing/restore-shares";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";
import { insertRecording, insertTask, userCaller } from "@/tests/mcp/fixtures";

const {
    ref,
    mode,
    profile,
    provider,
    actor,
    arrivalPause,
    disclosure,
    recordingInvitation,
    refreshes,
    readSnapshot,
} = vi.hoisted(() => ({
    ref: { current: null as Record<PropertyKey, unknown> | null },
    mode: {
        IS_HOSTED: false,
        SELF_HOST_MODE: "shared",
        AUTHZ_MODE: "local",
        ORG_ACCOUNT_EMAIL: "org@example.com",
        ORG_ACCOUNT_PASSWORD: "test",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        MAIL_ADDRESS_HASH_SECRET: "m".repeat(40),
        MAIL_DOMAIN: "mail.example.com",
        BETTER_AUTH_SECRET: "meeting-share-test",
    },
    profile: vi.fn(),
    provider: vi.fn(),
    actor: { id: "owner" },
    arrivalPause: { calls: 0, run: null as (() => Promise<void>) | null },
    disclosure: vi.fn(),
    recordingInvitation: vi.fn(),
    readSnapshot: vi.fn(),
    refreshes: [] as (() => Promise<void>)[],
}));
vi.mock("@/db/queries/meetings", async (original) => {
    const actual = await original<typeof MeetingQueries>();
    return {
        ...actual,
        findMeeting: async (...args: Parameters<typeof actual.findMeeting>) => {
            if (arrivalPause.run && args[4] && ++arrivalPause.calls === 2)
                await arrivalPause.run();
            return actual.findMeeting(...args);
        },
    };
});
vi.mock("@/lib/meetings/person-sharing", async (original) => {
    const actual = await original<typeof PersonSharing>();
    disclosure.mockImplementation(actual.agendaTaskShareDisclosure);
    recordingInvitation.mockImplementation(
        actual.inviteAgendaPeopleToRecording,
    );
    return {
        ...actual,
        agendaTaskShareDisclosure: disclosure,
        inviteAgendaPeopleToRecording: recordingInvitation,
    };
});
vi.mock("next/server", async (original) => ({
    ...(await original<typeof NextServer>()),
    after: (refresh: () => Promise<void>) => refreshes.push(refresh),
}));
vi.mock("@/lib/recording-sessions/route-gate", () => ({
    gateRecordingSessionRequest: async () => ({
        authn: { user: { id: actor.id } },
    }),
}));
vi.mock("@/lib/meetings/calendar-snapshot", async (original) => {
    const actual = await original<typeof CalendarSnapshot>();
    readSnapshot.mockImplementation(actual.readMeetingCalendarSnapshot);
    return { ...actual, readMeetingCalendarSnapshot: readSnapshot };
});
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
}));
vi.mock("@/lib/env", () => ({ env: mode }));
vi.mock("@/lib/authz/curator", () => ({
    userCuratesOrganizationNow: async (id: string) => id === "curator",
    actsForOrganization: async () => false,
}));
vi.mock("@/lib/integrations/google/connection", () => ({
    getGoogleConnectionStatus: async () => null,
}));
vi.mock("@/lib/integrations/google/calendar-events", () => ({
    getCalendarEvent: vi.fn(),
    listUpcomingCalendarEvents: async () => [],
}));
vi.mock("@/lib/profiles/resolve-for-placement", () => ({
    resolveProfileForPlacements: profile,
}));
vi.mock("@/lib/profiles/providers", () => ({
    resolveStepProviderSelection: provider,
}));
vi.mock("@/lib/ai/enhancement-provider", () => ({
    enhancementChatModel: vi.fn(),
}));
vi.mock("@/lib/events/personal", () => ({
    notifyPersonShareChanged: async () => {},
}));
vi.mock("@/lib/notifications/person-share", () => ({
    sendPersonShareInvitation: async () => {},
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: async () => {},
}));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async () => ({ user: { id: actor.id } }),
}));
vi.mock("@/lib/rate-limit", () => ({
    consumeRateLimitBucket: async () => ({ allowed: true }),
}));

const url = getTestDatabaseUrl();
const start = new Date(Date.now() + 3600000);
describe.skipIf(!url)("agenda person shares (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            url ?? "",
            "meeting_person_shares",
        );
        ref.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120000);
    afterAll(async () => {
        ref.current = null;
        await database?.dispose();
    }, 60000);
    beforeEach(async () => {
        mode.IS_HOSTED = false;
        mode.SELF_HOST_MODE = "shared";
        actor.id = "owner";
        arrivalPause.run = null;
        arrivalPause.calls = 0;
        disclosure.mockClear();
        recordingInvitation.mockClear();
        readSnapshot.mockClear();
        refreshes.length = 0;
        profile.mockReset().mockResolvedValue({ status: "unavailable" });
        provider.mockReset();
        await db.delete(users);
        await db.insert(users).values(
            ["owner", "receiver", "other", "curator", "org"].map(
                (id, index) => ({
                    id,
                    email: `${id}@example.com`,
                    name: [
                        "Jitka Dvořáková",
                        "Petr Novák",
                        "Hana Králová",
                        "Věra Benešová",
                        "Organization",
                    ][index],
                    role: id === "org" ? ("org" as const) : ("user" as const),
                }),
            ),
        );
        await db.insert(recordingFolders).values(
            ["owner", "receiver", "other", "org"].flatMap((userId) => [
                {
                    id: `${userId}-root`,
                    userId,
                    kind:
                        userId === "org"
                            ? ("public" as const)
                            : ("private" as const),
                    name: encryptText("Root"),
                    nameHash: "root",
                },
                {
                    id: `${userId}-folder`,
                    userId,
                    parentId: `${userId}-root`,
                    kind: "custom" as const,
                    name: encryptText(`${userId} filing`),
                    nameHash: "folder",
                },
            ]),
        );
    });
    async function create(folderId = "owner-folder") {
        const result = await prepareMeeting("owner", {
            title: "Project agenda",
            folderId,
            start: start.toISOString(),
            end: new Date(start.getTime() + 3600000).toISOString(),
        });
        if (result.meeting.unchanged) throw new Error("Missing plan");
        return { ...result, meeting: result.meeting };
    }
    async function invite(
        itemId: string,
        accept = true,
        receiver = "receiver",
    ) {
        const share = (await inviteToItem("owner", itemId, [receiver])).find(
            (share) => share.receiverUserId === receiver,
        );
        if (!share) throw new Error("Missing invitation");
        if (accept)
            await changePersonShare(receiver, share.id, {
                action: "accept",
                version: share.version,
                folderId: `${receiver}-folder`,
            });
        return share;
    }
    async function detail(userId: string, id: string) {
        const result = await getMeeting(userId, id);
        if (result.unchanged) throw new Error("Missing detail");
        return result;
    }
    async function recording(userId = "owner", id = "recording") {
        await insertRecording(database.db, {
            id,
            userId,
            title: "Recorded review",
            startTime: start,
        });
        return id;
    }

    it("requires acceptance, own private filing, and preserves version checks", async () => {
        const plan = await create();
        const itemId = plan.meeting.meetingItemId as string;
        const share = await invite(itemId, false);
        expect((await listMyInvitations("receiver"))[0]).toMatchObject({
            kind: "meeting",
            title: "Project agenda",
        });
        await expect(
            requireMeetingAccess("receiver", plan.id),
        ).rejects.toMatchObject({ statusCode: 404 });
        await expect(
            changePersonShare("receiver", share.id, {
                action: "accept",
                version: 0,
                folderId: "owner-folder",
            }),
        ).rejects.toMatchObject({ statusCode: 404 });
        await expect(
            changePersonShare("receiver", share.id, {
                action: "accept",
                version: 0,
            }),
        ).rejects.toMatchObject({ statusCode: 400 });
        await changePersonShare("receiver", share.id, {
            action: "accept",
            version: 0,
            folderId: "receiver-folder",
        });
        await expect(
            changePersonShare("receiver", share.id, {
                action: "accept",
                version: 0,
                folderId: "receiver-folder",
            }),
        ).rejects.toMatchObject({ statusCode: 409 });
        expect(
            (await requireMeetingAccess("receiver", plan.id, "edit"))
                .permissions,
        ).toEqual({ view: true, edit: true, manage: false });
        expect(await isItemReceived("receiver", itemId)).toBe(false);
        expect(
            (await detail("receiver", plan.id)).folders.map(
                (folder) => folder.name,
            ),
        ).toEqual(["receiver filing"]);
        expect(
            (
                await listMeetings("receiver", { folderId: "receiver-folder" })
            ).map((row) => row.id),
        ).toEqual([plan.id]);
        expect(
            await listMeetings("receiver", { folderId: "owner-folder" }),
        ).toEqual([]);
    });

    it("co-edits own points, discussed ticks and notes without granting management", async () => {
        const plan = await create();
        await invite(plan.meeting.meetingItemId as string);
        const authors = await addPoint("owner", plan.id, {
            text: "Author point",
        });
        const point = await addPoint("receiver", plan.id, {
            text: "Receiver point",
        });
        await changePoint("receiver", plan.id, point.id, {
            text: "Revised",
            version: 0,
        });
        await changePoint("receiver", plan.id, authors.id, {
            discussed: true,
            note: "Live hint",
            version: 0,
        });
        await expect(
            changePoint("receiver", plan.id, authors.id, {
                text: "Forbidden",
                version: 1,
            }),
        ).rejects.toMatchObject({ statusCode: 403 });
        await expect(
            changePoint("receiver", plan.id, authors.id, { version: 1 }, true),
        ).rejects.toMatchObject({ statusCode: 403 });
        for (const input of [
            { title: "Changed" },
            { start: start.toISOString() },
            { state: "live" as const },
            { taskSourceItemId: "source" },
        ])
            await expect(
                patchMeeting("receiver", plan.id, input),
            ).rejects.toMatchObject({ statusCode: 403 });
        await expect(deleteMeeting("receiver", plan.id)).rejects.toMatchObject({
            statusCode: 403,
        });
        const received = await detail("receiver", plan.id);
        expect(
            received.points.find((entry) => entry.id === authors.id),
        ).toMatchObject({ note: "Live hint", discussedByUserId: "receiver" });
    });

    it.each([
        "decline",
        "cancel",
        "remove",
        "inactive",
    ] as const)("ends access through %s without deleting a contributor's points", async (action) => {
        const plan = await create();
        const share = await invite(
            plan.meeting.meetingItemId as string,
            action === "remove" || action === "inactive",
        );
        const point =
            action === "remove" || action === "inactive"
                ? await addPoint("receiver", plan.id, { text: "Contribution" })
                : null;
        if (action === "inactive")
            await db
                .update(users)
                .set({ suspendedAt: new Date() })
                .where(eq(users.id, "receiver"));
        else
            await changePersonShare(
                action === "cancel" || action === "remove"
                    ? "owner"
                    : "receiver",
                share.id,
                { action, version: action === "remove" ? 1 : 0 },
            );
        await expect(
            requireMeetingAccess("receiver", plan.id),
        ).rejects.toMatchObject({ statusCode: 404 });
        if (point) {
            expect((await detail("owner", plan.id)).points).toContainEqual(
                expect.objectContaining({
                    id: point.id,
                    authorUserId: "receiver",
                }),
            );
            await changePoint("owner", plan.id, point.id, {
                version: 0,
                text: "Author revision",
            });
        }
    });

    it("deletes an agenda and publishes an ids-only invalidation with the next cursor", async () => {
        const plan = await create();
        await addPoint("owner", plan.id, { text: "Private agenda point" });
        const agenda = await detail("owner", plan.id);
        const messages: string[] = [];
        const listener = await database.sql.listen(
            AGENDA_EVENT_CHANNEL,
            (payload) => messages.push(payload),
        );
        try {
            await expect(
                deleteMeeting("owner", plan.id),
            ).resolves.toBeUndefined();
            await vi.waitFor(() => expect(messages).toHaveLength(1));
            expect(JSON.parse(messages[0])).toEqual({
                agendaId: plan.id,
                cursor: String(agenda.version + 1),
            });
            await expect(getMeeting("owner", plan.id)).rejects.toMatchObject({
                statusCode: 404,
            });
            expect(await listMeetings("owner")).toEqual([]);
        } finally {
            await listener.unlisten();
        }
    });

    it("lets receivers remove their own share and the author delete all invitations", async () => {
        const plan = await create();
        const share = await invite(plan.meeting.meetingItemId as string);
        await changePersonShare("receiver", share.id, {
            action: "remove",
            version: 1,
        });
        await expect(
            requireMeetingAccess("receiver", plan.id),
        ).rejects.toMatchObject({ statusCode: 404 });
        await invite(plan.meeting.meetingItemId as string, false);
        await deleteMeeting("owner", plan.id);
        expect(await listMyInvitations("receiver")).toEqual([]);
        expect(await db.select().from(itemShares)).toEqual([]);
    });

    it("refuses Organization invitations, preserves direct shares through Organization placement and restores receiver rights", async () => {
        const orgPlan = await create("org-folder");
        await expect(
            invite(orgPlan.meeting.meetingItemId as string),
        ).rejects.toMatchObject({ statusCode: 403 });
        const plan = await create();
        const itemId = plan.meeting.meetingItemId as string;
        await invite(itemId);
        await addRecordingToFolder({
            userId: "owner",
            recordingId: itemId,
            folderId: "org-folder",
        });
        expect(
            (await requireMeetingAccess("curator", plan.id, "manage"))
                .permissions.manage,
        ).toBe(true);
        expect((await detail("receiver", plan.id)).shared).toBe(true);
        expect(await listItemShares("owner", itemId)).toHaveLength(1);
        await removeRecordingFromFolder({
            userId: "owner",
            recordingId: itemId,
            folderId: "org-folder",
            withdraw: true,
        });
        expect(
            (await requireMeetingAccess("receiver", plan.id, "edit")).shared,
        ).toBe(false);
        await expect(
            requireMeetingAccess("curator", plan.id),
        ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("suppresses redundant folder invitations and keeps independent access paths", async () => {
        const plan = await create();
        const itemId = plan.meeting.meetingItemId as string;
        const share = await invite(itemId);
        const folderShare = (
            await inviteToFolder("owner", "owner-folder", ["receiver"])
        )[0];
        await changeFolderShare("receiver", folderShare.id, {
            action: "accept",
            version: 0,
            name: "Local planning",
        });
        await changePersonShare("receiver", share.id, {
            action: "file",
            version: 1,
        });
        expect(
            (await detail("receiver", plan.id)).folders.map(
                (folder) => folder.name,
            ),
        ).toEqual(["Local planning"]);
        await changePersonShare("owner", share.id, {
            action: "remove",
            version: 2,
        });
        expect(
            (await requireMeetingAccess("receiver", plan.id)).permissions.edit,
        ).toBe(true);
        expect(await inviteToItem("owner", itemId, ["receiver"])).toHaveLength(
            1,
        );
        await changeFolderShare("owner", folderShare.id, {
            action: "remove",
            version: 1,
        });
        await expect(
            requireMeetingAccess("receiver", plan.id),
        ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("hides and does not count source tasks, discloses their count to the author and invites to the source separately", async () => {
        const sourceId = await recording();
        const taskId = await insertTask(database.db, {
            recordingId: sourceId,
            userId: "owner",
            text: "Private source task",
        });
        const plan = await create();
        await patchMeeting("owner", plan.id, { taskSourceItemId: sourceId });
        await invite(plan.meeting.meetingItemId as string);
        expect((await detail("receiver", plan.id)).tasks).toEqual([]);
        expect((await detail("receiver", plan.id)).taskSource).toBeNull();
        expect((await listMeetings("receiver"))[0].counts.tasks).toBe(0);
        expect(await agendaTaskShareDisclosure("owner", plan.id)).toMatchObject(
            { count: 1, canInvite: true, recordingItemId: sourceId },
        );
        const response = await shareDetail(
            new Request("http://localhost/api/items/plan/shares"),
            {
                params: Promise.resolve({
                    id: plan.meeting.meetingItemId as string,
                }),
            },
        );
        expect((await response.json()).agendaTasks.count).toBe(1);
        const sourceInvitation = await itemShareRoute(
            new Request("http://localhost/api/items/source/shares", {
                method: "POST",
                body: JSON.stringify({ receiverIds: ["receiver"] }),
            }),
            { params: Promise.resolve({ id: sourceId }) },
        );
        expect(sourceInvitation.status).toBe(200);
        expect((await sourceInvitation.json()).shares).toContainEqual(
            expect.objectContaining({
                receiverUserId: "receiver",
                state: "pending",
            }),
        );
        expect((await detail("receiver", plan.id)).tasks).toEqual([]);
        const recordingShare = (await listItemShares("owner", sourceId))[0];
        await changePersonShare("receiver", recordingShare.id, {
            action: "accept",
            version: 0,
            folderId: "receiver-folder",
        });
        expect(
            (await detail("receiver", plan.id)).tasks.map((task) => task.id),
        ).toEqual([taskId]);
        expect(await agendaTaskShareDisclosure("owner", plan.id)).toBeNull();
    });

    it("preserves pending and accepted agenda shares after absorption, accepts the read-only plan and revives shares on detach", async () => {
        const plan = await create();
        const itemId = plan.meeting.meetingItemId as string;
        const share = await invite(itemId, false);
        await recording();
        await attachAgenda("owner", plan.id, "recording");
        expect((await listMyInvitations("receiver"))[0]).toMatchObject({
            kind: "meeting",
            recorded: true,
        });
        await expect(
            inviteToItem("owner", itemId, ["other"]),
        ).rejects.toMatchObject({ statusCode: 404 });
        await changePersonShare("receiver", share.id, {
            action: "accept",
            version: 0,
            folderId: "receiver-folder",
        });
        const received = await detail("receiver", itemId);
        expect(received).toMatchObject({
            attachedRecording: { visible: false },
            recordingItemId: null,
            redirectTo: null,
            permissions: { edit: false, manage: false },
        });
        expect(received).not.toHaveProperty("outcomeSummaryId");
        await expect(
            addPoint("receiver", itemId, { text: "Forbidden" }),
        ).rejects.toMatchObject({ statusCode: 409 });
        expect(await listItemShares("owner", itemId)).toHaveLength(1);
        await detachAgenda("owner", "recording");
        expect(
            (await requireMeetingAccess("receiver", itemId, "edit")).permissions
                .edit,
        ).toBe(true);
    });

    it("creates pending recording invitations through the explicit attach flag and suggests the receiver's agenda filing", async () => {
        const plan = await create();
        await invite(plan.meeting.meetingItemId as string);
        await recording();
        const response = await attachRoute(
            new Request("http://localhost/api/meetings/plan/attach", {
                method: "POST",
                body: JSON.stringify({
                    recordingItemId: "recording",
                    shareRecording: true,
                }),
            }),
            { params: Promise.resolve({ id: plan.id }) },
        );
        expect(await response.json()).toMatchObject({
            recordingShare: { invited: ["receiver"] },
        });
        expect((await listMyInvitations("receiver"))[0]).toMatchObject({
            kind: "audio",
            suggestedFolder: { id: "receiver-folder", name: "receiver filing" },
        });
        expect(
            await agendaRecordingShareOffer("owner", plan.id, "recording"),
        ).toMatchObject({ people: [] });
        const share = (await listItemShares("owner", "recording"))[0];
        await changePersonShare("receiver", share.id, {
            action: "accept",
            version: 0,
            folderId: "receiver-folder",
        });
        expect((await detail("receiver", plan.id)).redirectTo).toContain(
            "recording=recording&view=received",
        );
    });

    it("skips Organization-visible recordings without rolling back the attachment", async () => {
        const plan = await create();
        await invite(plan.meeting.meetingItemId as string);
        await recording();
        await db.insert(recordingFolderAssignments).values({
            userId: "owner",
            itemId: "recording",
            folderId: "org-folder",
        });
        const result = await attachAgenda("owner", plan.id, "recording", true);
        expect((await detail("owner", plan.id)).agendaTitle).toBe(
            "Project agenda",
        );
        expect(result?.recordingShare.skipped).toContainEqual({
            userId: "receiver",
            reason: "organization",
        });
        expect(
            (await detail("owner", plan.id)).attachedRecording?.visible,
        ).toBe(true);
    });

    it.each([
        false,
        true,
    ])("never auto-attaches an agenda with an accepted=%s direct share", async (accepted) => {
        const plan = await create();
        await invite(plan.meeting.meetingItemId as string, accepted);
        await recording();
        await db.insert(recordingFolderAssignments).values({
            userId: "owner",
            itemId: "recording",
            folderId: "owner-folder",
        });
        expect(await agendaCandidates("owner", "recording")).toHaveLength(1);
        await db.transaction((tx) =>
            attachArrivingRecordingInTx(tx, "owner", "recording", "arrival"),
        );
        expect((await detail("owner", plan.id)).attachedRecording).toBeNull();
    });

    it.each([
        "web",
        "arrival",
    ])("allows a receiver's own %s attachment, skips the author's private folders and offers other collaborators", async (path) => {
        const plan = await create();
        await invite(plan.meeting.meetingItemId as string);
        await invite(plan.meeting.meetingItemId as string, true, "other");
        await recording("receiver");
        if (path === "web")
            await attachAgenda("receiver", plan.id, "recording");
        else
            await db.transaction((tx) =>
                attachArrivingRecordingInTx(
                    tx,
                    "receiver",
                    "recording",
                    "arrival",
                    plan.id,
                ),
            );
        expect((await detail("owner", plan.id)).attachedRecording).toEqual({
            visible: false,
        });
        expect(
            await db
                .select()
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.itemId, "recording")),
        ).toEqual([]);
        expect(
            (
                await agendaRecordingShareOffer(
                    "receiver",
                    plan.id,
                    "recording",
                )
            ).people
                .map((person) => person.id)
                .sort(),
        ).toEqual(["other", "owner"]);
        await detachAgenda("receiver", "recording");
        expect(
            (await requireMeetingAccess("receiver", plan.id, "edit"))
                .permissions.edit,
        ).toBe(true);
    });

    it("refuses a receiver recording whose audience exceeds the agenda", async () => {
        const plan = await create();
        await invite(plan.meeting.meetingItemId as string);
        await recording("receiver");
        await inviteToItem("receiver", "recording", ["other"]);
        const share = (await listItemShares("receiver", "recording"))[0];
        await changePersonShare("other", share.id, {
            action: "accept",
            version: 0,
            folderId: "other-folder",
        });
        await expect(
            attachAgenda("receiver", plan.id, "recording"),
        ).rejects.toMatchObject({ statusCode: 409 });
    });

    it.each([
        "folder",
        "organization",
    ])("never discloses or invites direct receivers for a %s viewer's recording", async (audience) => {
        const plan = await create();
        const itemId = plan.meeting.meetingItemId as string;
        await invite(itemId);
        if (audience === "folder") {
            const share = (
                await inviteToFolder("owner", "owner-folder", ["other"])
            )[0];
            await changeFolderShare("other", share.id, {
                action: "accept",
                version: 0,
                name: "Shared plans",
            });
        } else
            await addRecordingToFolder({
                userId: "owner",
                recordingId: itemId,
                folderId: "org-folder",
            });
        await recording("other", "other-recording");
        expect(
            (
                await agendaRecordingShareOffer(
                    "other",
                    plan.id,
                    "other-recording",
                )
            ).people,
        ).toEqual([]);
        expect(
            await attachAgenda("other", plan.id, "other-recording", true),
        ).toEqual({ recordingShare: { invited: [], skipped: [] } });
        expect(await listItemShares("other", "other-recording")).toEqual([]);
    });

    it("keeps the attachment and logs when recording invitations fail unexpectedly", async () => {
        const plan = await create();
        await invite(plan.meeting.meetingItemId as string);
        await recording();
        recordingInvitation.mockRejectedValueOnce(
            new Error("Invented invitation failure"),
        );
        const logged = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            expect(
                await attachAgenda("owner", plan.id, "recording", true),
            ).toEqual({
                recordingShare: {
                    invited: [],
                    skipped: [{ userId: null, reason: "unavailable" }],
                },
            });
            expect(logged).toHaveBeenCalledWith(
                "[meetings] recording invitations after attach failed",
                { code: ErrorCode.INTERNAL_ERROR },
            );
        } finally {
            logged.mockRestore();
        }
        expect(
            (await detail("owner", plan.id)).attachedRecording?.visible,
        ).toBe(true);
        expect(await listItemShares("owner", "recording")).toEqual([]);
    });

    it("uses the caller's profile and providers even for an unfiled received agenda", async () => {
        const plan = await create();
        await invite(plan.meeting.meetingItemId as string);
        await db
            .delete(recordingFolderAssignments)
            .where(
                eq(
                    recordingFolderAssignments.itemId,
                    plan.meeting.meetingItemId as string,
                ),
            );
        profile.mockResolvedValue({
            status: "resolved",
            profile: {
                settings: {
                    steps: {
                        summary: {
                            provider: { kind: "default" },
                            outputLanguage: "en",
                        },
                    },
                },
            },
        });
        provider.mockResolvedValue({ kind: "credential", credential: {} });
        await agendaSuggestionsProvider("receiver", plan.id);
        expect(profile).toHaveBeenCalledWith(
            expect.objectContaining({
                ownerUserId: "receiver",
                folderIds: [],
                view: "private",
            }),
        );
        expect(provider).toHaveBeenCalledWith(
            expect.objectContaining({ actorUserId: "receiver" }),
        );
    });

    it("includes an accepted receiver in reminders, recorder lists and MCP list/get/edit before any contribution", async () => {
        const plan = await create();
        await invite(plan.meeting.meetingItemId as string);
        expect(
            (await reminderMeetings("receiver", { includePast: true })).map(
                (row) => row.id,
            ),
        ).toEqual([plan.id]);
        expect(
            (await matchRecorderAgendas("receiver", start)).length,
        ).toBeGreaterThan(0);
        const caller = userCaller(
            "receiver",
            "receiver@example.com",
            ["tasks:read", "tasks:write", "summaries:read"],
            "org",
        );
        const invoke = async (name: string, input: Record<string, unknown>) => {
            const tool = MEETING_TOOLS.find((tool) => tool.name === name);
            if (!tool) throw new Error("Missing tool");
            return tool.run({ caller, touched: [] }, input);
        };
        expect(await invoke("list_meetings", {})).toMatchObject({
            meetings: [expect.objectContaining({ id: plan.id })],
        });
        expect(
            await invoke("get_meeting", { meetingId: plan.id }),
        ).toMatchObject({ meeting: { id: plan.id } });
        expect(
            await invoke("edit_agenda", {
                meetingId: plan.id,
                operations: [{ action: "add_point", text: "From MCP" }],
            }),
        ).toMatchObject({ completed: 1 });
    });

    it("archives author shares, excludes receiver archives, maps imported meeting IDs and re-invites as pending", async () => {
        const plan = await create();
        await invite(plan.meeting.meetingItemId as string);
        const archive = await collectArchivedMeetings({
            kind: "personal",
            userId: "owner",
        });
        const shares = await collectArchivedItemShares(
            { kind: "personal", userId: "owner" },
            new Set(),
        );
        expect(shares).toHaveLength(1);
        expect(shares[0]).not.toHaveProperty("filingFolderId");
        expect(
            await collectArchivedMeetings({
                kind: "personal",
                userId: "receiver",
            }),
        ).toEqual([]);
        expect(
            await collectArchivedItemShares(
                { kind: "personal", userId: "receiver" },
                new Set(),
            ),
        ).toEqual([]);
        const restored = await restoreMeetings("owner", {
            meetings: archive,
            folderIdMap: { "owner-folder": "owner-folder" },
        });
        expect(restored.restored).toHaveLength(1);
        const result = await restoreArchivedItemShares(
            "owner",
            shares,
            new Map(Object.entries(restored.itemIdMap)),
        );
        expect(result.restored).toBe(1);
        expect((await listMyInvitations("receiver"))[0].kind).toBe("meeting");
        await expect(
            requireMeetingAccess("receiver", restored.restored[0].id),
        ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("accepts without extra filing only through a live accepted folder path", async () => {
        const plan = await create();
        const share = await invite(plan.meeting.meetingItemId as string, false);
        const folderShare = (
            await inviteToFolder("owner", "owner-folder", ["receiver"])
        )[0];
        await changeFolderShare("receiver", folderShare.id, {
            action: "accept",
            version: 0,
            name: "Local agenda folder",
        });
        await changePersonShare("receiver", share.id, {
            action: "accept",
            version: 0,
        });
        expect(
            (await detail("receiver", plan.id)).receivedShare?.filingFolderId,
        ).toBeNull();
        await changeFolderShare("owner", folderShare.id, {
            action: "remove",
            version: 1,
        });
        expect(
            (await requireMeetingAccess("receiver", plan.id, "edit"))
                .permissions.edit,
        ).toBe(true);
    });

    it("never exposes the author's private folder names in recording attachment candidates", async () => {
        const plan = await create();
        await invite(plan.meeting.meetingItemId as string);
        await recording("receiver");
        const candidates = await agendaCandidates("receiver", "recording");
        expect(candidates[0].folders.map((folder) => folder.name)).toEqual([
            "receiver filing",
        ]);
        expect(JSON.stringify(candidates)).not.toContain("owner filing");
    });

    it("keeps an absorbed agenda in the receiver list until recording access is granted, and permits author removal", async () => {
        const plan = await create();
        const share = await invite(plan.meeting.meetingItemId as string);
        await recording();
        await attachAgenda("owner", plan.id, "recording");
        const listed = await listMeetings("receiver", { includePast: true });
        expect(listed).toContainEqual(
            expect.objectContaining({
                id: plan.id,
                title: "Project agenda",
                recordingItemId: null,
                recorded: true,
            }),
        );
        expect(
            (
                await listMeetings("receiver", {
                    includeAbsorbed: true,
                    includePast: true,
                })
            )[0].title,
        ).toBe("Project agenda");
        expect(
            await reminderMeetings("receiver", { includePast: true }),
        ).toEqual([]);
        await changePersonShare("owner", share.id, {
            action: "remove",
            version: 1,
        });
        await expect(
            requireMeetingAccess("receiver", plan.id),
        ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("preserves the author's absorbed agenda and shares in backup when a receiver owns its recording", async () => {
        const plan = await create();
        await invite(plan.meeting.meetingItemId as string);
        await recording("receiver");
        await attachAgenda("receiver", plan.id, "recording");
        const recordingArchive = await collectArchivedMeetings({
            kind: "personal",
            userId: "receiver",
        });
        expect(recordingArchive).toHaveLength(1);
        expect(recordingArchive[0].recordingItemId).toBe("recording");
        await recording("receiver", "restored-recording");
        const recordingRestore = await restoreMeetings("receiver", {
            meetings: recordingArchive,
            itemIdMap: { recording: "restored-recording" },
        });
        expect(recordingRestore.skipped).toEqual([]);
        expect(recordingRestore.restored).toHaveLength(1);
        expect(
            (await detail("receiver", recordingRestore.restored[0].id))
                .recordingItemId,
        ).toBe("restored-recording");
        const archive = await collectArchivedMeetings({
            kind: "personal",
            userId: "owner",
        });
        expect(archive).toHaveLength(1);
        expect(archive[0]).toMatchObject({
            recordingItemId: null,
            outcomeSummaryId: null,
            outcomeUnplanned: [],
        });
        const restored = await restoreMeetings("owner", {
            meetings: archive,
            folderIdMap: { "owner-folder": "owner-folder" },
        });
        expect(restored.restored).toHaveLength(1);
        expect(restored.skipped).toEqual([]);
        expect(
            await collectArchivedItemShares(
                { kind: "personal", userId: "owner" },
                new Set(),
            ),
        ).toHaveLength(1);
    });

    it("shows task-source disclosure without an invitation button when another colleague owns the source", async () => {
        await recording("other", "source");
        const taskId = await insertTask(database.db, {
            recordingId: "source",
            userId: "other",
        });
        const sourceShare = (
            await inviteToItem("other", "source", ["owner"])
        )[0];
        await changePersonShare("owner", sourceShare.id, {
            action: "accept",
            version: 0,
            folderId: "owner-folder",
        });
        const plan = await create();
        await patchMeeting("owner", plan.id, { taskSourceItemId: "source" });
        await invite(plan.meeting.meetingItemId as string, false);
        expect(await agendaTaskShareDisclosure("owner", plan.id)).toMatchObject(
            { count: 1, canInvite: false },
        );
        expect(
            (await detail("owner", plan.id)).tasks.map((task) => task.id),
        ).toEqual([taskId]);
        await expect(
            inviteAgendaPeopleToRecording("owner", plan.id, "source"),
        ).rejects.toMatchObject({ statusCode: 404 });
    });

    it.each([
        false,
        true,
    ])("refuses unrelated recording invitations even with includePending=%s", async (includePending) => {
        const plan = await create();
        await invite(plan.meeting.meetingItemId as string);
        await recording();
        const response = await recordingShareRoute(
            new Request("http://localhost/api/meetings/plan/recording-shares", {
                method: "POST",
                body: JSON.stringify({
                    recordingItemId: "recording",
                    includePending,
                }),
            }),
            { params: Promise.resolve({ id: plan.id }) },
        );
        expect(response.status).toBe(409);
        expect(await listItemShares("owner", "recording")).toEqual([]);
    });

    it("serializes the first direct invitation with automatic absorption", async () => {
        const plan = await create();
        const itemId = plan.meeting.meetingItemId as string;
        await recording();
        await db.insert(recordingFolderAssignments).values({
            userId: "owner",
            itemId: "recording",
            folderId: "owner-folder",
        });
        let paused!: () => void;
        let resume!: () => void;
        const atDecision = new Promise<void>((resolve) => {
            paused = resolve;
        });
        const released = new Promise<void>((resolve) => {
            resume = resolve;
        });
        arrivalPause.run = async () => {
            paused();
            await released;
        };
        const arrival = db.transaction((tx) =>
            attachArrivingRecordingInTx(tx, "owner", "recording", "arrival"),
        );
        await atDecision;
        const invitation = inviteToItem("owner", itemId, ["receiver"]).then(
            () => "invited" as const,
            (error: unknown) => {
                expect(error).toMatchObject({ statusCode: 404 });
                return "refused" as const;
            },
        );
        try {
            await Promise.race([
                invitation,
                new Promise((resolve) => setTimeout(resolve, 150)),
            ]);
        } finally {
            resume();
        }
        await arrival;
        const outcome = await invitation;
        const [agenda] = await db
            .select()
            .from(meetingAgendas)
            .where(eq(meetingAgendas.id, plan.id));
        expect(!agenda.recordingItemId || outcome === "refused").toBe(true);
    });

    it.each([
        "owner",
        "folder",
        "organization",
    ])("keeps a hidden-recording agenda in the %s audience's list, folder and MCP", async (audience) => {
        const plan = await create();
        const itemId = plan.meeting.meetingItemId as string;
        await invite(itemId);
        let callerId = "owner";
        let folderId = "owner-folder";
        if (audience === "folder") {
            const share = (
                await inviteToFolder("owner", "owner-folder", ["other"])
            )[0];
            await changeFolderShare("other", share.id, {
                action: "accept",
                version: 0,
                name: "Shared plans",
            });
            callerId = "other";
        } else if (audience === "organization") {
            await addRecordingToFolder({
                userId: "owner",
                recordingId: itemId,
                folderId: "org-folder",
            });
            callerId = "other";
            folderId = "org-folder";
        }
        await recording("receiver");
        await attachAgenda("receiver", plan.id, "recording");
        const listed = await listMeetings(callerId, { includePast: true });
        expect(listed).toContainEqual(
            expect.objectContaining({
                id: plan.id,
                recordingItemId: null,
                recorded: true,
            }),
        );
        expect(
            (await listMeetings(callerId, { includePast: true, folderId })).map(
                (row) => row.id,
            ),
        ).toContain(plan.id);
        expect(await reminderMeetings(callerId, { includePast: true })).toEqual(
            [],
        );
        const tool = MEETING_TOOLS.find(
            (tool) => tool.name === "list_meetings",
        );
        expect(
            await tool?.run(
                {
                    caller: userCaller(
                        callerId,
                        `${callerId}@example.com`,
                        ["tasks:read", "summaries:read"],
                        "org",
                    ),
                    touched: [],
                },
                {},
            ),
        ).toMatchObject({
            meetings: [
                expect.objectContaining({ id: plan.id, recordingItemId: null }),
            ],
        });
    });

    it("excludes absorbed agendas from the recorder match endpoint and snapshot refresh", async () => {
        const plan = await create();
        await invite(plan.meeting.meetingItemId as string);
        await recording();
        await attachAgenda("owner", plan.id, "recording");
        actor.id = "receiver";
        readSnapshot.mockClear();
        const response = await matchRoute(
            new Request(
                `http://localhost/api/v1/recorder/agendas/match?at=${start.toISOString()}`,
            ),
            { params: Promise.resolve({}) },
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ data: [] });
        await Promise.all(refreshes.map((refresh) => refresh()));
        expect(readSnapshot).not.toHaveBeenCalled();
    });

    it.each([
        "organization",
        "private",
        "shared",
    ])("resolves only visible %s agenda placements on the caller's account", async (placement) => {
        const plan = await create(
            placement === "organization" ? "org-folder" : "owner-folder",
        );
        if (placement === "shared") {
            const share = (
                await inviteToFolder("owner", "owner-folder", ["receiver"])
            )[0];
            await changeFolderShare("receiver", share.id, {
                action: "accept",
                version: 0,
                name: "Team plans",
            });
        } else if (placement === "private")
            await invite(plan.meeting.meetingItemId as string);
        profile.mockResolvedValue({
            status: "resolved",
            profile: {
                settings: {
                    steps: {
                        summary: {
                            provider: { kind: "default" },
                            outputLanguage: "cs",
                        },
                    },
                },
            },
        });
        provider.mockResolvedValue({ kind: "credential", credential: {} });
        await agendaSuggestionsProvider("receiver", plan.id);
        expect(profile).toHaveBeenLastCalledWith(
            expect.objectContaining({
                ownerUserId: "receiver",
                folderIds:
                    placement === "private"
                        ? []
                        : [
                              placement === "organization"
                                  ? "org-folder"
                                  : "owner-folder",
                          ],
                view: placement === "organization" ? "org" : "private",
            }),
        );
        expect(provider).toHaveBeenLastCalledWith(
            expect.objectContaining({ actorUserId: "receiver" }),
        );
    });

    it("excludes an agenda anchored by the owner's trashed recording from backup", async () => {
        const plan = await create();
        await recording();
        await attachAgenda("owner", plan.id, "recording");
        await db
            .update(chatterItems)
            .set({ deletedAt: new Date() })
            .where(eq(chatterItems.id, "recording"));
        const archive = await collectArchivedMeetings({
            kind: "personal",
            userId: "owner",
        });
        expect(archive).toEqual([]);
        expect(
            await restoreMeetings("owner", { meetings: archive }),
        ).toMatchObject({ restored: [], skipped: [] });
    });

    it("does not compute agenda task disclosure in a recording's share dialog", async () => {
        const plan = await create();
        await recording();
        await attachAgenda("owner", plan.id, "recording");
        disclosure.mockClear();
        const response = await shareDetail(
            new Request("http://localhost/api/items/recording/shares"),
            { params: Promise.resolve({ id: "recording" }) },
        );
        expect(response.status).toBe(200);
        expect((await response.json()).agendaTasks).toBeNull();
        expect(disclosure).not.toHaveBeenCalled();
    });

    it.each([
        "hosted",
        "local",
        "organization",
    ])("returns 404 for %s person sharing", async (variant) => {
        const plan = await create();
        if (variant === "hosted") mode.IS_HOSTED = true;
        if (variant === "local") mode.SELF_HOST_MODE = "local";
        await expect(
            inviteToItem(
                variant === "organization" ? "org" : "owner",
                plan.meeting.meetingItemId as string,
                ["receiver"],
            ),
        ).rejects.toMatchObject({ statusCode: 404 });
    });
});
