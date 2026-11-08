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
import * as Y from "yjs";
import {
    agendaEventStreams,
    agendaPoints,
    agendaTasks,
    agendaTextDocs,
    apiKeys,
    chatterItems,
    itemShares,
    meetingAgendas,
    recordingSessions,
    recordingTasks,
    users,
} from "@/db/schema";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import {
    AGENDA_TEXT_NAME,
    agendaTextBase64,
    agendaTextBytes,
} from "@/lib/meetings/text-model";
import { insertRecordings } from "@/tests/integration/items";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { ref, proxy } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    return {
        ref,
        proxy: new Proxy(
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
    };
});
vi.mock("@/db", () => ({ db: proxy, sqlClient: null }));
const listenerConfig = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/env", () => ({
    env: {
        get DATABASE_URL() {
            return listenerConfig.url;
        },
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        BETTER_AUTH_SECRET: "agenda-live-test",
        AUTHZ_MODE: "local",
        IS_HOSTED: false,
    },
}));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: async () => null,
    isOrgScopeVisible: () => true,
    isOrgScopeEnabled: () => true,
    assertOrgScopeWritable: () => {},
    assertNotOrgAccount: async () => {},
    isOrgAccount: async () => false,
}));
vi.mock("@/lib/authz/curator", () => ({
    userCuratesOrganizationNow: async () => false,
    actsForOrganization: async () => false,
}));
const calendar = vi.hoisted(() => ({ event: vi.fn() }));
vi.mock("@/lib/integrations/google/calendar-events", () => ({
    getCalendarEvent: calendar.event,
}));
vi.mock("@/lib/integrations/google/connection", () => ({
    getGoogleConnectionStatus: async () => null,
}));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));
const principal = vi.hoisted(() => ({ id: "owner" }));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async () => ({ user: { id: principal.id } }),
}));
vi.mock("@/lib/recording-sessions/route-gate", () => ({
    gateRecordingSessionRequest: async () => ({
        authn: { user: { id: principal.id }, apiKeyId: "key" },
    }),
}));

import { GET as webEvents } from "@/app/api/meetings/[id]/events/route";
import { GET as recorderEvents } from "@/app/api/v1/recorder/agendas/[id]/events/route";
import { db } from "@/db";
import {
    bumpAgendaInTx,
    claimAgendaStream,
    MAX_AGENDA_STREAMS_PER_USER,
    releaseAgendaStream,
    renewAgendaStream,
} from "@/db/queries/agenda-events";
import { openAgendaListener } from "@/db/queries/agenda-listener";
import {
    encryptCalendarSnapshot,
    readMeetingCalendarSnapshot,
} from "@/lib/meetings/calendar-snapshot";
import { agendaRecordingBy } from "@/lib/meetings/recording-by";
import {
    addPoint,
    changeAgendaTask,
    changePoint,
    getMeeting,
    listMeetings,
} from "@/lib/meetings/service";
import { getAgendaText, updateAgendaText } from "@/lib/meetings/text-documents";
import {
    createRecordingSession,
    setRecordingSessionAgenda,
} from "@/lib/recording-sessions/store";
import { taskViewerById } from "@/lib/tasks/access";
import { logTaskStatusInTx } from "@/lib/tasks/status-transitions";
import { updateTask } from "@/lib/tasks/tasks";

const databaseUrl = getTestDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const at = new Date();

suite("live agenda concurrency and access (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            databaseUrl ?? "",
            "agenda_live",
        );
        ref.current = database.db as unknown as Record<PropertyKey, unknown>;
        listenerConfig.url = database.url;
    }, 120000);
    afterAll(async () => {
        ref.current = null;
        await database?.dispose();
    }, 60000);
    beforeEach(async () => {
        calendar.event.mockReset().mockResolvedValue(null);
        principal.id = "owner";
        await db.delete(users);
        await db.insert(users).values([
            {
                id: "owner",
                email: "jitka@example.com",
                name: "Jitka Dvořáková",
            },
            { id: "editor", email: "petr@example.com", name: "Petr Král" },
            { id: "stranger", email: "tomas@example.com", name: "Tomáš Beneš" },
        ]);
        await db.insert(chatterItems).values({
            id: "meeting",
            userId: "owner",
            kind: "meeting",
            title: encryptText("Planning"),
            occurredAt: at,
        });
        await db.insert(meetingAgendas).values({
            id: "agenda",
            userId: "owner",
            meetingItemId: "meeting",
            plannedStart: at,
            plannedEnd: new Date(at.getTime() + 3600000),
            timeSet: true,
        });
        await db.insert(itemShares).values({
            id: "invitation",
            itemId: "meeting",
            userId: "owner",
            receiverUserId: "editor",
            state: "accepted",
        });
        await db.insert(agendaPoints).values({
            id: "point",
            userId: "owner",
            agendaId: "agenda",
            authorUserId: "owner",
            text: encryptText("Planning"),
            note: encryptText("Note"),
        });
        await db.insert(apiKeys).values({
            id: "key",
            userId: "owner",
            name: "Recorder",
            keyHash: "test-recorder-hash",
            keyPrefix: "test",
            scopes: ["recordings:write"],
        });
    });

    function edit(seed: string, value: string, atEnd = false) {
        const doc = new Y.Doc();
        Y.applyUpdate(doc, agendaTextBytes(seed));
        const text = doc.getText(AGENDA_TEXT_NAME);
        text.insert(atEnd ? text.length : 0, value);
        const update = agendaTextBase64(Y.encodeStateAsUpdate(doc));
        const stateVector = agendaTextBase64(Y.encodeStateVector(doc));
        doc.destroy();
        return { update, stateVector };
    }
    async function plainPoint() {
        const [point] = await db
            .select()
            .from(agendaPoints)
            .where(eq(agendaPoints.id, "point"));
        return {
            ...point,
            text: decryptText(point.text),
            note: decryptText(point.note),
        };
    }
    async function session(
        agendaId: string | null = "agenda",
        startedAt = new Date(),
    ) {
        return createRecordingSession({
            userId: "owner",
            apiKeyId: "key",
            clientRecordingId: crypto.randomUUID(),
            mimeType: "audio/webm",
            metadata: { channelLayout: ["system"], liveAgendaId: agendaId },
            startedAt,
            noticeAcknowledgedAt: null,
            folderId: null,
        });
    }

    async function agendaEventsDuring(run: () => Promise<void>) {
        const messages: string[] = [];
        const marker = JSON.stringify({ marker: true });
        const listener = await database.sql.listen(
            "riffado_agenda",
            (payload) => {
                messages.push(payload);
            },
        );
        try {
            await run();
            await database.sql.notify("riffado_agenda", marker);
            await vi.waitFor(() => expect(messages.at(-1)).toBe(marker));
            return messages.slice(0, -1).map((message) => JSON.parse(message));
        } finally {
            await listener.unlisten();
        }
    }

    it.each([
        "advanced",
        "relinked",
        "unchanged",
    ])("publishes only a changed Calendar snapshot's returned cursor (%s)", async (scenario) => {
        const event = {
            id: "event",
            title: "Planning",
            start: at.toISOString(),
            end: new Date(at.getTime() + 3600000).toISOString(),
            attendees: [],
        };
        const [agenda] = await db
            .update(meetingAgendas)
            .set({
                calendarEventId: event.id,
                calendarSnapshot:
                    scenario === "unchanged"
                        ? encryptCalendarSnapshot(event)
                        : null,
            })
            .where(eq(meetingAgendas.id, "agenda"))
            .returning();
        calendar.event.mockImplementationOnce(async () => {
            await db
                .update(meetingAgendas)
                .set(
                    scenario === "relinked"
                        ? { calendarEventId: "replacement" }
                        : { version: 7 },
                )
                .where(eq(meetingAgendas.id, "agenda"));
            return event;
        });
        const messages = await agendaEventsDuring(async () => {
            await readMeetingCalendarSnapshot(agenda);
        });
        expect(messages).toEqual(
            scenario === "advanced"
                ? [{ agendaId: "agenda", cursor: "8" }]
                : [],
        );
        const [stored] = await db
            .select()
            .from(meetingAgendas)
            .where(eq(meetingAgendas.id, "agenda"));
        expect(stored.version).toBe(
            scenario === "advanced" ? 8 : scenario === "unchanged" ? 7 : 0,
        );
        expect(stored.calendarSnapshot !== null).toBe(scenario !== "relinked");
    });

    it("rejects a cursor bump without a matching owner-scoped agenda", async () => {
        for (const agenda of [
            { id: "missing", userId: "owner" },
            { id: "agenda", userId: "stranger" },
        ])
            await expect(
                db.transaction((tx) => bumpAgendaInTx(tx, agenda)),
            ).rejects.toThrow("Agenda update returned no row");
        const [stored] = await db
            .select()
            .from(meetingAgendas)
            .where(eq(meetingAgendas.id, "agenda"));
        expect(stored.version).toBe(0);
    });

    it("serializes simultaneous first fetches to one authoritative seed", async () => {
        const [a, b] = await Promise.all([
            getAgendaText("owner", "agenda", "point:point:note"),
            getAgendaText("editor", "agenda", "point:point:note"),
        ]);
        expect(a.update).toBe(b.update);
        const docs = await db.select().from(agendaTextDocs);
        expect(docs).toHaveLength(1);
        expect(docs[0].state.startsWith("v1:")).toBe(true);
        expect(docs[0].state).not.toContain("Note");
    });

    it("merges two writers without lost edits or duplicated initial text and materializes the exact result", async () => {
        const field = "point:point:note";
        const [a, b] = await Promise.all([
            getAgendaText("owner", "agenda", field),
            getAgendaText("editor", "agenda", field),
        ]);
        await Promise.all([
            updateAgendaText("owner", "agenda", {
                field,
                ...edit(a.update, "A "),
            }),
            updateAgendaText("editor", "agenda", {
                field,
                ...edit(b.update, " B", true),
            }),
        ]);
        const stored = await plainPoint();
        expect(stored.note).toBe("A Note B");
        expect(stored.version).toBe(2);
        const state = await getAgendaText("owner", "agenda", field);
        const doc = new Y.Doc();
        Y.applyUpdate(doc, agendaTextBytes(state.update));
        expect(doc.getText(AGENDA_TEXT_NAME).toString()).toBe(stored.note);
        doc.destroy();
    });

    it("keeps legacy point text and note PATCHes in the document history", async () => {
        await getAgendaText("owner", "agenda", "point:point:text");
        await getAgendaText("owner", "agenda", "point:point:note");
        await changePoint("owner", "agenda", "point", {
            version: 0,
            text: "Replaced",
            note: "Legacy note",
        });
        for (const [field, expected] of [
            ["point:point:text", "Replaced"],
            ["point:point:note", "Legacy note"],
        ]) {
            const state = await getAgendaText("owner", "agenda", field);
            const doc = new Y.Doc();
            Y.applyUpdate(doc, agendaTextBytes(state.update));
            expect(doc.getText(AGENDA_TEXT_NAME).toString()).toBe(expected);
            doc.destroy();
        }
        expect((await plainPoint()).text).toBe("Replaced");
    });
    it("reconciles materialized writes made by an older server image before serving a document", async () => {
        const field = "point:point:note";
        await getAgendaText("owner", "agenda", field);
        await db
            .update(agendaPoints)
            .set({ note: encryptText("Older image") })
            .where(eq(agendaPoints.id, "point"));
        const state = await getAgendaText("owner", "agenda", field);
        const doc = new Y.Doc();
        Y.applyUpdate(doc, agendaTextBytes(state.update));
        expect(doc.getText(AGENDA_TEXT_NAME).toString()).toBe("Older image");
        doc.destroy();
    });

    it("validates text shape, size, first-fetch requirement, and author-controlled text editing", async () => {
        const unrelated = new Y.Doc();
        unrelated.getText(AGENDA_TEXT_NAME).insert(0, "Planning");
        await expect(
            updateAgendaText("owner", "agenda", {
                field: "point:point:text",
                update: agendaTextBase64(Y.encodeStateAsUpdate(unrelated)),
            }),
        ).rejects.toMatchObject({ statusCode: 409 });
        unrelated.destroy();
        const state = await getAgendaText(
            "owner",
            "agenda",
            "point:point:text",
        );
        await expect(
            updateAgendaText("editor", "agenda", {
                field: "point:point:text",
                ...edit(state.update, "Other "),
            }),
        ).rejects.toMatchObject({ statusCode: 403 });
        await expect(
            updateAgendaText("owner", "agenda", {
                field: "point:point:text",
                ...edit(state.update, "x".repeat(2001)),
            }),
        ).rejects.toMatchObject({ statusCode: 400 });
        await expect(
            getAgendaText("owner", "agenda", "point:foreign:text"),
        ).rejects.toMatchObject({ statusCode: 404 });
        expect((await plainPoint()).text).toBe("Planning");
    });

    it("refuses text updates and subscriptions by nonmembers and immediately after revocation", async () => {
        const field = "point:point:note";
        const state = await getAgendaText("editor", "agenda", field);
        await expect(
            updateAgendaText("stranger", "agenda", {
                field,
                ...edit(state.update, "X"),
            }),
        ).rejects.toMatchObject({ statusCode: 404 });
        await db
            .update(itemShares)
            .set({ state: "removed" })
            .where(eq(itemShares.id, "invitation"));
        await expect(
            updateAgendaText("editor", "agenda", {
                field,
                ...edit(state.update, "X"),
            }),
        ).rejects.toMatchObject({ statusCode: 404 });
        for (const handler of [webEvents, recorderEvents]) {
            principal.id = "stranger";
            const response = await handler(
                new Request("https://example.com/events"),
                { params: Promise.resolve({ id: "agenda" }) },
            );
            expect(response.status).toBe(404);
        }
        expect(await db.select().from(agendaEventStreams)).toEqual([]);
    });

    it("keeps absorbed agendas read-only for CRDT updates", async () => {
        const state = await getAgendaText(
            "owner",
            "agenda",
            "point:point:note",
        );
        await insertRecordings(database.db, {
            id: "recording",
            userId: "owner",
            filename: encryptText("Meeting"),
            startTime: at,
            endTime: new Date(at.getTime() + 1000),
            duration: 1000,
            filesize: 1,
            fileMd5: "a".repeat(32),
            storageType: "local",
            storagePath: "test.ogg",
            deviceSn: "test",
            plaudFileId: "test",
            plaudVersion: "1",
        });
        await db
            .update(meetingAgendas)
            .set({ recordingItemId: "recording" })
            .where(eq(meetingAgendas.id, "agenda"));
        await expect(
            updateAgendaText("owner", "agenda", {
                field: "point:point:note",
                ...edit(state.update, "X"),
            }),
        ).rejects.toMatchObject({ statusCode: 409 });
    });

    it("deletes derivative documents when their point subtree is removed", async () => {
        const child = await addPoint("owner", "agenda", {
            text: "Child",
            parentId: "point",
        });
        await getAgendaText("owner", "agenda", "point:point:text");
        await getAgendaText("owner", "agenda", `point:${child.id}:note`);
        await changePoint("owner", "agenda", "point", { version: 0 }, true);
        expect(await db.select().from(agendaTextDocs)).toEqual([]);
    });

    it("scopes task notes to real visible review tasks and keeps plain task PATCHes synchronized", async () => {
        await db.insert(recordingTasks).values({
            id: "task",
            userId: "owner",
            source: "personal",
            text: encryptText("Task"),
            status: "open",
        });
        await db.insert(agendaTasks).values({
            userId: "owner",
            agendaId: "agenda",
            taskId: "task",
            origin: "older",
            note: encryptText("Review"),
            updatedByUserId: "stranger",
        });
        const field = "task:task:note";
        const state = await getAgendaText("owner", "agenda", field);
        await expect(
            getAgendaText("editor", "agenda", field),
        ).rejects.toMatchObject({ statusCode: 404 });
        const hidden = await getMeeting("editor", "agenda");
        if (hidden.unchanged) throw new Error("Missing detail");
        expect(hidden.authors.some((author) => author.id === "stranger")).toBe(
            false,
        );
        await updateAgendaText("owner", "agenda", {
            field,
            ...edit(state.update, "New "),
        });
        await changeAgendaTask("owner", "agenda", "task", {
            note: "Plain task note",
        });
        const next = await getAgendaText("owner", "agenda", field);
        const doc = new Y.Doc();
        Y.applyUpdate(doc, agendaTextBytes(next.update));
        const [link] = await db.select().from(agendaTasks);
        expect(doc.getText(AGENDA_TEXT_NAME).toString()).toBe(
            decryptText(link.note),
        );
        expect(decryptText(link.note)).toBe("Plain task note");
        expect(link.updatedByUserId).toBe("owner");
        doc.destroy();
    });

    it("caps concurrent streams per user across database claims and recovers expired leases", async () => {
        const claims = await Promise.all(
            Array.from({ length: 10 }, () => claimAgendaStream("owner")),
        );
        expect(claims.filter(Boolean)).toHaveLength(
            MAX_AGENDA_STREAMS_PER_USER,
        );
        const id = claims.find((id): id is string => id !== null);
        if (!id) throw new Error("Missing stream lease");
        expect(await renewAgendaStream("owner", id)).toBe(true);
        expect(await claimAgendaStream("editor")).not.toBeNull();
        await releaseAgendaStream("owner", id);
        expect(await claimAgendaStream("owner")).not.toBeNull();
        await db
            .update(agendaEventStreams)
            .set({ expiresAt: new Date(0) })
            .where(eq(agendaEventStreams.userId, "owner"));
        expect(await renewAgendaStream("owner", id)).toBe(false);
        expect(await claimAgendaStream("owner")).not.toBeNull();
    });
    it("advances the durable agenda cursor when a reviewed task changes status outside the agenda route", async () => {
        await db.insert(recordingTasks).values({
            id: "reviewed",
            userId: "owner",
            source: "personal",
            text: encryptText("Review task"),
            status: "open",
        });
        await db.insert(agendaTasks).values({
            agendaId: "agenda",
            userId: "owner",
            taskId: "reviewed",
            origin: "older",
        });
        await updateTask(await taskViewerById("owner"), "reviewed", {
            version: 0,
            status: "done",
        });
        const [agenda] = await db
            .select()
            .from(meetingAgendas)
            .where(eq(meetingAgendas.id, "agenda"));
        expect(agenda.version).toBe(1);
    });

    it("validates live agenda choices without altering completion metadata and scopes PATCH by recorder key", async () => {
        const created = await session();
        expect(created.session.metadata).toMatchObject({
            liveAgendaId: "agenda",
        });
        expect(created.session.metadata).not.toHaveProperty("agendaId");
        const updated = await setRecordingSessionAgenda({
            userId: "owner",
            apiKeyId: "key",
            sessionId: created.session.id,
            agendaId: null,
        });
        expect(updated.metadata.liveAgendaId).toBeNull();
        await expect(
            setRecordingSessionAgenda({
                userId: "owner",
                apiKeyId: "wrong",
                sessionId: created.session.id,
                agendaId: "agenda",
            }),
        ).rejects.toMatchObject({
            statusCode: 403,
            message: "Recorder key mismatch",
        });
        for (const input of [
            { userId: "owner", sessionId: "missing" },
            { userId: "stranger", sessionId: created.session.id },
        ])
            await expect(
                setRecordingSessionAgenda({
                    ...input,
                    apiKeyId: "key",
                    agendaId: null,
                }),
            ).rejects.toMatchObject({ statusCode: 404 });
        await expect(
            setRecordingSessionAgenda({
                userId: "owner",
                apiKeyId: "wrong",
                sessionId: created.session.id,
                agendaId: "missing",
            }),
        ).rejects.toMatchObject({
            statusCode: 403,
            message: "Recorder key mismatch",
        });
        await db
            .update(recordingSessions)
            .set({ status: "completed" })
            .where(eq(recordingSessions.id, created.session.id));
        await expect(
            setRecordingSessionAgenda({
                userId: "owner",
                apiKeyId: "key",
                sessionId: created.session.id,
                agendaId: "agenda",
            }),
        ).rejects.toMatchObject({ statusCode: 409 });
    });

    it("returns recordingBy only to agenda viewers and removes terminal or twelve-hour-old sessions", async () => {
        const created = await session();
        await session("agenda", new Date(Date.now() - 13 * 3600000));
        await session("agenda", new Date(Date.now() + 3600000));
        expect(
            (await agendaRecordingBy("editor", "agenda")).recordingBy,
        ).toEqual([{ name: "Jitka Dvořáková", self: false }]);
        expect(
            (await agendaRecordingBy("owner", "agenda")).recordingBy[0].self,
        ).toBe(true);
        await expect(
            agendaRecordingBy("stranger", "agenda"),
        ).rejects.toMatchObject({ statusCode: 404 });
        const detail = await getMeeting("editor", "agenda");
        if (detail.unchanged) throw new Error("Missing detail");
        await db
            .update(recordingSessions)
            .set({ status: "completed" })
            .where(eq(recordingSessions.id, created.session.id));
        const after = await getMeeting("editor", "agenda", detail.cursor);
        expect(after.unchanged).toBe(false);
        if (!after.unchanged) expect(after.recordingBy).toEqual([]);
    });

    it("orders own agendas first and attributes remote point changes", async () => {
        await db.insert(chatterItems).values({
            id: "other-meeting",
            userId: "editor",
            kind: "meeting",
            title: encryptText("Earlier"),
            occurredAt: new Date(at.getTime() - 60000),
        });
        await db.insert(meetingAgendas).values({
            id: "other-agenda",
            userId: "editor",
            meetingItemId: "other-meeting",
            plannedStart: new Date(at.getTime() - 60000),
        });
        const rows = await listMeetings("editor", { includePast: true });
        expect(rows.map((row) => [row.id, row.own])).toEqual([
            ["other-agenda", true],
            ["agenda", false],
        ]);
        await changePoint("editor", "agenda", "point", {
            version: 0,
            discussed: true,
        });
        const detail = await getMeeting("owner", "agenda");
        if (detail.unchanged) throw new Error("Missing detail");
        expect(detail.points[0].updatedByUserId).toBe("editor");
        expect(detail.authors).toContainEqual({
            id: "editor",
            name: "Petr Král",
        });
    });

    it("broadcasts IDs and cursors only after successful text transactions", async () => {
        const messages: string[] = [];
        const listener = await database.sql.listen(
            "riffado_agenda",
            (payload) => {
                messages.push(payload);
            },
        );
        try {
            const field = "point:point:note";
            const state = await getAgendaText("owner", "agenda", field);
            await updateAgendaText("owner", "agenda", {
                field,
                ...edit(state.update, "Private "),
            });
            await vi.waitFor(() => expect(messages).toHaveLength(1));
            expect(JSON.parse(messages[0])).toEqual({
                agendaId: "agenda",
                cursor: "1",
            });
            await expect(
                updateAgendaText("owner", "agenda", {
                    field,
                    ...edit(state.update, "x".repeat(2001)),
                }),
            ).rejects.toMatchObject({ statusCode: 400 });
            expect(messages).toHaveLength(1);
        } finally {
            await listener.unlisten();
        }
    });
    it("invalidates a private reviewing agenda hidden from the authorized task writer", async () => {
        await insertRecordings(database.db, {
            id: "shared-recording",
            userId: "owner",
            filename: encryptText("Review"),
            startTime: at,
            endTime: new Date(at.getTime() + 1000),
            duration: 1000,
            filesize: 1,
            fileMd5: "b".repeat(32),
            storageType: "local",
            storagePath: "test.ogg",
            deviceSn: "test",
            plaudFileId: "test-shared",
            plaudVersion: "1",
        });
        await db.insert(itemShares).values({
            id: "recording-invitation",
            itemId: "shared-recording",
            userId: "owner",
            receiverUserId: "editor",
            state: "accepted",
        });
        await db.insert(recordingTasks).values({
            id: "shared-task",
            userId: "owner",
            itemId: "shared-recording",
            source: "manual",
            text: encryptText("Review task"),
            status: "open",
        });
        await db.insert(chatterItems).values({
            id: "private-meeting",
            userId: "editor",
            kind: "meeting",
            title: encryptText("Private plan"),
            occurredAt: at,
        });
        await db.insert(meetingAgendas).values({
            id: "private-agenda",
            userId: "editor",
            meetingItemId: "private-meeting",
            plannedStart: at,
            taskSourceItemId: "shared-recording",
        });
        await db.insert(agendaTasks).values({
            agendaId: "private-agenda",
            userId: "editor",
            taskId: "shared-task",
            origin: "last_meeting",
        });
        const before = await getMeeting("editor", "private-agenda");
        if (before.unchanged) throw new Error("Missing detail");
        expect(before.tasks.map((task) => task.id)).toContain("shared-task");
        await expect(
            getMeeting("owner", "private-agenda"),
        ).rejects.toMatchObject({ statusCode: 404 });
        await updateTask(await taskViewerById("owner"), "shared-task", {
            version: 0,
            status: "done",
        });
        const [agenda] = await db
            .select()
            .from(meetingAgendas)
            .where(eq(meetingAgendas.id, "private-agenda"));
        expect(agenda.version).toBe(1);
        const after = await getMeeting(
            "editor",
            "private-agenda",
            before.cursor,
        );
        expect(after.unchanged).toBe(false);
    });
    it("receives a real NOTIFY after the dedicated LISTEN is active", async () => {
        const received = vi.fn();
        const failed = vi.fn();
        const stop = await openAgendaListener(received, failed);
        try {
            await database.sql.notify(
                "riffado_agenda",
                JSON.stringify({ agendaId: "agenda", cursor: "1" }),
            );
            await vi.waitFor(() =>
                expect(received).toHaveBeenCalledExactlyOnceWith(
                    JSON.stringify({ agendaId: "agenda", cursor: "1" }),
                ),
            );
            expect(failed).not.toHaveBeenCalled();
        } finally {
            stop();
        }
    });
    it("invalidates references for a background task status transition without an actor", async () => {
        await db.insert(recordingTasks).values({
            id: "background-task",
            userId: "owner",
            source: "personal",
            text: encryptText("Task"),
            status: "open",
        });
        await db.insert(agendaTasks).values({
            agendaId: "agenda",
            userId: "owner",
            taskId: "background-task",
            origin: "older",
        });
        await db.transaction(async (tx) => {
            await tx
                .update(recordingTasks)
                .set({ status: "done" })
                .where(eq(recordingTasks.id, "background-task"));
            await logTaskStatusInTx(
                tx,
                "background-task",
                null,
                "open",
                "done",
            );
        });
        const [agenda] = await db
            .select()
            .from(meetingAgendas)
            .where(eq(meetingAgendas.id, "agenda"));
        expect(agenda.version).toBe(1);
    });
});
