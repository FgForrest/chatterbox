import { and, eq } from "drizzle-orm";
import type postgres from "postgres";
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    expectTypeOf,
    it,
    vi,
} from "vitest";
import { db } from "@/db";
import { listMeetingRows, type MeetingTx } from "@/db/queries/meetings";
import {
    chatterItems,
    folderDefaultProfiles,
    meetingAgendas,
    recordingFolderAssignments,
    recordingFolders,
    restrictedFolderMembers,
    users,
} from "@/db/schema";
import { collectArchivedMeetings } from "@/lib/export/meetings";
import * as folders from "@/lib/folders/folders";
import { changeFolderRestriction } from "@/lib/folders/restricted-folders";
import { agendaCandidates } from "@/lib/meetings/attachment";
import { restoreMeetings } from "@/lib/meetings/restore";
import { prepareMeeting } from "@/lib/meetings/service";
import { recordIntendedPlacementInTx } from "@/lib/pipeline/share-intent";
import { folderDefaultProfileDetails } from "@/lib/profiles/resolve-for-placement";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";
import { insertRecording } from "@/tests/mcp/fixtures";

const { ref, sqlRef, mockEnv, curator } = vi.hoisted(() => ({
    ref: { current: null as Record<PropertyKey, unknown> | null },
    sqlRef: { current: null as postgres.Sql | null },
    curator: vi.fn(async (id: string) => id === "org" || id === "curator"),
    mockEnv: {
        IS_HOSTED: false,
        DEFAULT_STORAGE_TYPE: "local",
        SELF_HOST_MODE: "shared",
        AUTHZ_MODE: "local",
        ORG_ACCOUNT_EMAIL: "org@example.com",
        ORG_ACCOUNT_PASSWORD: "demo-password",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
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
    userCuratesOrganizationNow: curator,
    actsForOrganization: async (actor: { actorId: string }) =>
        curator(actor.actorId),
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/org/events", () => ({
    notifyOrgChange: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));

const url = getTestDatabaseUrl();
const suite = url ? describe : describe.skip;

suite("restricted folders review 6 (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    let folderId: string;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            url ?? "",
            "restricted_fix6",
        );
        sqlRef.current = database.sql;
        ref.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120000);
    afterAll(async () => {
        ref.current = null;
        sqlRef.current = null;
        await database?.dispose();
    }, 30000);
    beforeEach(async () => {
        vi.restoreAllMocks();
        curator.mockClear();
        await db.delete(users);
        await db.insert(users).values(
            ["owner", "member", "other", "new", "curator", "org"].map((id) => ({
                id,
                name: `User ${id}`,
                email: `${id}@example.com`,
                role: id === "org" ? ("org" as const) : ("user" as const),
            })),
        );
        await folders.ensureRootFolders("org");
        const [root] = await db
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, "org"));
        folderId = (
            await folders.createFolder({
                userId: "org",
                parentId: root.id,
                name: "Acme",
                canCurate: true,
            })
        ).id;
    }, 30000);

    it("requires explicit authority for transactional reads and intended placements", () => {
        const tx = {} as MeetingTx;
        const missingCurator = ["owner", "org", {}, tx] as const;
        expectTypeOf(listMeetingRows).toBeCallableWith("owner", "org");
        expectTypeOf(listMeetingRows).toBeCallableWith(
            "owner",
            "org",
            { isCurator: true },
            tx,
        );
        // @ts-expect-error Transactional meeting reads require explicit curator authority.
        expectTypeOf(listMeetingRows).toBeCallableWith(...missingCurator);
        const profileInput = {
            folderId,
            folderOwnerUserId: "org",
            actorUserId: "curator",
            channel: "audio" as const,
            executor: tx,
        };
        expectTypeOf(folderDefaultProfileDetails).toBeCallableWith({
            ...profileInput,
            isCurator: true,
        });
        const defaults = expectTypeOf(folderDefaultProfileDetails);
        // @ts-expect-error Transactional folder defaults require explicit curator authority.
        defaults.toBeCallableWith(profileInput);
        const placement = { ownerUserId: "owner", itemId: "item", folderId };
        expectTypeOf(recordIntendedPlacementInTx).toBeCallableWith(tx, {
            ...placement,
            canCurate: false,
        });
        const intended = expectTypeOf(recordIntendedPlacementInTx);
        // @ts-expect-error Intended placements require explicit curator authority.
        intended.toBeCallableWith(tx, placement);
    });

    it.each([
        false,
        true,
    ])("resumes a stuck restriction additively (new audience: %s)", async (addAudience) => {
        const epoch = new Date("2026-09-01T09:00:00Z");
        const addedAt = new Date("2026-09-01T09:10:00Z");
        await db
            .update(recordingFolders)
            .set({ restrictingAt: epoch })
            .where(eq(recordingFolders.id, folderId));
        await db.insert(restrictedFolderMembers).values([
            {
                folderId,
                userId: "member",
                role: "manager",
                addedByUserId: "other",
                createdAt: epoch,
            },
            {
                folderId,
                userId: "other",
                addedByUserId: "member",
                createdAt: addedAt,
            },
        ]);
        const existing = await db
            .select()
            .from(restrictedFolderMembers)
            .where(eq(restrictedFolderMembers.folderId, folderId));
        await insertRecording(database.db, {
            id: "current-owner-item",
            userId: "owner",
        });
        await db.insert(recordingFolderAssignments).values({
            folderId,
            userId: "owner",
            itemId: "current-owner-item",
        });
        const result = addAudience
            ? await changeFolderRestriction("org", folderId, "restrict", [
                  "new",
                  "member",
              ])
            : await changeFolderRestriction("org", folderId, "restrict");
        expect(result).toMatchObject({
            restricted: true,
            restricting: false,
            processed: 1,
        });
        const members = await db
            .select()
            .from(restrictedFolderMembers)
            .where(eq(restrictedFolderMembers.folderId, folderId));
        for (const member of existing)
            expect(members.find((row) => row.userId === member.userId)).toEqual(
                member,
            );
        expect(members.map((row) => row.userId).sort()).toEqual(
            (addAudience
                ? ["member", "other", "owner", "new"]
                : ["member", "other", "owner"]
            ).sort(),
        );
        const [folder] = await db
            .select()
            .from(recordingFolders)
            .where(eq(recordingFolders.id, folderId));
        expect(folder.restrictedAt).toEqual(epoch);
        const [placement] = await db
            .select()
            .from(recordingFolderAssignments)
            .where(eq(recordingFolderAssignments.itemId, "current-owner-item"));
        expect(placement.withheld).toBe(true);
    }, 30000);

    it.each([
        "curator",
        "other",
    ])("uses resolved authority for restricted attach candidates (%s)", async (actor) => {
        await changeFolderRestriction("org", folderId, "restrict", ["owner"]);
        const meeting = await prepareMeeting("owner", {
            folderId,
            title: "Restricted agenda",
            start: "2026-09-01T10:00:00Z",
            end: "2026-09-01T11:00:00Z",
        });
        await insertRecording(database.db, {
            id: "candidate-recording",
            userId: actor,
        });
        const candidates = await agendaCandidates(actor, "candidate-recording");
        expect(candidates.map((candidate) => candidate.id)).toEqual(
            actor === "curator" ? [meeting.id] : [],
        );
        const isCurator = await curator(actor);
        curator.mockClear();
        const rows = await db.transaction((tx) =>
            listMeetingRows(actor, "org", { includePast: true, isCurator }, tx),
        );
        expect(rows.map((row) => row.agenda.id)).toEqual(
            actor === "curator" ? [meeting.id] : [],
        );
        expect(curator).not.toHaveBeenCalled();
    }, 30000);

    it.each([
        "curator",
        "other",
    ])("uses resolved authority for restricted folder defaults (%s)", async (actor) => {
        await changeFolderRestriction("org", folderId, "restrict", ["owner"]);
        await db
            .insert(folderDefaultProfiles)
            .values({ folderId, channel: "audio", manualOnly: true });
        const isCurator = await curator(actor);
        curator.mockClear();
        const details = await db.transaction((executor) =>
            folderDefaultProfileDetails({
                folderId,
                folderOwnerUserId: "org",
                actorUserId: actor,
                channel: "audio",
                executor,
                isCurator,
            }),
        );
        if (isCurator) expect(details).toMatchObject({ ownManualOnly: true });
        else expect(details).toBeNull();
        expect(curator).not.toHaveBeenCalled();
    }, 30000);

    it("skips and rolls back a restore when its authorized folder is deleted concurrently", async () => {
        await folders.ensureRootFolders("owner");
        const [root] = await db
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, "owner"));
        const target = await folders.createFolder({
            userId: "owner",
            parentId: root.id,
            name: "Archive target",
        });
        const meeting = await prepareMeeting("owner", {
            folderId: target.id,
            title: "Restored agenda",
        });
        const archive = await collectArchivedMeetings({
            kind: "personal",
            userId: "owner",
        });
        await db
            .delete(meetingAgendas)
            .where(eq(meetingAgendas.id, meeting.id));
        await db
            .delete(chatterItems)
            .where(
                and(
                    eq(chatterItems.userId, "owner"),
                    eq(chatterItems.kind, "meeting"),
                ),
            );
        const authorize = folders.assertCategorizableFolder;
        vi.spyOn(folders, "assertCategorizableFolder").mockImplementation(
            async (...args) => {
                const authorized = await authorize(...args);
                await db
                    .delete(recordingFolders)
                    .where(
                        and(
                            eq(recordingFolders.id, target.id),
                            eq(recordingFolders.userId, "owner"),
                        ),
                    );
                return authorized;
            },
        );
        const result = await restoreMeetings("owner", {
            meetings: archive,
            folderIdMap: { [target.id]: target.id },
        });
        expect(result.restored).toEqual([]);
        expect(result.skipped).toEqual([
            { id: meeting.id, reason: "Mapped folder no longer exists" },
        ]);
        expect(
            await db
                .select()
                .from(chatterItems)
                .where(
                    and(
                        eq(chatterItems.userId, "owner"),
                        eq(chatterItems.kind, "meeting"),
                    ),
                ),
        ).toEqual([]);
        expect(
            await db
                .select()
                .from(meetingAgendas)
                .where(eq(meetingAgendas.userId, "owner")),
        ).toEqual([]);
    }, 30000);
});
