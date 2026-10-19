/**
 * Mail through the MCP server against a real PostgreSQL (D8): without
 * `mail:read` no tool returns a mail, its words or its source, while the
 * tasks and facts learned from it stay listed under their own roles; with
 * it the mail tools read the pile, every result flagged untrusted, and
 * secret addresses masked even for their owner.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, desc, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
    accounts,
    aiEnhancements,
    apiCredentials,
    apiRateLimitBuckets,
    chatterItems,
    knowledgeFactEvidence,
    knowledgeFacts,
    mailContents,
    mailMessages,
    mailParticipants,
    personEmails,
    recordingFolderAssignments,
    recordingFolders,
    recordingTasks,
    taskMentions,
    users,
} from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef, mockEnv, createCompletion } = vi.hoisted(() => {
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
        createCompletion: vi.fn(),
        mockEnv: {
            MCP_AUDIENCE: "test-mcp",
            MCP_CONNECTOR_KEYS: [],
            MCP_ALLOWED_CLIENTS: [],
            MCP_PUBLIC_CLIENTS: [],
            IS_HOSTED: false,
            SELF_HOST_MODE: "shared" as const,
            APP_URL: "https://riffado.example.test",
            ORG_ACCOUNT_EMAIL: "org@example.test",
            ORG_ACCOUNT_PASSWORD: undefined,
            ORG_ACCOUNT_NAME: undefined,
            OIDC_ISSUER_URL: "https://sso.example.test/realms/acme",
            OIDC_CLIENT_ID: "riffado",
            OIDC_CLIENT_SECRET: "secret",
            MAIL_DOMAIN: "klepna.example",
            MAIL_ORG_NICKNAME: "acme",
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
            KNOWLEDGE_MEMORY_MB: 64,
        },
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/mcp/audit", () => ({ recordMcpAccess: vi.fn() }));
vi.mock("@/lib/mcp/rate-limit", () => ({
    allowMcpScan: vi.fn().mockResolvedValue(true),
    limitMcpSubject: vi.fn().mockResolvedValue(null),
    mcpClientIp: vi.fn().mockReturnValue(null),
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("openai", async (importOriginal) => {
    const actual = await importOriginal<typeof import("openai")>();
    return {
        ...actual,
        OpenAI: class {
            chat = { completions: { create: createCompletion } };
        },
    };
});

import { POST } from "@/app/api/mcp/route";
import type { ContentParticipant, ContentSegment } from "@/lib/content/types";
import { encrypt } from "@/lib/encryption";
import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import { addRecordingToFolder, ensureRootFolders } from "@/lib/folders/folders";
import { createEntity } from "@/lib/knowledge/entities";
import { confirmFactFromMailInTx } from "@/lib/knowledge/facts";
import { knowledgeStore } from "@/lib/knowledge/knowledge-loader";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { createPerson } from "@/lib/knowledge/people";
import { seedCoreVocabulary } from "@/lib/knowledge/vocabulary";
import { createSecretAddress, ensureMailbox } from "@/lib/mail/addresses";
import { authenticateMessage } from "@/lib/mail/dkim";
import { participantAddressHash } from "@/lib/mail/hash";
import { ingestMail, precheckMail } from "@/lib/mail/ingest";
import { segmentMail } from "@/lib/mail/segment";
import type { McpCaller } from "@/lib/mcp/caller";
import * as callerModule from "@/lib/mcp/caller";
import * as rateLimitModule from "@/lib/mcp/rate-limit";
import { allowedTools } from "@/lib/mcp/registry";
import type { McpRole } from "@/lib/mcp/roles";
import * as tokenModule from "@/lib/mcp/token";
import { ALL_TOOLS } from "@/lib/mcp/tools";
import { ensureOrgAccount } from "@/lib/org/account";
import { generateSummaryForRecording } from "@/lib/summary/generate-summary";
import { taskViewerById } from "@/lib/tasks/access";
import { acceptReview } from "@/lib/tasks/tasks";
import {
    rawMessage,
    signMessage,
    testResolver,
    testSigner,
} from "@/tests/mail/dkim-fixtures";
import { serviceCaller, userCaller } from "@/tests/mcp/fixtures";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const company = testSigner("company.example");
const resolver = testResolver([company]);

interface TaskOut {
    id: string;
    text: string;
    kind: "audio" | "mail";
    untrusted?: true;
    quote: string | null;
    due_phrase: string | null;
    recording: { id: string; title: string } | null;
    url: string | null;
}

interface SearchOut {
    results: {
        mail: {
            id: string;
            subject: string;
            from: { name: string | null; address: string } | null;
            url: string;
        };
        snippets: { part: string; author: string | null; text: string }[];
    }[];
    scanned: number;
    complete: boolean;
    continue_before: string | null;
    resolved?: { id: string; input: string }[];
}

interface FactOut {
    id: string;
    origin: string;
    evidence?: {
        recording_id: string;
        kind: string;
        quote: string;
        quoted: boolean;
        untrusted?: true;
    }[];
}

async function call<T>(
    name: string,
    caller: McpCaller,
    args: Record<string, unknown>,
): Promise<T> {
    const definition = ALL_TOOLS.find((tool) => tool.name === name);
    if (!definition) throw new Error(`no tool ${name}`);
    const parsed = z.object(definition.input(caller)).parse(args);
    return (await definition.run(
        { caller, touched: [] },
        parsed,
    )) as unknown as T;
}

describeWithDatabase("mail through the MCP server (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let storageDir = "";
    let orgUserId = "";
    let itemId = "";
    let factId = "";
    let personId = "";
    let token = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    const jan = (roles: McpRole[]) =>
        userCaller("u-jan", "jan@company.example", roles, orgUserId);
    const READ: McpRole[] = [
        "tasks:read",
        "knowledge:read",
        "transcripts:read",
        "summaries:read",
    ];

    beforeAll(async () => {
        storageDir = mkdtempSync(path.join(tmpdir(), "riffado-mcp-mail-"));
        mockEnv.LOCAL_STORAGE_PATH = storageDir;
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "mcp_mail",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        orgUserId = (await ensureOrgAccount()) ?? "";
        await db().insert(users).values({
            id: "u-jan",
            email: "jan@company.example",
            emailVerified: true,
            lastSsoLoginAt: new Date(),
        });
        await db().insert(accounts).values({
            userId: "u-jan",
            accountId: "sub-jan",
            providerId: "oidc",
        });
        await ensureRootFolders("u-jan");
        const mailbox = await ensureMailbox("u-jan");
        await db()
            .insert(apiCredentials)
            .values({
                userId: "u-jan",
                provider: "openai",
                apiKey: encrypt("key"),
                defaultModel: "gpt-4o-mini",
                isDefaultEnhancement: true,
            });
        knowledgeStore().invalidateAll();
        await seedCoreVocabulary();

        const secret = await createSecretAddress({
            userId: "u-jan",
            baseAddressId: mailbox?.id ?? "",
            label: null,
        });
        token = secret.localPart;
        const raw = await signMessage(
            rawMessage(
                [
                    // A display name carrying a secret address.
                    `From: "Jan Novotny ${secret.localPart}@klepna.example" <jan@company.example>`,
                    "To: Eva Buyer <eva@client.example>, jan@klepna.example",
                    "Subject: Contract",
                    "Date: Fri, 09 Oct 2026 14:02:00 +0200",
                    "Message-ID: <mcp-mail@company.example>",
                    "MIME-Version: 1.0",
                    "Content-Type: text/plain; charset=utf-8",
                ],
                `Petra Mala is our CFO now. Eva, please send the signed contract by Friday. File it through ${secret.localPart}@klepna.example.`,
            ),
            company,
        );
        const now = new Date();
        const facts = await authenticateMessage(raw, { resolver, now });
        await precheckMail({ recipients: ["jan@klepna.example"], facts });
        await ingestMail({
            raw,
            recipients: ["jan@klepna.example"],
            spf: "pass",
            receivedAt: now,
            resolver,
        });
        const [message] = await db()
            .select({ id: mailMessages.id })
            .from(mailMessages)
            .orderBy(desc(mailMessages.createdAt))
            .limit(1);
        itemId = message?.id ?? "";

        createCompletion.mockReset();
        createCompletion.mockResolvedValueOnce({
            choices: [
                {
                    message: {
                        content: JSON.stringify({
                            summary: "Jan asks Eva for the signed contract.",
                            keyPoints: [],
                            actionItems: [
                                {
                                    text: "Send the signed contract",
                                    speaker: null,
                                    assignee: null,
                                    due: {
                                        phrase: "by Friday",
                                        date: "2026-10-09",
                                    },
                                    quote: "please send the signed contract by Friday",
                                },
                            ],
                            taskUpdates: [],
                        }),
                    },
                },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10 },
        });
        await generateSummaryForRecording("u-jan", itemId);
        await acceptReview(await taskViewerById("u-jan"), itemId);

        personId = (
            await createPerson({
                userId: "u-jan",
                displayName: "Petra Mala",
                createdByUserId: "u-jan",
            })
        ).id;
        const [content] = await db()
            .select({ revision: mailContents.revision })
            .from(mailContents)
            .where(eq(mailContents.itemId, itemId));
        factId = await db().transaction((tx) =>
            confirmFactFromMailInTx(tx, {
                actorUserId: "u-jan",
                ownerUserId: "u-jan",
                itemId,
                revision: content?.revision ?? 0,
                text: { segmentIndex: 0, charStart: 0, charEnd: 25 },
                subject: { personId },
                relationKey: "has_role",
                object: { literal: "CFO" },
            }),
        );
        knowledgeStore().invalidateAll();
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
        rmSync(storageDir, { recursive: true, force: true });
    }, 30_000);

    it("never shows a model a secret address", () => {
        const request = createCompletion.mock.calls[0]?.[0] as {
            messages: { role: string; content: string }[];
        };
        const sent = request.messages.map((m) => m.content).join("\n");
        expect(sent).toContain("please send the signed contract by Friday");
        expect(sent).not.toContain(token);
    });

    it("offers the mail tools only with mail:read", () => {
        const names = (roles: McpRole[]) =>
            allowedTools(ALL_TOOLS, jan(roles)).map((tool) => tool.name);
        expect(names(READ)).not.toContain("list_mail");
        expect(names(READ)).not.toContain("get_mail");
        expect(names(READ)).not.toContain("search_mail");
        expect(names(["mail:read"])).toEqual(
            expect.arrayContaining(["list_mail", "get_mail", "search_mail"]),
        );
    });

    it("lists a mail's task without mail:read, its words and its mail left out", async () => {
        const { tasks } = await call<{ tasks: TaskOut[] }>(
            "list_tasks",
            jan(READ),
            {},
        );
        const task = tasks.find(
            (row) => row.text === "Send the signed contract",
        );
        expect(task).toMatchObject({
            kind: "mail",
            untrusted: true,
            quote: null,
            due_phrase: null,
            recording: null,
            url: null,
        });
        // A word only its quote holds finds nothing.
        const hidden = await call<{ tasks: TaskOut[] }>(
            "search_tasks",
            jan(READ),
            { query: "Friday" },
        );
        expect(hidden.tasks).toEqual([]);
        const found = await call<{ tasks: TaskOut[] }>(
            "search_tasks",
            jan(READ),
            { query: "contract" },
        );
        expect(found.tasks.map((row) => row.id)).toEqual([task?.id]);
    });

    it("masks secret addresses in mail task text without mail:read", async () => {
        const [task] = await db()
            .insert(recordingTasks)
            .values({
                itemId,
                userId: "u-jan",
                status: "open",
                text: encryptText(`File through ${token}@klepna.example`),
                source: "manual",
            })
            .returning({ id: recordingTasks.id });
        if (!task) throw new Error("task not inserted");
        await db().insert(taskMentions).values({
            taskId: task.id,
            itemId,
            userId: "u-jan",
            view: "private",
            statementAt: new Date(),
            matchDecision: "home",
        });

        try {
            const listed = await call<{ tasks: TaskOut[] }>(
                "list_tasks",
                jan(READ),
                {},
            );
            const result = listed.tasks.find((row) => row.id === task.id);
            expect(result?.text).toContain("•");
            expect(JSON.stringify(result)).not.toContain(token);
            expect(result).toMatchObject({
                kind: "mail",
                recording: null,
                url: null,
            });
        } finally {
            await db()
                .delete(recordingTasks)
                .where(eq(recordingTasks.id, task.id));
        }
    });

    it("lists a fact from mail without mail:read, its evidence left out", async () => {
        const { facts } = await call<{ facts: FactOut[] }>(
            "get_facts",
            jan(READ),
            { entity: personId },
        );
        expect(facts).toEqual([
            expect.objectContaining({
                id: factId,
                origin: "mail",
                evidence: [],
            }),
        ]);
        const withMail = await call<{ facts: FactOut[] }>(
            "get_facts",
            jan(["knowledge:read", "mail:read"]),
            { entity: personId },
        );
        expect(withMail.facts[0]?.evidence).toEqual([
            expect.objectContaining({
                recording_id: itemId,
                kind: "mail",
                quote: "Petra Mala is our CFO now",
                quoted: false,
                untrusted: true,
            }),
        ]);
    });

    it("gives a mail's task its words and mail with mail:read", async () => {
        const { tasks } = await call<{ tasks: TaskOut[] }>(
            "list_tasks",
            jan([...READ, "mail:read"]),
            {},
        );
        expect(
            tasks.find((row) => row.text === "Send the signed contract"),
        ).toMatchObject({
            kind: "mail",
            untrusted: true,
            quote: "please send the signed contract by Friday",
            due_phrase: "by Friday",
            recording: { id: itemId, title: "Contract" },
            url: `https://riffado.example.test/dashboard?recording=${itemId}`,
        });
    });

    it("reads the pile with mail:read, secret addresses masked for their owner too", async () => {
        const caller = jan(["mail:read", "summaries:read"]);
        const listed = await call<{
            mail: { id: string; subject: string; from: unknown }[];
        }>("list_mail", caller, {});
        expect(listed.mail).toEqual([
            expect.objectContaining({
                id: itemId,
                kind: "mail",
                untrusted: true,
                subject: "Contract",
                from: {
                    name: expect.stringMatching(/^Jan Novotny jan\.•{10}@/),
                    address: "jan@company.example",
                },
            }),
        ]);
        const read = await call<{
            segments: { text: string }[];
            summary?: { summary: string | null };
        }>("get_mail", caller, { mail: itemId });
        const text = read.segments.map((segment) => segment.text).join("\n");
        expect(text).toContain("please send the signed contract by Friday");
        expect(text).toContain("jan.");
        expect(text).not.toContain(token);
        expect(read.summary?.summary).toBe(
            "Jan asks Eva for the signed contract.",
        );
        expect(
            (
                await call<{ summary?: unknown }>(
                    "get_mail",
                    jan(["mail:read"]),
                    {
                        mail: itemId,
                    },
                )
            ).summary,
        ).toBeUndefined();
    });

    it("gives a service caller the shared mail only", async () => {
        const service = serviceCaller(orgUserId, ["mail:read"]);
        expect(
            (await call<{ mail: unknown[] }>("list_mail", service, {})).mail,
        ).toEqual([]);
        await expect(
            call("get_mail", service, { mail: itemId }),
        ).rejects.toMatchObject({ outcome: "not_found" });
        const [orgRoot] = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(
                and(
                    eq(recordingFolders.userId, orgUserId),
                    isNull(recordingFolders.parentId),
                ),
            );
        await addRecordingToFolder({
            userId: "u-jan",
            recordingId: itemId,
            folderId: orgRoot?.id ?? "",
        });
        expect(
            (
                await call<{ mail: { id: string }[] }>("list_mail", service, {})
            ).mail.map((mail) => mail.id),
        ).toEqual([itemId]);
    });
    describe("search_mail", () => {
        const OWNER = "search-owner";
        const READER = "search-reader";
        let privateFolder = "";
        let orgFolder = "";
        let readerPerson = "";
        let ownerPerson = "";
        let secretPerson = "";
        let entityId = "";
        let orgPerson = "";
        let searchToken = "";
        const reader = (
            roles: McpRole[] = [
                "mail:read",
                "knowledge:read",
                "summaries:read",
            ],
        ) => userCaller(READER, "reader@example.test", roles, orgUserId);
        const owner = () =>
            userCaller(
                OWNER,
                "owner@example.test",
                ["mail:read", "knowledge:read", "summaries:read"],
                orgUserId,
            );
        const search = (caller: McpCaller, args: Record<string, unknown>) =>
            call<SearchOut>("search_mail", caller, args);
        const ids = (out: SearchOut) =>
            out.results.map((result) => result.mail.id);
        const body = (
            text: string,
            role: ContentSegment["role"] = "body",
            knownItemId?: string,
        ): ContentSegment => ({
            index: 0,
            role,
            participantRef: role === "quoted" ? "p2" : "p1",
            depth: role === "quoted" ? 1 : 0,
            at: null,
            text,
            knownItemId,
        });

        async function seedMail(
            id: string,
            userId: string,
            options: {
                subject?: string;
                segments?: ContentSegment[];
                participants?: ContentParticipant[];
                shared?: boolean;
                at?: Date;
                summary?: string;
                keyPoints?: string[];
                unreadable?: boolean;
                reaped?: boolean;
            } = {},
        ) {
            const at = options.at ?? new Date("2026-10-12T12:00:00Z");
            await db()
                .insert(chatterItems)
                .values({
                    id,
                    userId,
                    kind: "mail",
                    title: encryptText(options.subject ?? "Search fixture"),
                    occurredAt: at,
                    contentReapedAt: options.reaped ? new Date() : null,
                });
            await db()
                .insert(mailMessages)
                .values({
                    id,
                    userId,
                    rawHash: id,
                    receivedAt: at,
                    sentAt: at,
                    sizeBytes: 100,
                    senderVerified: true,
                    unreadable: options.unreadable ?? false,
                    auth: encryptJsonField({}),
                });
            await db()
                .insert(mailContents)
                .values({
                    itemId: id,
                    userId,
                    parserVersion: 1,
                    language: "cs",
                    segments: encryptJsonField(
                        options.segments ?? [body("Visibilitymarker")],
                    ),
                });
            const participants = options.participants ?? [
                {
                    ref: "p1",
                    roles: ["from"] as const,
                    displayName: "Forwarder",
                    address: "forwarder@example.test",
                },
                {
                    ref: "p2",
                    roles: ["quoted_author"] as const,
                    displayName: "Eva Buyer",
                    address: "eva@client.example",
                    personId: ownerPerson || null,
                },
            ];
            if (participants.length)
                await db()
                    .insert(mailParticipants)
                    .values(
                        participants.map((participant, position) => ({
                            itemId: id,
                            userId,
                            ref: participant.ref,
                            roles: [...participant.roles],
                            name: participant.displayName
                                ? encryptText(participant.displayName)
                                : null,
                            address: participant.address
                                ? encryptText(participant.address)
                                : null,
                            addressHash: participant.address
                                ? participantAddressHash(participant.address)
                                : null,
                            personId: participant.personId ?? null,
                            position,
                        })),
                    );
            if (options.summary)
                await db()
                    .insert(aiEnhancements)
                    .values({
                        itemId: id,
                        userId,
                        source: "riffado",
                        provider: "test",
                        model: "test",
                        summary: encryptText(options.summary),
                        keyPoints: encryptJsonField(options.keyPoints ?? []),
                    });
            if (options.shared)
                await db()
                    .insert(recordingFolderAssignments)
                    .values({ userId, itemId: id, folderId: orgFolder });
        }

        beforeAll(async () => {
            await db()
                .insert(users)
                .values([
                    {
                        id: OWNER,
                        email: "owner@example.test",
                        emailVerified: true,
                        lastSsoLoginAt: new Date(),
                    },
                    { id: READER, email: "reader@example.test" },
                ]);
            await ensureRootFolders(OWNER);
            await ensureRootFolders(READER);
            const roots = await db()
                .select()
                .from(recordingFolders)
                .where(isNull(recordingFolders.parentId));
            privateFolder = roots.find((row) => row.userId === OWNER)?.id ?? "";
            orgFolder = roots.find((row) => row.userId === orgUserId)?.id ?? "";
            readerPerson = (
                await createPerson({
                    userId: READER,
                    displayName: "Eva Search",
                    primaryEmail: "eva@client.example",
                    createdByUserId: READER,
                })
            ).id;
            ownerPerson = (
                await createPerson({
                    userId: OWNER,
                    displayName: "Eva Private",
                    primaryEmail: "eva@client.example",
                    createdByUserId: OWNER,
                })
            ).id;
            orgPerson = (
                await createPerson({
                    userId: orgUserId,
                    displayName: "Search Subject",
                    createdByUserId: orgUserId,
                })
            ).id;
            await db().insert(accounts).values({
                userId: OWNER,
                accountId: "search-owner-sub",
                providerId: "oidc",
            });
            entityId = (
                await createEntity(orgUserId, {
                    typeKey: "project",
                    name: "Mail Project",
                })
            ).id;
            const mailbox = await ensureMailbox(OWNER);
            const secret = await createSecretAddress({
                userId: OWNER,
                baseAddressId: mailbox?.id ?? "",
                label: null,
            });
            searchToken = secret.localPart;
            secretPerson = (
                await createPerson({
                    userId: READER,
                    displayName: "Secret Person",
                    primaryEmail: `${searchToken}@klepna.example`,
                    createdByUserId: READER,
                })
            ).id;
            await seedMail("search-private", OWNER);
            await seedMail("search-own", READER);
            await seedMail("search-shared", OWNER, {
                shared: true,
                summary: "Summarymarker",
                keyPoints: ["Keypointmarker"],
            });
            await seedMail("search-private-original", OWNER, {
                segments: [body("Originalonly")],
            });
            await seedMail("search-reply", OWNER, {
                shared: true,
                segments: [
                    body(
                        "Hiddenoriginalword",
                        "quoted",
                        "search-private-original",
                    ),
                ],
            });
            await seedMail("search-visible-original", OWNER, {
                shared: true,
                segments: [body("Original exists")],
            });
            await seedMail("search-known-reply", OWNER, {
                shared: true,
                segments: [
                    body("Knownquoteword", "quoted", "search-visible-original"),
                ],
            });
            const forward = segmentMail({
                text: null,
                html: readFileSync(
                    path.resolve(
                        "src/tests/mail/fixtures/gmail-forward-cs.html",
                    ),
                    "utf8",
                ),
                from: { name: "Jan", address: "jan@example.test" },
                sentAt: null,
                fromAuthenticated: true,
            });
            await seedMail("search-forward", OWNER, {
                shared: true,
                segments: forward.segments,
                participants: forward.participants,
            });
            await seedMail("search-noise", READER, {
                segments: [
                    body("Signatureonly", "signature"),
                    body("Disclaimeronly", "disclaimer"),
                    body("Quotedsignatureonly", "quoted_signature"),
                ],
            });
            await seedMail("search-morphology", READER, {
                subject: "Nabídka",
                segments: [body("Cena zůstává přijatelná.")],
            });
            await seedMail("search-secret", OWNER, {
                shared: true,
                subject: `Maskmarker ${searchToken}@klepna.example`,
                summary: `Summarymask ${searchToken}@klepna.example`,
                keyPoints: [`Keymask ${searchToken}@klepna.example`],
                segments: [
                    body(`Bodymask ${searchToken}@klepna.example`),
                    body(`Maskmarker ${searchToken}@klepna.example`, "quoted"),
                ],
                participants: [
                    {
                        ref: "p1",
                        roles: ["from"],
                        displayName: `Maskmarker ${searchToken}@klepna.example`,
                        address: `${searchToken}@klepna.example`,
                        personId: secretPerson,
                    },
                    {
                        ref: "p2",
                        roles: ["quoted_author"],
                        displayName: `Author ${searchToken}@klepna.example`,
                        address: "public@example.test",
                    },
                ],
            });
            await seedMail("search-reaped", READER, {
                subject: "Retentionmarker",
                reaped: true,
                segments: [],
                summary: "Retentionsummary",
            });
            await seedMail("search-unreadable", READER, {
                subject: "Unreadablemarker",
                unreadable: true,
                segments: [],
                summary: "Unreadablesummary",
            });
            for (const [id, scope, mail] of [
                ["search-fact-private", OWNER, "search-shared"],
                ["search-fact-org", orgUserId, "search-forward"],
                ["search-fact-hidden-mail", orgUserId, "search-private"],
            ]) {
                await db()
                    .insert(knowledgeFacts)
                    .values({
                        id,
                        userId: scope,
                        subjectEntityId: entityId,
                        subjectKey: `e:${entityId}`,
                        objectKey: `l:${id}`,
                        relationKey: "has_role",
                        objectLiteral: encryptText("Buyer"),
                        origin: "mail",
                    });
                await db()
                    .insert(knowledgeFactEvidence)
                    .values({
                        factId: id,
                        itemId: mail,
                        userId: scope,
                        transcriptRevision: 0,
                        segmentIndex: 0,
                        charStart: 0,
                        charEnd: 4,
                        quote: encryptText("Text"),
                        status: "supported",
                    });
            }
            knowledgeStore().invalidateAll();
        });

        it("never reads a colleague's private mail, including with filters", async () => {
            expect(
                ids(await search(reader(), { query: "Visibilitymarker" })),
            ).toEqual(expect.arrayContaining(["search-own", "search-shared"]));
            for (const filter of [
                {},
                { person: readerPerson },
                { folder: orgFolder },
                { entity: entityId },
            ]) {
                const result = await search(reader(), {
                    query: "Visibilitymarker",
                    ...filter,
                });
                expect(ids(result)).not.toContain("search-private");
            }
            const result = await search(reader(), { query: "Originalonly" });
            expect(result.results).toEqual([]);
        });

        it("gives a service shared mail only, even mail owned by the Organization must be shared", async () => {
            await seedMail("search-org-private", orgUserId);
            const result = await search(
                serviceCaller(orgUserId, ["mail:read"]),
                { query: "Visibilitymarker" },
            );
            expect(ids(result)).toEqual(["search-shared"]);
        });

        it("rejects a colleague's private folder", async () => {
            await expect(
                search(reader(), {
                    query: "Visibilitymarker",
                    folder: privateFolder,
                }),
            ).rejects.toMatchObject({
                message: "No such folder",
                outcome: "not_found",
            });
            await expect(
                search(serviceCaller(orgUserId, ["mail:read"]), {
                    query: "Visibilitymarker",
                    folder: privateFolder,
                }),
            ).rejects.toMatchObject({ message: "No such folder" });
        });

        it("searches a quote of a private original without exposing its id", async () => {
            const result = await search(reader(), {
                query: "Hiddenoriginalword",
            });
            expect(ids(result)).toEqual(["search-reply"]);
            expect(JSON.stringify(result)).not.toContain(
                "search-private-original",
            );
            expect(result.results[0]?.snippets).toEqual([
                {
                    part: "quoted",
                    author: "Eva Buyer",
                    text: "Hiddenoriginalword",
                },
            ]);
            expect(
                (await search(owner(), { query: "Hiddenoriginalword" }))
                    .results,
            ).toEqual([]);
        });

        it("skips known quotes only when their originals are visible", async () => {
            for (const caller of [
                reader(),
                owner(),
                serviceCaller(orgUserId, ["mail:read"]),
            ]) {
                expect(
                    (await search(caller, { query: "Knownquoteword" })).results,
                ).toEqual([]);
            }
        });

        it("finds a Czech Gmail forwarded part with its claimed author", async () => {
            const result = await search(reader(), { query: "cenu listopadu" });
            expect(ids(result)).toEqual(["search-forward"]);
            expect(result.results[0]?.snippets).toEqual([
                {
                    part: "quoted",
                    author: "Eva Buyer",
                    text: "Dobrý den,\nmůžeme přijmout cenu, pokud dodáte v listopadu.",
                },
            ]);
        });

        it.each([
            "Signatureonly",
            "Disclaimeronly",
            "Quotedsignatureonly",
        ])("does not search %s", async (query) => {
            expect((await search(reader(), { query })).results).toEqual([]);
        });

        it("matches Czech word forms, case and accents, across parts", async () => {
            const result = await search(reader(), { query: "NABIDKA cenu" });
            expect(ids(result)).toEqual(["search-morphology"]);
            expect(
                result.results[0]?.snippets.map((snippet) => snippet.part),
            ).toEqual(["subject", "body"]);
        });

        it("searches summary and key points only with summaries:read", async () => {
            for (const query of ["Summarymarker", "Keypointmarker"]) {
                expect(ids(await search(reader(), { query }))).toEqual([
                    "search-shared",
                ]);
                expect(
                    (await search(reader(["mail:read"]), { query })).results,
                ).toEqual([]);
            }
        });

        it("reads the Chatterbox summary over the Plaud one, as get_mail does", async () => {
            await db()
                .insert(aiEnhancements)
                .values({
                    itemId: "search-shared",
                    userId: OWNER,
                    source: "plaud",
                    provider: "test",
                    model: "test",
                    summary: encryptText("Plaudonlymarker"),
                });
            expect(
                (await search(reader(), { query: "Plaudonlymarker" })).results,
            ).toEqual([]);
            expect(
                ids(await search(reader(), { query: "Summarymarker" })),
            ).toEqual(["search-shared"]);
        });

        it("reads a Plaud summary when the mail has no Chatterbox one", async () => {
            await seedMail("search-plaud-only", READER, {
                segments: [body("Plaudfixture")],
            });
            await db()
                .insert(aiEnhancements)
                .values({
                    itemId: "search-plaud-only",
                    userId: READER,
                    source: "plaud",
                    provider: "test",
                    model: "test",
                    summary: encryptText("Plaudsolomarker"),
                });
            const out = await search(reader(), { query: "Plaudsolomarker" });
            expect(ids(out)).toEqual(["search-plaud-only"]);
            expect(out.results[0]?.snippets[0]?.part).toBe("summary");
        });

        it("ignores entity without knowledge:read instead of narrowing or failing", async () => {
            const caller = reader(["mail:read"]);
            const unfiltered = ids(
                await search(caller, { query: "Visibilitymarker" }),
            );
            expect(unfiltered.length).toBeGreaterThan(0);
            expect(
                ids(
                    await search(caller, {
                        query: "Visibilitymarker",
                        entity: entityId,
                    }),
                ),
            ).toEqual(unfiltered);
        });

        it("hides entity without knowledge:read and reads only caller-readable facts", async () => {
            const tool = ALL_TOOLS.find((tool) => tool.name === "search_mail");
            expect(tool?.input(reader(["mail:read"]))).not.toHaveProperty(
                "entity",
            );
            expect(
                ids(
                    await search(reader(), {
                        query: "Visibilitymarker",
                        entity: entityId,
                    }),
                ),
            ).toEqual([]);
            expect(
                ids(
                    await search(owner(), {
                        query: "Visibilitymarker",
                        entity: entityId,
                    }),
                ),
            ).toEqual(["search-shared", "search-private"]);
            expect(
                ids(
                    await search(reader(), {
                        query: "listopadu",
                        entity: entityId,
                    }),
                ),
            ).toEqual(["search-forward"]);
            await db()
                .update(knowledgeFactEvidence)
                .set({ status: "wording_changed" })
                .where(eq(knowledgeFactEvidence.factId, "search-fact-org"));
            try {
                expect(
                    (
                        await search(reader(), {
                            query: "listopadu",
                            entity: entityId,
                        })
                    ).results,
                ).toEqual([]);
            } finally {
                await db()
                    .update(knowledgeFactEvidence)
                    .set({ status: "supported" })
                    .where(eq(knowledgeFactEvidence.factId, "search-fact-org"));
            }
        });

        it("matches quoted_author through a readable person's address across private person copies", async () => {
            const result = await search(reader(), {
                query: "Visibilitymarker",
                person: "Eva Search",
            });
            expect(ids(result)).toEqual(["search-shared", "search-own"]);
            expect(result.resolved).toEqual([
                expect.objectContaining({
                    id: readerPerson,
                    input: "Eva Search",
                }),
            ]);
            expect(participantAddressHash(" Eva@CLIENT.example ")).toBe(
                participantAddressHash("eva@client.example"),
            );
            expect(participantAddressHash("eva@client.example")).not.toBe(
                lookupHash("eva@client.example"),
            );
        });

        it.each([
            "from",
            "sender",
            "to",
            "cc",
            "reply_to",
            "quoted_author",
        ] as const)("matches a %s participant by person_id without an address", async (role) => {
            const mail = `search-person-id-${role}`;
            await seedMail(mail, READER, {
                segments: [body(`Idparticipant${role}`)],
                participants: [
                    {
                        ref: "p1",
                        roles: [role],
                        displayName: "Eva",
                        personId: readerPerson,
                    },
                ],
            });
            expect(
                ids(
                    await search(reader(), {
                        query: `Idparticipant${role}`,
                        person: readerPerson,
                    }),
                ),
            ).toEqual([mail]);
        });

        it("matches additional addresses and sender participants", async () => {
            await db()
                .insert(personEmails)
                .values({
                    userId: READER,
                    personId: readerPerson,
                    email: encryptText("alternate@example.test"),
                    emailHash: lookupHash("alternate@example.test"),
                });
            await seedMail("search-alternate", OWNER, {
                shared: true,
                segments: [body("Alternateparticipant")],
                participants: [
                    {
                        ref: "p1",
                        roles: ["from"],
                        displayName: "Eva",
                        address: "alternate@example.test",
                        personId: ownerPerson,
                    },
                ],
            });
            expect(
                ids(
                    await search(reader(), {
                        query: "Alternateparticipant",
                        person: readerPerson,
                    }),
                ),
            ).toEqual(["search-alternate"]);
        });

        it("never counts another user's private additional address", async () => {
            await db()
                .insert(personEmails)
                .values({
                    userId: OWNER,
                    personId: orgPerson,
                    email: encryptText("forwarder@example.test"),
                    emailHash: lookupHash("forwarder@example.test"),
                });
            expect(
                (
                    await search(reader(), {
                        query: "Visibilitymarker",
                        person: orgPerson,
                    })
                ).results,
            ).toEqual([]);
        });

        it("never counts a secret address as a person's address", async () => {
            expect(
                (
                    await search(reader(), {
                        query: "Maskmarker",
                        person: secretPerson,
                    })
                ).results,
            ).toEqual([]);
        });

        it("does not count a secret participant linked by person_id through a private address", async () => {
            await db()
                .insert(personEmails)
                .values({
                    userId: OWNER,
                    personId: orgPerson,
                    email: encryptText(`${searchToken}@klepna.example`),
                    emailHash: lookupHash(`${searchToken}@klepna.example`),
                });
            await seedMail("search-private-secret-link", OWNER, {
                shared: true,
                segments: [body("Privatesecretlink")],
                participants: [
                    {
                        ref: "p1",
                        roles: ["to"],
                        displayName: "Secret recipient",
                        address: `${searchToken}@klepna.example`,
                        personId: orgPerson,
                    },
                ],
            });
            expect(
                (
                    await search(reader(), {
                        query: "Privatesecretlink",
                        person: orgPerson,
                    })
                ).results,
            ).toEqual([]);
        });

        it("masks subject, sender, quoted author and text before matching, for owners too", async () => {
            for (const caller of [
                reader(),
                owner(),
                serviceCaller(orgUserId, ["mail:read"]),
            ]) {
                const result = await search(caller, { query: "Maskmarker" });
                expect(ids(result)).toEqual(["search-secret"]);
                expect(JSON.stringify(result)).not.toContain(searchToken);
                expect(result.results[0]?.mail.subject).toContain("•");
                expect(result.results[0]?.mail.from?.address).toContain("•");
                expect(
                    (
                        await search(caller, {
                            query: searchToken.split(".").at(-1),
                        })
                    ).results,
                ).toEqual([]);
            }
        });

        it("uses inclusive dates, whole days, and folder descendants", async () => {
            await db()
                .insert(recordingFolders)
                .values({
                    id: "search-child",
                    userId: orgUserId,
                    parentId: orgFolder,
                    name: "Child",
                    kind: "custom",
                    nameHash: lookupHash("Child"),
                });
            await seedMail("search-date", OWNER, {
                at: new Date("2026-10-11T23:59:59Z"),
                segments: [body("Datemarker")],
            });
            await db().insert(recordingFolderAssignments).values({
                userId: OWNER,
                itemId: "search-date",
                folderId: "search-child",
            });
            expect(
                ids(
                    await search(reader(), {
                        query: "Datemarker",
                        from: "2026-10-11",
                        to: "2026-10-11",
                        folder: orgFolder,
                    }),
                ),
            ).toEqual(["search-date"]);
            expect(
                ids(
                    await search(reader(), {
                        query: "Datemarker",
                        to: "2026-10-11T23:59:59Z",
                    }),
                ),
            ).toEqual(["search-date"]);
            expect(
                (
                    await search(reader(), {
                        query: "Datemarker",
                        from: "2026-10-12",
                    })
                ).results,
            ).toEqual([]);
        });

        it.each([
            "search-reaped",
            "search-unreadable",
        ])("searches headers and summary after content is gone: %s", async (mail) => {
            for (const query of mail.endsWith("reaped")
                ? ["Retentionmarker", "Retentionsummary", "Forwarder"]
                : ["Unreadablemarker", "Unreadablesummary", "Forwarder"]) {
                expect(ids(await search(reader(), { query }))).toContain(mail);
            }
        });

        it("every snippet is text returned by get_mail for the same caller and mail", async () => {
            await seedMail("search-long", OWNER, {
                shared: true,
                segments: [
                    body(
                        `${"prefix ".repeat(40)}Parityneedle${" suffix".repeat(40)}`,
                        "quoted",
                    ),
                ],
                summary: "Paritysummary",
                keyPoints: ["Paritykeypoint"],
            });
            for (const caller of [
                reader(),
                owner(),
                serviceCaller(orgUserId, ["mail:read", "summaries:read"]),
            ]) {
                for (const query of [
                    "Parityneedle",
                    "Paritysummary",
                    "Paritykeypoint",
                    "Visibilitymarker",
                    "Maskmarker",
                    "listopadu",
                ]) {
                    const found = await search(caller, { query });
                    for (const result of found.results) {
                        const detail = await call<Record<string, unknown>>(
                            "get_mail",
                            caller,
                            { mail: result.mail.id },
                        );
                        const texts: string[] = [];
                        const collect = (value: unknown) => {
                            if (typeof value === "string") texts.push(value);
                            else if (Array.isArray(value))
                                value.forEach(collect);
                            else if (value && typeof value === "object")
                                Object.values(value).forEach(collect);
                        };
                        collect(detail);
                        for (const snippet of result.snippets)
                            expect(
                                texts.some((text) =>
                                    text.includes(snippet.text),
                                ),
                            ).toBe(true);
                        expect(result.snippets.length).toBeLessThanOrEqual(3);
                    }
                }
            }
        });

        it("ignores content, participants and summaries stored under the wrong owner", async () => {
            await seedMail("search-wrong-owner", OWNER, {
                shared: true,
                segments: [],
            });
            await db()
                .update(mailContents)
                .set({
                    userId: READER,
                    segments: encryptJsonField([body("Wrongcontent")]),
                })
                .where(eq(mailContents.itemId, "search-wrong-owner"));
            await db()
                .insert(mailParticipants)
                .values({
                    itemId: "search-wrong-owner",
                    userId: READER,
                    ref: "p3",
                    roles: ["from"],
                    name: encryptText("Wrongsender"),
                    personId: readerPerson,
                });
            await db()
                .insert(aiEnhancements)
                .values({
                    itemId: "search-wrong-owner",
                    userId: READER,
                    source: "riffado",
                    provider: "test",
                    model: "test",
                    summary: encryptText("Wrongsummary"),
                });
            for (const query of ["Wrongcontent", "Wrongsender", "Wrongsummary"])
                expect((await search(reader(), { query })).results).toEqual([]);
        });

        it("returns at most 50 matches, with audit ids and a continuation", async () => {
            for (let index = 0; index < 51; index++)
                await seedMail(
                    `search-many-${String(index).padStart(3, "0")}`,
                    READER,
                    { segments: [body("Manymatches")] },
                );
            const tool = ALL_TOOLS.find((tool) => tool.name === "search_mail");
            if (!tool) throw new Error("missing tool");
            const touched: string[] = [];
            const result = (await tool.run(
                { caller: reader(), touched },
                { query: "Manymatches" },
            )) as unknown as SearchOut;
            expect(result.results).toHaveLength(50);
            expect(result.complete).toBe(false);
            expect(touched).toEqual(ids(result));
            const next = await search(reader(), {
                query: "Manymatches",
                before: result.continue_before,
            });
            expect(next.results).toHaveLength(1);
            expect(ids(next).some((id) => touched.includes(id))).toBe(false);
        });

        it("stops after 500 mails and continues without gaps at equal timestamps", async () => {
            const at = new Date("2026-10-18");
            const batch = Array.from({ length: 501 }, (_, index) => ({
                id: `search-bound-${String(index).padStart(3, "0")}`,
                text: index === 0 ? "Boundaryneedle" : "No hit",
            }));
            await db()
                .insert(chatterItems)
                .values(
                    batch.map((row) => ({
                        id: row.id,
                        userId: READER,
                        kind: "mail" as const,
                        title: encryptText("Bound fixture"),
                        occurredAt: at,
                    })),
                );
            await db()
                .insert(mailMessages)
                .values(
                    batch.map((row) => ({
                        id: row.id,
                        userId: READER,
                        rawHash: row.id,
                        receivedAt: at,
                        sizeBytes: 100,
                        senderVerified: true,
                        auth: encryptJsonField({}),
                    })),
                );
            await db()
                .insert(mailContents)
                .values(
                    batch.map((row) => ({
                        itemId: row.id,
                        userId: READER,
                        parserVersion: 1,
                        language: "cs",
                        segments: encryptJsonField([body(row.text)]),
                    })),
                );
            const result = await search(reader(), {
                query: "Boundaryneedle",
                from: "2026-10-18",
            });
            expect(result).toMatchObject({
                scanned: 500,
                complete: false,
                results: [],
            });
            expect(result.continue_before).toBeTypeOf("string");
            const next = await search(reader(), {
                query: "Boundaryneedle",
                from: "2026-10-18",
                before: result.continue_before,
            });
            expect(ids(next)).toEqual(["search-bound-000"]);
            expect(next).toMatchObject({
                scanned: 1,
                complete: true,
                continue_before: null,
            });
        }, 30_000);

        it("denies the eleventh search in a minute through the real budget", async () => {
            const actual = await vi.importActual<typeof rateLimitModule>(
                "@/lib/mcp/rate-limit",
            );
            await db().delete(apiRateLimitBuckets);
            vi.mocked(rateLimitModule.allowMcpScan).mockImplementation(
                actual.allowMcpScan,
            );
            try {
                for (let index = 0; index < 10; index++)
                    await search(reader(), {
                        query: "Absentbudgetword",
                        from: "2099-01-01",
                    });
                await expect(
                    search(reader(), { query: "Absentbudgetword" }),
                ).rejects.toMatchObject({
                    message: "Too many searches; retry in a minute",
                    outcome: "denied",
                });
            } finally {
                vi.mocked(rateLimitModule.allowMcpScan).mockResolvedValue(true);
            }
        });

        it("answers 403 insufficient_scope without mail:read", async () => {
            const tokenSpy = vi
                .spyOn(tokenModule, "verifyMcpToken")
                .mockResolvedValue({
                    kind: "valid",
                    claims: { sub: "reader-sub", azp: "test-client" },
                });
            const callerSpy = vi
                .spyOn(callerModule, "resolveCaller")
                .mockResolvedValue({
                    ok: true,
                    caller: reader(["knowledge:read"]),
                });
            try {
                const response = await POST(
                    new Request("https://riffado.example.test/api/mcp", {
                        method: "POST",
                        headers: {
                            authorization: "Bearer test",
                            "content-type": "application/json",
                            accept: "application/json, text/event-stream",
                        },
                        body: JSON.stringify({
                            jsonrpc: "2.0",
                            id: 1,
                            method: "tools/call",
                            params: {
                                name: "search_mail",
                                arguments: { query: "Visibilitymarker" },
                            },
                        }),
                    }),
                );
                expect(response.status).toBe(403);
                expect(response.headers.get("WWW-Authenticate")).toContain(
                    'error="insufficient_scope"',
                );
                expect(response.headers.get("WWW-Authenticate")).toContain(
                    'scope="mail:read"',
                );
            } finally {
                tokenSpy.mockRestore();
                callerSpy.mockRestore();
            }
        });

        it.skipIf(process.env.MEASURE_MCP_SEARCH_MAIL !== "true")(
            "measures a 500-mail scan in a disposable 2000-mail pile",
            async () => {
                const userId = "search-measurement";
                await db()
                    .insert(users)
                    .values({ id: userId, email: "measurement@example.test" });
                const now = new Date("2026-10-19T00:00:00Z");
                let textCharacters = 0;
                let quotedParts = 0;
                for (let start = 0; start < 2000; start += 50) {
                    const batch = Array.from({ length: 50 }, (_, offset) => {
                        const index = start + offset;
                        const id = `measurement-${String(index).padStart(4, "0")}`;
                        const segments =
                            index % 2 === 0
                                ? [
                                      body("Please review the thread."),
                                      ...Array.from(
                                          { length: 6 },
                                          (_, quote) => ({
                                              ...body(
                                                  `Round ${quote}. ${"The delivery schedule and pricing remain under review. ".repeat(45)}`,
                                                  "quoted",
                                              ),
                                              index: quote + 1,
                                              depth: quote + 1,
                                          }),
                                      ),
                                  ]
                                : [
                                      body(
                                          "Please confirm the delivery schedule for next month.",
                                      ),
                                  ];
                        textCharacters += segments.reduce(
                            (total, segment) => total + segment.text.length,
                            0,
                        );
                        quotedParts += segments.filter(
                            (segment) => segment.role === "quoted",
                        ).length;
                        return {
                            id,
                            segments,
                            at: new Date(now.getTime() - index * 1000),
                        };
                    });
                    await db()
                        .insert(chatterItems)
                        .values(
                            batch.map((row) => ({
                                id: row.id,
                                userId,
                                kind: "mail" as const,
                                title: encryptText("Delivery discussion"),
                                occurredAt: row.at,
                            })),
                        );
                    await db()
                        .insert(mailMessages)
                        .values(
                            batch.map((row) => ({
                                id: row.id,
                                userId,
                                rawHash: row.id,
                                receivedAt: row.at,
                                sizeBytes: 15000,
                                senderVerified: true,
                                auth: encryptJsonField({}),
                            })),
                        );
                    await db()
                        .insert(mailContents)
                        .values(
                            batch.map((row) => ({
                                itemId: row.id,
                                userId,
                                parserVersion: 1,
                                language: "en",
                                segments: encryptJsonField(row.segments),
                            })),
                        );
                    await db()
                        .insert(mailParticipants)
                        .values(
                            batch.flatMap((row) => [
                                {
                                    itemId: row.id,
                                    userId,
                                    ref: "p1",
                                    roles: ["from"],
                                    name: encryptText("Sender"),
                                    address: encryptText("sender@example.test"),
                                    addressHash: participantAddressHash(
                                        "sender@example.test",
                                    ),
                                    position: 0,
                                },
                                {
                                    itemId: row.id,
                                    userId,
                                    ref: "p2",
                                    roles: ["quoted_author"],
                                    name: encryptText("Earlier author"),
                                    address: encryptText("author@example.test"),
                                    addressHash: participantAddressHash(
                                        "author@example.test",
                                    ),
                                    position: 1,
                                },
                            ]),
                        );
                    await db()
                        .insert(aiEnhancements)
                        .values(
                            batch.map((row) => ({
                                itemId: row.id,
                                userId,
                                source: "riffado",
                                provider: "test",
                                model: "test",
                                summary: encryptText(
                                    "Delivery schedule under review.",
                                ),
                                keyPoints: encryptJsonField([
                                    "Awaiting confirmation",
                                ]),
                            })),
                        );
                }
                const started = performance.now();
                const result = await search(
                    userCaller(
                        userId,
                        "measurement@example.test",
                        ["mail:read", "summaries:read"],
                        orgUserId,
                    ),
                    { query: "Unfindablemeasurementword" },
                );
                const elapsedMs = performance.now() - started;
                process.stdout.write(
                    `${JSON.stringify({
                        measurement: "search_mail",
                        mails: 2000,
                        longThreads: 1000,
                        quotedParts,
                        textCharacters,
                        elapsedMs: Math.round(elapsedMs),
                        scanned: result.scanned,
                        matches: result.results.length,
                        complete: result.complete,
                        continuation: result.continue_before !== null,
                    })}\n`,
                );
                expect(result.scanned).toBe(500);
                expect(result.complete).toBe(false);
            },
            120_000,
        );

        it("stops at the 10-second deadline before loading a batch", async () => {
            const now = vi
                .spyOn(Date, "now")
                .mockReturnValueOnce(0)
                .mockReturnValue(10_000);
            try {
                expect(
                    await search(reader(), { query: "Deadlineword" }),
                ).toMatchObject({
                    results: [],
                    scanned: 0,
                    complete: false,
                    continue_before: null,
                });
            } finally {
                now.mockRestore();
            }
        });

        it("rejects punctuation, bad dates and invalid cursors", async () => {
            for (const args of [
                { query: "..." },
                { query: "word", from: "yesterday" },
                { query: "word", from: "2026-10-12", to: "2026-10-11" },
                { query: "word", before: "not-a-cursor" },
            ])
                await expect(search(reader(), args)).rejects.toMatchObject({
                    outcome: "invalid",
                });
        });
    });
});
