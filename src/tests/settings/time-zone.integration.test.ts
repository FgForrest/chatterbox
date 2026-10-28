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
import type { ActorContext } from "@/lib/authz/model";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const state = vi.hoisted(() => ({
    current: null as Record<PropertyKey, unknown> | null,
    userId: "owner",
    idp: false,
    org: "org" as string | null,
    enabled: true,
    manager: false,
}));
vi.mock("@/db", () => ({
    db: new Proxy(
        {},
        {
            get(_target, key) {
                if (!state.current) throw new Error("Database not ready");
                const value = state.current[key];
                return typeof value === "function"
                    ? value.bind(state.current)
                    : value;
            },
        },
    ),
}));
vi.mock("@/lib/env", () => ({
    env: {
        AUTHZ_MODE: "local",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        IS_HOSTED: false,
    },
}));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async () => ({
        user: { id: state.userId, email: `${state.userId}@example.com` },
    }),
    requireApiSessionActor: async () => ({
        session: {
            user: { id: state.userId, email: `${state.userId}@example.com` },
        },
        actor: {
            actorId: state.userId,
            kind: "user",
            issuer: null,
            subject: null,
            clientId: null,
            clientPermissions: new Set(),
            verifiedAt: null,
            capabilities: new Set(
                state.manager ? ["use", "access.manage"] : ["use"],
            ),
        } as ActorContext,
    }),
}));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: async () => state.org,
    isOrgScopeEnabled: () => state.enabled,
}));
vi.mock("@/lib/identity/factory", () => ({
    isIdpAuthorization: () => state.idp,
}));
vi.mock("@/lib/knowledge/availability", () => ({
    isAutoLearnOffered: async () => false,
    isLearnDeploymentAvailable: () => false,
}));
vi.mock("@/lib/profiles/legacy-settings", () => ({
    readLegacySettingsFromProfiles: async () => ({}),
    writeLegacySettingsToProfiles: async () => undefined,
}));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));

import {
    GET as getOrganization,
    PUT as putOrganization,
} from "@/app/api/settings/organization/route";
import { GET as getUser, PUT as putUser } from "@/app/api/settings/user/route";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requestTimeZone, userTimeZone } from "@/lib/i18n/user-time-zone";

const url = getTestDatabaseUrl();
const suite = url ? describe : describe.skip;
function request(body?: unknown, cookie?: string) {
    return new Request("https://example.com/api/settings/user", {
        method: body === undefined ? "GET" : "PUT",
        headers: {
            "Content-Type": "application/json",
            ...(cookie ? { cookie } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}
suite("time zone settings (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            url ?? "",
            "time_zone_settings",
        );
        state.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120000);
    afterAll(async () => {
        state.current = null;
        await database?.dispose();
    });
    beforeEach(async () => {
        state.userId = "owner";
        state.idp = false;
        state.manager = false;
        state.org = "org";
        state.enabled = true;
        await db.delete(users);
        await db.insert(users).values(
            ["owner", "other", "org"].map((id) => ({
                id,
                email: `${id}@example.com`,
                role: id === "org" ? ("org" as const) : ("user" as const),
            })),
        );
    });
    it("round-trips the caller's explicit choice and automatic mode without changing others", async () => {
        expect(
            (await putUser(request({ timeZone: "Asia/Tokyo" }))).status,
        ).toBe(200);
        expect(await (await getUser(request())).json()).toMatchObject({
            timeZone: "Asia/Tokyo",
        });
        const [other] = await db
            .select()
            .from(users)
            .where(eq(users.id, "other"));
        expect(other.timeZone).toBeNull();
        expect((await putUser(request({ timeZone: null }))).status).toBe(200);
        expect(await (await getUser(request())).json()).toMatchObject({
            timeZone: null,
        });
    });
    it.each([
        "Invalid/Zone",
        "",
        42,
        "+01:00",
    ])("rejects invalid user zone %s before persisting", async (timeZone) => {
        expect((await putUser(request({ timeZone }))).status).toBe(400);
        expect(await userTimeZone("owner")).toBe("UTC");
    });
    it("uses the existing local Organization account settings boundary", async () => {
        expect(
            (await putOrganization(request({ timeZone: "Europe/Prague" })))
                .status,
        ).toBe(403);
        state.userId = "org";
        expect(
            (await putOrganization(request({ timeZone: "Europe/Prague" })))
                .status,
        ).toBe(200);
        state.userId = "owner";
        expect(await (await getOrganization(request())).json()).toEqual({
            timeZone: "Europe/Prague",
            canManage: false,
            isOrganizationAccount: false,
        });
        expect(await userTimeZone("owner")).toBe("Europe/Prague");
        state.enabled = false;
        state.userId = "org";
        expect((await putUser(request({ timeZone: "UTC" }))).status).toBe(403);
        state.userId = "owner";
        expect((await putUser(request({ timeZone: "UTC" }))).status).toBe(200);
        expect(await userTimeZone("other")).toBe("Europe/Prague");
        await putUser(request({ timeZone: null }));
        state.enabled = true;
        expect(
            await requestTimeZone(
                "owner",
                request(undefined, "viewer-time-zone=America%2FNew_York"),
            ),
        ).toBe("America/New_York");
        await db
            .update(users)
            .set({ timeZone: "UTC" })
            .where(eq(users.id, "owner"));
        expect(
            await requestTimeZone(
                "owner",
                request(undefined, "viewer-time-zone=America%2FNew_York"),
            ),
        ).toBe("UTC");
    });
    it("permits identity-provider access managers and rejects members, invalid zones and read-only Organization writes", async () => {
        state.idp = true;
        expect(
            (await putOrganization(request({ timeZone: "Asia/Tokyo" }))).status,
        ).toBe(403);
        state.manager = true;
        expect(
            (await putOrganization(request({ timeZone: "Invalid/Zone" })))
                .status,
        ).toBe(400);
        expect(
            (await putOrganization(request({ timeZone: "Asia/Tokyo" }))).status,
        ).toBe(200);
        state.enabled = false;
        expect(
            (await putOrganization(request({ timeZone: "UTC" }))).status,
        ).toBe(403);
        state.enabled = true;
        expect(
            (await putOrganization(request({ timeZone: null }))).status,
        ).toBe(200);
        expect(await userTimeZone("other")).toBe("UTC");
    });
    it("keeps the Organization default inert when the Organization scope is unavailable", async () => {
        await db
            .update(users)
            .set({ timeZone: "Asia/Tokyo" })
            .where(eq(users.id, "org"));
        state.org = null;
        expect(await userTimeZone("owner")).toBe("UTC");
    });
});
