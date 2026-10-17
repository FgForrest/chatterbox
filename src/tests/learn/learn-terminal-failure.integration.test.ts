import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chatterItems, learnRuns, users } from "@/db/schema";
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
        SELF_HOST_MODE: "shared",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
        DATABASE_URL: "postgres://unused",
    },
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
    captureServerException: vi.fn(),
}));

import { failLearnRunAfterTerminalJob } from "@/lib/learn/learn-job";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const OWNER = "terminal-owner";
const ORGANIZATION = "terminal-organization";
const ACTOR = "terminal-curator";
const THIRD_USER = "terminal-third-user";
const ITEM_ID = "terminal-item";

describeWithDatabase("Learn terminal failure (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "learn_terminal_failure",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    it("fails an Organization run for its actor but not another user", async () => {
        await db()
            .insert(users)
            .values([
                { id: OWNER, email: "terminal-owner@example.test" },
                {
                    id: ORGANIZATION,
                    email: "terminal-organization@example.test",
                },
                { id: ACTOR, email: "terminal-curator@example.test" },
                { id: THIRD_USER, email: "terminal-third@example.test" },
            ]);
        await db()
            .insert(chatterItems)
            .values({
                id: ITEM_ID,
                userId: OWNER,
                kind: "mail",
                title: "Organization mail",
                occurredAt: new Date("2026-10-17T00:00:00.000Z"),
            });
        const [run] = await db()
            .insert(learnRuns)
            .values({
                userId: OWNER,
                scopeUserId: ORGANIZATION,
                itemId: ITEM_ID,
                transcriptionId: null,
                view: "org",
                actorUserId: ACTOR,
                trigger: "manual",
                transcriptRevision: 1,
                vocabularyVersion: 1,
                status: "queued",
            })
            .returning({ id: learnRuns.id });
        const runId = run?.id ?? "";

        await expect(
            failLearnRunAfterTerminalJob(runId, THIRD_USER, "PROVIDER_FAILED"),
        ).resolves.toBeNull();
        const [untouched] = await db()
            .select({ status: learnRuns.status })
            .from(learnRuns)
            .where(and(eq(learnRuns.id, runId), eq(learnRuns.userId, OWNER)));
        expect(untouched?.status).toBe("queued");

        await expect(
            failLearnRunAfterTerminalJob(runId, ACTOR, "PROVIDER_FAILED"),
        ).resolves.toBe(ITEM_ID);
        const [failed] = await db()
            .select({
                status: learnRuns.status,
                errorCode: learnRuns.errorCode,
            })
            .from(learnRuns)
            .where(and(eq(learnRuns.id, runId), eq(learnRuns.userId, OWNER)));
        expect(failed).toEqual({
            status: "failed",
            errorCode: "PROVIDER_FAILED",
        });
    });
});
