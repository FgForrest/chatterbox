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
    recordingFolders,
    recordingTasks,
    transcriptSpeakers,
    users,
} from "@/db/schema";
import { encryptText } from "@/lib/encryption/fields";
import { compareDuplicates } from "@/lib/knowledge/duplicate-comparison";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";
import {
    attributeSpeaker,
    insertPerson,
    insertRecording,
    insertTranscript,
    shareRecording,
} from "@/tests/mcp/fixtures";

const { dbRef, dbProxy } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    return {
        dbRef: ref,
        dbProxy: new Proxy(
            {},
            {
                get: (_target, key) => {
                    const value = ref.current?.[key];
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
        BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
        DATABASE_URL: "postgres://unused",
    },
}));
vi.mock("@/lib/authz/curator", () => ({
    userCuratesOrganizationNow: vi.fn(async () => true),
}));
vi.mock("@/lib/org/config", () => ({ getOrgUserId: async () => "org" }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));

const testUrl = getTestDatabaseUrl();
const withDatabase = testUrl ? describe : describe.skip;

withDatabase("duplicate comparison preview limits", () => {
    let database: TestPostgresDatabase;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testUrl ?? "",
            "duplicate_previews",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);
    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);
    beforeEach(async () => {
        await database.db.delete(users);
        await database.db.insert(users).values([
            { id: "org", email: "org@example.test", role: "org" },
            { id: "member", email: "member@example.test" },
        ]);
        await database.db.insert(recordingFolders).values({
            id: "org-root",
            userId: "org",
            name: encryptText("Organization"),
            nameHash: "org",
            kind: "public",
        });
    });

    it.each([
        100, 101, 150, 250,
    ])("keeps both sides with %i appearances or tasks on one side and three on the other", async (count) => {
        const db = database.db;
        const left = await insertPerson(db, "org", "Zavi Duspektor");
        const right = await insertPerson(db, "org", "Zavi Duspektar");
        for (const [personId, prefix, size] of [
            [left, "a", count],
            [right, "z", 3],
        ] as const) {
            for (let index = 0; index < size; index++) {
                const id = `${prefix}-${String(index).padStart(3, "0")}`;
                await insertRecording(db, { id, userId: "member", title: id });
                await shareRecording(db, id, "org");
                const transcriptionId = await insertTranscript(
                    db,
                    id,
                    "member",
                );
                await attributeSpeaker(db, {
                    userId: "member",
                    transcriptionId,
                    label: "speaker_0",
                    personId,
                });
            }
        }
        const appearanceIds = Array.from(
            { length: 100 },
            (_, index) => `a-${String(index).padStart(3, "0")}`,
        );
        for (const [first, second] of [
            [left, right],
            [right, left],
        ]) {
            const comparison = await compareDuplicates(
                "org",
                "person",
                first,
                second,
            );
            const sides = [comparison.left, comparison.right];
            expect(
                sides
                    .find((side) => side.id === left)
                    ?.appearances.map((item) => item.itemId),
            ).toEqual(appearanceIds);
            expect(
                sides
                    .find((side) => side.id === right)
                    ?.appearances.map((item) => item.itemId),
            ).toEqual(["z-000", "z-001", "z-002"]);
            expect(comparison.itemsLimited).toBe(count > 100);
        }
        await db
            .delete(transcriptSpeakers)
            .where(eq(transcriptSpeakers.userId, "member"));
        for (const [personId, prefix, size] of [
            [left, "a", count],
            [right, "z", 3],
        ] as const) {
            await db.insert(recordingTasks).values(
                Array.from({ length: size }, (_, index) => {
                    const id = `${prefix}-task-${String(index).padStart(3, "0")}`;
                    return {
                        id,
                        itemId: "a-000",
                        userId: "member",
                        assigneePersonId: personId,
                        text: encryptText(id),
                        status: "open" as const,
                        source: "manual" as const,
                    };
                }),
            );
        }
        const taskIds = Array.from(
            { length: 100 },
            (_, index) => `a-task-${String(index).padStart(3, "0")}`,
        );
        for (const [first, second] of [
            [left, right],
            [right, left],
        ]) {
            const comparison = await compareDuplicates(
                "org",
                "person",
                first,
                second,
            );
            const sides = [comparison.left, comparison.right];
            expect(
                sides
                    .find((side) => side.id === left)
                    ?.tasks.map((task) => task.id),
            ).toEqual(taskIds);
            expect(
                sides
                    .find((side) => side.id === right)
                    ?.tasks.map((task) => task.id),
            ).toEqual(["z-task-000", "z-task-001", "z-task-002"]);
            expect(comparison.itemsLimited).toBe(count > 100);
        }
    }, 60_000);
});
