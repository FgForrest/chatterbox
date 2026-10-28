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
    agendaSuggestions,
    aiEnhancements,
    chatterItems,
    mailContents,
    mailMessages,
    meetingAgendas,
    people,
    personEmails,
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
                    const value = ref.current?.[key];
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
        BETTER_AUTH_SECRET: "meeting-gui-test",
        AUTHZ_MODE: "local",
        IS_HOSTED: false,
        SELF_HOST_MODE: "shared",
    },
}));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: async () => "org",
    isOrgAccount: async () => false,
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
vi.mock("@/lib/knowledge/embeddings", () => ({ embeddingClient: () => null }));
vi.mock("@/lib/mail/redact", () => ({
    secretAddressMasker: async () => (text: string) => text,
}));

import { db } from "@/db";
import { agendaSuggestionInputs } from "@/db/queries/agenda-suggestions";
import { encryptText } from "@/lib/encryption/fields";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { meetingMarkdown } from "@/lib/meetings/export";
import { meetingInvitees } from "@/lib/meetings/meeting-roster";
import { getMeeting } from "@/lib/meetings/service";
import { taskViewerById } from "@/lib/tasks/access";

const databaseUrl = getTestDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const at = new Date("2026-11-03T10:00:00Z");
suite("meeting GUI visibility and source languages (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            databaseUrl ?? "",
            "meeting_gui",
        );
        ref.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120000);
    afterAll(async () => {
        ref.current = null;
        await database?.dispose();
    });
    beforeEach(async () => {
        await db.delete(users);
        await db.insert(users).values([
            { id: "owner", email: "owner@example.com" },
            { id: "other", email: "other@example.com" },
            { id: "org", email: "org@example.com", role: "org" },
        ]);
        await db.insert(recordingFolders).values({
            id: "folder",
            userId: "owner",
            kind: "custom",
            name: encryptText("Acme"),
            nameHash: lookupHash("Acme"),
        });
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
        });
        await insertRecordings(
            database.db,
            ["visible", "hidden"].map((id) => ({
                id,
                userId: id === "hidden" ? "other" : "owner",
                filename: encryptText(id),
                startTime: at,
                endTime: at,
                duration: 0,
                filesize: 1,
                fileMd5: "a".repeat(32),
                storageType: "local",
                storagePath: `${id}.ogg`,
                deviceSn: "test",
                plaudFileId: id,
                plaudVersion: "1",
                confirmedLanguage: "cs",
            })),
        );
        await db.insert(recordingFolderAssignments).values(
            ["meeting", "visible"].map((itemId) => ({
                userId: "owner",
                itemId,
                folderId: "folder",
            })),
        );
    });
    it("returns task labels only after taskVisible and only in the web response", async () => {
        await db.insert(recordingTasks).values(
            ["visible", "hidden"].map((id) => ({
                id: `${id}-task`,
                userId: id === "hidden" ? "other" : "owner",
                itemId: id,
                text: encryptText(`${id} task text`),
                source: "manual" as const,
                status: "open" as const,
            })),
        );
        await db.insert(agendaSuggestions).values({
            id: "suggestion",
            userId: "owner",
            agendaId: "agenda",
            text: encryptText("Review tasks"),
            kind: "ai",
            sources: {
                itemIds: [],
                taskIds: ["visible-task", "hidden-task"],
            },
        });
        const web = await getMeeting("owner", "agenda", undefined, true);
        if (web.unchanged) throw new Error("Expected detail");
        expect(web.suggestionTasks).toEqual([
            { id: "visible-task", text: "visible task text" },
        ]);
        expect(web.folderRecordingIds).toEqual(["visible"]);
        expect(web.tasks).toEqual([]);
        expect(
            meetingMarkdown(
                {
                    ...web,
                    invitees: [
                        { name: "Jitka Dvořáková" },
                        { name: "" },
                        { name: "" },
                    ],
                },
                false,
                "cs-CZ",
            ),
        ).toContain("Pozvaní: Jitka Dvořáková +2");
        const otherClients = await getMeeting("owner", "agenda");
        expect(otherClients).not.toHaveProperty("suggestionTasks");
        expect(otherClients).not.toHaveProperty("folderRecordingIds");
    });
    it("matches primary and alternate e-mails only to people the viewer can see and preserves Calendar names", async () => {
        await db.insert(people).values([
            {
                id: "personal",
                userId: "owner",
                displayName: encryptText("Jitka Dvořáková"),
                primaryEmail: encryptText("jitka@example.com"),
                primaryEmailHash: lookupHash("jitka@example.com"),
            },
            {
                id: "organization",
                userId: "org",
                displayName: encryptText("Dana Nováková"),
            },
            {
                id: "secret",
                userId: "other",
                displayName: encryptText("Secret Person"),
                primaryEmail: encryptText("secret@example.com"),
                primaryEmailHash: lookupHash("secret@example.com"),
            },
        ]);
        await db.insert(personEmails).values({
            personId: "organization",
            userId: "org",
            email: encryptText("dana@example.com"),
            emailHash: lookupHash("dana@example.com"),
        });
        expect(
            await meetingInvitees("owner", [
                { name: "Calendar Name", email: "jitka@example.com" },
                { name: "", email: "jitka@example.com" },
                { name: "", email: "dana@example.com" },
                { name: "", email: "secret@example.com" },
                { name: "unknown@example.com", email: "unknown@example.com" },
            ]),
        ).toEqual([
            { name: "Calendar Name" },
            { name: "Jitka Dvořáková" },
            { name: "Dana Nováková" },
            { name: "" },
            { name: "" },
        ]);
    });
    it("loads confirmed recording language and mail content language with the visible summary inputs", async () => {
        await db.insert(chatterItems).values({
            id: "mail",
            userId: "owner",
            kind: "mail",
            title: encryptText("Mail"),
            occurredAt: at,
        });
        await db.insert(mailMessages).values({
            id: "mail",
            userId: "owner",
            rawHash: "a".repeat(64),
            receivedAt: at,
            sizeBytes: 1,
            auth: {},
            senderVerified: false,
        });
        await db.insert(mailContents).values({
            itemId: "mail",
            userId: "owner",
            language: "de",
            parserVersion: 1,
            segments: [],
        });
        await db
            .insert(recordingFolderAssignments)
            .values({ userId: "owner", itemId: "mail", folderId: "folder" });
        await db.insert(aiEnhancements).values(
            ["visible", "mail"].map((itemId) => ({
                itemId,
                userId: "owner",
                source: "riffado",
                provider: "test",
                model: "test",
                summary: encryptText("Summary"),
            })),
        );
        const [agenda] = await db
            .select()
            .from(meetingAgendas)
            .where(eq(meetingAgendas.id, "agenda"));
        const result = await agendaSuggestionInputs({
            agenda,
            folderId: "folder",
            userId: "owner",
            orgUserId: "org",
            viewer: await taskViewerById("owner"),
        });
        expect(
            result.summaries.map(({ itemId, language }) => ({
                itemId,
                language,
            })),
        ).toEqual(
            expect.arrayContaining([
                { itemId: "visible", language: "cs" },
                { itemId: "mail", language: "de" },
            ]),
        );
    });
});
