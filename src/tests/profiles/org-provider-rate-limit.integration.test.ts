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
import { apiCredentials, apiRateLimitBuckets, users } from "@/db/schema";
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
        ORG_PROVIDER_CALLS_PER_MEMBER_PER_HOUR: 60,
        BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
        API_TOKEN_HASH_SECRET: undefined,
    },
}));
vi.mock("@/lib/encryption", () => ({ decrypt: (value: string) => value }));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: async () => "rate-org",
    isOrgScopeEnabled: () => true,
}));
vi.mock("@/lib/identity/factory", () => ({
    isIdpAuthorization: () => false,
}));

import { resolveStepProvider } from "@/lib/profiles/providers";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

describeWithDatabase("Organization provider call cap (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;

    function db() {
        if (!database) throw new Error("test database not ready");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "org_provider_rate_limit",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        await db()
            .insert(users)
            .values([
                { id: "rate-org", email: "rate-org@example.test", role: "org" },
                { id: "rate-member-a", email: "rate-a@example.test" },
                { id: "rate-member-b", email: "rate-b@example.test" },
            ]);
    }, 120_000);

    beforeEach(async () => {
        await db().delete(apiRateLimitBuckets);
        await db()
            .delete(apiCredentials)
            .where(eq(apiCredentials.userId, "rate-org"));
        await db().insert(apiCredentials).values({
            id: "rate-org-provider",
            userId: "rate-org",
            provider: "OpenAI",
            apiKey: "encrypted-key",
            defaultModel: "gpt-4o-mini",
        });
    });

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    it("refuses only the member who passes the real hourly counter", async () => {
        const memberA = await resolveStepProvider({
            step: "summary",
            pin: {
                credentialId: "rate-org-provider",
                scope: "organization",
            },
            actorUserId: "rate-member-a",
        });
        const memberB = await resolveStepProvider({
            step: "summary",
            pin: {
                credentialId: "rate-org-provider",
                scope: "organization",
            },
            actorUserId: "rate-member-b",
        });

        for (let call = 0; call < 60; call++) {
            await memberA.reserveCall();
        }
        await expect(memberA.reserveCall()).rejects.toMatchObject({
            code: "AI_RATE_LIMITED",
            statusCode: 429,
        });
        await expect(memberB.reserveCall()).resolves.toBeUndefined();

        const buckets = await db()
            .select({ count: apiRateLimitBuckets.count })
            .from(apiRateLimitBuckets);
        expect(buckets).toHaveLength(2);
        expect(buckets.map((bucket) => bucket.count).sort()).toEqual([1, 61]);
    });
});
