/**
 * `deleteUser` guarded by the scheduled deletion, against a real PostgreSQL:
 * a reactivated user is kept, and of two workers deleting the same user
 * exactly one reports the deletion.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

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
import { users } from "@/db/schema";
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

import { deleteUser } from "@/db/queries/billing";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const HOUR = 60 * 60 * 1000;

describeWithDatabase("deleteUser when the deletion is due (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "account_deletion",
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

    async function user(id: string, accountDeletionScheduledAt: Date | null) {
        await db()
            .insert(users)
            .values({
                id,
                email: `${id}@example.test`,
                accountDeletionScheduledAt,
            });
    }

    async function exists(id: string): Promise<boolean> {
        const rows = await db()
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, id));
        return rows.length > 0;
    }

    it("deletes a user whose deletion is due", async () => {
        await user("due", new Date(Date.now() - HOUR));

        expect(await deleteUser("due", { onlyIfDeletionDue: true })).toBe(true);
        expect(await exists("due")).toBe(false);
    });

    it("keeps a user whose deletion was cleared or pushed out", async () => {
        await user("reactivated", null);
        await user("later", new Date(Date.now() + HOUR));

        expect(
            await deleteUser("reactivated", { onlyIfDeletionDue: true }),
        ).toBe(false);
        expect(await deleteUser("later", { onlyIfDeletionDue: true })).toBe(
            false,
        );
        expect(await exists("reactivated")).toBe(true);
        expect(await exists("later")).toBe(true);
    });

    it("reports one deletion when two workers delete the same user", async () => {
        await user("raced", new Date(Date.now() - HOUR));

        const results = await Promise.all([
            deleteUser("raced", { onlyIfDeletionDue: true }),
            deleteUser("raced", { onlyIfDeletionDue: true }),
        ]);

        expect(results.filter(Boolean)).toHaveLength(1);
        expect(await exists("raced")).toBe(false);
    });

    it("deletes regardless of the schedule without the guard", async () => {
        await user("unscheduled", null);

        expect(await deleteUser("unscheduled")).toBe(true);
        expect(await exists("unscheduled")).toBe(false);
    });
});
