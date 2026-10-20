import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, desc, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
    accounts,
    aiEnhancements,
    mailMessages,
    recordingFolders,
    transcriptions,
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
            IS_HOSTED: false,
            SELF_HOST_MODE: "shared" as const,
            ORG_ACCOUNT_EMAIL: "org@example.com",
            ORG_ACCOUNT_PASSWORD: undefined,
            ORG_ACCOUNT_NAME: undefined,
            OIDC_ISSUER_URL: "https://sso.example.com/realms/test",
            OIDC_CLIENT_ID: "riffado",
            OIDC_CLIENT_SECRET: "secret",
            MAIL_DOMAIN: "mail.example.com",
            MAIL_ORG_NICKNAME: "team",
            MAIL_FORMER_ORG_NICKNAMES: [] as string[],
            MAIL_ADDRESS_HASH_SECRET: "m".repeat(40),
            MAIL_INGEST_SECRET: "i".repeat(40),
            MAIL_INACTIVE_DAYS: 180,
            MAIL_MAX_SIGNATURE_AGE_HOURS: 72,
            MAIL_DAILY_LIMIT: 500,
            MAIL_MAX_MESSAGE_MB: 36,
            DEFAULT_STORAGE_TYPE: "local" as const,
            LOCAL_STORAGE_PATH: "",
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            DATABASE_URL: "postgres://unused",
            AUTO_SUMMARY_RATE_LIMIT_PER_HOUR: 100,
        },
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));

import { markRecordingDeleted } from "@/db/items";
import { encryptText } from "@/lib/encryption/fields";
import { addRecordingToFolder, ensureRootFolders } from "@/lib/folders/folders";
import { createSecretAddress, ensureMailbox } from "@/lib/mail/addresses";
import { authenticateMessage } from "@/lib/mail/dkim";
import { ingestMail, precheckMail } from "@/lib/mail/ingest";
import { ensureOrgAccount } from "@/lib/org/account";
import {
    foldForSearch,
    type ItemSearchScope,
    searchItems,
} from "@/lib/search/item-search";
import { insertRecordings } from "@/tests/integration/items";
import {
    rawMessage,
    signMessage,
    testResolver,
    testSigner,
} from "@/tests/mail/dkim-fixtures";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const senderSigner = testSigner("example.com");
const resolver = testResolver([senderSigner]);

const BODY = [
    "Příliš žluťoučký kůň: the pilot budget is approved.",
    "",
    "Best regards,",
    "Jan Novotny",
    "Head of Lighthouse",
    "",
    "On Thu, 8 Oct 2026 at 17:40, Eva Buyer <buyer@example.com> wrote:",
    "> The warehouse expects the samples on Monday.",
].join("\n");

describeWithDatabase("searching the pile (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let storageDir = "";
    let orgUserId = "";
    let janMail = "";
    let evaMail = "";
    let token = "";
    let janMailboxAddress = "";
    let orgRootId = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    async function deliver(
        userMailbox: string,
        subject: string,
        body: string,
        from = "Jan Novotny <jan@example.com>",
        options: {
            messageId?: string;
            inReplyTo?: string;
            contentType?: string;
        } = {},
    ): Promise<string> {
        const raw = await signMessage(
            rawMessage(
                [
                    `From: ${from}`,
                    `To: ${userMailbox}`,
                    `Subject: ${subject}`,
                    "Date: Fri, 09 Oct 2026 14:02:00 +0200",
                    `Message-ID: <${options.messageId ?? Math.random().toString(36).slice(2)}@example.com>`,
                    ...(options.inReplyTo
                        ? [`In-Reply-To: <${options.inReplyTo}@example.com>`]
                        : []),
                    "MIME-Version: 1.0",
                    `Content-Type: ${options.contentType ?? "text/plain; charset=utf-8"}`,
                ],
                body,
            ),
            senderSigner,
        );
        const now = new Date();
        const facts = await authenticateMessage(raw, { resolver, now });
        await precheckMail({ recipients: [userMailbox], facts });
        const result = await ingestMail({
            raw,
            recipients: [userMailbox],
            spf: "pass",
            receivedAt: now,
            resolver,
        });
        const [message] = await db()
            .select({ id: mailMessages.id })
            .from(mailMessages)
            .orderBy(desc(mailMessages.createdAt))
            .limit(1);
        if (!message) {
            throw new Error(
                `mail not stored: ${JSON.stringify(result.outcomes)}`,
            );
        }
        return message.id;
    }

    async function share(itemId: string) {
        await addRecordingToFolder({
            userId: "u-jan",
            recordingId: itemId,
            folderId: orgRootId,
        });
    }

    const ids = async (
        viewerUserId: string,
        query: string,
        view: "private" | "org" = "private",
        scopes?: readonly ItemSearchScope[],
    ) =>
        (await searchItems({ viewerUserId, view, query, scopes })).hits.map(
            (hit) => hit.id,
        );

    beforeAll(async () => {
        storageDir = mkdtempSync(path.join(tmpdir(), "riffado-search-"));
        mockEnv.LOCAL_STORAGE_PATH = storageDir;
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "item_search",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        orgUserId = (await ensureOrgAccount()) ?? "";
        const [orgRoot] = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(
                and(
                    eq(recordingFolders.userId, orgUserId),
                    isNull(recordingFolders.parentId),
                ),
            );
        orgRootId = orgRoot?.id ?? "";
        for (const [id, email, sub] of [
            ["u-jan", "jan@example.com", "sub-jan"],
            ["u-eva", "eva@example.com", "sub-eva"],
        ] as const) {
            await db().insert(users).values({
                id,
                email,
                emailVerified: true,
                lastSsoLoginAt: new Date(),
            });
            await db()
                .insert(accounts)
                .values({ userId: id, accountId: sub, providerId: "oidc" });
            await ensureRootFolders(id);
        }
        const mailbox = await ensureMailbox("u-jan");
        const evaMailbox = await ensureMailbox("u-eva");
        janMailboxAddress = `${mailbox?.localPart}@mail.example.com`;
        const secret = await createSecretAddress({
            userId: "u-jan",
            baseAddressId: mailbox?.id ?? "",
            label: null,
        });
        token = secret.localPart;
        janMail = await deliver(
            `${mailbox?.localPart}@mail.example.com`,
            "Flight plan",
            `${BODY}\n\nFile the receipts through ${secret.localPart}@mail.example.com please.`,
        );
        evaMail = await deliver(
            `${evaMailbox?.localPart}@mail.example.com`,
            "Eva's own",
            "The pilot budget is Eva's secret too.",
            "Eva Buyer <eva@example.com>",
        );
        expect(evaMail).not.toBe(janMail);
        await insertRecordings(db(), {
            id: "rec-jan",
            userId: "u-jan",
            deviceSn: "SN-1",
            plaudFileId: "plaud-rec-jan",
            filename: encryptText("Weekly sync"),
            duration: 60_000,
            startTime: new Date("2026-09-01T10:00:00Z"),
            endTime: new Date("2026-09-01T10:01:00Z"),
            filesize: 1000,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: "u-jan/rec-jan.mp3",
            plaudVersion: "1",
        });
        await db()
            .insert(transcriptions)
            .values({
                recordingId: "rec-jan",
                userId: "u-jan",
                text: encryptText("We talked about the zeppelin roadmap."),
                provider: "openai",
                model: "whisper-1",
                source: "riffado",
            });
        await db()
            .insert(aiEnhancements)
            .values([
                {
                    itemId: "rec-jan",
                    userId: "u-jan",
                    summary: encryptText(
                        "The constellation schedule is approved.",
                    ),
                    provider: "openai",
                    model: "test-model",
                    source: "riffado",
                },
                {
                    itemId: janMail,
                    userId: "u-jan",
                    summary: encryptText("The harbor launch is ready."),
                    provider: "openai",
                    model: "test-model",
                    source: "riffado",
                },
            ]);
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
        rmSync(storageDir, { recursive: true, force: true });
    }, 30_000);

    it("folds case and accents", () => {
        expect(foldForSearch("Příliš ŽLUŤOUČKÝ")).toBe("prilis zlutoucky");
    });

    it("finds a mail by what it says itself, accents and case aside", async () => {
        const result = await searchItems({
            viewerUserId: "u-jan",
            view: "private",
            query: "zlutoucky BUDGET",
        });
        expect(result.complete).toBe(true);
        expect(result.hits).toEqual([
            expect.objectContaining({
                id: janMail,
                kind: "mail",
                snippet: expect.stringContaining("žluťoučký kůň"),
            }),
        ]);
    });

    it("finds quoted text but never a signature", async () => {
        expect(await ids("u-jan", "warehouse")).toEqual([janMail]);
        expect(await ids("u-jan", "Lighthouse")).toEqual([]);
        expect(await ids("u-jan", "pilot")).toEqual([janMail]);
    });

    it("finds the Czech Gmail forward's words but not its quoted signature", async () => {
        const forwarded = await deliver(
            janMailboxAddress,
            "Forwarded offer",
            readFileSync(
                path.join(__dirname, "../mail/fixtures/gmail-forward-cs.html"),
                "utf8",
            ),
            undefined,
            { contentType: "text/html; charset=utf-8" },
        );
        const result = await searchItems({
            viewerUserId: "u-jan",
            view: "private",
            query: "cenu listopadu",
        });
        expect(result.hits).toEqual([
            {
                id: forwarded,
                kind: "mail",
                snippet: expect.stringContaining("můžeme přijmout cenu"),
            },
        ]);
        expect(await ids("u-jan", "nakupu")).toEqual([]);
    });

    it.each([
        "",
        "> ",
    ])("never searches a disclaimer at quote prefix %j", async (prefix) => {
        await deliver(
            janMailboxAddress,
            "Notice",
            `The documents are ready.\n\n${prefix}This email is confidential and intended solely for its recipient; disclaimerneedle must not be disclosed.`,
        );
        expect(await ids("u-jan", "disclaimerneedle")).toEqual([]);
    });

    it("never searches attachment names or text", async () => {
        await deliver(
            janMailboxAddress,
            "Documents",
            [
                "--search-boundary",
                "Content-Type: text/plain; charset=utf-8",
                "",
                "The documents are enclosed.",
                "--search-boundary",
                "Content-Type: text/plain; charset=utf-8",
                'Content-Disposition: attachment; filename="attachmentname.txt"',
                "",
                "attachmentword",
                "--search-boundary--",
            ].join("\r\n"),
            undefined,
            { contentType: 'multipart/mixed; boundary="search-boundary"' },
        );
        expect(await ids("u-jan", "attachmentname")).toEqual([]);
        expect(await ids("u-jan", "attachmentword")).toEqual([]);
    });

    it("skips known quotes only when the original is a candidate in the searched library", async () => {
        const original = await deliver(
            janMailboxAddress,
            "Original",
            "The juniper shipment is ready. Privateoriginalword.",
            undefined,
            { messageId: "known-original" },
        );
        const reply = await deliver(
            janMailboxAddress,
            "Reply",
            [
                "Acknowledged.",
                "",
                "On Thu, 8 Oct 2026 at 17:40, Eva Buyer <buyer@example.com> wrote:",
                "> The juniper shipment is ready.",
            ].join("\n"),
            undefined,
            { inReplyTo: "known-original" },
        );
        await share(reply);
        for (const scopes of [undefined, ["content"] as const]) {
            expect(await ids("u-jan", "juniper", "private", scopes)).toEqual([
                original,
            ]);
            const ownOrg = await searchItems({
                viewerUserId: "u-jan",
                view: "org",
                query: "juniper",
                scopes,
            });
            expect(ownOrg.hits).toEqual([
                {
                    id: reply,
                    kind: "mail",
                    snippet: expect.stringContaining("juniper"),
                },
            ]);
            expect(JSON.stringify(ownOrg)).not.toContain(original);
        }
        const result = await searchItems({
            viewerUserId: "u-eva",
            view: "org",
            query: "juniper",
        });
        expect(result.hits).toEqual([
            {
                id: reply,
                kind: "mail",
                snippet: expect.stringContaining("juniper"),
            },
        ]);
        expect(JSON.stringify(result)).not.toContain(original);
        expect(await ids("u-eva", "privateoriginalword", "org")).toEqual([]);
        expect(await ids("u-eva", "juniper")).toEqual([]);
        await share(original);
        expect(await ids("u-jan", "juniper")).toEqual([original]);
        expect(await ids("u-jan", "juniper", "org")).toEqual([original]);
        expect(await ids("u-eva", "juniper", "org")).toEqual([original]);
        await markRecordingDeleted(db(), {
            id: original,
            userId: "u-jan",
            at: new Date(),
        });
        expect(await ids("u-jan", "juniper")).toEqual([reply]);
        expect(await ids("u-eva", "juniper", "org")).toEqual([reply]);
    });

    it("cuts app search snippets at word boundaries in both libraries", async () => {
        const text = `${"amber lanterns shimmer gently ".repeat(12)}snippetneedle ${"violet ribbons flutter softly ".repeat(12)}`;
        const mail = await deliver(
            janMailboxAddress,
            "Excerpt discussion",
            text,
        );
        await share(mail);
        for (const view of ["private", "org"] as const) {
            const result = await searchItems({
                viewerUserId: "u-jan",
                view,
                query: "snippetneedle",
                scopes: ["content"],
            });
            expect(result.hits).toHaveLength(1);
            expect(result.hits[0]?.id).toBe(mail);
            const snippet = result.hits[0]?.snippet ?? "";
            expect(snippet).toContain("snippetneedle");
            expect(snippet.startsWith("…")).toBe(true);
            expect(snippet.endsWith("…")).toBe(true);
            const literal = snippet.replace(/^…|…$/g, "");
            const start = text.indexOf(literal);
            const end = start + literal.length;
            expect(start).toBeGreaterThanOrEqual(0);
            expect(/\s/u.test(text[start - 1])).toBe(true);
            expect(/\s/u.test(text[end])).toBe(true);
        }
    });

    it("masks secret addresses in a colleague's quoted text before matching", async () => {
        const quoted = await deliver(
            janMailboxAddress,
            "Quoted address",
            [
                "Please handle this.",
                "",
                "On Thu, 8 Oct 2026 at 17:40, Eva Buyer <buyer@example.com> wrote:",
                `> Use the quotedaddress ${token}@mail.example.com for delivery.`,
            ].join("\n"),
        );
        await share(quoted);
        const result = await searchItems({
            viewerUserId: "u-eva",
            view: "org",
            query: "quotedaddress",
        });
        expect(result.hits).toEqual([
            {
                id: quoted,
                kind: "mail",
                snippet: expect.stringContaining("jan."),
            },
        ]);
        expect(JSON.stringify(result)).not.toContain(token);
        expect(
            await ids("u-eva", `quotedaddress ${token.slice(0, 7)}`, "org"),
        ).toEqual([]);
        expect(
            await ids("u-jan", `quotedaddress ${token.slice(0, 7)}`),
        ).toEqual([quoted]);
        const own = await searchItems({
            viewerUserId: "u-jan",
            view: "private",
            query: "quotedaddress",
        });
        expect(own.hits[0]?.snippet).toContain(token);
    });

    it("finds a recording by its transcript", async () => {
        expect(await ids("u-jan", "zeppelin")).toEqual(["rec-jan"]);
    });

    describe.each([
        {
            scope: "title" as const,
            audioQuery: "weekly",
            mailQuery: "flight",
        },
        {
            scope: "content" as const,
            audioQuery: "zeppelin",
            mailQuery: "zlutoucky",
        },
        {
            scope: "summary" as const,
            audioQuery: "constellation",
            mailQuery: "harbor",
        },
    ])("$scope search scope", ({ scope, audioQuery, mailQuery }) => {
        it("finds audio and mail only from that field", async () => {
            expect(await ids("u-jan", audioQuery, "private", [scope])).toEqual([
                "rec-jan",
            ]);
            expect(await ids("u-jan", mailQuery, "private", [scope])).toEqual([
                janMail,
            ]);
        });
    });

    it("reads only the library asked for", async () => {
        expect(await ids("u-eva", "pilot")).toEqual([evaMail]);
        expect(await ids("u-eva", "zeppelin")).toEqual([]);
        expect(await ids("u-eva", "pilot", "org")).toEqual([]);
    });

    it("masks a colleague's secret addresses in the Organization library", async () => {
        await share(janMail);
        const { hits } = await searchItems({
            viewerUserId: "u-eva",
            view: "org",
            query: "receipts",
        });
        expect(hits.map((hit) => hit.id)).toEqual([janMail]);
        expect(hits[0]?.snippet).toContain("jan.");
        expect(hits[0]?.snippet).not.toContain(token);
        expect(await ids("u-eva", token.slice(0, 7), "org")).toEqual([]);
        expect(await ids("u-jan", `receipts ${token.slice(0, 7)}`)).toEqual([
            janMail,
        ]);
        const own = await searchItems({
            viewerUserId: "u-jan",
            view: "private",
            query: "receipts",
        });
        expect(own.hits[0]?.snippet).toContain(token);
    });

    it("leaves deleted items out", async () => {
        await markRecordingDeleted(db(), {
            id: "rec-jan",
            userId: "u-jan",
            at: new Date(),
        });
        expect(await ids("u-jan", "zeppelin")).toEqual([]);
    });
});
