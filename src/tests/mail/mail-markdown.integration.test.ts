/** Mail summary Markdown against a real PostgreSQL database. */

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
    chatterItems,
    mailContents,
    mailMessages,
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
        mockEnv: {
            DEFAULT_STORAGE_TYPE: "local" as const,
            LOCAL_STORAGE_PATH: "",
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            DATABASE_URL: "postgres://unused",
        },
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));

import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import { getRecordingMarkdownDocument } from "@/lib/export/document-sidecars";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const OWNER = "mail-markdown-owner";
const OTHER = "mail-markdown-other";
const MAIL_ID = "mail-markdown-item";

describeWithDatabase("mail summary Markdown (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "mail_markdown",
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
        const occurredAt = new Date("2026-10-18T12:00:00.000Z");
        await db()
            .insert(chatterItems)
            .values({
                id: MAIL_ID,
                userId: OWNER,
                kind: "mail",
                title: encryptText("Harbor / proposal"),
                occurredAt,
            });
        await db().insert(mailMessages).values({
            id: MAIL_ID,
            userId: OWNER,
            rawHash: "mail-markdown-hash",
            receivedAt: occurredAt,
            sizeBytes: 512,
            auth: {},
            senderVerified: true,
        });
        await db()
            .insert(mailContents)
            .values({
                itemId: MAIL_ID,
                userId: OWNER,
                parserVersion: 1,
                segments: encryptJsonField([]),
                language: "en",
            });
        await db()
            .insert(aiEnhancements)
            .values({
                id: "mail-markdown-summary",
                itemId: MAIL_ID,
                userId: OWNER,
                summary: encryptText("The harbor proposal is ready."),
                keyPoints: encryptJsonField(["The price is fixed."]),
                actionItems: encryptJsonField(["Send the proposal."]),
                provider: "openai",
                model: "gpt-summary",
                source: "riffado",
            });
    });

    it("renders the owner's summary with a portable filename", async () => {
        const document = await getRecordingMarkdownDocument(
            OWNER,
            MAIL_ID,
            "summary",
            { source: "riffado" },
        );

        expect(document?.filename).toBe("Harbor - proposal.custom.summary.md");
        expect(document?.content).toContain("The harbor proposal is ready.");
        expect(document?.content).toContain("The price is fixed.");
        expect(document?.content).toContain("Send the proposal.");
        expect(document?.content).toContain('provider: "openai"');
        expect(document?.content).toContain('model: "gpt-summary"');
    });

    it("does not render another user's mail or a mail transcript", async () => {
        expect(
            await getRecordingMarkdownDocument(OTHER, MAIL_ID, "summary"),
        ).toBeNull();
        expect(
            await getRecordingMarkdownDocument(OWNER, MAIL_ID, "transcript"),
        ).toBeNull();
    });
});
