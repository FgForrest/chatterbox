/** Mail title, spend, erasure, and deletion through the shared item routes. */

import { and, eq } from "drizzle-orm";
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
    aiEnhancements,
    aiUsageEvents,
    chatterItems,
    itemProcessing,
    learnDismissals,
    learnReviewItems,
    learnRuns,
    mailMessages,
    recordingFolderAssignments,
    recordingFolders,
    recordingTasks,
    users,
} from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef, mockEnv } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    const proxy = new Proxy(
        {},
        {
            get: (_target, property: string | symbol) => {
                const current = ref.current;
                if (!current)
                    throw new Error("test database was not initialized");
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
        mockEnv: {
            IS_HOSTED: false,
            SELF_HOST_MODE: "shared",
            ORG_ACCOUNT_EMAIL: "org@example.test",
            ORG_ACCOUNT_PASSWORD: "organization-password",
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            DATABASE_URL: "postgres://unused",
            WHISPER_REQUEST_TIMEOUT_MS: 60_000,
        },
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/webhooks/emit", () => ({
    emitEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/ai/generate-title", () => ({
    generateTitleFromTranscription: vi
        .fn()
        .mockResolvedValue("Generated mail title"),
}));
vi.mock("@/lib/recordings/title-input", () => ({
    readTitleInput: vi.fn().mockResolvedValue({
        text: "Summary or message text",
        source: "summary",
    }),
}));
vi.mock("@/lib/auth-server", async () => {
    const { AppError, ErrorCode } =
        await vi.importActual<typeof import("@/lib/errors")>("@/lib/errors");
    const { withSessionActor } = await vi.importActual<
        typeof import("@/tests/helpers/session-actor")
    >("@/tests/helpers/session-actor");
    return withSessionActor({
        requireApiSession: vi.fn(async (request: Request) => {
            const id = request.headers.get("x-test-user");
            if (!id) {
                throw new AppError(
                    ErrorCode.AUTH_SESSION_MISSING,
                    "Unauthorized",
                    401,
                );
            }
            const email =
                id === "organization-user"
                    ? "org@example.test"
                    : `${id}@example.test`;
            return { user: { id, email } };
        }),
    });
});

import {
    DELETE as deleteMailRoute,
    GET as getMailDetail,
} from "@/app/api/mail/[id]/route";
import { GET as aiCost } from "@/app/api/recordings/[id]/ai-cost/route";
import { POST as erase } from "@/app/api/recordings/[id]/erase/route";
import { PATCH as rename } from "@/app/api/recordings/[id]/route";
import { POST as regenerate } from "@/app/api/recordings/[id]/title/route";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { loadMailListRows } from "@/lib/mail/list";
import { ensureOrgAccount } from "@/lib/org/account";
import { insertRecordings } from "@/tests/integration/items";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const OWNER = "mail-owner";
const OTHER = "mail-other";
const MAIL = "mail-item";
const OTHER_MAIL = "other-mail-item";
const AUDIO = "audio-item";

type Handler = (
    request: Request,
    context: { params: Promise<{ id: string }> },
) => Promise<Response>;

function call(
    handler: unknown,
    userId: string,
    id: string,
    path: string,
    init: RequestInit = {},
) {
    const headers = new Headers(init.headers);
    headers.set("x-test-user", userId);
    return (handler as Handler)(
        new Request(`http://localhost${path}`, { ...init, headers }),
        { params: Promise.resolve({ id }) },
    );
}

function json(body: unknown): Pick<RequestInit, "headers" | "body"> {
    return {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    };
}

describeWithDatabase("mail item routes (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";
    let orgRootId = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    async function insertMail(id: string, userId: string, subject: string) {
        const now = new Date("2026-10-18T12:00:00Z");
        await db()
            .insert(chatterItems)
            .values({
                id,
                userId,
                kind: "mail",
                title: encryptText(subject),
                occurredAt: now,
                summaryDueAt: now,
            });
        await db()
            .insert(mailMessages)
            .values({
                id,
                userId,
                rawHash: `${id}-hash`,
                receivedAt: now,
                sizeBytes: 100,
                auth: {},
                senderVerified: true,
            });
    }

    async function share(id = MAIL) {
        await db().insert(recordingFolderAssignments).values({
            userId: OWNER,
            itemId: id,
            folderId: orgRootId,
        });
    }

    async function seedLearn(itemId: string, userId: string) {
        const [run] = await db()
            .insert(learnRuns)
            .values({
                id: `${itemId}-run`,
                userId,
                scopeUserId: userId,
                itemId,
                view: "private",
                trigger: "manual",
                transcriptRevision: 1,
                vocabularyVersion: 1,
                status: "ready",
            })
            .returning({ id: learnRuns.id });
        await db()
            .insert(learnReviewItems)
            .values({
                runId: run?.id ?? "",
                userId,
                kind: "known_fact",
                fingerprintHmac: "a".repeat(64),
                payload: {},
            });
        await db()
            .insert(learnDismissals)
            .values({
                userId,
                itemId,
                fingerprintHmac: "b".repeat(64),
            });
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "mail_item_routes",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        await db().delete(users);
        await db()
            .insert(users)
            .values([
                { id: OWNER, email: `${OWNER}@example.test` },
                { id: OTHER, email: `${OTHER}@example.test` },
            ]);
        orgUserId = (await ensureOrgAccount()) ?? "";
        const [root] = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, orgUserId));
        orgRootId = root?.id ?? "";
        await insertMail(MAIL, OWNER, "Original subject");
        await insertMail(OTHER_MAIL, OTHER, "Other subject");
        await insertRecordings(db(), {
            id: AUDIO,
            userId: OWNER,
            deviceSn: "local",
            plaudFileId: AUDIO,
            filename: encryptText("Recording"),
            duration: 1_000,
            startTime: new Date("2026-10-18T12:00:00Z"),
            endTime: new Date("2026-10-18T12:00:01Z"),
            filesize: 10,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: `${OWNER}/${AUDIO}.mp3`,
            plaudVersion: "1",
            summaryDueAt: new Date("2026-10-18T13:00:00Z"),
        });
    });

    it("renames own mail, freezes its private view when shared, and lets the Organization rename it", async () => {
        const own = await call(rename, OWNER, MAIL, `/api/recordings/${MAIL}`, {
            method: "PATCH",
            ...json({ filename: "Renamed subject" }),
        });
        expect(own.status).toBe(200);

        await share();
        const frozen = await call(
            rename,
            OWNER,
            MAIL,
            `/api/recordings/${MAIL}`,
            { method: "PATCH", ...json({ filename: "Private rename" }) },
        );
        expect(frozen.status).toBe(409);
        const member = await call(
            rename,
            OTHER,
            MAIL,
            `/api/recordings/${MAIL}?view=org`,
            { method: "PATCH", ...json({ filename: "Member rename" }) },
        );
        expect(member.status).toBe(403);
        const curated = await call(
            rename,
            orgUserId,
            MAIL,
            `/api/recordings/${MAIL}?view=org`,
            { method: "PATCH", ...json({ filename: "Organization title" }) },
        );
        expect(curated.status).toBe(200);
        const [item] = await db()
            .select({ title: chatterItems.title })
            .from(chatterItems)
            .where(
                and(eq(chatterItems.id, MAIL), eq(chatterItems.userId, OWNER)),
            );
        expect(decryptText(item?.title)).toBe("Organization title");
        expect(
            (await loadMailListRows(OWNER)).find((row) => row.id === MAIL)
                ?.filename,
        ).toBe("Organization title");
    });

    it("regenerates mail titles from the shared title input under the same access rules", async () => {
        const own = await call(
            regenerate,
            OWNER,
            MAIL,
            `/api/recordings/${MAIL}/title`,
            { method: "POST" },
        );
        expect(own.status).toBe(200);
        await db()
            .update(chatterItems)
            .set({ titleEditedAt: null })
            .where(
                and(eq(chatterItems.id, MAIL), eq(chatterItems.userId, OWNER)),
            );
        await share();
        expect(
            (
                await call(
                    regenerate,
                    OWNER,
                    MAIL,
                    `/api/recordings/${MAIL}/title`,
                    { method: "POST" },
                )
            ).status,
        ).toBe(409);
        expect(
            (
                await call(
                    regenerate,
                    OTHER,
                    MAIL,
                    `/api/recordings/${MAIL}/title?view=org`,
                    { method: "POST" },
                )
            ).status,
        ).toBe(403);
        expect(
            (
                await call(
                    regenerate,
                    orgUserId,
                    MAIL,
                    `/api/recordings/${MAIL}/title?view=org`,
                    { method: "POST" },
                )
            ).status,
        ).toBe(200);
    });

    it("returns mail AI spend only in an allowed view", async () => {
        await db().insert(aiUsageEvents).values({
            itemId: MAIL,
            userId: OWNER,
            actorUserId: OWNER,
            payerUserId: OWNER,
            operation: "summary",
            provider: "OpenAI",
            model: "gpt-test",
            costUsd: "0.125",
        });
        const own = await call(
            aiCost,
            OWNER,
            MAIL,
            `/api/recordings/${MAIL}/ai-cost`,
        );
        expect(own.status).toBe(200);
        await expect(own.json()).resolves.toMatchObject({
            totalUsd: 0.125,
            requestCount: 1,
        });
        expect(
            (await call(aiCost, OTHER, MAIL, `/api/recordings/${MAIL}/ai-cost`))
                .status,
        ).toBe(404);
        await share();
        expect(
            (
                await call(
                    aiCost,
                    OTHER,
                    MAIL,
                    `/api/recordings/${MAIL}/ai-cost?view=org`,
                )
            ).status,
        ).toBe(200);
    });

    it("returns the owner's processing projection only to allowed mail viewers", async () => {
        await db()
            .insert(itemProcessing)
            .values({
                itemId: MAIL,
                userId: OWNER,
                view: "private",
                phases: {
                    categorize: {
                        state: "done",
                        reason: "legacy",
                        generation: 0,
                        at: "2026-10-18T12:00:00.000Z",
                    },
                },
            });
        expect(
            (await call(getMailDetail, OTHER, MAIL, `/api/mail/${MAIL}`))
                .status,
        ).toBe(404);
        const owner = await call(
            getMailDetail,
            OWNER,
            MAIL,
            `/api/mail/${MAIL}`,
        );
        expect(owner.status).toBe(200);
        await expect(owner.json()).resolves.toMatchObject({
            processing: { itemId: MAIL, kind: "mail" },
        });

        await share();
        const member = await call(
            getMailDetail,
            OTHER,
            MAIL,
            `/api/mail/${MAIL}`,
        );
        expect(member.status).toBe(200);
        await expect(member.json()).resolves.toMatchObject({
            processing: { itemId: MAIL, kind: "mail" },
        });
    });

    it("erases a mail summary and its derived tasks without touching another user", async () => {
        await db()
            .insert(aiEnhancements)
            .values([
                {
                    itemId: MAIL,
                    userId: OWNER,
                    summary: encryptText("summary"),
                    provider: "test",
                    model: "test",
                },
                {
                    itemId: OTHER_MAIL,
                    userId: OTHER,
                    summary: encryptText("other"),
                    provider: "test",
                    model: "test",
                },
            ]);
        await db()
            .insert(recordingTasks)
            .values({
                itemId: MAIL,
                userId: OWNER,
                status: "proposed",
                text: encryptText("task"),
                source: "riffado",
            });
        const response = await call(
            erase,
            OWNER,
            MAIL,
            `/api/recordings/${MAIL}/erase`,
            { method: "POST", ...json({ scope: "summary" }) },
        );
        expect(response.status).toBe(200);
        expect(
            await db()
                .select()
                .from(aiEnhancements)
                .where(eq(aiEnhancements.itemId, MAIL)),
        ).toHaveLength(0);
        expect(
            await db()
                .select()
                .from(recordingTasks)
                .where(eq(recordingTasks.itemId, MAIL)),
        ).toHaveLength(0);
        expect(
            await db()
                .select()
                .from(aiEnhancements)
                .where(eq(aiEnhancements.itemId, OTHER_MAIL)),
        ).toHaveLength(1);
    });

    it("withdraws shared mail before summary erasure and refuses the Organization view", async () => {
        await share();
        const refused = await call(
            erase,
            OWNER,
            MAIL,
            `/api/recordings/${MAIL}/erase`,
            { method: "POST", ...json({ scope: "summary" }) },
        );
        expect(refused.status).toBe(409);
        expect(
            (
                await call(
                    erase,
                    orgUserId,
                    MAIL,
                    `/api/recordings/${MAIL}/erase`,
                    { method: "POST", ...json({ scope: "summary" }) },
                )
            ).status,
        ).toBe(404);
        const erased = await call(
            erase,
            OWNER,
            MAIL,
            `/api/recordings/${MAIL}/erase`,
            { method: "POST", ...json({ scope: "summary", withdraw: true }) },
        );
        expect(erased.status).toBe(200);
        expect(
            await db()
                .select()
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.itemId, MAIL)),
        ).toHaveLength(0);
    });

    it("erases Learn runs, reviews, dismissals, and the hold with user scoping", async () => {
        await seedLearn(MAIL, OWNER);
        await seedLearn(OTHER_MAIL, OTHER);
        await seedLearn(AUDIO, OWNER);
        const response = await call(
            erase,
            OWNER,
            MAIL,
            `/api/recordings/${MAIL}/erase`,
            { method: "POST", ...json({ scope: "learn" }) },
        );
        expect(response.status).toBe(200);
        expect(
            await db()
                .select()
                .from(learnRuns)
                .where(eq(learnRuns.itemId, MAIL)),
        ).toHaveLength(0);
        expect(
            await db()
                .select()
                .from(learnReviewItems)
                .where(eq(learnReviewItems.runId, `${MAIL}-run`)),
        ).toHaveLength(0);
        expect(
            await db()
                .select()
                .from(learnDismissals)
                .where(eq(learnDismissals.itemId, MAIL)),
        ).toHaveLength(0);
        const [item] = await db()
            .select({ hold: chatterItems.summaryDueAt })
            .from(chatterItems)
            .where(
                and(eq(chatterItems.id, MAIL), eq(chatterItems.userId, OWNER)),
            );
        expect(item?.hold).toBeNull();
        expect(
            await db()
                .select()
                .from(learnRuns)
                .where(eq(learnRuns.itemId, OTHER_MAIL)),
        ).toHaveLength(1);

        const audio = await call(
            erase,
            OWNER,
            AUDIO,
            `/api/recordings/${AUDIO}/erase`,
            { method: "POST", ...json({ scope: "learn" }) },
        );
        expect(audio.status).toBe(200);
        expect(
            await db()
                .select()
                .from(learnRuns)
                .where(eq(learnRuns.itemId, AUDIO)),
        ).toHaveLength(0);
    });

    it("deletes only the owner's mail, including when it is shared", async () => {
        await share();
        expect(
            (
                await call(deleteMailRoute, OTHER, MAIL, `/api/mail/${MAIL}`, {
                    method: "DELETE",
                })
            ).status,
        ).toBe(404);
        expect(
            (
                await call(deleteMailRoute, OWNER, MAIL, `/api/mail/${MAIL}`, {
                    method: "DELETE",
                })
            ).status,
        ).toBe(200);
        expect(
            await db()
                .select()
                .from(chatterItems)
                .where(eq(chatterItems.id, MAIL)),
        ).toHaveLength(0);
        expect(
            await db()
                .select()
                .from(chatterItems)
                .where(eq(chatterItems.id, OTHER_MAIL)),
        ).toHaveLength(1);
    });
});
