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
import {
    agendaPoints,
    agendaSuggestions,
    aiEnhancements,
    chatterItems,
    folderShares,
    mailPendingShares,
    meetingAgendas,
    recordingFolderAssignments,
    recordingFolders,
    recordingTasks,
    users,
} from "@/db/schema";
import { insertRecordings } from "@/tests/integration/items";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const state = vi.hoisted(() => ({
    actor: "owner",
    current: null as Record<PropertyKey, unknown> | null,
}));
vi.mock("@/db", () => ({
    db: new Proxy(
        {},
        {
            get(_target, key) {
                const value = state.current?.[key];
                return typeof value === "function"
                    ? value.bind(state.current)
                    : value;
            },
        },
    ),
    sqlClient: null,
}));
vi.mock("@/lib/env", () => ({
    env: {
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        BETTER_AUTH_SECRET: "multiple-folders-test",
        AUTHZ_MODE: "local",
        IS_HOSTED: false,
        SELF_HOST_MODE: "shared",
    },
}));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async () => ({ user: { id: state.actor } }),
}));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: async () => "org",
    isOrgAccount: async (id: string) => id === "org",
    isOrgScopeVisible: () => true,
    isOrgScopeEnabled: () => true,
    assertOrgScopeWritable: () => undefined,
}));
vi.mock("@/lib/authz/curator", () => ({
    userCuratesOrganizationNow: async () => false,
    actsForOrganization: async () => false,
}));
vi.mock("@/lib/meetings/suggestions-provider", () => ({
    agendaSuggestionsAvailability: async () => ({
        available: false,
        reason: null,
    }),
}));
vi.mock("@/lib/meetings/calendar-snapshot", () => ({
    readMeetingCalendarSnapshot: async () => null,
}));
vi.mock("@/lib/learn/summary-refresh", () => ({
    isSummaryStale: async () => false,
}));
vi.mock("@/lib/pipeline/trigger", () => ({
    requestAdvanceInTx: async () => undefined,
}));
vi.mock("@/lib/profiles/placement-binding", () => ({
    bindPlacementProfileInTx: async () => undefined,
}));
vi.mock("@/lib/knowledge/share-knowledge", () => ({
    publishKnowledgeInTx: async () => ({ scopes: new Set() }),
    withdrawKnowledgeInTx: async () => new Set(),
}));
vi.mock("@/lib/knowledge/embeddings", () => ({ embeddingClient: () => null }));
vi.mock("@/lib/mail/redact", () => ({
    secretAddressMasker: async () => (text: string) => text,
}));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: async () => undefined,
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));

import { DELETE, PATCH, POST } from "@/app/api/recordings/[id]/folders/route";
import { db } from "@/db";
import { agendaSuggestionInputs } from "@/db/queries/agenda-suggestions";
import { meetingItemAudienceInTx } from "@/db/queries/meeting-audience";
import { encryptText } from "@/lib/encryption/fields";
import { collectArchivedMeetings } from "@/lib/export/meetings";
import {
    agendaCandidates,
    attachAgenda,
    attachArrivingRecordingInTx,
} from "@/lib/meetings/attachment";
import { meetingCalendarEvents } from "@/lib/meetings/calendar";
import { restoreMeetings } from "@/lib/meetings/restore";
import {
    addPoint,
    changeAgendaTask,
    getMeeting,
    listMeetings,
    patchMeeting,
    prepareMeeting,
} from "@/lib/meetings/service";
import { taskViewerById } from "@/lib/tasks/access";

const url = getTestDatabaseUrl();
const at = new Date("2026-11-03T10:00:00Z");
describe.skipIf(!url)("agenda placements (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            url ?? "",
            "agenda_folders",
        );
        state.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120000);
    afterAll(async () => {
        state.current = null;
        await database?.dispose();
    }, 120_000);
    beforeEach(async () => {
        state.actor = "owner";
        await db.delete(users);
        await db.insert(users).values(
            ["owner", "other", "third", "org"].map((id) => ({
                id,
                email: `${id}@example.com`,
                role: id === "org" ? ("org" as const) : ("user" as const),
            })),
        );
        for (const owner of ["owner", "other", "org"]) {
            await db.insert(recordingFolders).values({
                id: `${owner}-root`,
                userId: owner,
                kind: owner === "org" ? "public" : "private",
                name: encryptText("Root"),
                nameHash: "root",
            });
            await db.insert(recordingFolders).values({
                id: `${owner}-folder`,
                userId: owner,
                parentId: `${owner}-root`,
                kind: "custom",
                name: encryptText(`${owner} folder`),
                nameHash: "folder",
            });
        }
        await db.insert(chatterItems).values({
            id: "meeting",
            userId: "owner",
            kind: "meeting",
            title: encryptText("Planning"),
            occurredAt: at,
        });
        await db.insert(meetingAgendas).values({
            id: "agenda",
            userId: "owner",
            meetingItemId: "meeting",
            plannedStart: at,
            plannedEnd: new Date(at.getTime() + 3600000),
            timeSet: true,
        });
        await db.insert(recordingFolderAssignments).values({
            userId: "owner",
            itemId: "meeting",
            folderId: "owner-folder",
        });
    });
    async function mutate(
        method: "POST" | "PATCH" | "DELETE",
        body: object,
        actor = "owner",
    ) {
        state.actor = actor;
        return { POST, PATCH, DELETE }[method](
            new Request("http://localhost/api/recordings/meeting/folders", {
                method,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            }),
            { params: Promise.resolve({ id: "meeting" }) },
        );
    }
    async function share(folderId: string, owner: string, receiver: string) {
        await db.insert(folderShares).values({
            userId: owner,
            folderId,
            receiverUserId: receiver,
            state: "accepted",
        });
    }
    async function recording(id: string, folders: string[]) {
        await insertRecordings(database.db, {
            id,
            userId: "owner",
            filename: encryptText(id),
            startTime: at,
            endTime: new Date(at.getTime() + 3600000),
            duration: 3600000,
            filesize: 1,
            fileMd5: "a".repeat(32),
            storageType: "local",
            storagePath: `${id}.ogg`,
            deviceSn: "test",
            plaudFileId: id,
            plaudVersion: "1",
        });
        if (folders.length)
            await db.insert(recordingFolderAssignments).values(
                folders.map((folderId) => ({
                    userId: "owner",
                    itemId: id,
                    folderId,
                })),
            );
    }
    it("unions viewers and co-editors from a second folder, then revokes that path on unfiling", async () => {
        await share("other-folder", "other", "owner");
        await share("other-folder", "other", "third");
        await expect(getMeeting("third", "agenda")).rejects.toMatchObject({
            statusCode: 404,
        });
        expect(
            (await mutate("POST", { folderId: "other-folder" })).status,
        ).toBe(200);
        expect(await getMeeting("third", "agenda")).toMatchObject({
            permissions: { edit: true, manage: false },
        });
        const point = await addPoint("third", "agenda", {
            text: "A colleague's point",
        });
        expect(
            (
                await listMeetings("third", {
                    folderId: "other-folder",
                    includePast: true,
                })
            ).map((row) => row.id),
        ).toEqual(["agenda"]);
        expect(
            (await mutate("DELETE", { folderId: "other-folder" })).status,
        ).toBe(200);
        await expect(getMeeting("third", "agenda")).rejects.toMatchObject({
            statusCode: 404,
        });
        expect(
            await db
                .select()
                .from(agendaPoints)
                .where(eq(agendaPoints.id, point.id)),
        ).toHaveLength(1);
    });
    it("moves between personal and Organization folders atomically, with no recording share gate for a plan", async () => {
        expect(
            (
                await mutate("PATCH", {
                    fromFolderId: "owner-folder",
                    toFolderId: "org-folder",
                })
            ).status,
        ).toBe(200);
        expect(await getMeeting("other", "agenda")).toMatchObject({
            permissions: { edit: true },
        });
        expect(
            (
                await mutate("PATCH", {
                    fromFolderId: "org-folder",
                    toFolderId: "owner-folder",
                    withdraw: true,
                })
            ).status,
        ).toBe(200);
        await expect(getMeeting("other", "agenda")).rejects.toMatchObject({
            statusCode: 404,
        });
        expect(
            (await db.select().from(recordingFolderAssignments)).map(
                (row) => row.folderId,
            ),
        ).toEqual(["owner-folder"]);
    });
    it("lets a receiver file their own agenda into a two-way shared folder but rejects another participant's write", async () => {
        await share("other-folder", "other", "owner");
        expect(
            (await mutate("POST", { folderId: "other-folder" })).status,
        ).toBe(200);
        expect(await getMeeting("other", "agenda")).toMatchObject({
            permissions: { edit: true },
        });
        expect(
            (await mutate("POST", { folderId: "org-folder" }, "other")).status,
        ).toBe(403);
        expect(
            (await mutate("DELETE", { folderId: "other-folder" }, "other"))
                .status,
        ).toBe(200);
    });
    it("keeps points and notes when the last folder is removed, with owner-only access", async () => {
        const point = await addPoint("owner", "agenda", {
            text: "Keep this point",
        });
        expect(
            (await mutate("DELETE", { folderId: "owner-folder" })).status,
        ).toBe(200);
        expect(await getMeeting("owner", "agenda")).toMatchObject({
            folders: [],
            points: [expect.objectContaining({ id: point.id })],
        });
        await expect(getMeeting("other", "agenda")).rejects.toMatchObject({
            statusCode: 404,
        });
    });
    it("never automatically widens a recording to a viewer from the second agenda folder", async () => {
        await share("other-folder", "other", "owner");
        await mutate("POST", { folderId: "other-folder" });
        await recording("rec", ["owner-folder"]);
        await db.transaction((tx) =>
            attachArrivingRecordingInTx(tx, "owner", "rec", "rec"),
        );
        expect(await getMeeting("owner", "agenda")).toMatchObject({
            recordingItemId: null,
        });
        const audience = await db.transaction((tx) =>
            meetingItemAudienceInTx(tx, "meeting", "owner", "org"),
        );
        expect([...audience.userIds].sort()).toEqual(["other", "owner"]);
    });
    it("automatically attaches with equal audiences across both existing placements without filing anything", async () => {
        await share("other-folder", "other", "owner");
        await mutate("POST", { folderId: "other-folder" });
        await recording("rec", ["owner-folder", "other-folder"]);
        const [candidate] = await agendaCandidates("owner", "rec");
        expect(candidate.widensSharing).toBe(false);
        await db.transaction((tx) =>
            attachArrivingRecordingInTx(tx, "owner", "rec", "rec"),
        );
        expect(await getMeeting("owner", "agenda")).toMatchObject({
            recordingItemId: "rec",
        });
        expect(
            await db
                .select()
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.itemId, "rec")),
        ).toHaveLength(2);
    });
    it("explicit attachment carries all agenda placements", async () => {
        await share("other-folder", "other", "owner");
        await mutate("POST", { folderId: "other-folder" });
        await recording("rec", []);
        await attachAgenda("owner", "agenda", "rec");
        expect(
            (
                await db
                    .select()
                    .from(recordingFolderAssignments)
                    .where(eq(recordingFolderAssignments.itemId, "rec"))
            )
                .map((row) => row.folderId)
                .sort(),
        ).toEqual(["other-folder", "owner-folder"]);
    });
    it.each([
        ["org-folder", "owner-folder"],
        ["owner-folder", "org-folder"],
    ])("discloses Organization publication with placement order %s, %s", async (first, second) => {
        expect((await mutate("POST", { folderId: "org-folder" })).status).toBe(
            200,
        );
        for (const [index, folderId] of [first, second].entries()) {
            await db
                .update(recordingFolderAssignments)
                .set({ createdAt: new Date(at.getTime() - index * 1000) })
                .where(eq(recordingFolderAssignments.folderId, folderId));
        }
        await recording("rec", ["owner-folder"]);
        const candidates = await agendaCandidates("owner", "rec");
        expect(candidates).toHaveLength(1);
        expect(candidates[0]).toMatchObject({
            widensSharing: true,
            audience: { organization: true },
        });
        expect(candidates[0].folders.map((folder) => folder.id)).toEqual([
            first,
            second,
        ]);
        expect(
            await getMeeting("owner", "agenda", undefined, true),
        ).toMatchObject({
            attachmentAudience: candidates[0].audience,
        });
        await attachAgenda("owner", "agenda", "rec");
        expect(await db.select().from(mailPendingShares)).toMatchObject([
            { itemId: "rec", userId: "owner", folderId: "org-folder" },
        ]);
    });
    it.each([
        "accepted",
        "pending",
    ] as const)("discloses the extra recipient across two person-shared folders (%s)", async (state) => {
        await share("owner-folder", "owner", "other");
        await db.insert(recordingFolders).values({
            id: "second-folder",
            userId: "owner",
            parentId: "owner-root",
            kind: "custom",
            name: encryptText("Second"),
            nameHash: "second",
        });
        await db.insert(folderShares).values({
            userId: "owner",
            folderId: "second-folder",
            receiverUserId: "third",
            state,
        });
        expect(
            (await mutate("POST", { folderId: "second-folder" })).status,
        ).toBe(200);
        await recording("rec", ["owner-folder"]);
        const [candidate] = await agendaCandidates("owner", "rec");
        expect(candidate.widensSharing).toBe(true);
        expect(candidate.audience.organization).toBe(false);
        expect(candidate.audience.userIds.sort()).toEqual(["other", "third"]);
        expect(candidate.audience.users.map((user) => user.id).sort()).toEqual([
            "other",
            "third",
        ]);
        expect(
            await getMeeting("owner", "agenda", undefined, true),
        ).toMatchObject({
            attachmentAudience: candidate.audience,
        });
        await attachAgenda("owner", "agenda", "rec");
        expect(
            (
                await db
                    .select()
                    .from(recordingFolderAssignments)
                    .where(eq(recordingFolderAssignments.itemId, "rec"))
            )
                .map((row) => row.folderId)
                .sort(),
        ).toEqual(["owner-folder", "second-folder"]);
    });
    it("combines suggestions from both folders and deduplicates a recording filed in both", async () => {
        await share("other-folder", "other", "owner");
        await mutate("POST", { folderId: "other-folder" });
        await recording("first", ["owner-folder"]);
        await recording("second", ["other-folder"]);
        await recording("both", ["owner-folder", "other-folder"]);
        await db.insert(aiEnhancements).values(
            ["first", "second", "both"].map((itemId) => ({
                itemId,
                userId: "owner",
                source: "riffado" as const,
                provider: "test",
                model: "test",
                summary: encryptText(itemId),
            })),
        );
        const [agenda] = await db
            .select()
            .from(meetingAgendas)
            .where(eq(meetingAgendas.id, "agenda"));
        const result = await agendaSuggestionInputs({
            agenda,
            folderId: ["owner-folder", "other-folder"],
            userId: "owner",
            orgUserId: "org",
            viewer: await taskViewerById("owner"),
        });
        expect(result.summaries.map((row) => row.itemId).sort()).toEqual([
            "both",
            "first",
            "second",
        ]);
    });
    it("round-trips every owner folder placement without restoring foreign shares", async () => {
        await db.insert(recordingFolders).values({
            id: "second-folder",
            userId: "owner",
            parentId: "owner-root",
            kind: "custom",
            name: encryptText("Second"),
            nameHash: "second",
        });
        await mutate("POST", { folderId: "second-folder" });
        const archive = await collectArchivedMeetings({
            kind: "personal",
            userId: "owner",
        });
        expect(archive[0].folderIds.sort()).toEqual([
            "owner-folder",
            "second-folder",
        ]);
        const result = await restoreMeetings("owner", {
            meetings: archive,
            folderIdMap: {
                "owner-folder": "owner-folder",
                "second-folder": "second-folder",
            },
        });
        expect(result.skipped).toEqual([]);
        const restored = await getMeeting("owner", result.restored[0].id);
        expect(restored).toMatchObject({
            folders: expect.arrayContaining([
                expect.objectContaining({ id: "owner-folder" }),
                expect.objectContaining({ id: "second-folder" }),
            ]),
        });
    });
    it("selects automatic tasks across all folders while preserving an explicit source", async () => {
        await share("other-folder", "other", "owner");
        await recording("first", ["owner-folder"]);
        await recording("second", ["other-folder"]);
        for (const [index, id] of ["first", "second"].entries()) {
            await db
                .update(chatterItems)
                .set({
                    occurredAt: new Date(at.getTime() - (2 - index) * 3600000),
                })
                .where(eq(chatterItems.id, id));
            await db.insert(recordingTasks).values({
                id: `${id}-task`,
                itemId: id,
                userId: "owner",
                source: "manual",
                status: "open",
                text: encryptText(id),
            });
        }
        await mutate("POST", { folderId: "owner-folder" });
        expect(await getMeeting("owner", "agenda")).toMatchObject({
            snapshotSourceItemId: "first",
        });
        await changeAgendaTask("owner", "agenda", "first-task", {
            note: "Keep this review note",
        });
        await mutate("POST", { folderId: "other-folder" });
        expect(await getMeeting("owner", "agenda")).toMatchObject({
            snapshotSourceItemId: "second",
            tasks: expect.arrayContaining([
                expect.objectContaining({ id: "second-task" }),
                expect.objectContaining({
                    id: "first-task",
                    agendaNote: "Keep this review note",
                }),
            ]),
        });
        await patchMeeting("owner", "agenda", { taskSourceItemId: "first" });
        await mutate("DELETE", { folderId: "other-folder" });
        expect(await getMeeting("owner", "agenda")).toMatchObject({
            taskSourceItemId: "first",
            snapshotSourceItemId: "first",
        });
    });
    it("offers carry-over from a second folder once, including after it is filed again", async () => {
        await share("other-folder", "other", "owner");
        const previousAt = new Date(at.getTime() - 86400000);
        await db.insert(chatterItems).values({
            id: "prior-item",
            userId: "owner",
            kind: "meeting",
            title: encryptText("Previous"),
            occurredAt: previousAt,
        });
        await db.insert(meetingAgendas).values({
            id: "prior",
            meetingItemId: "prior-item",
            userId: "owner",
            state: "held",
            plannedStart: previousAt,
            createdAt: new Date("2026-01-01T00:00:00Z"),
        });
        await db.insert(recordingFolderAssignments).values({
            itemId: "prior-item",
            userId: "owner",
            folderId: "other-folder",
        });
        await db.insert(agendaPoints).values({
            id: "unfinished",
            agendaId: "prior",
            userId: "owner",
            authorUserId: "owner",
            text: encryptText("Review the proposal"),
        });
        await mutate("POST", { folderId: "other-folder" });
        let suggestions = await db
            .select()
            .from(agendaSuggestions)
            .where(eq(agendaSuggestions.agendaId, "agenda"));
        expect(suggestions).toHaveLength(1);
        expect(suggestions[0].originPointId).toBe("unfinished");
        await mutate("DELETE", { folderId: "other-folder" });
        await mutate("POST", { folderId: "other-folder" });
        suggestions = await db
            .select()
            .from(agendaSuggestions)
            .where(eq(agendaSuggestions.agendaId, "agenda"));
        expect(suggestions).toHaveLength(1);
    });
    it("serializes a second-folder filing against automatic attachment", async () => {
        await share("other-folder", "other", "owner");
        await recording("rec", ["owner-folder"]);
        const [filed] = await Promise.all([
            mutate("POST", { folderId: "other-folder" }),
            db.transaction((tx) =>
                attachArrivingRecordingInTx(tx, "owner", "rec", "rec"),
            ),
        ]);
        expect([200, 404, 409]).toContain(filed.status);
        const result = await getMeeting("owner", "agenda");
        expect(
            filed.status === 200 &&
                !result.unchanged &&
                result.recordingItemId === "rec",
        ).toBe(false);
    });
    it("does not regenerate another author's private preparation context during a collaborative Organization move", async () => {
        const previousAt = new Date(at.getTime() - 86400000);
        await db.insert(chatterItems).values({
            id: "private-prior",
            userId: "owner",
            kind: "meeting",
            title: encryptText("Private planning"),
            occurredAt: previousAt,
        });
        await db.insert(meetingAgendas).values({
            id: "private-prior-agenda",
            userId: "owner",
            meetingItemId: "private-prior",
            state: "held",
            plannedStart: previousAt,
            createdAt: new Date("2026-01-01T00:00:00Z"),
        });
        await db.insert(recordingFolderAssignments).values({
            itemId: "private-prior",
            userId: "owner",
            folderId: "owner-folder",
        });
        expect((await mutate("POST", { folderId: "org-folder" })).status).toBe(
            200,
        );
        await db.insert(agendaPoints).values({
            id: "private-topic",
            agendaId: "private-prior-agenda",
            userId: "owner",
            authorUserId: "owner",
            text: encryptText("Private follow-up"),
        });
        await db.insert(recordingFolders).values({
            id: "org-second",
            userId: "org",
            parentId: "org-root",
            kind: "custom",
            name: encryptText("Second team"),
            nameHash: "second",
        });
        expect(
            (
                await mutate(
                    "PATCH",
                    { fromFolderId: "org-folder", toFolderId: "org-second" },
                    "other",
                )
            ).status,
        ).toBe(200);
        const result = await getMeeting("other", "agenda");
        expect(result).toMatchObject({ suggestions: [] });
        expect(JSON.stringify(result)).not.toContain("Private follow-up");
    });
    it("authorizes Calendar context by the agenda after root filing or last unfiling", async () => {
        await share("other-folder", "other", "owner");
        await mutate("POST", { folderId: "other-folder" });
        await expect(
            meetingCalendarEvents("other", [], "agenda"),
        ).resolves.toMatchObject({ reason: "not_configured" });
        await expect(
            meetingCalendarEvents("third", [], "agenda"),
        ).rejects.toMatchObject({ statusCode: 404 });
        await mutate("DELETE", { folderId: "other-folder" });
        await mutate("PATCH", {
            fromFolderId: "owner-folder",
            toFolderId: "org-root",
        });
        await expect(
            meetingCalendarEvents("owner", [], "agenda"),
        ).resolves.toMatchObject({ reason: "not_configured" });
        await mutate("DELETE", { folderId: "org-root", withdraw: true });
        await expect(
            meetingCalendarEvents("owner", [], "agenda"),
        ).resolves.toMatchObject({ reason: "not_configured" });
    });
    it("discloses recipients for an untimed held agenda without a matching recording", async () => {
        await share("other-folder", "other", "owner");
        await mutate("POST", { folderId: "other-folder" });
        await db
            .update(meetingAgendas)
            .set({
                state: "held",
                timeSet: false,
                plannedStart: null,
                plannedEnd: null,
            })
            .where(eq(meetingAgendas.id, "agenda"));
        expect(
            await getMeeting("owner", "agenda", undefined, true),
        ).toMatchObject({
            attachmentAudience: {
                organization: false,
                userIds: ["other"],
                users: [{ id: "other" }],
            },
        });
        expect(await getMeeting("owner", "agenda")).toMatchObject({
            attachmentAudience: { userIds: ["other"] },
        });
        await expect(
            getMeeting("third", "agenda", undefined, true),
        ).rejects.toMatchObject({ statusCode: 404 });
    });
    it("includes disclosure in the initial creation response and after settings changes", async () => {
        await share("other-folder", "other", "owner");
        const created = await prepareMeeting("owner", {
            folderId: "other-folder",
            title: "New planning",
        });
        expect(created.meeting).toMatchObject({
            attachmentAudience: { userIds: ["other"] },
        });
        expect(
            await patchMeeting("owner", created.id, { state: "held" }),
        ).toMatchObject({
            attachmentAudience: { userIds: ["other"] },
        });
    });
    it("retries candidate discovery after a wrapped PostgreSQL deadlock", async () => {
        await recording("rec", ["owner-folder"]);
        const transaction = vi.spyOn(database.db, "transaction");
        transaction.mockRejectedValueOnce(
            new Error("Transaction failed", {
                cause: { code: "40P01" },
            }),
        );
        try {
            expect(await agendaCandidates("owner", "rec")).toMatchObject([
                { id: "agenda" },
            ]);
            expect(transaction).toHaveBeenCalledTimes(2);
        } finally {
            transaction.mockRestore();
        }
    });
    it("does not retry other candidate discovery errors", async () => {
        const error = new Error("Transaction failed");
        const transaction = vi
            .spyOn(database.db, "transaction")
            .mockRejectedValueOnce(error);
        try {
            await expect(agendaCandidates("owner", "rec")).rejects.toBe(error);
            expect(transaction).toHaveBeenCalledOnce();
        } finally {
            transaction.mockRestore();
        }
    });
});
