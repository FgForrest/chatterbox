import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { pruneExpiredSessions } from "@/db/queries/auth-sessions";
import {
    clearSsoSessionsMarker,
    revokeSessionsOnSsoSwitch,
} from "@/db/queries/sso";
import { instanceState, sessions, users } from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const databaseRef = vi.hoisted(() => ({
    current: null as Record<PropertyKey, unknown> | null,
}));
vi.mock("@/db", () => ({
    db: new Proxy(
        {},
        {
            get: (_target, property) => {
                const database = databaseRef.current;
                if (!database)
                    throw new Error("example database not initialized");
                const value = database[property];
                return typeof value === "function"
                    ? value.bind(database)
                    : value;
            },
        },
    ),
}));

const url = getTestDatabaseUrl();
const withDatabase = url ? describe : describe.skip;

withDatabase("direct bulk session deletion logs", () => {
    let database: TestPostgresDatabase;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(url ?? "", "session_logs");
        databaseRef.current = database.db as unknown as Record<
            PropertyKey,
            unknown
        >;
        await database.db.insert(users).values({
            id: "example-user",
            email: "example@example.com",
            name: "Acme",
        });
    }, 120_000);
    afterEach(() => vi.restoreAllMocks());
    afterAll(async () => {
        databaseRef.current = null;
        await database?.dispose();
    });

    async function insertSession(id: string, expired = false) {
        await database.db.insert(sessions).values({
            id,
            userId: "example-user",
            token: `example-secret-${id}`,
            expiresAt: new Date(Date.now() + (expired ? -3600_000 : 3600_000)),
        });
    }

    it("logs each actual cleanup batch once under racing processes", async () => {
        await insertSession("example-expired-one", true);
        await insertSession("example-expired-two", true);
        await insertSession("example-live");
        const info = vi.spyOn(console, "info");
        const counts = await Promise.all([
            pruneExpiredSessions(new Date(), 1),
            pruneExpiredSessions(new Date(), 1),
        ]);
        expect(counts).toEqual([1, 1]);
        expect(info.mock.calls).toEqual([
            ["[session] ended cause=expired-cleanup count=1"],
            ["[session] ended cause=expired-cleanup count=1"],
        ]);
        info.mockClear();
        expect(await pruneExpiredSessions(new Date(), 10)).toBe(0);
        expect(info).not.toHaveBeenCalled();
        expect(await database.db.select().from(sessions)).toHaveLength(1);
    });

    it("logs a committed SSO switch once and leaves repeated switches silent", async () => {
        await database.db.delete(instanceState);
        await insertSession("example-switch");
        const info = vi.spyOn(console, "info");
        const counts = await Promise.all([
            revokeSessionsOnSsoSwitch(),
            revokeSessionsOnSsoSwitch(),
        ]);
        expect(counts).toContain(2);
        expect(counts).toContain(null);
        expect(info.mock.calls).toEqual([
            ["[session] ended cause=sso-enabled count=2"],
        ]);
        info.mockClear();
        await clearSsoSessionsMarker();
        expect(await revokeSessionsOnSsoSwitch()).toBe(0);
        expect(info).not.toHaveBeenCalled();
    });
});
