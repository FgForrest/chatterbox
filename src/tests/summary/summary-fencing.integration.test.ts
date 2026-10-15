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
    itemProcessing,
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
        BETTER_AUTH_SECRET: "summary-fencing-test-secret",
        DATABASE_URL: "postgres://unused",
    },
}));
vi.mock("@/lib/org/config", () => ({ getOrgUserId: async () => null }));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));

import { decryptText, encryptText } from "@/lib/encryption/fields";
import { upsertEnhancement } from "@/lib/transcription/persist";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const USER = "summary-fencing-user";
const ITEM = "summary-fencing-item";
const TRANSCRIPT = "summary-fencing-transcript";

describeWithDatabase("summary commit fencing (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;

    function db() {
        if (!database) throw new Error("test database not ready");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "summary_fencing",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        await db().delete(users);
        await db()
            .insert(users)
            .values({ id: USER, email: "summary-fencing@example.test" });
        await insertRecordings(db(), {
            id: ITEM,
            userId: USER,
            filename: encryptText("Fencing"),
            deviceSn: "device",
            plaudFileId: "plaud-fencing",
            duration: 1_000,
            startTime: new Date("2026-10-15T00:00:00Z"),
            endTime: new Date("2026-10-15T00:00:01Z"),
            filesize: 10,
            fileMd5: "0123456789abcdef0123456789abcdef",
            storageType: "local",
            storagePath: "fencing.mp3",
            plaudVersion: "1",
        });
        await db()
            .insert(itemProcessing)
            .values({
                itemId: ITEM,
                userId: USER,
                view: "private",
                phases: {
                    categorize: {
                        state: "done",
                        reason: "categorized",
                        generation: 1,
                        at: "2026-10-15T00:00:00.000Z",
                    },
                },
            });
        await db()
            .insert(transcriptions)
            .values({
                id: TRANSCRIPT,
                recordingId: ITEM,
                userId: USER,
                text: encryptText("Old transcript"),
                detectedLanguage: "en",
                source: "riffado",
                provider: "test",
                model: "test",
                revision: 0,
            });
        await db()
            .insert(aiEnhancements)
            .values({
                itemId: ITEM,
                userId: USER,
                transcriptionId: TRANSCRIPT,
                summary: encryptText("Current summary"),
                keyPoints: [],
                actionItems: [],
                source: "riffado",
                provider: "test",
                model: "test",
            });
    });

    it("does not replace the current summary when the transcript changes during the job", async () => {
        await db()
            .update(transcriptions)
            .set({ text: encryptText("New transcript"), revision: 1 })
            .where(
                and(
                    eq(transcriptions.id, TRANSCRIPT),
                    eq(transcriptions.userId, USER),
                ),
            );

        await expect(
            upsertEnhancement({
                userId: USER,
                recordingId: ITEM,
                transcriptionId: TRANSCRIPT,
                summary: "Stale result",
                keyPoints: [],
                actionItems: [],
                source: "riffado",
                provider: "test",
                model: "test",
                inputs: {
                    contentId: TRANSCRIPT,
                    contentSourceId: "riffado",
                    contentRevision: 0,
                    itemProfileRevisionId: null,
                },
            }),
        ).resolves.toEqual({ committed: false, reason: "outdated" });

        const [stored] = await db()
            .select({ summary: aiEnhancements.summary })
            .from(aiEnhancements)
            .where(
                and(
                    eq(aiEnhancements.itemId, ITEM),
                    eq(aiEnhancements.userId, USER),
                ),
            );
        expect(decryptText(stored?.summary)).toBe("Current summary");
        expect(
            (await db().select().from(itemProcessing))[0]?.phases.summary,
        ).toMatchObject({ state: "outdated", reason: "content_changed" });
    });
});
