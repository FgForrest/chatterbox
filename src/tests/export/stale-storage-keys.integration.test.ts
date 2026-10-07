/**
 * The export worker's stale-key sweep against a real PostgreSQL: it lists
 * the keys of jobs that still have some, oldest job first, and nothing for
 * jobs whose list is empty.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { exportJobs, users } from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    const proxy = new Proxy(
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
    );
    return { dbProxy: proxy, dbRef: ref };
});

vi.mock("@/db", () => ({ db: dbProxy }));

import {
    clearStaleStorageKey,
    selectStaleStorageKeys,
} from "@/db/queries/export-jobs";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const USER = "export-user";
const HOUR = 60 * 60 * 1000;

describeWithDatabase("selectStaleStorageKeys (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "export_stale_keys",
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
            .values({ id: USER, email: `${USER}@example.test` });
        const job = (id: string, keys: string[], hoursAgo: number) => ({
            id,
            userId: USER,
            status: "completed" as const,
            staleStorageKeys: keys,
            createdAt: new Date(Date.now() - hoursAgo * HOUR),
        });
        await db()
            .insert(exportJobs)
            .values([
                job("clean", [], 3),
                job("newer", ["exports/newer.zip"], 1),
                job("older", ["exports/a.zip", "exports/b.zip"], 2),
            ]);
    });

    it("lists the keys of jobs that have some, oldest job first", async () => {
        expect(await selectStaleStorageKeys(10)).toEqual([
            { jobId: "older", key: "exports/a.zip" },
            { jobId: "older", key: "exports/b.zip" },
            { jobId: "newer", key: "exports/newer.zip" },
        ]);
    });

    it("stops listing a job once its last key is cleared", async () => {
        await clearStaleStorageKey("newer", "exports/newer.zip");

        expect(
            (await selectStaleStorageKeys(10)).map((entry) => entry.jobId),
        ).toEqual(["older", "older"]);
    });
});
