import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { chatterItems, recordings, transcriptions, users } from "@/db/schema";
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
        dbProxy: new Proxy(
            {},
            {
                get: (_target, property: string | symbol) => {
                    const current = ref.current;
                    if (!current) {
                        throw new Error("test database was not initialized");
                    }
                    const value = current[property];
                    return typeof value === "function"
                        ? value.bind(current)
                        : value;
                },
            },
        ),
        dbRef: ref,
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));

import {
    markLearnReleasedInTx,
    readProcessing,
    updatePhaseInTx,
} from "@/lib/pipeline/state";
import type { PhaseRecord } from "@/lib/pipeline/types";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const USER_ID = "pipeline-state-user";
const OTHER_USER_ID = "pipeline-state-other-user";
const ITEM_ID = "pipeline-state-item";

function record(generation: number, reason: string): PhaseRecord {
    return {
        state: "pending",
        reason,
        generation,
        inputs: {
            contentId: "transcription-1",
            contentSourceId: "riffado",
            contentRevision: 2,
        },
        at: "2026-10-14T12:00:00.000Z",
    };
}

describeWithDatabase("pipeline state (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "pipeline_state",
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
            .values([
                { id: USER_ID, email: "pipeline-state@example.test" },
                { id: OTHER_USER_ID, email: "pipeline-other@example.test" },
            ]);
        await db()
            .insert(chatterItems)
            .values({
                id: ITEM_ID,
                userId: USER_ID,
                kind: "audio",
                title: "Pipeline state",
                occurredAt: new Date("2026-10-14T00:00:00.000Z"),
            });
    });

    it("reads only the requested user's processing row", async () => {
        expect(await readProcessing(ITEM_ID, "private", USER_ID)).toBeNull();
        await db().transaction((tx) =>
            updatePhaseInTx(
                tx,
                ITEM_ID,
                "private",
                USER_ID,
                "summary",
                record(2, "requested"),
            ),
        );

        const row = await readProcessing(ITEM_ID, "private", USER_ID);
        expect(row?.phases.summary).toEqual(record(2, "requested"));
        expect(
            await readProcessing(ITEM_ID, "private", OTHER_USER_ID),
        ).toBeNull();
    });

    it("does not overwrite a phase carrying a higher generation", async () => {
        await db().transaction((tx) =>
            updatePhaseInTx(
                tx,
                ITEM_ID,
                "private",
                USER_ID,
                "summary",
                record(5, "newer"),
            ),
        );
        const updated = await db().transaction((tx) =>
            updatePhaseInTx(
                tx,
                ITEM_ID,
                "private",
                USER_ID,
                "summary",
                record(4, "older"),
            ),
        );

        expect(updated).toBe(false);
        expect(
            (await readProcessing(ITEM_ID, "private", USER_ID))?.phases.summary
                ?.reason,
        ).toBe("newer");
    });

    it("writes nothing when the user_id does not own the item", async () => {
        const updated = await db().transaction((tx) =>
            updatePhaseInTx(
                tx,
                ITEM_ID,
                "private",
                OTHER_USER_ID,
                "summary",
                record(3, "wrong-user"),
            ),
        );

        expect(updated).toBe(false);
        expect(
            await readProcessing(ITEM_ID, "private", OTHER_USER_ID),
        ).toBeNull();
    });

    it("marks a Learn release durably for the content revision", async () => {
        await db()
            .insert(recordings)
            .values({
                id: ITEM_ID,
                userId: USER_ID,
                deviceSn: "pipeline-state-device",
                plaudFileId: "pipeline-state-plaud",
                duration: 1_000,
                endTime: new Date("2026-10-14T00:00:01.000Z"),
                filesize: 10,
                fileMd5: "0".repeat(32),
                storageType: "local",
                storagePath: `${USER_ID}/${ITEM_ID}.mp3`,
                plaudVersion: "1",
            });
        await db().insert(transcriptions).values({
            id: "pipeline-state-transcription",
            recordingId: ITEM_ID,
            userId: USER_ID,
            text: "Transcript",
            provider: "test",
            model: "test",
            source: "riffado",
            revision: 9,
        });
        const updated = await db().transaction((tx) =>
            markLearnReleasedInTx(tx, {
                itemId: ITEM_ID,
                userId: USER_ID,
                generation: 6,
            }),
        );

        expect(updated).toBe(true);
        expect(
            (await readProcessing(ITEM_ID, "private", USER_ID))?.phases.learn,
        ).toMatchObject({
            state: "done",
            reason: "released",
            generation: 6,
            inputs: {
                contentId: "pipeline-state-transcription",
                contentSourceId: "riffado",
                contentRevision: 9,
            },
        });
    });

    it("does not mark a Learn release when the transcript is gone", async () => {
        const updated = await db().transaction((tx) =>
            markLearnReleasedInTx(tx, {
                itemId: ITEM_ID,
                userId: USER_ID,
                generation: 6,
            }),
        );

        expect(updated).toBe(false);
        expect(await readProcessing(ITEM_ID, "private", USER_ID)).toBeNull();
    });
});
