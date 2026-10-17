import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
    chatterItems,
    itemProcessing,
    mailContents,
    mailMessages,
    recordingFolderAssignments,
    recordingFolders,
    transcriptions,
    users,
} from "@/db/schema";
import { gatherFacts } from "@/lib/pipeline/facts";
import { planAdvance } from "@/lib/pipeline/plan";
import { insertRecordings } from "@/tests/integration/items";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef, mockEnv } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    const proxy = new Proxy(
        {},
        {
            get: (_target, property: string | symbol) => {
                if (!ref.current) throw new Error("test database not ready");
                const value = ref.current[property];
                return typeof value === "function"
                    ? value.bind(ref.current)
                    : value;
            },
        },
    );
    return {
        dbProxy: proxy,
        dbRef: ref,
        mockEnv: {
            IS_HOSTED: false,
            SELF_HOST_MODE: "shared",
            ORG_ACCOUNT_EMAIL: "org@example.test",
            ORG_ACCOUNT_PASSWORD: "organization-password",
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            DATABASE_URL: "postgres://unused",
        },
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const USER = "legacy-migration-user";

describeWithDatabase("legacy item processing migration", () => {
    let database: TestPostgresDatabase | null = null;

    function db() {
        if (!database) throw new Error("test database not ready");
        return database.db;
    }

    async function addAudio(id: string, deleted = false, withContent = true) {
        await insertRecordings(db(), {
            id,
            userId: USER,
            deviceSn: `device-${id}`,
            plaudFileId: `plaud-${id}`,
            filename: id,
            duration: 1_000,
            startTime: new Date("2026-10-15T10:00:00Z"),
            endTime: new Date("2026-10-15T10:00:01Z"),
            filesize: 100,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: `${USER}/${id}.mp3`,
            plaudVersion: "1",
        });
        if (deleted) {
            await db()
                .update(chatterItems)
                .set({ deletedAt: new Date("2026-10-15T11:00:00Z") })
                .where(
                    and(eq(chatterItems.id, id), eq(chatterItems.userId, USER)),
                );
        }
        if (withContent) {
            await db()
                .insert(transcriptions)
                .values({
                    id: `content-${id}`,
                    recordingId: id,
                    userId: USER,
                    text: "Transcript",
                    provider: "test",
                    model: "test",
                    source: "riffado",
                    revision: 3,
                });
        }
    }

    async function addMail(id: string, deleted = false, withContent = true) {
        await db()
            .insert(chatterItems)
            .values({
                id,
                userId: USER,
                kind: "mail",
                title: id,
                occurredAt: new Date("2026-10-15T10:00:00Z"),
                deletedAt: deleted ? new Date("2026-10-15T11:00:00Z") : null,
            });
        await db()
            .insert(mailMessages)
            .values({
                id,
                userId: USER,
                rawHash: `hash-${id}`,
                receivedAt: new Date("2026-10-15T10:00:00Z"),
                sizeBytes: 100,
                auth: {},
                senderVerified: true,
            });
        if (withContent) {
            await db()
                .insert(mailContents)
                .values({
                    id: `content-${id}`,
                    itemId: id,
                    userId: USER,
                    revision: 5,
                    parserVersion: 1,
                    segments: [],
                });
        }
    }

    async function rows() {
        return db()
            .select()
            .from(itemProcessing)
            .where(eq(itemProcessing.userId, USER));
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "legacy_item_processing",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        await db().insert(users).values({
            id: USER,
            email: "legacy-migration@example.test",
        });
        await db()
            .insert(recordingFolders)
            .values([
                {
                    id: "legacy-root",
                    userId: USER,
                    parentId: null,
                    name: "Private",
                    nameHash: "root-hash",
                    kind: "private",
                },
                {
                    id: "legacy-folder",
                    userId: USER,
                    parentId: "legacy-root",
                    name: "Projects",
                    nameHash: "folder-hash",
                    kind: "custom",
                },
            ]);
        await addAudio("placed-audio");
        await addAudio("root-audio");
        await addAudio("empty-audio", false, false);
        await addAudio("deleted-audio", true);
        await addMail("placed-mail");
        await addMail("unplaced-mail");
        await addMail("empty-mail", false, false);
        await addMail("deleted-mail", true);
        await db()
            .insert(recordingFolderAssignments)
            .values([
                {
                    userId: USER,
                    itemId: "placed-audio",
                    folderId: "legacy-folder",
                },
                {
                    userId: USER,
                    itemId: "root-audio",
                    folderId: "legacy-root",
                },
                {
                    userId: USER,
                    itemId: "placed-mail",
                    folderId: "legacy-folder",
                },
            ]);
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    it("marks live items once with their cutover content identity", async () => {
        if (!database) throw new Error("test database not ready");

        await database.sql.file(
            "./src/db/migrations/0116_mark_legacy_items.sql",
        );
        const first = await rows();
        await database.sql.file(
            "./src/db/migrations/0116_mark_legacy_items.sql",
        );
        const second = await rows();

        expect(first).toHaveLength(6);
        expect(second).toHaveLength(6);
        expect(first.map((row) => row.itemId).sort()).toEqual(
            [
                "empty-audio",
                "empty-mail",
                "placed-audio",
                "placed-mail",
                "root-audio",
                "unplaced-mail",
            ].sort(),
        );
        expect(
            first.find((row) => row.itemId === "placed-audio"),
        ).toMatchObject({
            profileId: null,
            profileRevisionId: null,
            phases: {
                categorize: { state: "done", reason: "legacy" },
                learn: {
                    state: "done",
                    reason: "legacy",
                    inputs: {
                        contentId: "content-placed-audio",
                        contentSourceId: "riffado",
                        contentRevision: 3,
                    },
                },
                summary: {
                    state: "done",
                    reason: "legacy",
                    steps: {
                        title: {
                            contentId: "content-placed-audio",
                            contentRevision: 3,
                        },
                        topics: {
                            contentId: "content-placed-audio",
                            contentRevision: 3,
                        },
                        summary: {
                            contentId: "content-placed-audio",
                            contentRevision: 3,
                        },
                    },
                },
            },
        });
        expect(first.find((row) => row.itemId === "root-audio")).toMatchObject({
            phases: {
                categorize: { state: "skipped", reason: "legacy" },
            },
        });
        expect(first.find((row) => row.itemId === "placed-mail")).toMatchObject(
            {
                phases: {
                    categorize: { state: "done", reason: "legacy" },
                    learn: {
                        inputs: {
                            contentId: "content-placed-mail",
                            contentSourceId: "mail",
                            contentRevision: 5,
                        },
                    },
                    summary: {
                        steps: {
                            title: {
                                contentId: "content-placed-mail",
                                contentRevision: 5,
                            },
                            summary: {
                                contentId: "content-placed-mail",
                                contentRevision: 5,
                            },
                        },
                    },
                },
            },
        );
        for (const itemId of ["empty-audio", "empty-mail"]) {
            const row = first.find((candidate) => candidate.itemId === itemId);
            expect(row?.phases).not.toHaveProperty("learn");
            expect(row?.phases).not.toHaveProperty("summary");
        }
        expect(first.some((row) => row.itemId === "deleted-audio")).toBe(false);
        expect(first.some((row) => row.itemId === "deleted-mail")).toBe(false);
    });

    it("treats an item created without processing state as legacy", async () => {
        await addAudio("old-runtime-audio");

        const facts = await gatherFacts("old-runtime-audio", "private", USER);

        expect(facts.phases).toMatchObject({
            categorize: { state: "skipped", reason: "legacy" },
            learn: {
                state: "done",
                reason: "legacy",
                inputs: {
                    contentId: "content-old-runtime-audio",
                    contentSourceId: "riffado",
                    contentRevision: 3,
                },
            },
            summary: {
                state: "done",
                reason: "legacy",
            },
        });
        expect(planAdvance(facts).actions).toHaveLength(3);
        expect(planAdvance(facts).actions).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    type: "markPhase",
                    phase: "categorize",
                }),
                expect.objectContaining({ type: "markPhase", phase: "learn" }),
                expect.objectContaining({
                    type: "markPhase",
                    phase: "summary",
                }),
            ]),
        );
    });
});
