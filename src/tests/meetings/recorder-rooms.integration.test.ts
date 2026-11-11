import { and, eq } from "drizzle-orm";
import type * as NextServer from "next/server";
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
    apiKeys,
    chatterItems,
    itemShares,
    meetingAgendas,
    recorderRoomPresence,
    recordingFolders,
    recordingSessions,
    users,
} from "@/db/schema";
import { encryptText } from "@/lib/encryption/fields";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const state = vi.hoisted(() => ({
    db: null as Record<PropertyKey, unknown> | null,
    userId: "owner",
    sharing: true,
}));
vi.mock("@/db", () => ({
    db: new Proxy(
        {},
        {
            get(_target, key) {
                const value = state.db?.[key];
                return typeof value === "function"
                    ? value.bind(state.db)
                    : value;
            },
        },
    ),
}));
vi.mock("@/lib/env", () => ({
    env: {
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        BETTER_AUTH_SECRET: "recorder-room-tests",
        AUTHZ_MODE: "local",
        IS_HOSTED: false,
    },
}));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: async () => null,
    isOrgScopeVisible: () => state.sharing,
    isOrgScopeEnabled: () => state.sharing,
    assertOrgScopeWritable: () => {},
    assertNotOrgAccount: async () => {},
    isOrgAccount: async () => false,
}));
vi.mock("@/lib/authz/curator", () => ({
    userCuratesOrganizationNow: async () => false,
    actsForOrganization: async () => false,
}));
vi.mock("@/lib/integrations/google/connection", () => ({
    getGoogleConnectionStatus: async () => null,
}));
vi.mock("@/lib/recording-sessions/route-gate", () => ({
    gateRecordingSessionRequest: async () =>
        state.userId
            ? {
                  authn: {
                      user: { id: state.userId },
                      apiKeyId: `key-${state.userId}`,
                  },
              }
            : { response: new Response(null, { status: 401 }) },
}));
vi.mock("@/lib/notifications/person-share", () => ({
    sendPersonShareInvitation: async () => {},
}));
vi.mock("@/lib/events/personal", () => ({
    notifyPersonShareChanged: async () => {},
}));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));
vi.mock("next/server", async (importOriginal) => ({
    ...(await importOriginal<typeof NextServer>()),
    after: () => {},
}));

import {
    POST as invite,
    GET as people,
} from "@/app/api/v1/recorder/agendas/[id]/people/route";
import { POST as respond } from "@/app/api/v1/recorder/agendas/invitations/[shareId]/route";
import { GET as match } from "@/app/api/v1/recorder/agendas/match/route";
import {
    DELETE as leave,
    POST as presence,
} from "@/app/api/v1/recorder/agendas/presence/route";
import { POST as createSession } from "@/app/api/v1/recording-sessions/route";
import { db } from "@/db";
import {
    pruneRecorderRoomPresence,
    queryRecorderRoom,
    refreshRecorderPresence,
    removeRecorderPresence,
} from "@/db/queries/recorder-rooms";
import { encryptCalendarSnapshot } from "@/lib/meetings/calendar-snapshot";
import { recorderRoomKey } from "@/lib/meetings/room-key";
import { setRecordingSessionAgenda } from "@/lib/recording-sessions/store";

const code = "abc-defg-hij";
const key = recorderRoomKey(code) as string;
const databaseUrl = getTestDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const request = (path: string, body?: unknown) =>
    new Request(
        `https://example.com/api/v1/recorder/agendas/${path}`,
        body === undefined
            ? {}
            : {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(body),
              },
    );
const context = (id = "agenda") => ({ params: Promise.resolve({ id }) });

suite("recorder room boundaries (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            databaseUrl ?? "",
            "recorder_rooms",
        );
        state.db = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120000);
    afterAll(async () => {
        state.db = null;
        await database?.dispose();
    }, 60000);
    beforeEach(async () => {
        state.userId = "owner";
        state.sharing = true;
        await db.delete(users);
        for (const [id, name] of [
            ["owner", "Jitka Dvořáková"],
            ["reader", "Alex Rowan"],
            ["receiver", "Robin Vale"],
            ["outsider", "Casey Linden"],
        ]) {
            await db
                .insert(users)
                .values({ id, email: `${id}@example.com`, name });
            await db.insert(apiKeys).values({
                id: `key-${id}`,
                userId: id,
                name: "Recorder",
                keyHash: `hash-${id}`,
                keyPrefix: "test",
                scopes: ["recordings:write"],
            });
            await db.insert(recordingFolders).values({
                id: `folder-${id}`,
                userId: id,
                name: encryptText("Meetings"),
                nameHash: "meetings",
                kind: "custom",
            });
        }
        await db.insert(chatterItems).values({
            id: "meeting",
            userId: "owner",
            kind: "meeting",
            title: encryptText("Acme planning"),
            occurredAt: new Date(),
        });
        await db.insert(meetingAgendas).values({
            id: "agenda",
            userId: "owner",
            meetingItemId: "meeting",
        });
        await db.insert(itemShares).values({
            id: "reader-share",
            userId: "owner",
            receiverUserId: "reader",
            itemId: "meeting",
            state: "accepted",
            filingFolderId: "folder-reader",
        });
    });
    async function panel(
        userId: string,
        agendaId: string | null = null,
        roomCode = code,
    ) {
        state.userId = userId;
        return presence(
            request("presence", { meetCode: roomCode, agendaId }),
            context(),
        );
    }
    async function matching(userId: string, roomCode = code) {
        state.userId = userId;
        const response = await match(
            request(`match?meetCode=${roomCode}`),
            context(),
        );
        expect(response.status).toBe(200);
        return response.json();
    }
    async function live(
        agendaId: string | null = "agenda",
        roomCode: unknown = code,
    ) {
        state.userId = "owner";
        const response = await createSession(
            new Request("https://example.com/api/v1/recording-sessions", {
                method: "POST",
                body: JSON.stringify({
                    clientRecordingId: crypto.randomUUID(),
                    mimeType: "audio/webm",
                    channelLayout: ["system"],
                    startedAt: new Date().toISOString(),
                    agendaId,
                    meetCode: roomCode,
                }),
            }),
        );
        expect(response.status).toBe(201);
        return response.json();
    }
    async function ownerPeople(userId = "owner") {
        state.userId = userId;
        return people(request("agenda/people"), context());
    }
    async function linkCalendar() {
        const start = new Date(Date.now() - 60000),
            end = new Date(Date.now() + 3600000);
        await db.update(meetingAgendas).set({
            calendarEventId: "event",
            plannedStart: start,
            plannedEnd: end,
            timeSet: true,
            calendarRefreshedAt: new Date(),
            calendarSnapshot: encryptCalendarSnapshot({
                id: "event",
                title: "Acme planning",
                start: start.toISOString(),
                end: end.toISOString(),
                attendees: [],
                meetingCode: code,
            }),
        });
    }
    async function invitation() {
        await linkCalendar();
        await live();
        await panel("owner", "agenda");
        await panel("receiver");
        state.userId = "owner";
        const response = await invite(
            request("agenda/people", { receiverIds: ["receiver"] }),
            context(),
        );
        expect(response.status).toBe(200);
        const body = await matching("receiver");
        return body.invitations[0];
    }
    it("stores only a stable keyed room hash with a session and restores it through metadata", async () => {
        await live("agenda", "ABC-DEFG-HIJ");
        const [row] = await db.select().from(recordingSessions);
        expect(row.metadata.roomKey).toBe(key);
        expect(key).toMatch(/^[a-f0-9]{64}$/);
        expect(JSON.stringify(row.metadata)).not.toContain(code);
        expect(JSON.stringify(row.metadata)).not.toContain("meetCode");
    });
    it.each([
        "bad",
        "abc-defg-hij?x=1",
        "https://meet.google.com/abc-defg-hij",
        7,
        null,
    ])("ignores invalid optional session room input %s", async (value) => {
        await live(null, value);
        const [row] = await db.select().from(recordingSessions);
        expect(row.metadata).not.toHaveProperty("roomKey");
    });
    it("matches a visible untimed live agenda and reveals recorder names only to viewers", async () => {
        await live();
        const body = await matching("reader");
        expect(body.data).toHaveLength(1);
        expect(body.data[0]).toMatchObject({
            id: "agenda",
            roomBound: true,
            chosenBy: [{ name: "Jitka Dvořáková", self: false }],
        });
        expect(body.restricted).toBe(false);
        expect(await matching("outsider")).toEqual({
            data: [],
            restricted: true,
            invitations: [],
        });
        expect(await matching("outsider", "xyz-abcd-efg")).toEqual({
            data: [],
            restricted: false,
            invitations: [],
        });
    });
    it.each([
        "open",
        "completing",
        "completed",
        "failed",
        "aborted",
    ] as const)("binds only open/completing sessions (%s)", async (status) => {
        await live();
        await db.update(recordingSessions).set({ status });
        expect((await matching("reader")).data.length).toBe(
            ["open", "completing"].includes(status) ? 1 : 0,
        );
    });
    it("expires old and future live sessions", async () => {
        await live();
        for (const hours of [-13, 1]) {
            await db
                .update(recordingSessions)
                .set({ startedAt: new Date(Date.now() + hours * 3600000) });
            expect((await matching("reader")).data).toEqual([]);
        }
    });
    it("binds a panel selection and ignores it after three minutes", async () => {
        expect((await panel("owner", "agenda")).status).toBe(200);
        expect((await matching("reader")).data[0].id).toBe("agenda");
        expect((await matching("outsider")).restricted).toBe(true);
        await db.update(recorderRoomPresence).set({
            seenAt: new Date(Date.now() - 181000),
            writtenAt: new Date(Date.now() - 181000),
        });
        expect(await matching("outsider")).toEqual({
            data: [],
            restricted: false,
            invitations: [],
        });
        expect(await pruneRecorderRoomPresence(10)).toBe(1);
    });
    it("preserves Calendar matching alongside room matches", async () => {
        await linkCalendar();
        expect((await matching("reader")).data[0].id).toBe("agenda");
        await panel("receiver");
        expect((await ownerPeople()).status).toBe(200);
        expect((await (await ownerPeople()).json()).data).toEqual([
            { id: "receiver", name: "Robin Vale", pending: false },
        ]);
    });
    it("serializes per-user writes across rooms and accepts updates after twenty seconds", async () => {
        const at = new Date();
        const writes = await Promise.all([
            refreshRecorderPresence("owner", key, "agenda", at),
            refreshRecorderPresence(
                "owner",
                recorderRoomKey("xyz-abcd-efg") as string,
                null,
                at,
            ),
        ]);
        expect(writes.map((row) => row.retryAfterMs).sort()).toEqual([
            0, 20000,
        ]);
        expect(await db.select().from(recorderRoomPresence)).toHaveLength(1);
        expect(
            await refreshRecorderPresence(
                "owner",
                key,
                null,
                new Date(at.getTime() + 20001),
            ),
        ).toEqual({ retryAfterMs: 0 });
    });
    it("refuses another user's inaccessible agenda choice and keeps leave caller-scoped", async () => {
        await panel("owner", "agenda");
        expect((await panel("outsider", "agenda")).status).toBe(404);
        state.userId = "outsider";
        await leave(request("presence", { meetCode: code }), context());
        expect(await db.select().from(recorderRoomPresence)).toHaveLength(1);
        state.userId = "owner";
        await leave(request("presence", { meetCode: code }), context());
        expect((await db.select().from(recorderRoomPresence))[0]).toMatchObject(
            { seenAt: new Date(0), agendaId: null },
        );
        expect((await matching("reader")).data).toEqual([]);
    });
    it("lists only valid present people without access, including pending state", async () => {
        await linkCalendar();
        await live();
        await panel("owner", "agenda");
        await panel("reader");
        await panel("receiver");
        await panel("outsider", null, "xyz-abcd-efg");
        expect((await (await ownerPeople()).json()).data).toEqual([
            { id: "receiver", name: "Robin Vale", pending: false },
        ]);
        await db.insert(itemShares).values({
            id: "pending",
            userId: "owner",
            receiverUserId: "receiver",
            itemId: "meeting",
        });
        expect((await (await ownerPeople()).json()).data[0].pending).toBe(true);
        await db
            .update(users)
            .set({ suspendedAt: new Date() })
            .where(eq(users.id, "receiver"));
        expect((await (await ownerPeople()).json()).data).toEqual([]);
    });
    it("refuses a co-editor's people list and invites, and refuses absent recipients", async () => {
        expect((await ownerPeople("reader")).status).toBe(404);
        expect(
            (
                await invite(
                    request("agenda/people", { receiverIds: ["receiver"] }),
                    context(),
                )
            ).status,
        ).toBe(404);
        state.userId = "owner";
        expect(
            (
                await invite(
                    request("agenda/people", { receiverIds: ["receiver"] }),
                    context(),
                )
            ).status,
        ).toBe(404);
        expect(
            await db
                .select()
                .from(itemShares)
                .where(eq(itemShares.receiverUserId, "receiver")),
        ).toEqual([]);
    });
    it("invites, accepts into the receiver's chosen private folder and publishes agenda events", async () => {
        const shared = await invitation();
        expect(shared).toMatchObject({
            agendaId: "agenda",
            title: "Acme planning",
            sharerName: "Jitka Dvořáková",
        });
        state.userId = "receiver";
        expect(
            (
                await respond(
                    request("invitation", {
                        action: "accept",
                        version: shared.version,
                        folderId: "folder-owner",
                    }),
                    { params: Promise.resolve({ shareId: shared.id }) },
                )
            ).status,
        ).toBe(404);
        const before = (await db.select().from(meetingAgendas))[0].version;
        const messages: string[] = [];
        const listener = await database.sql.listen(
            "riffado_agenda",
            (payload) => {
                messages.push(payload);
            },
        );
        try {
            expect(
                (
                    await respond(
                        request("invitation", {
                            action: "accept",
                            version: shared.version,
                            folderId: "folder-receiver",
                        }),
                        { params: Promise.resolve({ shareId: shared.id }) },
                    )
                ).status,
            ).toBe(200);
            await vi.waitFor(() =>
                expect(
                    messages.some(
                        (message) => JSON.parse(message).agendaId === "agenda",
                    ),
                ).toBe(true),
            );
        } finally {
            await listener.unlisten();
        }
        const [stored] = await db
            .select()
            .from(itemShares)
            .where(eq(itemShares.id, shared.id));
        expect(stored).toMatchObject({
            state: "accepted",
            filingFolderId: "folder-receiver",
        });
        expect(
            (await db.select().from(meetingAgendas))[0].version,
        ).toBeGreaterThan(before);
        expect((await matching("receiver")).data[0].id).toBe("agenda");
        expect((await (await ownerPeople()).json()).data).toEqual([]);
    });
    it("never substitutes an owner's email when a pending invitation has no display name", async () => {
        await invitation();
        await db.update(users).set({ name: null }).where(eq(users.id, "owner"));
        const body = await matching("receiver");
        expect(body.invitations[0].sharerName).toBeNull();
        expect(JSON.stringify(body)).not.toContain("owner@example.com");
    });

    it("declines without granting access and refuses a foreign invitation response", async () => {
        const shared = await invitation();
        state.userId = "outsider";
        expect(
            (
                await respond(
                    request("invitation", {
                        action: "decline",
                        version: shared.version,
                    }),
                    { params: Promise.resolve({ shareId: shared.id }) },
                )
            ).status,
        ).toBe(404);
        state.userId = "receiver";
        expect(
            (
                await respond(
                    request("invitation", {
                        action: "decline",
                        version: shared.version,
                    }),
                    { params: Promise.resolve({ shareId: shared.id }) },
                )
            ).status,
        ).toBe(200);
        expect(await matching("receiver")).toEqual({
            data: [],
            restricted: true,
            invitations: [],
        });
        expect(
            (
                await db
                    .select()
                    .from(itemShares)
                    .where(
                        and(
                            eq(itemShares.id, shared.id),
                            eq(itemShares.receiverUserId, "receiver"),
                        ),
                    )
            )[0].state,
        ).toBe("declined");
    });
    it("keeps person sharing disabled outside the self-host Organization mode", async () => {
        await panel("owner", "agenda");
        state.sharing = false;
        expect((await ownerPeople()).status).toBe(404);
        expect((await matching("receiver")).invitations).toEqual([]);
    });
    it.each([
        "match",
        "presence",
        "leave",
        "people",
        "invite",
        "respond",
    ])("authenticates the %s endpoint before data access", async (endpoint) => {
        state.userId = "";
        const response =
            endpoint === "match"
                ? await match(request("match"), context())
                : endpoint === "presence"
                  ? await presence(
                        request("presence", { meetCode: code }),
                        context(),
                    )
                  : endpoint === "leave"
                    ? await leave(
                          request("presence", { meetCode: code }),
                          context(),
                      )
                    : endpoint === "people"
                      ? await ownerPeople("")
                      : endpoint === "invite"
                        ? await invite(
                              request("agenda/people", {
                                  receiverIds: ["receiver"],
                              }),
                              context(),
                          )
                        : await respond(
                              request("invitation", {
                                  action: "accept",
                                  version: 0,
                              }),
                              {
                                  params: Promise.resolve({
                                      shareId: "missing",
                                  }),
                              },
                          );
        expect(response.status).toBe(401);
    });
    it("#403 refuses dummy-agenda probing through self-declared presence or another user's session", async () => {
        await live();
        await panel("owner", "agenda");
        await db.insert(chatterItems).values({
            id: "dummy-item",
            userId: "outsider",
            kind: "meeting",
            title: encryptText("Unrelated plan"),
            occurredAt: new Date(),
        });
        await db.insert(meetingAgendas).values({
            id: "dummy",
            userId: "outsider",
            meetingItemId: "dummy-item",
        });
        expect((await panel("outsider", "dummy")).status).toBe(200);
        expect(await matching("outsider")).toMatchObject({ restricted: true });
        state.userId = "outsider";
        expect(
            await (
                await people(request("dummy/people"), context("dummy"))
            ).json(),
        ).toEqual({ data: [] });
        expect(
            (
                await invite(
                    request("dummy/people", { receiverIds: ["owner"] }),
                    context("dummy"),
                )
            ).status,
        ).toBe(404);
        await db
            .update(recordingSessions)
            .set({ metadata: { roomKey: key, liveAgendaId: "dummy" } });
        expect(
            await (
                await people(request("dummy/people"), context("dummy"))
            ).json(),
        ).toEqual({ data: [] });
        expect(
            await db
                .select()
                .from(itemShares)
                .where(eq(itemShares.userId, "outsider")),
        ).toEqual([]);
    });
    it("#403 refuses dummy-agenda people and invitations after an empty caller-created recording session", async () => {
        await live();
        await panel("owner", "agenda");
        await db.insert(chatterItems).values({
            id: "probe-item",
            userId: "outsider",
            kind: "meeting",
            title: encryptText("Unrelated probe"),
            occurredAt: new Date(),
        });
        await db.insert(meetingAgendas).values({
            id: "probe-agenda",
            userId: "outsider",
            meetingItemId: "probe-item",
        });
        await panel("outsider", "probe-agenda");
        state.userId = "outsider";
        expect(
            await (
                await people(
                    request("probe-agenda/people"),
                    context("probe-agenda"),
                )
            ).json(),
        ).toEqual({ data: [] });
        const created = await createSession(
            new Request("https://example.com/api/v1/recording-sessions", {
                method: "POST",
                body: JSON.stringify({
                    clientRecordingId: crypto.randomUUID(),
                    mimeType: "audio/webm",
                    channelLayout: ["system"],
                    startedAt: new Date().toISOString(),
                    agendaId: "probe-agenda",
                    meetCode: code,
                }),
            }),
        );
        expect(created.status).toBe(201);
        expect(
            await (
                await people(
                    request("probe-agenda/people"),
                    context("probe-agenda"),
                )
            ).json(),
        ).toEqual({ data: [] });
        expect(
            (
                await invite(
                    request("probe-agenda/people", { receiverIds: ["owner"] }),
                    context("probe-agenda"),
                )
            ).status,
        ).toBe(404);
        expect(
            await db
                .select()
                .from(itemShares)
                .where(eq(itemShares.userId, "outsider")),
        ).toEqual([]);
    });
    it("#403 uses only the agenda's Calendar room for people and invitations despite other session and presence rooms", async () => {
        await linkCalendar();
        await live("agenda", "xyz-abcd-efg");
        await panel("owner", "agenda", "xyz-abcd-efg");
        await panel("receiver");
        await panel("outsider", null, "xyz-abcd-efg");
        expect((await (await ownerPeople()).json()).data).toEqual([
            { id: "receiver", name: "Robin Vale", pending: false },
        ]);
        expect(
            (
                await invite(
                    request("agenda/people", { receiverIds: ["outsider"] }),
                    context(),
                )
            ).status,
        ).toBe(404);
        expect(
            (
                await invite(
                    request("agenda/people", { receiverIds: ["receiver"] }),
                    context(),
                )
            ).status,
        ).toBe(200);
        await db.update(meetingAgendas).set({ calendarEventId: null });
        expect((await (await ownerPeople()).json()).data).toEqual([]);
    });
    it("#403 refuses people discovery from a Calendar event without a Meet room even during recording", async () => {
        await linkCalendar();
        await db.update(meetingAgendas).set({
            calendarSnapshot: encryptCalendarSnapshot({
                id: "event",
                title: "Acme planning",
                start: new Date().toISOString(),
                end: new Date(Date.now() + 3600000).toISOString(),
                attendees: [],
            }),
        });
        await live();
        await panel("receiver");
        expect((await (await ownerPeople()).json()).data).toEqual([]);
        expect(
            (
                await invite(
                    request("agenda/people", { receiverIds: ["receiver"] }),
                    context(),
                )
            ).status,
        ).toBe(404);
    });
    it("#403 preserves the write cap through POST/DELETE/POST and pruning, with immediate leave", async () => {
        const at = new Date();
        expect(
            await refreshRecorderPresence("owner", key, "agenda", at),
        ).toEqual({ retryAfterMs: 0 });
        await removeRecorderPresence("owner", key);
        expect((await matching("reader")).data).toEqual([]);
        expect(await pruneRecorderRoomPresence(10, at)).toBe(0);
        expect(
            await refreshRecorderPresence(
                "owner",
                key,
                "agenda",
                new Date(at.getTime() + 1),
            ),
        ).toEqual({ retryAfterMs: 19999 });
        expect((await matching("reader")).data).toEqual([]);
        expect(
            await refreshRecorderPresence(
                "owner",
                key,
                "agenda",
                new Date(at.getTime() + 20001),
            ),
        ).toEqual({ retryAfterMs: 0 });
    });
    it("#403 serializes a concurrent leave and throttled refresh without reviving the binding", async () => {
        const at = new Date();
        await refreshRecorderPresence("owner", key, "agenda", at);
        const [, refreshed] = await Promise.all([
            removeRecorderPresence("owner", key),
            refreshRecorderPresence(
                "owner",
                key,
                "agenda",
                new Date(at.getTime() + 1),
            ),
        ]);
        expect(refreshed).toEqual({ retryAfterMs: 19999 });
        expect((await matching("reader")).data).toEqual([]);
        expect((await db.select().from(recorderRoomPresence))[0]).toMatchObject(
            { seenAt: new Date(0), writtenAt: at },
        );
    });
    it("#403 keeps a follower unbound when the recorder switches A to B across presence expiry", async () => {
        await live();
        await db.insert(chatterItems).values({
            id: "meeting-b",
            userId: "owner",
            kind: "meeting",
            title: encryptText("Next plan"),
            occurredAt: new Date(),
        });
        await db.insert(meetingAgendas).values({
            id: "agenda-b",
            userId: "owner",
            meetingItemId: "meeting-b",
        });
        await db.insert(itemShares).values({
            userId: "owner",
            receiverUserId: "reader",
            itemId: "meeting-b",
            state: "accepted",
            filingFolderId: "folder-reader",
        });
        const at = new Date();
        const viewer = { userId: "reader", orgUserId: null, curator: false };
        await refreshRecorderPresence("reader", key, null, at);
        expect((await queryRecorderRoom(viewer, key, at)).ids).toEqual([
            "agenda",
        ]);
        await db
            .update(recordingSessions)
            .set({ metadata: { roomKey: key, liveAgendaId: "agenda-b" } });
        for (const minutes of [1, 4, 8]) {
            const later = new Date(at.getTime() + minutes * 60000);
            await refreshRecorderPresence("reader", key, null, later);
            expect((await queryRecorderRoom(viewer, key, later)).ids).toEqual([
                "agenda-b",
            ]);
        }
        await db.update(recordingSessions).set({ metadata: { roomKey: key } });
        expect(
            (
                await queryRecorderRoom(
                    viewer,
                    key,
                    new Date(at.getTime() + 9 * 60000),
                )
            ).ids,
        ).toEqual([]);
    });
    it("#403 returns A+B during a throttled heartbeat after a recording switch, then B alone", async () => {
        const captured = await live();
        await db.insert(chatterItems).values({
            id: "switch-item",
            userId: "owner",
            kind: "meeting",
            title: encryptText("Next planning"),
            occurredAt: new Date(),
        });
        await db.insert(meetingAgendas).values({
            id: "switch-agenda",
            userId: "owner",
            meetingItemId: "switch-item",
        });
        const at = new Date();
        await refreshRecorderPresence("owner", key, "agenda", at);
        await setRecordingSessionAgenda({
            userId: "owner",
            apiKeyId: "key-owner",
            sessionId: captured.id,
            agendaId: "switch-agenda",
        });
        await db.insert(itemShares).values({
            userId: "owner",
            receiverUserId: "reader",
            itemId: "switch-item",
            state: "accepted",
            filingFolderId: "folder-reader",
        });
        const viewer = { userId: "reader", orgUserId: null, curator: false };
        const duringThrottle = new Date(at.getTime() + 15000);
        expect(
            await refreshRecorderPresence(
                "owner",
                key,
                "switch-agenda",
                duringThrottle,
            ),
        ).toEqual({ retryAfterMs: 5000 });
        expect(
            (await queryRecorderRoom(viewer, key, duringThrottle)).ids.sort(),
        ).toEqual(["agenda", "switch-agenda"]);
        const afterThrottle = new Date(at.getTime() + 20001);
        expect(
            await refreshRecorderPresence(
                "owner",
                key,
                "switch-agenda",
                afterThrottle,
            ),
        ).toEqual({ retryAfterMs: 0 });
        expect(
            (await queryRecorderRoom(viewer, key, afterThrottle)).ids,
        ).toEqual(["switch-agenda"]);
    });
});
