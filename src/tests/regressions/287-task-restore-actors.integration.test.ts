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
    chatterItems,
    recordingTasks,
    taskStatusTransitions,
    users,
} from "@/db/schema";
import { encryptText } from "@/lib/encryption/fields";
import type { TaskViewer } from "@/lib/tasks/access";
import { restoreTaskArchive } from "@/lib/tasks/restore";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { ref } = vi.hoisted(() => ({
    ref: { current: null as Record<PropertyKey, unknown> | null },
}));
vi.mock("@/db", () => ({
    db: new Proxy(
        {},
        {
            get(_target, key) {
                if (!ref.current) throw new Error("Database not ready");
                const value = ref.current[key];
                return typeof value === "function"
                    ? value.bind(ref.current)
                    : value;
            },
        },
    ),
}));
vi.mock("@/lib/env", () => ({
    env: {
        IS_HOSTED: false,
        SELF_HOST_MODE: "shared",
        AUTHZ_MODE: "local",
        ORG_ACCOUNT_EMAIL: "org@example.test",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        BETTER_AUTH_SECRET: "test-status-history-secret",
        DATABASE_URL: "postgres://unused",
    },
}));
vi.mock("@/lib/org/config", () => ({
    assertOrgScopeWritable: vi.fn(),
    getOrgUserId: async () => "org",
    isOrgScopeEnabled: () => true,
}));
vi.mock("@/lib/tasks/tasks", () => ({ setTaskFollowInTx: vi.fn() }));
const url = getTestDatabaseUrl();
const viewer: TaskViewer = {
    userId: "owner",
    emailHash: "owner-hash",
    orgUserId: "org",
    isOrg: false,
    isCurator: false,
};

describe.skipIf(!url)(
    "#287 restored task actor authorization (PostgreSQL)",
    () => {
        let database: TestPostgresDatabase;
        beforeAll(async () => {
            database = await createMigratedTestDatabase(
                url as string,
                "restore_task_actors",
            );
            ref.current = database.db as unknown as Record<
                PropertyKey,
                unknown
            >;
        }, 120_000);
        afterAll(async () => {
            ref.current = null;
            await database?.dispose();
        }, 30_000);
        beforeEach(async () => {
            await database.db.delete(users);
            await database.db.insert(users).values([
                { id: "owner", email: "owner@example.test" },
                { id: "unrelated", email: "unrelated@example.test" },
                { id: "org", email: "org@example.test", role: "org" },
            ]);
            await database.db.insert(chatterItems).values({
                id: "mail",
                userId: "owner",
                kind: "mail",
                title: encryptText("Restored mail"),
                occurredAt: new Date("2026-10-01T12:00:00Z"),
            });
        });
        it.each([
            "personal",
            "manual",
        ] as const)("nulls forged actors but retains transitions and authorized owners on %s tasks", async (source) => {
            const createdAt = "2026-10-01T12:00:00.000Z";
            const transitions = [
                {
                    id: "created",
                    actorUserId: "owner",
                    fromStatus: null,
                    toStatus: "open",
                    createdAt,
                },
                {
                    id: "forged-done",
                    actorUserId: "unrelated",
                    fromStatus: "open",
                    toStatus: "done",
                    createdAt,
                },
                {
                    id: "reopened",
                    actorUserId: "owner",
                    fromStatus: "done",
                    toStatus: "open",
                    createdAt,
                },
                {
                    id: "forged-drop",
                    actorUserId: "unrelated",
                    fromStatus: "open",
                    toStatus: "dropped",
                    createdAt,
                },
                {
                    id: "missing",
                    actorUserId: "missing-account",
                    fromStatus: "dropped",
                    toStatus: "open",
                    createdAt,
                },
                {
                    id: "anonymous",
                    actorUserId: null,
                    fromStatus: "open",
                    toStatus: "done",
                    createdAt,
                },
            ];
            const task = {
                id: "restored",
                text: "Restored task",
                source,
                status: "done",
                createdAt,
                statusTransitions: transitions,
            };
            const archive =
                source === "personal"
                    ? { personal: [task] }
                    : { items: [{ itemId: "mail", tasks: [task] }] };
            expect(await restoreTaskArchive(viewer, archive)).toEqual({
                tasks: 1,
                follows: 0,
                skipped: 0,
            });
            const rows = await database.db
                .select()
                .from(taskStatusTransitions)
                .where(eq(taskStatusTransitions.taskId, task.id));
            expect(rows).toHaveLength(transitions.length);
            for (const transition of transitions) {
                expect(
                    rows.find((row) => row.id === transition.id),
                ).toMatchObject({
                    ...transition,
                    actorUserId:
                        transition.actorUserId === "owner" ? "owner" : null,
                    createdAt: new Date(createdAt),
                });
            }
            expect(
                (
                    await database.db
                        .select()
                        .from(recordingTasks)
                        .where(eq(recordingTasks.id, task.id))
                )[0].status,
            ).toBe("done");
        });
    },
);
