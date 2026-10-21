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
    aiEnhancements,
    chatterItems,
    mailContents,
    mailMessages,
    recordingFolderAssignments,
    recordingFolders,
    transcriptions,
    users,
} from "@/db/schema";
import { insertRecordings } from "@/tests/integration/items";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    return {
        dbRef: ref,
        dbProxy: new Proxy(
            {},
            {
                get: (_target, property: string | symbol) => {
                    if (!ref.current)
                        throw new Error("test database not ready");
                    const value = ref.current[property];
                    return typeof value === "function"
                        ? value.bind(ref.current)
                        : value;
                },
            },
        ),
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({
    env: {
        IS_HOSTED: false,
        SELF_HOST_MODE: "shared",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        BETTER_AUTH_SECRET: "older-summary-test-secret",
        DATABASE_URL: "postgres://unused",
    },
}));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: async () => "summary-org",
}));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async (request: Request) => ({
        user: { id: request.headers.get("x-test-user") ?? "summary-owner" },
    }),
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/learn/llm-input", () => ({ llmRendering: async () => null }));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));

import { GET } from "@/app/api/recordings/[id]/summary/route";
import { encryptText } from "@/lib/encryption/fields";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const OWNER = "summary-owner";
const ORG = "summary-org";
const OTHER = "summary-other";
const ITEM = "summary-item";
const CONTENT = "summary-content";

describeWithDatabase("summary content revisions (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;

    function db() {
        if (!database) throw new Error("test database not ready");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "summary_older_content",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    describe.each([
        ["audio", "private"],
        ["audio", "org"],
        ["mail", "private"],
        ["mail", "org"],
    ] as const)("%s in %s view", (kind, view) => {
        const source = kind === "mail" ? "mail" : "riffado";

        function inputs(contentId = CONTENT, contentRevision = 0) {
            return { contentId, contentSourceId: source, contentRevision };
        }

        async function writeContent(
            id = CONTENT,
            revision = 0,
            userId = OWNER,
        ) {
            if (kind === "mail") {
                await db().insert(mailContents).values({
                    id,
                    revision,
                    userId,
                    itemId: ITEM,
                    parserVersion: 1,
                    segments: [],
                });
            } else {
                await db()
                    .insert(transcriptions)
                    .values({
                        id,
                        revision,
                        userId,
                        recordingId: ITEM,
                        text: encryptText("Transcript"),
                        source,
                        provider: "test",
                        model: "test",
                    });
            }
        }

        async function removeContent() {
            const table = kind === "mail" ? mailContents : transcriptions;
            await db()
                .delete(table)
                .where(and(eq(table.id, CONTENT), eq(table.userId, OWNER)));
        }

        async function writeInputs(value: Record<string, unknown> | null) {
            await db()
                .update(aiEnhancements)
                .set({ inputs: value })
                .where(
                    and(
                        eq(aiEnhancements.itemId, ITEM),
                        eq(aiEnhancements.userId, OWNER),
                    ),
                );
        }

        async function readSummary(userId = view === "org" ? ORG : OWNER) {
            const response = await GET(
                new Request(
                    `http://localhost/api/recordings/${ITEM}/summary?view=${view}`,
                    {
                        headers: { "x-test-user": userId },
                    },
                ),
                { params: Promise.resolve({ id: ITEM }) },
            );
            expect(response.status).toBe(200);
            return response.json() as Promise<{
                summary: string;
                olderContent: boolean;
            }>;
        }

        beforeEach(async () => {
            await db().delete(users);
            await db()
                .insert(users)
                .values([
                    { id: OWNER, email: "owner@example.test" },
                    { id: ORG, email: "org@example.test", role: "org" },
                    { id: OTHER, email: "other@example.test" },
                ]);
            if (kind === "audio") {
                await insertRecordings(db(), {
                    id: ITEM,
                    userId: OWNER,
                    filename: encryptText("Recording"),
                    deviceSn: "device",
                    plaudFileId: ITEM,
                    duration: 1000,
                    startTime: new Date(0),
                    endTime: new Date(1000),
                    filesize: 10,
                    fileMd5: "0".repeat(32),
                    storageType: "local",
                    storagePath: "test.mp3",
                    plaudVersion: "1",
                });
            } else {
                await db()
                    .insert(chatterItems)
                    .values({
                        id: ITEM,
                        userId: OWNER,
                        kind,
                        title: encryptText("Mail"),
                        occurredAt: new Date(0),
                    });
                await db()
                    .insert(mailMessages)
                    .values({
                        id: ITEM,
                        userId: OWNER,
                        rawHash: "0".repeat(64),
                        receivedAt: new Date(0),
                        sizeBytes: 10,
                        auth: {},
                        senderVerified: true,
                    });
            }
            await writeContent();
            await db()
                .insert(aiEnhancements)
                .values({
                    itemId: ITEM,
                    userId: OWNER,
                    transcriptionId: kind === "audio" ? CONTENT : null,
                    summary: encryptText("Previous summary stays visible"),
                    keyPoints: [],
                    actionItems: [],
                    source: "riffado",
                    provider: "test",
                    model: "test",
                    inputs: inputs(),
                });
            if (view === "org") {
                await db()
                    .insert(recordingFolders)
                    .values({
                        id: "org-folder",
                        userId: ORG,
                        name: encryptText("Organization"),
                        nameHash: "folder-hash",
                        kind: "public",
                    });
                await db().insert(recordingFolderAssignments).values({
                    userId: OWNER,
                    itemId: ITEM,
                    folderId: "org-folder",
                });
            }
        });

        it("does not mark a summary of the current revision", async () => {
            expect(await readSummary()).toMatchObject({ olderContent: false });
        });

        it("marks a higher revision on the same row and preserves the summary", async () => {
            const table = kind === "mail" ? mailContents : transcriptions;
            await db()
                .update(table)
                .set({ revision: 1 })
                .where(and(eq(table.id, CONTENT), eq(table.userId, OWNER)));
            expect(await readSummary()).toMatchObject({
                olderContent: true,
                summary: "Previous summary stays visible",
            });
            await writeInputs(inputs(CONTENT, 1));
            expect(await readSummary()).toMatchObject({ olderContent: false });
        });

        it("marks a replacement content row even when its revision starts at zero", async () => {
            await removeContent();
            await writeContent("replacement");
            expect(await readSummary()).toMatchObject({ olderContent: true });
            await writeInputs(inputs("replacement"));
            expect(await readSummary()).toMatchObject({ olderContent: false });
        });

        it.each([
            null,
            {},
            { contentId: CONTENT },
            { contentId: CONTENT, contentRevision: 0 },
        ])("does not infer older content from incomplete legacy inputs %j", async (legacyInputs) => {
            await writeInputs(legacyInputs);
            expect(await readSummary()).toMatchObject({ olderContent: false });
        });

        it("does not compare content belonging to another user", async () => {
            await removeContent();
            await writeContent("another-users-content", 3, OTHER);
            expect(await readSummary()).toMatchObject({ olderContent: false });
        });

        it("does not infer older content when the current content is missing", async () => {
            await removeContent();
            expect(await readSummary()).toMatchObject({ olderContent: false });
        });

        if (kind === "audio") {
            it("compares the recorded transcript source when other sources coexist", async () => {
                await db()
                    .insert(transcriptions)
                    .values({
                        id: "plaud-content",
                        userId: OWNER,
                        recordingId: ITEM,
                        text: encryptText("Imported transcript"),
                        source: "plaud",
                        revision: 3,
                        provider: "plaud",
                        model: "plaud",
                    });
                expect(await readSummary()).toMatchObject({
                    olderContent: false,
                });
                await writeInputs({
                    contentId: "plaud-content",
                    contentSourceId: "plaud",
                    contentRevision: 2,
                });
                expect(await readSummary()).toMatchObject({
                    olderContent: true,
                });
            });
        }

        if (view === "org") {
            it("returns the same note to another Organization member", async () => {
                const table = kind === "mail" ? mailContents : transcriptions;
                await db()
                    .update(table)
                    .set({ revision: 1 })
                    .where(and(eq(table.id, CONTENT), eq(table.userId, OWNER)));
                expect(await readSummary(OTHER)).toMatchObject({
                    olderContent: true,
                });
            });
        }
    });
});
