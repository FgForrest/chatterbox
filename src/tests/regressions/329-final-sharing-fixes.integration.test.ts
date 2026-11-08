import { eq } from "drizzle-orm";
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { POST } from "@/app/api/meetings/[id]/recording-shares/route";
import { db } from "@/db";
import { meetingItemAudienceInTx } from "@/db/queries/meeting-audience";
import {
    chatterItems,
    folderShares,
    itemShares,
    meetingAgendas,
    recordingFolderAssignments,
    recordingFolders,
    users,
} from "@/db/schema";
import { encryptText } from "@/lib/encryption/fields";
import { agendaCandidates } from "@/lib/meetings/attachment";
import { meetingAttachmentAudienceInTx } from "@/lib/meetings/attachment-audience";
import { getMeeting } from "@/lib/meetings/service";
import { inviteToItem } from "@/lib/sharing/person-shares";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";
import { insertRecording } from "@/tests/mcp/fixtures";

const { ref, actor } = vi.hoisted(() => ({
    ref: { current: null as Record<PropertyKey, unknown> | null },
    actor: { id: "owner" },
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
}));
vi.mock("@/lib/env", () => ({
    env: {
        IS_HOSTED: false,
        SELF_HOST_MODE: "shared",
        AUTHZ_MODE: "local",
        ORG_ACCOUNT_EMAIL: "org@example.com",
        ORG_ACCOUNT_PASSWORD: "test",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        BETTER_AUTH_SECRET: "round-four-test",
    },
}));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async () => ({ user: { id: actor.id } }),
}));
vi.mock("@/lib/authz/curator", () => ({
    userCuratesOrganizationNow: async () => false,
    actsForOrganization: async () => false,
}));
vi.mock("@/lib/recording-sessions/route-gate", () => ({
    gateRecordingSessionRequest: vi.fn(),
}));
vi.mock("@/lib/events/personal", () => ({
    notifyPersonShareChanged: async () => {},
}));
vi.mock("@/lib/notifications/person-share", () => ({
    sendPersonShareInvitation: async () => {},
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));
vi.mock("@/lib/meetings/calendar-snapshot", () => ({
    readMeetingCalendarSnapshot: async () => null,
}));
vi.mock("@/lib/meetings/suggestions-provider", () => ({
    agendaSuggestionsAvailability: async () => ({
        available: false,
        reason: null,
    }),
}));
vi.mock("@/lib/integrations/google/connection", () => ({
    getGoogleConnectionStatus: async () => null,
}));

const url = getTestDatabaseUrl();
const start = new Date("2026-11-08T10:00:00Z");
describe.skipIf(!url)("round-four sharing fixes (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            url ?? "",
            "round_four_sharing",
        );
        ref.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120000);
    afterAll(async () => {
        ref.current = null;
        await database?.dispose();
    }, 60000);
    beforeEach(async () => {
        actor.id = "owner";
        await db.delete(users);
        await db.insert(users).values(
            ["owner", "direct", "folder-person", "inactive", "org"].map(
                (id) => ({
                    id,
                    email: `${id}@example.com`,
                    name: id,
                    role: id === "org" ? ("org" as const) : ("user" as const),
                }),
            ),
        );
        await db.insert(recordingFolders).values(
            ["owner", "direct", "org"].map((userId) => ({
                id: `${userId}-folder`,
                userId,
                kind: "custom" as const,
                name: encryptText("Project"),
                nameHash: "project",
            })),
        );
        await db.insert(chatterItems).values({
            id: "meeting",
            userId: "owner",
            kind: "meeting",
            title: encryptText("Project agenda"),
            occurredAt: start,
        });
        await db.insert(meetingAgendas).values({
            id: "agenda",
            userId: "owner",
            meetingItemId: "meeting",
            plannedStart: start,
            plannedEnd: new Date(start.getTime() + 3600000),
            timeSet: true,
        });
        await db.insert(recordingFolderAssignments).values({
            userId: "owner",
            itemId: "meeting",
            folderId: "owner-folder",
        });
        await insertRecording(database.db, {
            id: "source",
            userId: "owner",
            startTime: start,
        });
        await db
            .update(meetingAgendas)
            .set({ snapshotSourceItemId: "source" })
            .where(eq(meetingAgendas.id, "agenda"));
    });
    async function inviteSource(recordingItemId = "source", id = "meeting") {
        return POST(
            new Request(
                `http://localhost/api/meetings/${id}/recording-shares`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ recordingItemId, taskSource: true }),
                },
            ),
            { params: Promise.resolve({ id }) },
        );
    }
    async function agendaInvite(
        userId: string,
        state: "pending" | "accepted" = "pending",
    ) {
        await db.insert(itemShares).values({
            userId: "owner",
            itemId: "meeting",
            receiverUserId: userId,
            state,
        });
    }
    it("invites active pending and accepted task-source recipients despite a suspended co-invitee", async () => {
        await agendaInvite("direct");
        await agendaInvite("folder-person", "accepted");
        await agendaInvite("inactive");
        await db
            .update(users)
            .set({ suspendedAt: new Date() })
            .where(eq(users.id, "inactive"));
        const response = await inviteSource();
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            recordingShare: {
                invited: expect.arrayContaining(["direct", "folder-person"]),
                skipped: [{ userId: "inactive", reason: "inactive" }],
            },
        });
        const shares = await db
            .select()
            .from(itemShares)
            .where(eq(itemShares.itemId, "source"));
        expect(shares.map((share) => share.receiverUserId).sort()).toEqual([
            "direct",
            "folder-person",
        ]);
    });
    it("invites more than twenty task-source recipients independently", async () => {
        const ids = Array.from({ length: 25 }, (_, i) => `invitee-${i}`);
        await db
            .insert(users)
            .values(ids.map((id) => ({ id, email: `${id}@example.com` })));
        for (const id of ids) await agendaInvite(id);
        const response = await inviteSource();
        expect(response.status).toBe(200);
        const result = await response.json();
        expect(result.recordingShare.invited.sort()).toEqual(ids.sort());
        expect(result.recordingShare.skipped).toEqual([]);
    });
    it("skips recording viewers and existing invitations without resetting their state", async () => {
        await agendaInvite("direct");
        await agendaInvite("folder-person");
        await inviteToItem("owner", "source", ["direct"]);
        await db.insert(recordingFolderAssignments).values({
            userId: "owner",
            itemId: "source",
            folderId: "owner-folder",
        });
        await db.insert(folderShares).values({
            userId: "owner",
            folderId: "owner-folder",
            receiverUserId: "folder-person",
            state: "accepted",
        });
        const response = await inviteSource();
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            recordingShare: {
                invited: [],
                skipped: expect.arrayContaining([
                    { userId: "direct", reason: "already_visible_or_invited" },
                    {
                        userId: "folder-person",
                        reason: "already_visible_or_invited",
                    },
                ]),
            },
        });
    });
    it("keeps task-source invitations author-only, recording-owner-only and scoped to the agenda source", async () => {
        await agendaInvite("direct", "accepted");
        actor.id = "direct";
        expect((await inviteSource()).status).toBe(404);
        actor.id = "owner";
        expect((await inviteSource("unrelated")).status).toBe(409);
        await insertRecording(database.db, {
            id: "other-source",
            userId: "direct",
        });
        await db
            .update(meetingAgendas)
            .set({ snapshotSourceItemId: "other-source" })
            .where(eq(meetingAgendas.id, "agenda"));
        expect((await inviteSource("other-source")).status).toBe(404);
        expect((await inviteSource("source", "source")).status).toBe(404);
    });
    it("excludes direct agenda recipients from detail and candidate filing disclosure", async () => {
        await agendaInvite("direct", "accepted");
        const detail = await getMeeting("owner", "agenda");
        if (detail.unchanged) throw new Error("Missing agenda");
        expect(detail.attachmentAudience).toEqual({
            organization: false,
            userIds: [],
            users: [],
        });
        const candidates = await agendaCandidates("owner", "source");
        expect(candidates[0].audience).toEqual(detail.attachmentAudience);
        expect(candidates[0].widensSharing).toBe(false);
        const current = await db.transaction((tx) =>
            meetingItemAudienceInTx(tx, "meeting", "owner", "org"),
        );
        expect(current.userIds.has("direct")).toBe(true);
    });
    it("discloses folder recipients without direct recipients", async () => {
        await agendaInvite("direct", "accepted");
        await db.insert(folderShares).values({
            userId: "owner",
            folderId: "owner-folder",
            receiverUserId: "folder-person",
            state: "accepted",
        });
        const detail = await getMeeting("owner", "agenda");
        if (detail.unchanged) throw new Error("Missing agenda");
        expect(detail.attachmentAudience).toEqual({
            organization: false,
            userIds: ["folder-person"],
            users: [{ id: "folder-person", name: "folder-person" }],
        });
        expect((await agendaCandidates("owner", "source"))[0].audience).toEqual(
            detail.attachmentAudience,
        );
    });
    it("discloses Organization filing", async () => {
        await db.insert(recordingFolderAssignments).values({
            userId: "owner",
            itemId: "meeting",
            folderId: "org-folder",
        });
        const detail = await getMeeting("owner", "agenda");
        if (detail.unchanged) throw new Error("Missing agenda");
        expect(detail.attachmentAudience).toEqual({
            organization: true,
            userIds: [],
            users: [],
        });
        expect((await agendaCandidates("owner", "source"))[0].audience).toEqual(
            detail.attachmentAudience,
        );
    });
    it("omits the author's inaccessible folders when a receiver attaches", async () => {
        await agendaInvite("direct", "accepted");
        await db.insert(folderShares).values({
            userId: "owner",
            folderId: "owner-folder",
            receiverUserId: "folder-person",
            state: "accepted",
        });
        const result = await db.transaction((tx) =>
            meetingAttachmentAudienceInTx(tx, {
                itemId: "meeting",
                ownerUserId: "owner",
                actorUserId: "direct",
                orgUserId: "org",
                folderIds: ["owner-folder"],
            }),
        );
        expect(result.disclosure).toEqual({
            organization: false,
            userIds: [],
            users: [],
        });
        expect(result.current.userIds.has("folder-person")).toBe(true);
    });
});
