import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
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
import { z } from "zod";
import {
    accounts,
    chatterItems,
    itemShares,
    people,
    personEmails,
    recordings,
    transcriptions,
    transcriptSpeakers,
    users,
} from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef, mockEnv, audit, allowScan } = vi.hoisted(() => {
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
    return {
        dbProxy: proxy,
        dbRef: ref,
        audit: vi.fn(),
        allowScan: vi.fn(async () => true),
        mockEnv: {
            IS_HOSTED: false,
            SELF_HOST_MODE: "shared",
            APP_URL: "https://riffado.example.test",
            ORG_ACCOUNT_EMAIL: "org@example.test",
            ORG_ACCOUNT_PASSWORD: "organization-password",
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            DATABASE_URL: "postgres://unused",
            KNOWLEDGE_MEMORY_MB: 64,
        },
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/mcp/audit", () => ({ recordMcpAccess: audit }));
vi.mock("@/lib/mcp/rate-limit", () => ({ allowMcpScan: allowScan }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));

import { encryptText } from "@/lib/encryption/fields";
import { ensureRootFolders } from "@/lib/folders/folders";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import type { McpCaller } from "@/lib/mcp/caller";
import {
    allowedTools,
    buildMcpServer,
    type ToolContext,
} from "@/lib/mcp/registry";
import { RECORDING_TOOLS } from "@/lib/mcp/tools/recordings";
import { SUMMARY_TOOLS } from "@/lib/mcp/tools/summaries";
import { TRANSCRIPT_TOOLS } from "@/lib/mcp/tools/transcripts";
import { ensureOrgAccount } from "@/lib/org/account";
import { SSO_PROVIDER_ID } from "@/lib/sso/constants";
import {
    attributeSpeaker,
    insertPerson,
    insertRecording,
    insertTranscript,
    serviceCaller,
    shareRecording,
    userCaller,
} from "@/tests/mcp/fixtures";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const VIEWER = "attendee";
const OWNER = "owner";
const OTHER = "other";
const EMAIL = "jitka@example.test";
const FIRST_SIGN_IN = new Date("2026-09-10T12:00:00Z");
const RANGE = { from: "2026-09-01", to: "2026-09-30" };
const TOOLS = [...RECORDING_TOOLS, ...TRANSCRIPT_TOOLS, ...SUMMARY_TOOLS];

function tool(name: string) {
    const found = TOOLS.find((entry) => entry.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    return found;
}
const attendedTool = tool("list_attended_recordings");
const resultSchema = z.object(attendedTool.output);

describeWithDatabase("MCP attended recordings (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";
    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }
    const viewer = () =>
        userCaller(
            VIEWER,
            EMAIL,
            ["transcripts:read", "summaries:read"],
            orgUserId,
        );
    const context = (caller: McpCaller = viewer()): ToolContext => ({
        caller,
        touched: [],
    });
    async function list(
        args: Record<string, unknown> = RANGE,
        ctx = context(),
    ) {
        const parsed = z.object(attendedTool.input(ctx.caller)).parse(args);
        return attendedTool.run(ctx, parsed);
    }
    async function titles(args: Record<string, unknown> = RANGE) {
        const result = resultSchema.parse(await list(args));
        return (result.recordings as { title: string }[]).map(
            (row) => row.title,
        );
    }
    async function tagged(
        id: string,
        personId: string,
        status: "confirmed" | "suggested" | "rejected" = "confirmed",
        userId = OWNER,
    ) {
        await insertRecording(db(), { id, userId, title: id });
        const transcriptionId = await insertTranscript(db(), id, userId);
        if (status === "rejected") {
            await db().insert(transcriptSpeakers).values({
                userId,
                transcriptionId,
                label: "speaker_0",
                personId,
                status,
                source: "user",
            });
        } else {
            await attributeSpeaker(db(), {
                userId,
                transcriptionId,
                label: "speaker_0",
                personId,
                status,
            });
        }
        return transcriptionId;
    }
    async function person(userId = OWNER, email: string | null = EMAIL) {
        return insertPerson(db(), userId, "Jitka Dvořáková", {
            emailHash: email ? lookupHash(email) : null,
        });
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "mcp_attended",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        await db()
            .insert(users)
            .values([
                { id: VIEWER, email: EMAIL, emailVerified: true },
                { id: OWNER, email: "owner@example.test" },
                { id: OTHER, email: "other@example.test" },
            ]);
        orgUserId = (await ensureOrgAccount()) ?? "";
        if (!orgUserId) throw new Error("organization account missing");
        await ensureRootFolders(VIEWER);
        await ensureRootFolders(OWNER);
    }, 120_000);
    beforeEach(async () => {
        await db().delete(accounts);
        await db()
            .insert(accounts)
            .values({
                userId: VIEWER,
                providerId: SSO_PROVIDER_ID,
                accountId: viewer().subject,
                createdAt: new Date("2026-08-01T00:00:00Z"),
            });
        await db().delete(chatterItems);
        await db().delete(people);
        await db()
            .update(users)
            .set({ email: EMAIL, emailVerified: true })
            .where(eq(users.id, VIEWER));
        audit.mockReset().mockResolvedValue(undefined);
    });
    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    it.each([
        "owner",
        "org",
    ])("discloses exactly three decrypted fields for a confirmed %s person", async (scope) => {
        await tagged(
            "private-meeting",
            await person(scope === "org" ? orgUserId : OWNER),
        );
        await db()
            .update(chatterItems)
            .set({ title: encryptText("Rozpočtová porada") })
            .where(eq(chatterItems.id, "private-meeting"));
        await db()
            .update(recordings)
            .set({ duration: 123_456 })
            .where(eq(recordings.id, "private-meeting"));
        const ctx = context();
        const result = await list(RANGE, ctx);
        expect(Object.keys(result).sort()).toEqual(["recordings", "truncated"]);
        expect(result).toEqual({
            recordings: [
                {
                    title: "Rozpočtová porada",
                    recorded_at: "2026-09-01T10:00:00.000Z",
                    duration_ms: 123_456,
                },
            ],
            truncated: false,
        });
        const rows = result.recordings as Record<string, unknown>[];
        expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
            "duration_ms",
            "recorded_at",
            "title",
        ]);
        expect(ctx.touched).toEqual(["private-meeting"]);
    });

    it("does not grant access through any existing recording read tool", async () => {
        await tagged("private-meeting", await person());
        expect(await titles()).toEqual(["private-meeting"]);
        const readable = await tool("list_recordings").run(context(), RANGE);
        expect(readable.recordings).toEqual([]);
        for (const name of ["get_transcript", "get_summary"]) {
            await expect(
                tool(name).run(context(), { recording: "private-meeting" }),
            ).rejects.toMatchObject({ outcome: "not_found" });
        }
    });

    it.each([
        "suggested",
        "rejected",
    ] as const)("excludes %s speaker rows", async (status) => {
        await tagged("not-confirmed", await person(), status);
        expect(await titles()).toEqual([]);
    });
    it("excludes a confirmed speaker marked unknown", async () => {
        const transcriptionId = await tagged("unknown", await person());
        await db()
            .update(transcriptSpeakers)
            .set({ personId: null, markedUnknown: true })
            .where(eq(transcriptSpeakers.transcriptionId, transcriptionId));
        expect(await titles()).toEqual([]);
    });
    it.each([
        null,
        "different@example.test",
    ])("does not match the same display name with email %s", async (email) => {
        await tagged("same-name", await person(OWNER, email));
        expect(await titles()).toEqual([]);
    });
    it("does not use an address learned only in person_emails", async () => {
        const personId = await person(OWNER, null);
        await tagged("mail-address", personId);
        await db()
            .insert(personEmails)
            .values({
                userId: OWNER,
                personId,
                emailHash: lookupHash(EMAIL),
                email: encryptText(EMAIL),
            });
        expect(await titles()).toEqual([]);
    });
    it("excludes a person outside the recording owner and Organization scopes", async () => {
        await tagged("wrong-scope", await person(OTHER));
        expect(await titles()).toEqual([]);
    });
    it("excludes a merged person", async () => {
        const personId = await person();
        const keptId = await person(OWNER, "kept@example.test");
        await tagged("merged-person", personId);
        await db()
            .update(people)
            .set({ mergedIntoId: keptId })
            .where(eq(people.id, personId));
        expect(await titles()).toEqual([]);
    });
    it("excludes deleted attended recordings", async () => {
        await tagged("deleted-attended", await person());
        await db()
            .update(recordings)
            .set({ deletedAt: new Date() })
            .where(eq(recordings.id, "deleted-attended"));
        expect(await titles()).toEqual([]);
    });
    it("excludes merely Organization-shared or received recordings", async () => {
        for (const id of ["shared-no-tag", "received-no-tag"])
            await insertRecording(db(), { id, userId: OWNER });
        await shareRecording(db(), "shared-no-tag", orgUserId);
        await db().insert(itemShares).values({
            userId: OWNER,
            receiverUserId: VIEWER,
            itemId: "received-no-tag",
            state: "accepted",
        });
        expect(await titles()).toEqual([]);
        const readable = await tool("list_recordings").run(context(), RANGE);
        expect(readable.recordings).toHaveLength(2);
    });
    it("includes own uploads without speakers and excludes own deleted recordings", async () => {
        await insertRecording(db(), { id: "own-upload", userId: VIEWER });
        await insertRecording(db(), {
            id: "own-deleted",
            userId: VIEWER,
            deletedAt: new Date(),
        });
        expect(await titles()).toEqual(["Recording own-upload"]);
        const result = await list();
        expect(result).toEqual({
            recordings: [
                {
                    title: "Recording own-upload",
                    recorded_at: "2026-09-01T10:00:00.000Z",
                    duration_ms: 60_000,
                },
            ],
            truncated: false,
        });
    });
    it.each([
        ["before", "2026-09-10T11:59:59.999Z", false],
        ["exactly at", "2026-09-10T12:00:00.000Z", true],
        ["after", "2026-09-10T12:00:00.001Z", true],
    ] as const)("lists foreign attendance %s first sign-in only when at or after it", async (_boundary, at, included) => {
        await db()
            .update(accounts)
            .set({ createdAt: FIRST_SIGN_IN })
            .where(eq(accounts.userId, VIEWER));
        const transcriptionId = await tagged("cutoff-meeting", await person());
        await db()
            .update(chatterItems)
            .set({ occurredAt: new Date(at) })
            .where(eq(chatterItems.id, "cutoff-meeting"));
        await db()
            .update(transcriptSpeakers)
            .set({
                createdAt: new Date("2026-08-01T00:00:00Z"),
                updatedAt: new Date("2026-09-20T00:00:00Z"),
            })
            .where(eq(transcriptSpeakers.transcriptionId, transcriptionId));
        expect(await titles()).toEqual(included ? ["cutoff-meeting"] : []);
    });
    it("excludes an earlier meeting even when its speaker tag is written after first sign-in", async () => {
        await db()
            .update(accounts)
            .set({ createdAt: FIRST_SIGN_IN })
            .where(eq(accounts.userId, VIEWER));
        const transcriptionId = await tagged("late-tag", await person());
        const [tag] = await db()
            .select()
            .from(transcriptSpeakers)
            .where(eq(transcriptSpeakers.transcriptionId, transcriptionId));
        expect(tag?.createdAt.getTime()).toBeGreaterThan(
            FIRST_SIGN_IN.getTime(),
        );
        expect(await titles()).toEqual([]);
    });
    it("includes own recordings from before first sign-in", async () => {
        await db()
            .update(accounts)
            .set({ createdAt: FIRST_SIGN_IN })
            .where(eq(accounts.userId, VIEWER));
        await insertRecording(db(), {
            id: "own-before-sign-in",
            userId: VIEWER,
        });
        expect(await titles()).toEqual(["Recording own-before-sign-in"]);
    });
    it("lists only own recordings when the linked SSO account is missing", async () => {
        await db().delete(accounts).where(eq(accounts.userId, VIEWER));
        await insertRecording(db(), { id: "own-without-link", userId: VIEWER });
        await tagged("foreign-without-link", await person());
        expect(await titles()).toEqual(["Recording own-without-link"]);
    });
    it.each([
        "provider",
        "subject",
        "user",
    ] as const)("does not take the first sign-in from another %s", async (mismatch) => {
        await db().delete(accounts).where(eq(accounts.userId, VIEWER));
        await db()
            .insert(accounts)
            .values({
                userId: mismatch === "user" ? OTHER : VIEWER,
                providerId:
                    mismatch === "provider" ? "credential" : SSO_PROVIDER_ID,
                accountId:
                    mismatch === "subject"
                        ? "another-subject"
                        : viewer().subject,
                createdAt: new Date("2026-08-01T00:00:00Z"),
            });
        await insertRecording(db(), {
            id: "own-with-other-link",
            userId: VIEWER,
        });
        await tagged("foreign-with-other-link", await person());
        expect(await titles()).toEqual(["Recording own-with-other-link"]);
    });
    it("keeps the first sign-in cutoff after a later identity-provider email change", async () => {
        await db()
            .update(accounts)
            .set({ createdAt: FIRST_SIGN_IN })
            .where(eq(accounts.userId, VIEWER));
        await db()
            .update(users)
            .set({
                email: "changed@example.test",
                lastSsoLoginAt: new Date("2026-09-20T00:00:00Z"),
            })
            .where(eq(users.id, VIEWER));
        await tagged(
            "before-email-change",
            await person(OWNER, "changed@example.test"),
        );
        await db()
            .update(chatterItems)
            .set({ occurredAt: new Date("2026-09-11T00:00:00Z") })
            .where(eq(chatterItems.id, "before-email-change"));
        expect(await titles()).toEqual(["before-email-change"]);
    });
    it("matches primary email regardless of case", async () => {
        await tagged(
            "case-insensitive",
            await person(OWNER, "JITKA@EXAMPLE.TEST"),
        );
        await db()
            .update(users)
            .set({ email: "Jitka@Example.Test" })
            .where(eq(users.id, VIEWER));
        expect(await titles()).toEqual(["case-insensitive"]);
    });
    it("uses the current database email rather than a stale caller email", async () => {
        await tagged("stale-email", await person());
        await db()
            .update(users)
            .set({ email: "changed@example.test" })
            .where(eq(users.id, VIEWER));
        expect(await titles()).toEqual([]);
    });
    it("counts any own transcript and returns a recording tagged on two transcripts once", async () => {
        const personId = await person();
        const first = await tagged("two-transcripts", personId);
        await db()
            .update(transcriptions)
            .set({ source: "plaud" })
            .where(eq(transcriptions.id, first));
        const second = await insertTranscript(db(), "two-transcripts", OWNER);
        await attributeSpeaker(db(), {
            userId: OWNER,
            transcriptionId: second,
            label: "speaker_0",
            personId,
        });
        expect(await titles()).toEqual(["two-transcripts"]);
        await db()
            .delete(transcriptSpeakers)
            .where(eq(transcriptSpeakers.transcriptionId, second));
        expect(await titles()).toEqual(["two-transcripts"]);
    });
    it("does not transfer a tag to another recording with its own untagged transcript", async () => {
        await tagged("tagged-meeting", await person());
        await insertRecording(db(), {
            id: "untagged-meeting",
            userId: OWNER,
            title: "untagged-meeting",
        });
        await insertTranscript(db(), "untagged-meeting", OWNER);
        expect(await titles()).toEqual(["tagged-meeting"]);
    });
    it("excludes a speaker row belonging to someone other than the transcript owner", async () => {
        const transcriptionId = await tagged(
            "foreign-speaker",
            await person(orgUserId),
        );
        expect(await titles()).toEqual(["foreign-speaker"]);
        await db()
            .update(transcriptSpeakers)
            .set({ userId: OTHER })
            .where(eq(transcriptSpeakers.transcriptionId, transcriptionId));
        expect(await titles()).toEqual([]);
    });
    it("excludes an Organization person tagged on a foreign-owned transcript", async () => {
        const transcriptionId = await tagged(
            "foreign-org-transcript",
            await person(orgUserId),
        );
        expect(await titles()).toEqual(["foreign-org-transcript"]);
        await db()
            .update(transcriptions)
            .set({ userId: OTHER })
            .where(eq(transcriptions.id, transcriptionId));
        await db()
            .update(transcriptSpeakers)
            .set({ userId: OTHER })
            .where(eq(transcriptSpeakers.transcriptionId, transcriptionId));
        expect(await titles()).toEqual([]);
    });
    it("excludes tags on another user's transcript of the recording", async () => {
        const first = await tagged("foreign-transcript", await person());
        await db()
            .update(transcriptions)
            .set({ userId: OTHER })
            .where(eq(transcriptions.id, first));
        await db()
            .update(transcriptSpeakers)
            .set({ userId: OTHER })
            .where(eq(transcriptSpeakers.transcriptionId, first));
        expect(await titles()).toEqual([]);
    });

    it("includes exact datetime boundaries and all of a date-only to day", async () => {
        for (const [id, at] of [
            ["before", "2026-09-01T09:59:59.999Z"],
            ["start", "2026-09-01T10:00:00Z"],
            ["end", "2026-09-01T11:00:00Z"],
            ["late", "2026-09-01T23:59:59.999Z"],
            ["tomorrow", "2026-09-02T00:00:00Z"],
        ] as const)
            await insertRecording(db(), {
                id,
                title: id,
                userId: VIEWER,
                startTime: new Date(at),
            });
        expect(
            await titles({
                from: "2026-09-01T12:00:00+02:00",
                to: "2026-09-01T11:00:00Z",
            }),
        ).toEqual(["end", "start"]);
        expect(
            await titles({ from: "2026-09-01T10:00:00Z", to: "2026-09-01" }),
        ).toEqual(["late", "end", "start"]);
        expect(
            await titles({
                from: "2026-09-01T10:00:00Z",
                to: "2026-09-01T10:00:00Z",
            }),
        ).toEqual(["start"]);
    });
    it.each([
        { from: "2026-09-02", to: "2026-09-01" },
        { from: "yesterday", to: "2026-09-01" },
        { from: "2026-09-01", to: "2026-02-31" },
    ])("refuses an invalid range %j", async (args) => {
        await expect(list(args)).rejects.toMatchObject({ outcome: "invalid" });
    });
    it.each([
        { from: RANGE.from },
        { to: RANGE.to },
    ])("requires both range arguments through MCP: %j", async (args) => {
        const server = buildMcpServer(RECORDING_TOOLS, viewer(), null);
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "test", version: "1" });
        try {
            await server.connect(serverSide);
            await client.connect(clientSide);
            const result = (await client.callTool({
                name: attendedTool.name,
                arguments: args,
            })) as CallToolResult;
            expect(result.isError).toBe(true);
            expect(result.content).toEqual([
                {
                    type: "text",
                    text: expect.stringContaining("Invalid arguments"),
                },
            ]);
            expect(audit).toHaveBeenCalledWith(
                expect.objectContaining({
                    tool: attendedTool.name,
                    outcome: "invalid",
                    targetIds: [],
                }),
            );
        } finally {
            await client.close();
            await server.close();
        }
    });
    it.each([
        200, 201,
    ])("caps %i matching recordings at 200, newest first, and logs only returned ids", async (count) => {
        const ids: string[] = [];
        for (let i = 0; i < count; i++) {
            const id = `bounded-${String(i).padStart(3, "0")}`;
            ids.push(id);
            await insertRecording(db(), {
                id,
                userId: VIEWER,
                title: id,
                startTime: new Date(
                    Date.UTC(2026, 8, 1, 10, Math.floor(i / 2)),
                ),
            });
        }
        const ctx = context();
        const result = await list(RANGE, ctx);
        const expected = ids.reverse().slice(0, 200);
        expect(result.truncated).toBe(count > 200);
        expect(
            (result.recordings as { title: string }[]).map((row) => row.title),
        ).toEqual(expected);
        expect(ctx.touched).toEqual(expected);
    });
    it("refuses service callers", async () => {
        const ctx = context(serviceCaller(orgUserId, ["tasks:read"]));
        await expect(list(RANGE, ctx)).rejects.toMatchObject({
            outcome: "denied",
            message: "Service accounts cannot list attended recordings",
        });
        expect(ctx.touched).toEqual([]);
    });
    it("refuses unverified email even for own recordings", async () => {
        await insertRecording(db(), { id: "own-unverified", userId: VIEWER });
        await tagged("matched-unverified", await person());
        await db()
            .update(users)
            .set({ emailVerified: false })
            .where(eq(users.id, VIEWER));
        const ctx = context();
        await expect(list(RANGE, ctx)).rejects.toMatchObject({
            outcome: "denied",
            message: expect.stringContaining(
                "identity provider has not verified your email",
            ),
        });
        expect(ctx.touched).toEqual([]);
    });
    it.each([
        "transcripts:read",
        "summaries:read",
        "tasks:read",
    ] as const)("uses the existing %s role and read-only annotations", (role) => {
        const caller = userCaller(VIEWER, EMAIL, [role], orgUserId);
        expect(allowedTools(RECORDING_TOOLS, caller)).toContain(attendedTool);
        expect(attendedTool.annotations).toEqual({
            readOnlyHint: true,
            openWorldHint: false,
        });
        expect(Object.keys(attendedTool.input(caller))).toEqual(["from", "to"]);
    });
});
