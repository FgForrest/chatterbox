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
    agendaSuggestions,
    chatterItems,
    meetingAgendas,
    users,
} from "@/db/schema";
import { encryptText } from "@/lib/encryption/fields";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const holder = vi.hoisted(() => ({
    database: null as Record<PropertyKey, unknown> | null,
    caller: "owner",
}));
vi.mock("@/db", () => ({
    db: new Proxy(
        {},
        {
            get(_target, key) {
                const value = holder.database?.[key];
                return typeof value === "function"
                    ? value.bind(holder.database)
                    : value;
            },
        },
    ),
}));
vi.mock("@/lib/env", () => ({
    env: {
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        AUTHZ_MODE: "local",
        IS_HOSTED: false,
    },
}));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: async () => null,
    isOrgScopeVisible: () => true,
    assertOrgScopeWritable: () => {},
}));
vi.mock("@/lib/authz/curator", () => ({
    userCuratesOrganizationNow: async () => false,
}));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async () => ({ user: { id: holder.caller } }),
}));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));

import { PATCH } from "@/app/api/meetings/[id]/suggestions/route";

const url = getTestDatabaseUrl();
describe.skipIf(!url)("bulk suggestion dismissal (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            url ?? "",
            "bulk_suggestions",
        );
        holder.database = database.db as unknown as Record<
            PropertyKey,
            unknown
        >;
    }, 120000);
    afterAll(async () => {
        holder.database = null;
        await database?.dispose();
    }, 60000);
    beforeEach(async () => {
        holder.caller = "owner";
        await database.db.delete(users);
        await database.db.insert(users).values(
            ["owner", "stranger"].map((id) => ({
                id,
                email: `${id}@example.com`,
            })),
        );
        await database.db.insert(chatterItems).values(
            ["first", "second"].map((id) => ({
                id,
                userId: "owner",
                kind: "meeting" as const,
                title: encryptText("Acme"),
                occurredAt: new Date(),
            })),
        );
        await database.db.insert(meetingAgendas).values(
            ["first", "second"].map((id) => ({
                id,
                userId: "owner",
                meetingItemId: id,
            })),
        );
        await database.db.insert(agendaSuggestions).values(
            [
                {
                    id: "open-one",
                    agendaId: "first",
                    kind: "ai" as const,
                    state: "open" as const,
                },
                {
                    id: "open-two",
                    agendaId: "first",
                    kind: "ai" as const,
                    state: "open" as const,
                },
                {
                    id: "accepted",
                    agendaId: "first",
                    kind: "ai" as const,
                    state: "added" as const,
                },
                {
                    id: "carry",
                    agendaId: "first",
                    kind: "carry_over" as const,
                    state: "open" as const,
                },
                {
                    id: "other-agenda",
                    agendaId: "second",
                    kind: "ai" as const,
                    state: "open" as const,
                },
            ].map((row) => ({
                ...row,
                userId: "owner",
                text: encryptText("Suggestion"),
                sources: { itemIds: [], taskIds: [] },
            })),
        );
    });
    const dismiss = (body: unknown = { kind: "ai", state: "dismissed" }) =>
        PATCH(
            new Request("https://example.com/api/meetings/first/suggestions", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            }),
            { params: Promise.resolve({ id: "first" }) },
        );
    async function states() {
        return Object.fromEntries(
            (await database.db.select().from(agendaSuggestions)).map((row) => [
                row.id,
                row.state,
            ]),
        );
    }
    it("dismisses only open suggestions of the requested kind and agenda, with one version bump", async () => {
        expect((await dismiss()).status).toBe(200);
        expect(await states()).toEqual({
            "open-one": "dismissed",
            "open-two": "dismissed",
            accepted: "added",
            carry: "open",
            "other-agenda": "open",
        });
        const [agenda] = await database.db
            .select()
            .from(meetingAgendas)
            .where(eq(meetingAgendas.id, "first"));
        expect(agenda.version).toBe(1);
        expect((await dismiss()).status).toBe(200);
        const [again] = await database.db
            .select()
            .from(meetingAgendas)
            .where(eq(meetingAgendas.id, "first"));
        expect(again.version).toBe(1);
    });
    it("rejects callers without meeting access without changing suggestions", async () => {
        holder.caller = "stranger";
        expect((await dismiss()).status).toBe(404);
        expect((await states())["open-one"]).toBe("open");
    });
    it("rejects unsupported actions without changing suggestions", async () => {
        expect((await dismiss({ kind: "ai", state: "added" })).status).toBe(
            400,
        );
        expect((await states())["open-one"]).toBe("open");
    });
    it("keeps absorbed agendas read-only", async () => {
        await database.db.insert(chatterItems).values({
            id: "recording",
            userId: "owner",
            kind: "audio",
            title: encryptText("Recording"),
            occurredAt: new Date(),
        });
        await database.db
            .update(meetingAgendas)
            .set({ recordingItemId: "recording", absorbedAt: new Date() })
            .where(eq(meetingAgendas.id, "first"));
        expect((await dismiss()).status).toBe(409);
        expect((await states())["open-one"]).toBe("open");
    });
});
