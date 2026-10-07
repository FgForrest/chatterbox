/**
 * The background sync claim against a real PostgreSQL: which connections a
 * tick picks when more are due than it takes.
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
import { plaudConnections, users } from "@/db/schema";
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
vi.mock("@/lib/env", () => ({
    env: {
        IS_HOSTED: false,
        BACKGROUND_SYNC_ENABLED: true,
        BACKGROUND_SYNC_INTERVAL_MS: 300_000,
    },
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/sync/sync-recordings", () => ({
    syncRecordingsForUser: vi.fn(),
}));

import { claimUsersForSync } from "@/lib/sync/worker";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function ago(ms: number): Date {
    return new Date(Date.now() - ms);
}

describeWithDatabase("claimUsersForSync (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "sync_claim",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        await db().delete(users);
    });

    async function connection(
        userId: string,
        state: { lastSync: Date | null; invalidatedAt?: Date | null },
    ) {
        await db()
            .insert(users)
            .values({ id: userId, email: `${userId}@example.test` });
        await db()
            .insert(plaudConnections)
            .values({
                userId,
                bearerToken: "encrypted",
                lastSync: state.lastSync,
                invalidatedAt: state.invalidatedAt ?? null,
            });
    }

    it("takes never-synced connections before long-unsynced ones", async () => {
        for (let index = 0; index < 25; index++) {
            await connection(`synced-${index}`, {
                lastSync: ago(HOUR + index * MINUTE),
            });
        }
        await connection("never-synced", { lastSync: null });

        const claimed = await claimUsersForSync();

        expect(claimed).toHaveLength(20);
        expect(claimed[0]).toBe("never-synced");
        expect(claimed[1]).toBe("synced-24");
        expect(claimed).not.toContain("synced-0");
    });

    it("skips connections synced in the last few minutes", async () => {
        await connection("fresh", { lastSync: ago(MINUTE) });
        await connection("stale", { lastSync: ago(HOUR) });

        expect(await claimUsersForSync()).toEqual(["stale"]);
    });

    it("retries a connection Plaud rejected at most hourly", async () => {
        await connection("rejected-recently", {
            lastSync: ago(10 * HOUR),
            invalidatedAt: ago(10 * MINUTE),
        });
        await connection("rejected-long-ago", {
            lastSync: ago(10 * HOUR),
            invalidatedAt: ago(2 * HOUR),
        });
        await connection("healthy", { lastSync: ago(HOUR) });

        expect(await claimUsersForSync()).toEqual([
            "rejected-long-ago",
            "healthy",
        ]);
    });
});
