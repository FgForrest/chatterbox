import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
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
    POST as inviteRoute,
    GET as listSharesRoute,
} from "@/app/api/items/[id]/shares/route";
import { GET as readAttachment } from "@/app/api/mail/[id]/attachments/[index]/route";
import { GET as readMailHtml } from "@/app/api/mail/[id]/html/route";
import { GET as readMail } from "@/app/api/mail/[id]/route";
import { GET as readAudio } from "@/app/api/recordings/[id]/audio/route";
import { GET as readCorrections } from "@/app/api/recordings/[id]/corrections/route";
import { GET as readLearn } from "@/app/api/recordings/[id]/learn/route";
import { GET as readMarkdown } from "@/app/api/recordings/[id]/markdown/[kind]/route";
import { GET as readItem } from "@/app/api/recordings/[id]/route";
import { GET as readSpeakers } from "@/app/api/recordings/[id]/speakers/route";
import { GET as readSummary } from "@/app/api/recordings/[id]/summary/route";
import { GET as readTopics } from "@/app/api/recordings/[id]/topics/route";
import { PATCH as changeShareRoute } from "@/app/api/shares/[id]/route";
import { GET as peopleRoute } from "@/app/api/shares/people/route";
import { POST as restoreRoute } from "@/app/api/shares/restore/route";
import { GET as invitationsRoute } from "@/app/api/shares/route";
import {
    aiEnhancements,
    apiCredentials,
    asyncJobs,
    chatterItems,
    itemShares,
    knowledgeEntities,
    mailAddresses,
    mailContents,
    mailMessages,
    mailParticipants,
    people,
    recordingFolderAssignments,
    recordingFolders,
    recordingTasks,
    taskMentions,
    transcriptCorrections,
    transcriptions,
    transcriptSpeakers,
    userAccessStates,
    userSettings,
    users,
} from "@/db/schema";
import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import { archivedItemCondition } from "@/lib/export/archive-scope";
import { collectArchivedItemShares } from "@/lib/export/item-shares";
import * as knowledgeLoader from "@/lib/knowledge/knowledge-loader";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { resolveMailAccess } from "@/lib/mail/access";
import { localPartHash } from "@/lib/mail/hash";
import type { McpCaller } from "@/lib/mcp/caller";
import { mcpItemCondition } from "@/lib/mcp/scope";
import { ALL_TOOLS } from "@/lib/mcp/tools";
import { sendPersonShareInvitation } from "@/lib/notifications/person-share";
import { searchApp } from "@/lib/search/app-search";
import { searchItems } from "@/lib/search/item-search";
import {
    requireRecordingView,
    resolveRecordingAccess,
} from "@/lib/sharing/access";
import {
    changePersonShare,
    findShareRecipients,
    inviteToItem,
    listItemShares,
    listMyInvitations,
} from "@/lib/sharing/person-shares";
import { restoreArchivedItemShares } from "@/lib/sharing/restore-shares";
import { assertMayChange } from "@/lib/sharing/writer";
import { taskViewer, taskViewerById } from "@/lib/tasks/access";
import {
    addTask,
    countNewTasks,
    listRecordingTasks,
    listTasks,
    markTasksSeen,
    updateTask,
} from "@/lib/tasks/tasks";
import { localActor } from "@/tests/helpers/session-actor";
import { insertRecordings } from "@/tests/integration/items";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";
import { serviceCaller, userCaller } from "@/tests/mcp/fixtures";
import { personWriteRoutes } from "@/tests/sharing/person-route-cases";

const { ref, mockEnv, sendMail } = vi.hoisted(() => ({
    sendMail: vi.fn().mockResolvedValue(true),
    ref: { current: null as Record<PropertyKey, unknown> | null },
    mockEnv: {
        IS_HOSTED: false,
        SELF_HOST_MODE: "shared",
        AUTHZ_MODE: "local",
        ORG_ACCOUNT_EMAIL: "organization@example.com",
        ORG_ACCOUNT_PASSWORD: "demo-password",
        ORG_PROVIDER_CALLS_PER_MEMBER_PER_HOUR: 60,
        KNOWLEDGE_MEMORY_MB: 64,
        MAIL_DOMAIN: "mail.example.com",
        MAIL_ADDRESS_HASH_SECRET: "m".repeat(40),
        APP_URL: "http://localhost:3000",
        BETTER_AUTH_SECRET: "demo-secret-demo-secret-demo-secret",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
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
}));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/authz/curator", () => ({
    userCuratesOrganizationNow: async (id: string) =>
        ["demo-curator", "demo-organization"].includes(id),
    actsForOrganization: async (actor: { actorId: string }) =>
        ["demo-curator", "demo-organization"].includes(actor.actorId),
}));
vi.mock("@/lib/events/personal", () => ({
    notifyPersonShareChanged: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));

vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn(async (request: Request) => {
        const id = request.headers.get("x-test-user") ?? "demo-receiver";
        return {
            user: {
                id,
                email:
                    id === "demo-receiver"
                        ? "lena@example.com"
                        : `${id}@example.com`,
            },
        };
    }),
    requireApiSessionActor: vi.fn(async (request: Request) => {
        const id = request.headers.get("x-test-user") ?? "demo-receiver";
        return {
            session: {
                user: {
                    id,
                    email:
                        id === "demo-receiver"
                            ? "lena@example.com"
                            : `${id}@example.com`,
                },
            },
            actor: localActor(id),
            authTime: null,
        };
    }),
}));
vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: vi.fn().mockResolvedValue({
        downloadFile: vi.fn().mockResolvedValue(Buffer.from("audio")),
        exists: vi.fn().mockResolvedValue(false),
        deleteFile: vi.fn(),
    }),
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/jobs/watch", () => ({
    watchJob: vi.fn(async () => ({ row: null, reason: "timeout" })),
}));
vi.mock("@/lib/webhooks/emit", () => ({ emitEvent: vi.fn() }));
vi.mock("@/lib/recordings/reconcile-storage", () => ({
    reconcileRecordingStorage: vi.fn(
        async (state: { storagePath: string; storageFilename: string }) => ({
            changed: false,
            storagePath: state.storagePath,
            storageFilename: state.storageFilename,
        }),
    ),
}));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/mcp/rate-limit", () => ({
    allowMcpScan: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/mail/raw-storage", () => ({
    readRawMail: vi
        .fn()
        .mockResolvedValue(
            Buffer.from(
                "MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=demo\r\n\r\n--demo\r\nContent-Type: text/html\r\n\r\n<p>Project body</p>\r\n--demo\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename=plan.txt\r\n\r\nPlan\r\n--demo--\r\n",
            ),
        ),
    deleteRawMail: vi.fn(),
}));
vi.mock("@/lib/notifications/email", () => ({ sendEmail: sendMail }));
const url = getTestDatabaseUrl();
describe.skipIf(!url)("person shares (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    const owner = "demo-owner";
    const receiver = "demo-receiver";
    const outsider = "demo-other";
    const curator = "demo-curator";
    const organization = "demo-organization";
    beforeAll(async () => {
        database = await createMigratedTestDatabase(url ?? "", "person_shares");
        ref.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);
    afterAll(async () => {
        ref.current = null;
        await database?.dispose();
    });
    beforeEach(async () => {
        sendMail.mockClear();
        mockEnv.AUTHZ_MODE = "local";
        mockEnv.IS_HOSTED = false;
        mockEnv.SELF_HOST_MODE = "shared";
        await database.db.delete(mailAddresses);
        await database.db.delete(users);
        await database.db.insert(users).values([
            { id: owner, email: "alex@example.com", name: "Alex Morgan" },
            { id: receiver, email: "lena@example.com", name: "Lena Fischer" },
            { id: outsider, email: "priya@example.com", name: "Priya Raman" },
            { id: curator, email: "sam@example.com", name: "Sam Okafor" },
            {
                id: organization,
                email: "organization@example.com",
                role: "org",
            },
        ]);
        await insertRecordings(database.db, {
            id: "audio-item",
            userId: owner,
            filename: encryptText("Interview"),
            startTime: new Date(),
            endTime: new Date(),
            duration: 1000,
            filesize: 10,
            deviceSn: "demo",
            plaudFileId: "demo-file",
            fileMd5: "demo-md5",
            storageType: "local",
            storagePath: "demo/audio.opus",
            storageFilename: "audio.opus",
            plaudVersion: "1",
        });
        await database.db.insert(chatterItems).values({
            id: "mail-item",
            userId: owner,
            kind: "mail",
            title: encryptText("Project mail"),
            occurredAt: new Date(),
        });
        await database.db.insert(mailMessages).values({
            id: "mail-item",
            userId: owner,
            rawHash: "demo-mail",
            receivedAt: new Date(),
            sizeBytes: 500,
            rawStoragePath: "mail/demo-owner/mail-item.eml.enc",
            auth: encryptJsonField({ dkim: [], spf: null, arc: null }),
            senderVerified: true,
            attachments: encryptJsonField([
                {
                    filename: "plan.txt",
                    contentType: "text/plain",
                    size: 4,
                },
            ]),
        });
        await database.db.insert(mailContents).values({
            itemId: "mail-item",
            userId: owner,
            parserVersion: 1,
            language: "en",
            segments: encryptJsonField([
                {
                    index: 0,
                    role: "body",
                    depth: 0,
                    text: "Project body",
                    participantRef: null,
                    at: null,
                },
            ]),
        });
        await database.db.insert(transcriptions).values({
            id: "owner-transcript",
            recordingId: "audio-item",
            userId: owner,
            text: encryptText("speaker_0: Project body."),
            provider: "browser",
            model: "demo",
            source: "riffado",
        });
        await database.db.insert(people).values({
            id: "owner-private-person",
            userId: owner,
            displayName: encryptText("Priya Raman"),
            notes: encryptText("private-person-notes"),
        });
        await database.db.insert(transcriptSpeakers).values({
            transcriptionId: "owner-transcript",
            userId: owner,
            label: "speaker_0",
            personId: "owner-private-person",
            source: "user",
            status: "confirmed",
        });
        await database.db.insert(mailParticipants).values({
            itemId: "mail-item",
            userId: owner,
            ref: "p1",
            roles: ["from"],
            personId: "owner-private-person",
            name: encryptText("Priya Raman"),
            address: encryptText("priya@example.com"),
        });
        for (const itemId of ["audio-item", "mail-item"])
            await database.db.insert(aiEnhancements).values({
                itemId,
                userId: owner,
                summary: encryptText("Project body summary"),
                keyPoints: encryptJsonField(["Project plan"]),
                actionItems: encryptJsonField([]),
                source: "riffado",
                provider: "local",
                model: "demo",
            });
        await database.db.insert(recordingFolders).values([
            {
                id: "receiver-folder",
                userId: receiver,
                name: encryptText("Interviews"),
                nameHash: "interviews",
            },
            {
                id: "owner-folder",
                userId: owner,
                name: encryptText("Research"),
                nameHash: "research",
            },
            {
                id: "org-folder",
                userId: organization,
                name: encryptText("Organization"),
                nameHash: "organization",
            },
        ]);
    });

    it.each([
        "audio-item",
        "mail-item",
    ])("requires acceptance and keeps %s private to everyone else", async (itemId) => {
        const [share] = await inviteToItem(owner, itemId, [receiver]);
        expect(share.state).toBe("pending");
        expect(
            await resolveRecordingAccess(receiver, itemId, {
                kinds: ["audio", "mail"],
            }),
        ).toBeNull();
        expect((await listMyInvitations(receiver))[0].title).toBe(
            itemId === "audio-item" ? "Interview" : "Project mail",
        );
        await changePersonShare(receiver, share.id, {
            action: "accept",
            version: share.version,
            folderId: "receiver-folder",
        });
        const access = await requireRecordingView(
            receiver,
            itemId,
            "received",
            { kinds: ["audio", "mail"] },
        );
        expect(access.role).toBe("receiver");
        expect(access.shared).toBe(false);
        expect(() => assertMayChange(access, receiver, true)).toThrow(
            "read-only",
        );
        for (const user of [outsider, curator, organization])
            expect(
                await resolveRecordingAccess(user, itemId, {
                    kinds: ["audio", "mail"],
                }),
            ).toBeNull();
        if (itemId === "mail-item")
            expect((await resolveMailAccess(receiver, itemId))?.role).toBe(
                "receiver",
            );
        expect(
            await database.db.select().from(recordingFolderAssignments),
        ).toEqual([]);
        expect(await listMyInvitations(receiver)).toEqual([]);
    });

    it("declines, invites again, accepts, files and removes with stale changes refused", async () => {
        let [share] = await inviteToItem(owner, "audio-item", [receiver]);
        await changePersonShare(receiver, share.id, {
            action: "decline",
            version: share.version,
        });
        expect((await listItemShares(owner, "audio-item"))[0].state).toBe(
            "declined",
        );
        [share] = await inviteToItem(owner, "audio-item", [receiver]);
        await expect(
            changePersonShare(receiver, share.id, {
                action: "accept",
                version: share.version,
                folderId: "owner-folder",
            }),
        ).rejects.toMatchObject({ statusCode: 404 });
        await expect(
            changePersonShare(receiver, share.id, {
                action: "accept",
                version: share.version,
                folderId: "org-folder",
            }),
        ).rejects.toMatchObject({ statusCode: 404 });
        const results = await Promise.allSettled([
            changePersonShare(receiver, share.id, {
                action: "accept",
                version: share.version,
                folderId: "receiver-folder",
            }),
            changePersonShare(receiver, share.id, {
                action: "accept",
                version: share.version,
                folderId: "receiver-folder",
            }),
        ]);
        expect(
            results.filter((result) => result.status === "fulfilled"),
        ).toHaveLength(1);
        expect(
            results.filter((result) => result.status === "rejected"),
        ).toHaveLength(1);
        [share] = await listItemShares(owner, "audio-item");
        await changePersonShare(receiver, share.id, {
            action: "file",
            version: share.version,
            folderId: "receiver-folder",
        });
        [share] = await listItemShares(owner, "audio-item");
        await changePersonShare(receiver, share.id, {
            action: "remove",
            version: share.version,
        });
        expect(await resolveRecordingAccess(receiver, "audio-item")).toBeNull();
        expect((await listItemShares(owner, "audio-item"))[0].state).toBe(
            "removed",
        );
        expect(
            (await inviteToItem(owner, "audio-item", [receiver]))[0].state,
        ).toBe("pending");
    });

    it("cancellation prevents later acceptance", async () => {
        const [share] = await inviteToItem(owner, "audio-item", [receiver]);
        await changePersonShare(owner, share.id, {
            action: "cancel",
            version: share.version,
        });
        await expect(
            changePersonShare(receiver, share.id, {
                action: "accept",
                version: share.version,
                folderId: "receiver-folder",
            }),
        ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("refuses re-sharing, self-invites, organization recipients and unrelated changes", async () => {
        for (const id of [owner, organization])
            await expect(
                inviteToItem(owner, "audio-item", [id]),
            ).rejects.toMatchObject({ statusCode: expect.any(Number) });
        const [share] = await inviteToItem(owner, "audio-item", [receiver]);
        await expect(
            inviteToItem(receiver, "audio-item", [outsider]),
        ).rejects.toMatchObject({ statusCode: 404 });
        await expect(
            changePersonShare(outsider, share.id, {
                action: "decline",
                version: share.version,
            }),
        ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("directory excludes the caller and organization and treats wildcard characters literally", async () => {
        expect(
            (await findShareRecipients(owner, "Lena")).map((row) => row.id),
        ).toEqual([receiver]);
        expect(await findShareRecipients(owner, "%_")).toEqual([]);
        expect(await findShareRecipients(owner, "Alex")).toEqual([]);
        expect(await findShareRecipients(owner, "organization")).toEqual([]);
    });

    it.each([
        "hosted",
        "local",
    ])("disables sharing in %s mode", async (mode) => {
        mockEnv.IS_HOSTED = mode === "hosted";
        mockEnv.SELF_HOST_MODE = mode === "local" ? "local" : "shared";
        await expect(
            inviteToItem(owner, "audio-item", [receiver]),
        ).rejects.toMatchObject({ statusCode: 404 });
        await expect(listMyInvitations(receiver)).rejects.toMatchObject({
            statusCode: 404,
        });
        const context = { params: Promise.resolve({ id: "audio-item" }) };
        for (const handler of [
            listSharesRoute,
            inviteRoute,
            changeShareRoute,
            peopleRoute,
            restoreRoute,
            invitationsRoute,
        ]) {
            const response = await handler(
                new Request("http://localhost/api/shares", {
                    headers: { "x-test-user": owner },
                }),
                context,
            );
            expect(response.status).toBe(404);
        }
    });

    it.each([
        "item",
        "owner",
        "receiver",
    ])("deleting the %s cascades shares", async (kind) => {
        await inviteToItem(owner, "audio-item", [receiver]);
        if (kind === "item")
            await database.db
                .delete(chatterItems)
                .where(eq(chatterItems.id, "audio-item"));
        else
            await database.db
                .delete(users)
                .where(eq(users.id, kind === "owner" ? owner : receiver));
        expect(await database.db.select().from(itemShares)).toEqual([]);
    });
    it("makes every item write route decide receiver access", async () => {
        const root = join(__dirname, "../../app/api");
        const scan = (dir: string): string[] =>
            readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
                entry.isDirectory()
                    ? scan(join(dir, entry.name))
                    : entry.name === "route.ts"
                      ? [join(dir, entry.name)]
                      : [],
            );
        const writes = [
            ...scan(join(root, "recordings/[id]")),
            join(root, "mail/[id]/route.ts"),
        ].flatMap((file) =>
            [
                ...readFileSync(file, "utf8").matchAll(
                    /export const (POST|PUT|PATCH|DELETE)\b/g,
                ),
            ].map((match) => `${relative(root, file)}:${match[1]}`),
        );
        expect(
            personWriteRoutes
                .map((route) => `${route.path}:${route.method}`)
                .sort(),
        ).toEqual(writes.sort());
        const refused: string[] = [];
        for (const itemId of ["audio-item", "mail-item"]) {
            const [share] = await inviteToItem(owner, itemId, [receiver]);
            await changePersonShare(receiver, share.id, {
                action: "accept",
                version: share.version,
                folderId: "receiver-folder",
            });
            for (const route of personWriteRoutes) {
                const body = {
                    scope: "summary",
                    filename: "Changed",
                    text: "Changed",
                    model: "browser",
                    status: "open",
                    folderId: "receiver-folder",
                    fromFolderId: "receiver-folder",
                    toFolderId: "owner-folder",
                    taskIds: ["missing-task", "missing-target"],
                    proposals: [],
                    updates: [],
                    matches: [],
                    ticked: true,
                    version: 0,
                    transcriptionId: "owner-transcript",
                    revision: 0,
                    label: "speaker_0",
                    markedUnknown: true,
                    decision: "accepted",
                };
                const response = await route.handler(
                    new Request(
                        `http://localhost/api/${route.path.replace("route.ts", "").replace("[id]", itemId)}?view=received`,
                        {
                            method: route.method,
                            headers: {
                                "content-type": "application/json",
                                "x-test-user": receiver,
                            },
                            body: JSON.stringify(
                                route.path.includes("categorize/")
                                    ? { folderIds: ["receiver-folder"] }
                                    : body,
                            ),
                        },
                    ),
                    {
                        params: Promise.resolve({
                            id: itemId,
                            folderId: "owner-folder",
                            itemId: "missing-review",
                            taskId: "missing-task",
                            updateId: "missing-update",
                            correctionId: "missing-correction",
                        }),
                    },
                );
                if (![403, 404].includes(response.status))
                    refused.push(
                        `${itemId}: ${route.method} ${route.path}: ${response.status} ${await response.text()}`,
                    );
            }
        }
        expect(refused).toEqual([]);
    });

    it("archives only the owner's share list and restores consent by existing email", async () => {
        const [share] = await inviteToItem(owner, "audio-item", [receiver]);
        await changePersonShare(receiver, share.id, {
            action: "accept",
            version: share.version,
            folderId: "receiver-folder",
        });
        const archived = await collectArchivedItemShares(
            { kind: "personal", userId: owner },
            new Set(["audio-item"]),
        );
        expect(archived).toMatchObject([
            { receiverEmail: "lena@example.com", state: "accepted" },
        ]);
        expect(JSON.stringify(archived)).not.toContain("receiver-folder");
        expect(
            await collectArchivedItemShares(
                { kind: "personal", userId: receiver },
                new Set(["audio-item"]),
            ),
        ).toEqual([]);
        expect(
            await database.db
                .select({ id: chatterItems.id })
                .from(chatterItems)
                .where(
                    archivedItemCondition({
                        kind: "personal",
                        userId: receiver,
                    }),
                ),
        ).toEqual([]);
        await database.db.delete(itemShares);
        const result = await restoreArchivedItemShares(
            owner,
            [
                ...archived,
                { ...archived[0], receiverEmail: "absent@example.com" },
            ],
            new Map([["audio-item", "audio-item"]]),
        );
        expect(result).toMatchObject({
            restored: 1,
            skipped: [
                {
                    receiverEmail: "absent@example.com",
                    reason: "receiver_missing",
                },
            ],
        });
        expect((await listItemShares(owner, "audio-item"))[0].state).toBe(
            "pending",
        );
        expect(await resolveRecordingAccess(receiver, "audio-item")).toBeNull();
    });

    it.each([
        "audio-item",
        "mail-item",
    ])("lets only the assigned receiver close tasks on %s without teaching Learn", async (itemId) => {
        const [share] = await inviteToItem(owner, itemId, [receiver]);
        await changePersonShare(receiver, share.id, {
            action: "accept",
            version: share.version,
            folderId: "receiver-folder",
        });
        await database.db.insert(people).values({
            id: "assignee",
            userId: owner,
            displayName: encryptText("Lena Fischer"),
            primaryEmail: encryptText("lena@example.com"),
            primaryEmailHash: lookupHash("lena@example.com"),
        });
        const ownerViewer = await taskViewer({
            id: owner,
            email: "alex@example.com",
        });
        const mine = await addTask(ownerViewer, itemId, {
            text: "Send the plan",
            assigneePersonId: "assignee",
            status: "open",
        });
        const other = await addTask(ownerViewer, itemId, {
            text: "Check the route",
            status: "open",
        });
        const viewer = await taskViewer({
            id: receiver,
            email: "lena@example.com",
        });
        const detail = await listRecordingTasks(viewer, itemId);
        expect(detail?.tasks).toHaveLength(2);
        expect(detail?.tasks.find((task) => task.id === mine.id)).toMatchObject(
            {
                canClose: true,
                canEdit: false,
                assignee: { personId: "", name: "Lena Fischer" },
            },
        );
        expect(
            (
                await listTasks(viewer, {
                    tab: "mine",
                    state: "all",
                    folderId: null,
                    due: null,
                    today: "2026-10-22",
                    sort: "created",
                })
            ).map((task) => task.id),
        ).toEqual([mine.id]);
        expect(await countNewTasks(viewer)).toBe(1);
        await markTasksSeen(viewer);
        expect(await countNewTasks(viewer)).toBe(0);
        const done = await updateTask(viewer, mine.id, {
            status: "done",
            version: mine.version,
        });
        await updateTask(viewer, mine.id, {
            status: "open",
            version: done.version,
        });
        for (const change of [
            { text: "Changed" },
            { assigneePersonId: null },
            { dueDate: "2026-10-25" },
            { status: "dropped" as const },
        ])
            await expect(
                updateTask(viewer, mine.id, {
                    ...change,
                    version: done.version + 1,
                }),
            ).rejects.toMatchObject({ statusCode: 403 });
        await expect(
            updateTask(viewer, other.id, {
                status: "done",
                version: other.version,
            }),
        ).rejects.toMatchObject({ statusCode: 403 });
        expect(
            await listRecordingTasks(await taskViewerById(receiver), itemId),
        ).toBeNull();
        for (const userId of [outsider, curator, organization])
            expect(
                await listRecordingTasks(
                    await taskViewer({
                        id: userId,
                        email: `${userId}@example.com`,
                    }),
                    itemId,
                ),
            ).toBeNull();
    });
    it.each([
        "audio-item",
        "mail-item",
    ])("checks all read surfaces by invitation state for %s", async (itemId) => {
        const [share] = await inviteToItem(owner, itemId, [receiver]);
        const routes =
            itemId === "audio-item"
                ? [
                      { handler: readItem, tail: "" },
                      { handler: readAudio, tail: "/audio" },
                      { handler: readSpeakers, tail: "/speakers" },
                      { handler: readCorrections, tail: "/corrections" },
                      { handler: readTopics, tail: "/topics" },
                      { handler: readSummary, tail: "/summary" },
                      { handler: readMarkdown, tail: "/markdown/transcript" },
                      { handler: readMarkdown, tail: "/markdown/summary" },
                  ]
                : [
                      { handler: readMail, tail: "" },
                      { handler: readMailHtml, tail: "/html" },
                      { handler: readAttachment, tail: "/attachments/0" },
                      { handler: readSummary, tail: "/summary" },
                      { handler: readMarkdown, tail: "/markdown/summary" },
                  ];
        for (const state of [
            "pending",
            "accepted",
            "declined",
            "removed",
        ] as const) {
            await database.db
                .update(itemShares)
                .set({
                    state,
                    filingFolderId:
                        state === "accepted" ? "receiver-folder" : null,
                })
                .where(eq(itemShares.id, share.id));
            for (const userId of [
                owner,
                receiver,
                outsider,
                curator,
                organization,
            ]) {
                const allowed =
                    userId === owner ||
                    (userId === receiver && state === "accepted");
                for (const route of routes) {
                    const kind = route.tail.endsWith("transcript")
                        ? "transcript"
                        : "summary";
                    const response = await route.handler(
                        new Request(
                            `http://localhost/api/${itemId === "audio-item" ? "recordings" : "mail"}/${itemId}${route.tail}?view=${userId === owner ? "private" : "received"}`,
                            { headers: { "x-test-user": userId } },
                        ),
                        {
                            params: Promise.resolve({
                                id: itemId,
                                index: "0",
                                kind,
                            }),
                        },
                    );
                    expect(
                        response.status,
                        `${userId}/${state}/${route.tail}: ${await response.text()}`,
                    ).toBe(allowed ? 200 : 404);
                }
            }
            const search = await searchItems({
                viewerUserId: receiver,
                view: "private",
                query: "Project",
            });
            expect(search.hits.some((hit) => hit.id === itemId)).toBe(
                state === "accepted",
            );
            const app = await searchApp(
                await taskViewer({ id: receiver, email: "lena@example.com" }),
                "chatter",
                "Project",
            );
            const hit = app.chatter.find((entry) => entry.id === itemId);
            expect(Boolean(hit)).toBe(state === "accepted");
            if (hit) expect(hit.href).toContain("view=received");
        }
    });

    it("shows confirmed speaker names and filing without private Almanac records", async () => {
        const [share] = await inviteToItem(owner, "audio-item", [receiver]);
        await changePersonShare(receiver, share.id, {
            action: "accept",
            version: share.version,
            folderId: "receiver-folder",
        });
        const response = await readSpeakers(
            new Request(
                "http://localhost/api/recordings/audio-item/speakers?view=received",
            ),
            { params: Promise.resolve({ id: "audio-item" }) },
        );
        const payload = await response.text();
        expect(payload).toContain("Priya Raman");
        for (const value of [
            "owner-private-person",
            "private-person-notes",
            "owner-folder",
        ])
            expect(payload).not.toContain(value);
        await database.db.insert(recordingFolderAssignments).values({
            userId: owner,
            itemId: "audio-item",
            folderId: "org-folder",
        });
        const sharedReceived = await readSpeakers(
            new Request(
                "http://localhost/api/recordings/audio-item/speakers?view=received",
            ),
            { params: Promise.resolve({ id: "audio-item" }) },
        );
        expect(sharedReceived.status).toBe(200);
        expect(await sharedReceived.json()).toMatchObject({
            speakers: [
                {
                    personName: "Priya Raman",
                    personId: null,
                    confirmedByUserId: null,
                },
            ],
        });
        const learn = await readLearn(
            new Request(
                "http://localhost/api/recordings/audio-item/learn?view=received",
            ),
            { params: Promise.resolve({ id: "audio-item" }) },
        );
        expect(learn.status).toBe(403);
        await database.db.insert(asyncJobs).values(
            ["summary", "topics"].map((kind) => ({
                id: `owner-${kind}-job`,
                userId: owner,
                kind,
                subjectId: "audio-item",
                payload: { source: "riffado" },
            })),
        );
        for (const handler of [readSummary, readTopics]) {
            const result = await handler(
                new Request(
                    "http://localhost/api/recordings/audio-item/summary?view=received",
                ),
                { params: Promise.resolve({ id: "audio-item" }) },
            );
            expect(result.status).toBe(200);
            expect(await result.text()).not.toContain("-job");
        }
    });

    it("reads accepted items through MCP without granting Organization or mail permissions", async () => {
        for (const itemId of ["audio-item", "mail-item"]) {
            const [share] = await inviteToItem(owner, itemId, [receiver]);
            await changePersonShare(receiver, share.id, {
                action: "accept",
                version: share.version,
                folderId: "receiver-folder",
            });
        }
        await database.db.insert(recordingFolderAssignments).values(
            ["audio-item", "mail-item"].map((itemId) => ({
                itemId,
                userId: owner,
                folderId: "owner-folder",
            })),
        );
        const caller = userCaller(
            receiver,
            "lena@example.com",
            [
                "transcripts:read",
                "summaries:read",
                "mail:read",
                "tasks:read",
                "tasks:write",
            ],
            organization,
        );
        caller.receivedItemIds = new Set(["audio-item", "mail-item"]);
        const run = async (
            name: string,
            args: Record<string, unknown> = {},
            who: McpCaller = caller,
        ) => {
            const tool = ALL_TOOLS.find((entry) => entry.name === name);
            if (!tool) throw new Error(name);
            return tool.run({ caller: who, touched: [] }, args);
        };
        for (const [name, args] of [
            ["list_recordings", {}],
            ["get_transcript", { recording: "audio-item" }],
            ["search_transcripts", { query: "Project" }],
            ["get_summary", { recording: "audio-item" }],
            ["search_summaries", { query: "Project" }],
            ["list_mail", {}],
            ["get_mail", { mail: "mail-item" }],
            ["search_mail", { query: "Project" }],
        ] as const) {
            const text = JSON.stringify(await run(name, args));
            expect(text, name).toContain(
                name.includes("mail") ? "mail-item" : "audio-item",
            );
            expect(text, name).not.toContain("owner-private-person");
            expect(text, name).not.toContain("private-person-notes");
            expect(text, name).not.toContain("Research");
            expect(text, name).not.toContain("owner-folder");
            expect(text, name).toContain("view=received");
        }
        const noMail = userCaller(
            receiver,
            "lena@example.com",
            ["tasks:read"],
            organization,
        );
        expect(
            await database.db
                .select({ id: chatterItems.id })
                .from(chatterItems)
                .where(mcpItemCondition(noMail, ["mail"])),
        ).toEqual([]);
        for (const who of [
            userCaller(
                outsider,
                "priya@example.com",
                ["transcripts:read", "mail:read"],
                organization,
            ),
            userCaller(
                curator,
                "sam@example.com",
                ["transcripts:read", "mail:read"],
                organization,
            ),
            serviceCaller(organization, ["transcripts:read", "mail:read"]),
        ]) {
            expect(await run("list_recordings", {}, who)).toMatchObject({
                recordings: [],
            });
            expect(await run("list_mail", {}, who)).toMatchObject({ mail: [] });
        }
    });
    it("honors the receiver's email preference and delivery address", async () => {
        await sendPersonShareInvitation(receiver);
        expect(sendMail).not.toHaveBeenCalled();
        await database.db.insert(userSettings).values({
            userId: receiver,
            emailNotifications: false,
            notificationEmail: "notices@example.com",
        });
        await sendPersonShareInvitation(receiver);
        expect(sendMail).not.toHaveBeenCalled();
        await database.db
            .update(userSettings)
            .set({ emailNotifications: true })
            .where(eq(userSettings.userId, receiver));
        await sendPersonShareInvitation(receiver);
        expect(sendMail).toHaveBeenCalledWith(
            expect.objectContaining({
                to: "notices@example.com",
                html: expect.stringContaining("/dashboard?invitations=1"),
            }),
        );
    });

    it("counts pre-existing assigned tasks as new after accepting an invitation", async () => {
        await database.db.insert(people).values({
            id: "assignee",
            userId: owner,
            displayName: encryptText("Lena Fischer"),
            primaryEmailHash: lookupHash("lena@example.com"),
        });
        await addTask(
            await taskViewer({ id: owner, email: "alex@example.com" }),
            "audio-item",
            { text: "Send plan", status: "open", assigneePersonId: "assignee" },
        );
        const viewer = await taskViewer({
            id: receiver,
            email: "lena@example.com",
        });
        await markTasksSeen(viewer);
        expect(await countNewTasks(viewer)).toBe(0);
        const [share] = await inviteToItem(owner, "audio-item", [receiver]);
        await changePersonShare(receiver, share.id, {
            action: "accept",
            version: share.version,
            folderId: "receiver-folder",
        });
        expect(await countNewTasks(viewer)).toBe(1);
    });
    it.each([
        "audio-item",
        "mail-item",
    ])("keeps received %s tasks read-only through MCP except assigned completion", async (itemId) => {
        const [share] = await inviteToItem(owner, itemId, [receiver]);
        await changePersonShare(receiver, share.id, {
            action: "accept",
            version: share.version,
            folderId: "receiver-folder",
        });
        await database.db.insert(people).values({
            id: "assignee",
            userId: owner,
            displayName: encryptText("Lena Fischer"),
            primaryEmailHash: lookupHash("lena@example.com"),
        });
        const task = await addTask(
            await taskViewer({ id: owner, email: "alex@example.com" }),
            itemId,
            {
                text: "Send the plan",
                status: "open",
                assigneePersonId: "assignee",
            },
        );
        await database.db
            .update(recordingTasks)
            .set({
                quote: encryptText("Private evidence"),
                duePhrase: encryptText("Next week"),
            })
            .where(eq(recordingTasks.id, task.id));
        await database.db
            .update(taskMentions)
            .set({ quote: encryptText("Private evidence") })
            .where(eq(taskMentions.taskId, task.id));
        const caller = userCaller(
            receiver,
            "lena@example.com",
            ["tasks:read", "tasks:write"],
            organization,
        );
        caller.receivedItemIds = new Set([itemId]);
        const run = async (name: string, args: Record<string, unknown>) => {
            const tool = ALL_TOOLS.find((entry) => entry.name === name);
            if (!tool) throw new Error(name);
            return tool.run({ caller, touched: [] }, args);
        };
        const listed = await run("list_tasks", { status: "all" });
        expect(listed).toMatchObject({
            tasks: [
                {
                    id: task.id,
                    can_edit: false,
                    can_close: true,
                    assignee: { id: "" },
                },
            ],
        });
        if (itemId === "mail-item") {
            expect(listed).toMatchObject({
                tasks: [
                    {
                        quote: null,
                        due_phrase: null,
                        recording: null,
                        url: null,
                    },
                ],
            });
            expect(JSON.stringify(listed)).not.toContain("Private evidence");
        } else expect(JSON.stringify(listed)).toContain("view=received");
        expect(
            await run("search_tasks", { query: "Send", status: "all" }),
        ).toMatchObject({ tasks: [{ id: task.id }] });
        expect(
            await run("update_task", {
                task: task.id,
                version: task.version,
                status: "done",
            }),
        ).toMatchObject({ task: { status: "done", can_edit: false } });
        expect(
            await run("update_task", {
                task: task.id,
                version: task.version + 1,
                status: "open",
            }),
        ).toMatchObject({ task: { status: "open" } });
        await expect(
            run("update_task", {
                task: task.id,
                version: task.version + 2,
                assignee: null,
            }),
        ).rejects.toThrow("Not allowed");
        await expect(
            run("update_task", {
                task: task.id,
                version: task.version + 2,
                status: "dropped",
            }),
        ).rejects.toThrow("Not allowed");
        const curatorViewer = {
            ...(await taskViewer({ id: receiver, email: "lena@example.com" })),
            isCurator: true,
        };
        expect(
            (await listRecordingTasks(curatorViewer, itemId))?.tasks[0],
        ).toMatchObject({ canEdit: false, canClose: true });
    });

    it("preserves consent after Organization sharing and clears a deleted receiver filing folder", async () => {
        const [share] = await inviteToItem(owner, "audio-item", [receiver]);
        await changePersonShare(receiver, share.id, {
            action: "accept",
            version: share.version,
            folderId: "receiver-folder",
        });
        await database.db.insert(recordingFolderAssignments).values({
            userId: owner,
            itemId: "audio-item",
            folderId: "org-folder",
        });
        expect((await listItemShares(owner, "audio-item"))[0].state).toBe(
            "accepted",
        );
        expect(
            (await resolveRecordingAccess(receiver, "audio-item"))?.role,
        ).toBe("member");
        await expect(
            inviteToItem(owner, "audio-item", [outsider]),
        ).rejects.toMatchObject({ statusCode: 403 });
        await database.db
            .delete(recordingFolders)
            .where(eq(recordingFolders.id, "receiver-folder"));
        const [stored] = await database.db
            .select()
            .from(itemShares)
            .where(eq(itemShares.id, share.id));
        expect(stored.filingFolderId).toBeNull();
        await changePersonShare(owner, share.id, {
            action: "remove",
            version: stored.version,
        });
        expect((await listItemShares(owner, "audio-item"))[0].state).toBe(
            "removed",
        );
    });
    it.each([
        "audio-item",
        "mail-item",
    ])("restores no invitation to Organization-visible %s", async (itemId) => {
        await database.db
            .insert(recordingFolderAssignments)
            .values({ userId: owner, itemId, folderId: "org-folder" });
        expect(
            await restoreArchivedItemShares(
                owner,
                [
                    {
                        itemId: "old",
                        receiverEmail: "lena@example.com",
                        state: "accepted",
                    },
                ],
                new Map([["old", itemId]]),
            ),
        ).toEqual({
            restored: 0,
            skipped: [
                {
                    itemId: "old",
                    receiverEmail: "lena@example.com",
                    reason: "organization_shared",
                },
            ],
        });
        expect(await listItemShares(owner, itemId)).toEqual([]);
    });

    it("masks a secret inbound address in a pending mail invitation", async () => {
        const localPart = "alex.private-token";
        await database.db.insert(mailAddresses).values({
            id: "base-mailbox",
            localPartHash: localPartHash("alex"),
            localPart: encryptText("alex"),
            kind: "mailbox",
            namespaceUserId: owner,
        });
        await database.db.insert(mailAddresses).values({
            localPartHash: localPartHash(localPart),
            localPart: encryptText(localPart),
            kind: "secret",
            namespaceUserId: owner,
            baseAddressId: "base-mailbox",
        });
        await database.db
            .update(chatterItems)
            .set({
                title: encryptText(`Plan for ${localPart}@mail.example.com`),
            })
            .where(eq(chatterItems.id, "mail-item"));
        await inviteToItem(owner, "mail-item", [receiver]);
        const response = await invitationsRoute(
            new Request("http://localhost/api/shares"),
        );
        expect(response.status).toBe(200);
        const payload = await response.text();
        expect(payload).not.toContain("private-token");
        expect(payload).toContain("alex.•••••••••••••@mail.example.com");
    });

    it.each([
        "suspended",
        "disabled",
        "missing",
        "not-granted",
        "deleted",
    ])("excludes %s accounts from lookup, new invitations and restore", async (state) => {
        await inviteToItem(owner, "audio-item", [receiver]);
        if (state === "suspended")
            await database.db
                .update(users)
                .set({ suspendedAt: new Date() })
                .where(eq(users.id, receiver));
        else if (state === "deleted")
            await database.db.delete(users).where(eq(users.id, receiver));
        else {
            mockEnv.AUTHZ_MODE = "idp";
            await database.db.insert(userAccessStates).values({
                userId: receiver,
                issuer: "https://identity.example.com",
                subject: "demo-subject",
                status:
                    state === "not-granted"
                        ? "active"
                        : (state as "disabled" | "missing"),
                capabilities: state === "not-granted" ? [] : ["use"],
                verifiedAt: new Date(),
                source: "access-change",
            });
        }
        expect(await findShareRecipients(owner, "Lena")).toEqual([]);
        expect(await resolveRecordingAccess(receiver, "audio-item")).toBeNull();
        await expect(
            inviteToItem(owner, "mail-item", [receiver]),
        ).rejects.toMatchObject({ statusCode: 404 });
        expect(
            await restoreArchivedItemShares(
                owner,
                [
                    {
                        itemId: "mail-item",
                        receiverEmail: "lena@example.com",
                        state: "accepted",
                    },
                ],
                new Map([["mail-item", "mail-item"]]),
            ),
        ).toMatchObject({
            restored: 0,
            skipped: [{ reason: "receiver_missing" }],
        });
    });

    it("keeps active identity-provider members invitable", async () => {
        mockEnv.AUTHZ_MODE = "idp";
        await database.db.insert(userAccessStates).values({
            userId: receiver,
            issuer: "https://identity.example.com",
            subject: "demo-subject",
            capabilities: ["use"],
            verifiedAt: new Date(),
            source: "login",
        });
        expect(
            (await findShareRecipients(owner, "Lena")).map((row) => row.id),
        ).toEqual([receiver]);
        expect(
            (await inviteToItem(owner, "audio-item", [receiver]))[0].state,
        ).toBe("pending");
    });

    it("caps the restore item-id map at one hundred entries", async () => {
        for (const count of [100, 101]) {
            const response = await restoreRoute(
                new Request("http://localhost/api/shares/restore", {
                    method: "POST",
                    headers: {
                        "x-test-user": owner,
                        "content-type": "application/json",
                    },
                    body: JSON.stringify({
                        shares: [],
                        itemIds: Object.fromEntries(
                            Array.from({ length: count }, (_, index) => [
                                `old-${index}`,
                                `new-${index}`,
                            ]),
                        ),
                    }),
                }),
            );
            expect(response.status).toBe(count === 100 ? 200 : 400);
        }
    });

    it("returns correction words without consulting the owner's private Almanac", async () => {
        const [share] = await inviteToItem(owner, "audio-item", [receiver]);
        await changePersonShare(receiver, share.id, {
            action: "accept",
            version: share.version,
            folderId: "receiver-folder",
        });
        await database.db.insert(knowledgeEntities).values({
            id: "private-project",
            userId: owner,
            typeKey: "project",
            name: encryptText("Confidential acquisition"),
            nameHmac: "private-project",
            description: encryptText("Private project notes"),
        });
        await database.db.insert(transcriptCorrections).values([
            {
                id: "linked",
                userId: owner,
                transcriptionId: "owner-transcript",
                transcriptRevision: 0,
                turnIndex: 0,
                charStart: 0,
                charEnd: 7,
                heard: encryptText("Project"),
                heardHmac: "project",
                kind: "link",
                targetEntityId: "private-project",
            },
            {
                id: "corrected",
                userId: owner,
                transcriptionId: "owner-transcript",
                transcriptRevision: 0,
                turnIndex: 0,
                charStart: 8,
                charEnd: 12,
                heard: encryptText("body"),
                heardHmac: "body",
                kind: "correct",
                targetEntityId: "private-project",
                replacement: encryptText("plan"),
            },
        ]);
        const knowledge = vi.spyOn(knowledgeLoader, "knowledgeView");
        try {
            const response = await readCorrections(
                new Request(
                    "http://localhost/api/recordings/audio-item/corrections?view=received",
                ),
                { params: Promise.resolve({ id: "audio-item" }) },
            );
            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({
                canUndo: false,
                corrections: [
                    { id: "linked", meaning: "Project", replacement: null },
                    { id: "corrected", meaning: "plan", replacement: "plan" },
                ],
            });
            expect(knowledge).not.toHaveBeenCalled();
        } finally {
            knowledge.mockRestore();
        }
    });

    it.each([
        ["demo-receiver", "audio-item"],
        ["demo-curator", "audio-item"],
        ["demo-receiver", "mail-item"],
        ["demo-curator", "mail-item"],
    ])("preserves %s Organization rights on %s and resumes receiver rights on withdrawal", async (userId, itemId) => {
        const curates = userId === curator;
        const filing =
            userId === receiver ? "receiver-folder" : "curator-folder";
        if (curates)
            await database.db.insert(recordingFolders).values({
                id: filing,
                userId,
                name: encryptText("Received"),
                nameHash: "received",
            });
        const [share] = await inviteToItem(owner, itemId, [userId]);
        await database.db.insert(people).values({
            id: "org-assignee",
            userId: organization,
            displayName: encryptText("Lena Fischer"),
            primaryEmailHash: lookupHash(
                userId === receiver ? "lena@example.com" : "sam@example.com",
            ),
        });
        const task = await addTask(
            await taskViewer({ id: owner, email: "alex@example.com" }),
            itemId,
            {
                text: "Send the plan",
                status: "open",
                assigneePersonId: "org-assignee",
            },
        );
        const other = await addTask(
            await taskViewer({ id: owner, email: "alex@example.com" }),
            itemId,
            { text: "Check the route", status: "open" },
        );
        await database.db
            .insert(recordingFolderAssignments)
            .values({ userId: owner, itemId, folderId: "org-folder" });
        await database.db.insert(apiCredentials).values({
            userId: organization,
            provider: "local",
            apiKey: encryptText("demo-key"),
            defaultModel: "demo",
        });
        const routes = personWriteRoutes.filter(
            (route) =>
                (route.path === "recordings/[id]/route.ts" &&
                    route.method === "PATCH") ||
                (route.path === "recordings/[id]/summary/route.ts" &&
                    route.method === "POST") ||
                route.path === "recordings/[id]/tasks/route.ts" ||
                (itemId === "audio-item" &&
                    [
                        "recordings/[id]/speakers/route.ts",
                        "recordings/[id]/topics/route.ts",
                    ].includes(route.path)),
        );
        const callWrites = async () => {
            const statuses: number[] = [];
            for (const route of routes) {
                const response = await route.handler(
                    new Request(
                        `http://localhost/api/${route.path.replace("route.ts", "").replace("[id]", itemId)}?view=org`,
                        {
                            method: route.method,
                            headers: {
                                "x-test-user": userId,
                                "content-type": "application/json",
                            },
                            body: JSON.stringify({
                                filename: "Updated title",
                                text: "A task",
                                status: "open",
                                transcriptionId: "owner-transcript",
                                revision: 0,
                                label: "speaker_0",
                                unknown: true,
                            }),
                        },
                    ),
                    {
                        params: Promise.resolve({
                            id: itemId,
                            correctionId: "missing",
                            folderId: "org-folder",
                            itemId: "missing",
                            taskId: "missing",
                            updateId: "missing",
                        }),
                    },
                );
                const payload = await response.text();
                expect(payload).not.toContain("Received items are read-only");
                expect(response.status, `${route.path}: ${payload}`).toBe(
                    curates
                        ? route.path.includes("topics/") ||
                          route.path.includes("summary/")
                            ? 202
                            : route.path.includes("tasks/")
                              ? 201
                              : 200
                        : 403,
                );
                statuses.push(response.status);
            }
            return statuses;
        };
        const before = await callWrites();
        await database.db
            .delete(recordingFolderAssignments)
            .where(
                and(
                    eq(recordingFolderAssignments.itemId, itemId),
                    eq(recordingFolderAssignments.folderId, "org-folder"),
                ),
            );
        await changePersonShare(userId, share.id, {
            action: "accept",
            version: share.version,
            folderId: filing,
        });
        expect(
            await resolveRecordingAccess(userId, itemId, {
                kinds: ["audio", "mail"],
            }),
        ).toMatchObject({ role: "receiver", shared: false });
        await database.db
            .insert(recordingFolderAssignments)
            .values({ userId: owner, itemId, folderId: "org-folder" });
        expect(
            await requireRecordingView(userId, itemId, "org", {
                kinds: ["audio", "mail"],
            }),
        ).toMatchObject({ role: "member", shared: true, received: true });
        expect(
            await requireRecordingView(userId, itemId, "received", {
                kinds: ["audio", "mail"],
            }),
        ).toMatchObject({ received: true });
        expect(await callWrites()).toEqual(before);
        if (itemId === "audio-item") {
            const learned = await readLearn(
                new Request(
                    `http://localhost/api/recordings/${itemId}/learn?view=org`,
                    { headers: { "x-test-user": userId } },
                ),
                { params: Promise.resolve({ id: itemId }) },
            );
            expect(learned.status).toBe(curates ? 200 : 403);
        } else {
            for (const view of ["org", "received"]) {
                const mail = await readMail(
                    new Request(
                        `http://localhost/api/mail/${itemId}?view=${view}`,
                        { headers: { "x-test-user": userId } },
                    ),
                    { params: Promise.resolve({ id: itemId }) },
                );
                expect(mail.status).toBe(200);
                expect(await mail.json()).toMatchObject({
                    folderIds: [view === "org" ? "org-folder" : filing],
                });
            }
            expect((await resolveMailAccess(userId, itemId))?.role).toBe(
                "member",
            );
        }
        const viewer = await taskViewer({
            id: userId,
            email: userId === receiver ? "lena@example.com" : "sam@example.com",
        });
        const listed = await listRecordingTasks(viewer, itemId);
        expect(listed?.tasks.find((row) => row.id === task.id)).toMatchObject({
            canEdit: curates,
            canClose: true,
            assignee: { personId: "org-assignee" },
        });
        expect(listed?.tasks.find((row) => row.id === other.id)).toMatchObject({
            canEdit: curates,
            canClose: curates,
        });
        const mine = await listTasks(viewer, {
            tab: "mine",
            state: "all",
            folderId: null,
            due: null,
            today: "2026-10-22",
            sort: "created",
        });
        expect(mine.some((row) => row.id === task.id)).toBe(true);
        if (curates) {
            const tracked = await listTasks(viewer, {
                tab: "tracked",
                organization: true,
                state: "all",
                folderId: null,
                due: null,
                today: "2026-10-22",
                sort: "created",
            });
            expect(tracked.some((row) => row.id === other.id)).toBe(true);
        }
        const done = await updateTask(viewer, task.id, {
            version: task.version,
            status: "done",
        });
        const opened = await updateTask(viewer, task.id, {
            version: done.version,
            status: "open",
        });
        if (curates)
            await updateTask(viewer, task.id, {
                version: opened.version,
                text: "Updated task",
            });
        else
            await expect(
                updateTask(viewer, task.id, {
                    version: opened.version,
                    text: "Updated task",
                }),
            ).rejects.toMatchObject({ statusCode: 403 });
        const withdrawal = personWriteRoutes.find(
            (route) =>
                route.path === "recordings/[id]/folders/route.ts" &&
                route.method === "DELETE",
        );
        if (!withdrawal) throw new Error("Missing withdrawal route");
        const withdraw = (actor: string) =>
            withdrawal.handler(
                new Request(
                    `http://localhost/api/recordings/${itemId}/folders?view=org`,
                    {
                        method: "DELETE",
                        headers: {
                            "x-test-user": actor,
                            "content-type": "application/json",
                        },
                        body: JSON.stringify({
                            organization: true,
                            withdraw: true,
                        }),
                    },
                ),
                { params: Promise.resolve({ id: itemId }) },
            );
        expect((await withdraw(userId)).status).toBe(403);
        expect((await withdraw(organization)).status).toBe(200);
        expect(
            await requireRecordingView(userId, itemId, "received", {
                kinds: ["audio", "mail"],
            }),
        ).toMatchObject({ role: "receiver", received: true, shared: false });
        await expect(
            requireRecordingView(userId, itemId, "org", {
                kinds: ["audio", "mail"],
            }),
        ).rejects.toMatchObject({ statusCode: 404 });
        expect((await listItemShares(owner, itemId))[0]).toMatchObject({
            state: "accepted",
        });
        expect(
            (
                await database.db
                    .select()
                    .from(itemShares)
                    .where(
                        and(
                            eq(itemShares.id, share.id),
                            eq(itemShares.receiverUserId, userId),
                        ),
                    )
            )[0].filingFolderId,
        ).toBe(filing);
        expect(
            (await listRecordingTasks(viewer, itemId))?.tasks.find(
                (row) => row.id === task.id,
            ),
        ).toMatchObject({
            canEdit: false,
            canClose: true,
            assignee: { personId: "" },
        });
        expect(
            (await listRecordingTasks(viewer, itemId))?.tasks.find(
                (row) => row.id === other.id,
            ),
        ).toMatchObject({ canEdit: false, canClose: false });
    });
    it.each([
        "audio-item",
        "mail-item",
    ])("lets an accepted curator delete the Organization summary of %s", async (itemId) => {
        const [share] = await inviteToItem(owner, itemId, [curator]);
        await database.db.insert(recordingFolders).values({
            id: "curator-filing",
            userId: curator,
            name: encryptText("Received"),
            nameHash: "received",
        });
        await changePersonShare(curator, share.id, {
            action: "accept",
            version: share.version,
            folderId: "curator-filing",
        });
        await database.db
            .insert(recordingFolderAssignments)
            .values({ itemId, userId: owner, folderId: "org-folder" });
        const route = personWriteRoutes.find(
            (entry) =>
                entry.path === "recordings/[id]/summary/route.ts" &&
                entry.method === "DELETE",
        );
        if (!route) throw new Error("Summary route missing");
        const response = await route.handler(
            new Request(
                `http://localhost/api/recordings/${itemId}/summary?view=org`,
                { method: "DELETE", headers: { "x-test-user": curator } },
            ),
            { params: Promise.resolve({ id: itemId }) },
        );
        expect(response.status).toBe(200);
        expect(
            await database.db
                .select()
                .from(aiEnhancements)
                .where(eq(aiEnhancements.itemId, itemId)),
        ).toEqual([]);
    });
});
