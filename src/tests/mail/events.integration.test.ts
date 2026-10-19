import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mailDeliveryLog, mailMessages, users } from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const refs = vi.hoisted(() => ({
    db: null as TestPostgresDatabase["db"] | null,
    sql: null as TestPostgresDatabase["sql"] | null,
    ready: null as Promise<unknown> | null,
    arrival: vi.fn().mockResolvedValue(null),
    enabled: true,
}));
vi.mock("@/db", () => ({
    db: new Proxy(
        {},
        {
            get: (_target, key: keyof TestPostgresDatabase["db"]) => {
                if (!refs.db) throw new Error("missing database");
                const value = refs.db[key];
                return typeof value === "function"
                    ? value.bind(refs.db)
                    : value;
            },
        },
    ),
    sqlClient: {
        listen: (
            ...args: Parameters<TestPostgresDatabase["sql"]["listen"]>
        ) => {
            if (!refs.sql) throw new Error("missing database");
            refs.ready = refs.sql.listen(...args);
            return refs.ready;
        },
    },
}));
vi.mock("@/lib/env", () => ({
    env: {
        ENCRYPTION_KEY: "0123456789abcdef".repeat(4),
        BETTER_AUTH_SECRET: "mail-events-lookup-secret".repeat(2),
        MAIL_ADDRESS_HASH_SECRET: "mail-events-test-secret".repeat(2),
    },
}));
vi.mock("@/lib/mail/config", () => ({ isMailEnabled: () => refs.enabled }));
vi.mock("@/lib/mail/addresses", () => ({ touchAddress: vi.fn() }));
vi.mock("@/lib/mail/raw-storage", () => ({
    storeRawMail: vi
        .fn()
        .mockImplementation(
            async (_userId: string, itemId: string) => `mail/${itemId}`,
        ),
    deleteRawMail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/pipeline/arrival", () => ({
    requestArrivalInTx: refs.arrival,
    resolveArrivalProfile: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/pipeline/trigger", () => ({
    requestAdvanceInTx: vi.fn().mockResolvedValue(null),
}));

import { subscribePersonalEvents } from "@/lib/events/personal";
import { parseMessage } from "@/lib/mail/parse";
import { storeMailForOwner } from "@/lib/mail/store";

const url = getTestDatabaseUrl();
const withDatabase = url ? describe : describe.skip;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

withDatabase("mail acceptance events (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    const receivedA = vi.fn();
    const receivedB = vi.fn();
    const stops: (() => void)[] = [];

    beforeAll(async () => {
        database = await createMigratedTestDatabase(url ?? "", "mail_events");
        refs.db = database.db;
        refs.sql = database.sql;
        await database.db.insert(users).values([
            { id: "a", email: "a@example.test" },
            { id: "b", email: "b@example.test" },
        ]);
        stops.push(
            subscribePersonalEvents("a", receivedA),
            subscribePersonalEvents("b", receivedB),
        );
        await refs.ready;
    }, 120_000);
    afterAll(async () => {
        for (const stop of stops) stop();
        await database?.dispose();
    }, 30_000);

    async function accept(userId: string, subject: string) {
        const raw = Buffer.from(
            `From: sender@example.test\r\nTo: ${userId}@example.test\r\nSubject: ${subject}\r\n\r\nBody`,
        );
        const receivedAt = new Date();
        return storeMailForOwner({
            delivery: {
                ownerUserId: userId,
                senderVerified: true,
                folderIds: [],
                pendingShareFolderIds: [],
                addresses: [],
                recipients: [],
            },
            raw,
            parsed: await parseMessage(raw),
            facts: {
                fromHeaders: 1,
                fromAddresses: ["sender@example.test"],
                dkim: [],
                receivedAt,
            },
            spf: null,
            receivedAt,
        });
    }

    it("delivers a committed acceptance over LISTEN/NOTIFY only to its owner", async () => {
        const stored = await accept("a", "first");
        expect(stored.duplicate).toBe(false);
        await vi.waitFor(() => expect(receivedA).toHaveBeenCalledTimes(1));
        await pause(100);
        expect(receivedB).not.toHaveBeenCalled();
        const rows = await database.db
            .select()
            .from(mailDeliveryLog)
            .where(
                and(
                    eq(mailDeliveryLog.userId, "a"),
                    eq(mailDeliveryLog.itemId, stored.itemId),
                ),
            );
        expect(rows).toHaveLength(1);
        expect(rows[0]?.outcome).toBe("accepted");
        await accept("b", "second");
        await vi.waitFor(() => expect(receivedB).toHaveBeenCalledTimes(1));
        expect(receivedA).toHaveBeenCalledTimes(1);
    });

    it("does not notify when a transaction rolls back after writing its accepted log", async () => {
        refs.arrival.mockRejectedValueOnce(new Error("roll back accept"));
        await expect(accept("a", "rolled back")).rejects.toThrow(
            "roll back accept",
        );
        await pause(200);
        expect(receivedA).toHaveBeenCalledTimes(1);
        expect(receivedB).toHaveBeenCalledTimes(1);
        const logs = await database.db
            .select()
            .from(mailDeliveryLog)
            .where(eq(mailDeliveryLog.userId, "a"));
        const messages = await database.db
            .select()
            .from(mailMessages)
            .where(eq(mailMessages.userId, "a"));
        expect(logs).toHaveLength(1);
        expect(messages).toHaveLength(1);
    });

    it("also notifies after committed duplicate placement", async () => {
        const stored = await accept("a", "first");
        expect(stored.duplicate).toBe(true);
        await vi.waitFor(() => expect(receivedA).toHaveBeenCalledTimes(2));
        expect(receivedB).toHaveBeenCalledTimes(1);
    });
});
