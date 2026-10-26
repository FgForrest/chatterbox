/**
 * Housekeeping prunes against a real PostgreSQL: rows past each table's
 * window go, rows inside it and rows still in use stay, and a backlog is
 * worked through in batches.
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
import {
    adminAuditLog,
    apiRateLimitBuckets,
    asyncJobs,
    mailDeliveryLog,
    mcpAccessLog,
    sessions,
    storageDailySnapshots,
    stripeWebhookEvents,
    users,
    verifications,
    webhookDeliveries,
    webhookEndpoints,
} from "@/db/schema";
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
vi.mock("@/lib/env", () => ({ env: { MCP_AUDIT_RETENTION_DAYS: 90 } }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));

import { runHousekeeping } from "@/lib/jobs/housekeeping";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const USER = "housekeeping-user";
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function ago(ms: number): Date {
    return new Date(Date.now() - ms);
}

describeWithDatabase("housekeeping prunes (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "housekeeping",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        await db().delete(stripeWebhookEvents);
        await db().delete(apiRateLimitBuckets);
        await db().delete(verifications);
        await db().delete(adminAuditLog);
        await db().delete(users);
        await db()
            .insert(users)
            .values({ id: USER, email: `${USER}@example.test` });
    });

    async function ids<T extends { id: string }>(
        rows: Promise<T[]>,
    ): Promise<string[]> {
        return (await rows).map((row) => row.id).sort();
    }

    async function seedJobs() {
        const job = (
            id: string,
            status: "pending" | "completed" | "failed",
        ) => ({ id, status, userId: USER, kind: "test" });
        await db()
            .insert(asyncJobs)
            .values([
                job("job-old", "completed"),
                job("job-old-failed", "failed"),
                job("job-recent", "completed"),
                job("job-pending", "pending"),
            ]);
        const sql = database?.sql;
        if (!sql) throw new Error("test database was not initialized");
        await sql`update async_jobs set completed_at = now() - interval '2 days' where id in ('job-old', 'job-old-failed')`;
        await sql`update async_jobs set completed_at = now() - interval '1 hour' where id = 'job-recent'`;
    }

    async function seedWebhookDeliveries() {
        await db()
            .insert(webhookEndpoints)
            .values({
                id: "endpoint",
                userId: USER,
                url: "encrypted",
                secret: "encrypted",
                events: ["recording.created"],
            });
        const delivery = (id: string, status: string, updatedAt: Date) => ({
            id,
            status,
            updatedAt,
            endpointId: "endpoint",
            userId: USER,
            event: "recording.created",
            payload: {},
        });
        await db()
            .insert(webhookDeliveries)
            .values([
                delivery("success-old", "success", ago(31 * DAY)),
                delivery("dead-old", "dead", ago(31 * DAY)),
                delivery("success-recent", "success", ago(29 * DAY)),
                delivery("pending-old", "pending", ago(31 * DAY)),
                delivery("processing-old", "processing", ago(31 * DAY)),
            ]);
    }

    it("deletes rows past each window and keeps the rest", async () => {
        await seedJobs();
        await seedWebhookDeliveries();
        await db()
            .insert(apiRateLimitBuckets)
            .values([
                { key: "closed-old", resetAt: ago(2 * DAY) },
                { key: "closed-recent", resetAt: ago(HOUR) },
                { key: "open", resetAt: new Date(Date.now() + MINUTE) },
            ]);
        const event = (
            eventId: string,
            status: "pending" | "completed" | "failed",
            createdAt: Date,
        ) => ({
            eventId,
            status,
            createdAt,
            type: "invoice.paid",
            eventCreatedAt: createdAt,
        });
        await db()
            .insert(stripeWebhookEvents)
            .values([
                event("evt-completed-old", "completed", ago(91 * DAY)),
                event("evt-failed-old", "failed", ago(91 * DAY)),
                event("evt-pending-old", "pending", ago(91 * DAY)),
                event("evt-completed-recent", "completed", ago(89 * DAY)),
            ]);
        const session = (id: string, expiresAt: Date) => ({
            id,
            expiresAt,
            token: id,
            userId: USER,
        });
        await db()
            .insert(sessions)
            .values([
                session("session-old", ago(2 * DAY)),
                session("session-recent", ago(HOUR)),
                session("session-live", new Date(Date.now() + DAY)),
            ]);
        const verification = (id: string, expiresAt: Date) => ({
            id,
            expiresAt,
            identifier: id,
            value: "code",
        });
        await db()
            .insert(verifications)
            .values([
                verification("verification-expired", ago(MINUTE)),
                verification(
                    "verification-live",
                    new Date(Date.now() + MINUTE),
                ),
            ]);
        const audit = (id: string, createdAt: Date) => ({
            id,
            createdAt,
            adminUserEmail: "admin@example.test",
            route: "/admin",
            method: "GET",
        });
        await db()
            .insert(adminAuditLog)
            .values([
                audit("audit-old", ago(91 * DAY)),
                audit("audit-recent", ago(89 * DAY)),
            ]);
        await db()
            .insert(mcpAccessLog)
            .values([
                { id: "mcp-old", at: ago(91 * DAY), outcome: "ok" },
                { id: "mcp-recent", at: ago(89 * DAY), outcome: "ok" },
            ]);
        await db()
            .insert(mailDeliveryLog)
            .values([
                {
                    id: "mail-old",
                    userId: USER,
                    at: ago(31 * DAY),
                    outcome: "refused",
                },
                {
                    id: "mail-recent",
                    userId: USER,
                    at: ago(29 * DAY),
                    outcome: "accepted",
                },
            ]);

        expect(await runHousekeeping()).toEqual({
            async_jobs: 2,
            webhook_deliveries: 2,
            api_rate_limit_buckets: 1,
            stripe_webhook_events: 1,
            sessions: 1,
            verifications: 1,
            admin_audit_log: 1,
            mcp_access_log: 1,
            mail_delivery_log: 1,
        });

        expect(
            await ids(
                db()
                    .select({ id: asyncJobs.id })
                    .from(asyncJobs)
                    .where(eq(asyncJobs.kind, "test")),
            ),
        ).toEqual(["job-pending", "job-recent"]);
        expect(
            await ids(
                db()
                    .select({ id: webhookDeliveries.id })
                    .from(webhookDeliveries),
            ),
        ).toEqual(["pending-old", "processing-old", "success-recent"]);
        expect(
            await ids(
                db()
                    .select({ id: apiRateLimitBuckets.key })
                    .from(apiRateLimitBuckets),
            ),
        ).toEqual(["closed-recent", "open"]);
        expect(
            await ids(
                db()
                    .select({ id: stripeWebhookEvents.eventId })
                    .from(stripeWebhookEvents),
            ),
        ).toEqual([
            "evt-completed-recent",
            "evt-failed-old",
            "evt-pending-old",
        ]);
        expect(
            await ids(db().select({ id: sessions.id }).from(sessions)),
        ).toEqual(["session-live", "session-recent"]);
        expect(
            await ids(
                db().select({ id: verifications.id }).from(verifications),
            ),
        ).toEqual(["verification-live"]);
        expect(
            await ids(
                db().select({ id: adminAuditLog.id }).from(adminAuditLog),
            ),
        ).toEqual(["audit-recent"]);
        expect(
            await ids(db().select({ id: mcpAccessLog.id }).from(mcpAccessLog)),
        ).toEqual(["mcp-recent"]);
        expect(
            await ids(
                db().select({ id: mailDeliveryLog.id }).from(mailDeliveryLog),
            ),
        ).toEqual(["mail-recent"]);
    });

    function closedBuckets(count: number) {
        return db()
            .insert(apiRateLimitBuckets)
            .values(
                Array.from({ length: count }, (_, index) => ({
                    key: `closed-${index}`,
                    resetAt: ago(2 * DAY + index * MINUTE),
                })),
            );
    }

    it("works through a backlog in batches", async () => {
        await closedBuckets(25);

        const pruned = await runHousekeeping({
            batchSize: 10,
            maxBatches: 100,
            budgetMs: 60_000,
        });

        expect(pruned.api_rate_limit_buckets).toBe(25);
        expect(await db().select().from(apiRateLimitBuckets)).toEqual([]);
    });

    it("stops after its batch cap and leaves the rest for the next run", async () => {
        await closedBuckets(25);

        const pruned = await runHousekeeping({
            batchSize: 10,
            maxBatches: 2,
            budgetMs: 60_000,
        });

        expect(pruned.api_rate_limit_buckets).toBe(20);
        expect(await db().select().from(apiRateLimitBuckets)).toHaveLength(5);
    });

    it("aggregates storage only once across concurrent housekeeping processes", async () => {
        const client = database?.sql;
        if (!client) throw new Error("Database not initialized");
        await client`create sequence snapshot_refreshes`;
        await client`create function count_snapshot_refresh() returns trigger language plpgsql as $$
            begin perform nextval('snapshot_refreshes'); perform pg_sleep(0.1); return null; end $$`;
        await client`create trigger count_snapshot_refresh after insert on storage_daily_snapshots for each statement execute function count_snapshot_refresh()`;
        try {
            await Promise.all([runHousekeeping(), runHousekeeping()]);
            expect(
                (
                    await client`select last_value::int as count, is_called from snapshot_refreshes`
                )[0],
            ).toEqual({ count: 1, is_called: true });
            await runHousekeeping();
            expect(
                (
                    await client`select last_value::int as count from snapshot_refreshes`
                )[0].count,
            ).toBe(1);
        } finally {
            await client`drop trigger count_snapshot_refresh on storage_daily_snapshots`;
            await client`drop function count_snapshot_refresh()`;
            await client`drop sequence snapshot_refreshes`;
        }
    });
    it("rolls back a snapshot insert failure after the day check and retries on a later housekeeping run", async () => {
        const client = database?.sql;
        if (!client) throw new Error("Database not initialized");
        await db()
            .insert(users)
            .values({ id: "second-user", email: "second@example.test" });
        expect(await db().select().from(storageDailySnapshots)).toEqual([]);
        await client`create function reject_snapshot_insert() returns trigger language plpgsql as $$
            begin raise exception 'synthetic snapshot insert failure'; end $$`;
        await client`create trigger reject_snapshot_insert after insert on storage_daily_snapshots for each statement execute function reject_snapshot_insert()`;
        const errorLog = vi
            .spyOn(console, "error")
            .mockImplementation(() => undefined);
        try {
            await expect(runHousekeeping()).rejects.toMatchObject({
                cause: { message: "synthetic snapshot insert failure" },
            });
            expect(await db().select().from(storageDailySnapshots)).toEqual([]);
        } finally {
            errorLog.mockRestore();
            await client`drop trigger reject_snapshot_insert on storage_daily_snapshots`;
            await client`drop function reject_snapshot_insert()`;
        }
        await runHousekeeping();
        expect(
            (await db().select().from(storageDailySnapshots))
                .map((row) => row.userId)
                .sort(),
        ).toEqual([USER, "second-user"]);
        expect(await db().select().from(asyncJobs)).toEqual([]);
    });
    it("splits the work between processes running at once", async () => {
        await closedBuckets(60);
        const limits = { batchSize: 5, maxBatches: 100, budgetMs: 60_000 };

        const runs = await Promise.all([
            runHousekeeping(limits),
            runHousekeeping(limits),
            runHousekeeping(limits),
        ]);

        expect(
            runs.reduce(
                (sum, run) => sum + (run.api_rate_limit_buckets ?? 0),
                0,
            ),
        ).toBe(60);
        expect(await db().select().from(apiRateLimitBuckets)).toEqual([]);
    });
});
