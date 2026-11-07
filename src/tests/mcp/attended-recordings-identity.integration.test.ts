import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import type * as OpenAIModule from "openai";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
    accounts,
    apiCredentials,
    chatterItems,
    mailMessages,
    mailParticipants,
    people,
    recordingFolders,
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
        createCompletion: vi.fn(),
        mockEnv: {
            IS_HOSTED: false,
            SELF_HOST_MODE: "shared",
            ORG_ACCOUNT_EMAIL: "org@example.test",
            ORG_ACCOUNT_PASSWORD: undefined,
            ORG_ACCOUNT_NAME: undefined,
            OIDC_ISSUER_URL: "https://sso.example.test/realms/acme",
            OIDC_CLIENT_ID: "chatterbox",
            OIDC_CLIENT_SECRET: "secret",
            MAIL_DOMAIN: "mail.example.test",
            MAIL_ORG_NICKNAME: "acme",
            MAIL_FORMER_ORG_NICKNAMES: [] as string[],
            MAIL_ADDRESS_HASH_SECRET: "m".repeat(40),
            MAIL_INGEST_SECRET: "i".repeat(40),
            MAIL_INACTIVE_DAYS: 180,
            MAIL_MAX_SIGNATURE_AGE_HOURS: 72,
            MAIL_DAILY_LIMIT: 500,
            MAIL_MAX_MESSAGE_MB: 36,
            DEFAULT_STORAGE_TYPE: "local",
            LOCAL_STORAGE_PATH: "",
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            DATABASE_URL: "postgres://unused",
            AUTO_SUMMARY_RATE_LIMIT_PER_HOUR: 100,
            APP_URL: "https://chatterbox.example.test",
            KNOWLEDGE_MEMORY_MB: 64,
        },
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/mcp/rate-limit", () => ({
    allowMcpScan: vi.fn(async () => true),
}));
vi.mock("openai", async (importOriginal) => {
    const actual = await importOriginal<typeof OpenAIModule>();
    return {
        ...actual,
        OpenAI: class {
            chat = { completions: { create: createCompletion } };
        },
    };
});

import { ALL_ITEM_KINDS } from "@/lib/content/item-kinds";
import { encrypt } from "@/lib/encryption";
import { decryptText } from "@/lib/encryption/fields";
import { addRecordingToFolder, ensureRootFolders } from "@/lib/folders/folders";
import { knowledgeStore } from "@/lib/knowledge/knowledge-loader";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { createPerson } from "@/lib/knowledge/people";
import { seedCoreVocabulary } from "@/lib/knowledge/vocabulary";
import { startLearnRun } from "@/lib/learn/learn-job";
import { learnJobHandler } from "@/lib/learn/learn-job-handler";
import { decideReviewItem, finishReview, loadReview } from "@/lib/learn/review";
import { ensureMailbox } from "@/lib/mail/addresses";
import { authenticateMessage } from "@/lib/mail/dkim";
import { ingestMail, precheckMail } from "@/lib/mail/ingest";
import { RECORDING_TOOLS } from "@/lib/mcp/tools/recordings";
import { ensureOrgAccount } from "@/lib/org/account";
import { resolveDefaultProfile } from "@/lib/profiles/resolve";
import { updateProfile } from "@/lib/profiles/store";
import {
    type RecordingViewContext,
    requireRecordingView,
} from "@/lib/sharing/access";
import { recordSsoUserInAlmanac } from "@/lib/sso/almanac";
import { SSO_PROVIDER_ID } from "@/lib/sso/constants";
import { seedExistingPersonalProfiles } from "@/tests/integration/profile-fixtures";
import {
    rawMessage,
    signMessage,
    testResolver,
    testSigner,
} from "@/tests/mail/dkim-fixtures";
import {
    attributeSpeaker,
    insertRecording,
    insertTranscript,
    userCaller,
} from "@/tests/mcp/fixtures";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const signer = testSigner("example.test");
const resolver = testResolver([signer]);
const EMPTY = {
    newRecords: [],
    speakers: [],
    corrections: [],
    facts: [],
    relationPhrases: [],
};
const RANGE = { from: "2026-09-01", to: "2026-09-30" };
const OWNER = "recording-owner";

function reply(content: object) {
    return {
        choices: [{ message: { content: JSON.stringify(content) } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
    };
}

describeWithDatabase(
    "MCP attended recordings login-address protections (PostgreSQL)",
    () => {
        let database: TestPostgresDatabase | null = null;
        let storage = "";
        let orgUserId = "";
        let orgRoot = "";

        function db() {
            if (!database) throw new Error("test database was not initialized");
            return database.db;
        }
        async function member(
            id: string,
            email: string,
            firstSignInAt = new Date("2026-08-01T00:00:00Z"),
        ) {
            await db().insert(users).values({
                id,
                email,
                emailVerified: true,
                lastSsoLoginAt: new Date(),
            });
            await db()
                .insert(accounts)
                .values({
                    userId: id,
                    accountId: userCaller(id, email, [], orgUserId).subject,
                    providerId: SSO_PROVIDER_ID,
                    createdAt: firstSignInAt,
                });
            await ensureRootFolders(id);
            await ensureMailbox(id);
            await seedExistingPersonalProfiles(id, mockEnv);
            await db()
                .insert(apiCredentials)
                .values({
                    userId: id,
                    provider: "openai",
                    apiKey: encrypt("key"),
                    defaultModel: "gpt-4o-mini",
                    isDefaultEnhancement: true,
                });
            const resolved = await resolveDefaultProfile(id, "mail");
            const settings = resolved.settings;
            if ("transcribe" in settings.steps)
                throw new Error("expected mail profile");
            await updateProfile({
                ownerUserId: id,
                profileId: resolved.profile.id,
                actor: {
                    kind: "user",
                    actorId: id,
                    issuer: null,
                    subject: null,
                    capabilities: new Set(["use"]),
                    clientId: null,
                    clientPermissions: new Set(),
                    verifiedAt: null,
                },
                expectedVersion: resolved.profile.version,
                settings: {
                    ...settings,
                    steps: {
                        ...settings.steps,
                        learn: { ...settings.steps.learn, automatic: false },
                    },
                },
            });
        }
        async function deliver(
            owner: string,
            name: string,
            email: string,
            addressee?: { name: string; email: string },
        ) {
            const recipient = `${owner.replace("u-", "")}@mail.example.test`;
            const raw = await signMessage(
                rawMessage(
                    [
                        `From: ${name} <${email}>`,
                        `To: ${addressee ? `${addressee.name} <${addressee.email}>, ` : ""}${recipient}`,
                        "Subject: Login address",
                        "Date: Fri, 09 Oct 2026 14:02:00 +0200",
                        `Message-ID: <${randomUUID()}@example.test>`,
                        "MIME-Version: 1.0",
                        "Content-Type: text/plain; charset=utf-8",
                    ],
                    "Please read this message.",
                ),
                signer,
            );
            const now = new Date();
            const facts = await authenticateMessage(raw, { resolver, now });
            await precheckMail({ recipients: [recipient], facts });
            await ingestMail({
                raw,
                recipients: [recipient],
                spf: "pass",
                receivedAt: now,
                resolver,
            });
            const [mail] = await db()
                .select({ id: mailMessages.id })
                .from(mailMessages)
                .where(
                    and(
                        eq(mailMessages.userId, owner),
                        eq(mailMessages.sizeBytes, raw.length),
                    ),
                );
            if (!mail) throw new Error("mail not stored");
            return mail.id;
        }
        async function learn(
            actor: string,
            itemId: string,
            answer: object = EMPTY,
        ) {
            await addRecordingToFolder({
                userId: actor,
                recordingId: itemId,
                folderId: orgRoot,
            });
            const access = await requireRecordingView(actor, itemId, "org", {
                kinds: ALL_ITEM_KINDS,
            });
            createCompletion.mockReset();
            createCompletion
                .mockResolvedValueOnce(reply({ mentions: [] }))
                .mockResolvedValue(reply(answer));
            const { runId } = await startLearnRun({
                access,
                actorUserId: actor,
                source: "riffado",
                trigger: "manual",
                actsForOrganization: false,
            });
            const result = await learnJobHandler.run({
                payload: { runId },
                userId: actor,
                jobId: "job",
                attempt: 1,
                maxAttempts: 2,
                signal: new AbortController().signal,
                reportProgress: () => undefined,
            });
            return { access, result };
        }
        async function acceptAddress(
            actor: string,
            access: RecordingViewContext,
            email: string,
            personId: string,
        ) {
            const review = await loadReview(access);
            const versions: Record<string, number> = {};
            expect(review.items).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        payload: expect.objectContaining({ address: email }),
                    }),
                ]),
            );
            for (const item of review.items) {
                const matches =
                    "address" in item.payload && item.payload.address === email;
                versions[item.id] = (
                    await decideReviewItem(access, item.id, {
                        decision: matches ? "accepted" : "rejected",
                        version: item.version,
                        ...(matches ? { choice: { personId } } : {}),
                    })
                ).version;
            }
            const finished = await finishReview(access, actor, {
                versions,
                actsForOrganization: false,
            });
            expect(finished).toMatchObject({
                status: "finished",
                applied: 1,
                skipped: [],
            });
        }
        async function nameTarget(recordingId: string, personId: string) {
            await insertRecording(db(), { id: recordingId, userId: OWNER });
            const transcriptionId = await insertTranscript(
                db(),
                recordingId,
                OWNER,
            );
            await attributeSpeaker(db(), {
                userId: OWNER,
                transcriptionId,
                label: "speaker_0",
                personId,
            });
        }
        async function expectBlocked(
            memberId: string,
            email: string,
            targetId: string,
        ) {
            const [target] = await db()
                .select()
                .from(people)
                .where(
                    and(eq(people.id, targetId), eq(people.userId, orgUserId)),
                );
            expect(target).toMatchObject({
                primaryEmail: null,
                primaryEmailHash: null,
            });
            const attended = RECORDING_TOOLS.find(
                (tool) => tool.name === "list_attended_recordings",
            );
            if (!attended) throw new Error("attendance tool missing");
            expect(
                await attended.run(
                    {
                        caller: userCaller(
                            memberId,
                            email,
                            ["tasks:read"],
                            orgUserId,
                        ),
                        touched: [],
                    },
                    RANGE,
                ),
            ).toEqual({ recordings: [], truncated: false });
        }

        beforeAll(async () => {
            storage = mkdtempSync(join(tmpdir(), "attended-identity-"));
            mockEnv.LOCAL_STORAGE_PATH = storage;
            database = await createMigratedTestDatabase(
                testDatabaseUrl ?? "",
                "attended_identity",
            );
            dbRef.current = database.db as unknown as Record<
                PropertyKey,
                unknown
            >;
            orgUserId = (await ensureOrgAccount()) ?? "";
            if (!orgUserId) throw new Error("organization account missing");
            await ensureRootFolders(orgUserId);
            const [root] = await db()
                .select({ id: recordingFolders.id })
                .from(recordingFolders)
                .where(
                    and(
                        eq(recordingFolders.userId, orgUserId),
                        isNull(recordingFolders.parentId),
                    ),
                );
            if (!root) throw new Error("organization root missing");
            orgRoot = root.id;
            knowledgeStore().invalidateAll();
            await seedCoreVocabulary();
            await db()
                .insert(users)
                .values({ id: OWNER, email: "owner@example.test" });
        }, 120_000);
        afterAll(async () => {
            knowledgeStore().invalidateAll();
            dbRef.current = null;
            await database?.dispose();
            if (storage) rmSync(storage, { recursive: true, force: true });
        }, 30_000);

        it("excludes inherited history assigned through shared mail Learn before first sign-in and lists later attendance", async () => {
            await member("u-reviewer", "reviewer@example.test");
            const target = await createPerson({
                userId: orgUserId,
                displayName: "Ivana Malá",
            });
            await nameTarget("before-inherited-sign-in", target.id);
            const mail = await deliver(
                "u-reviewer",
                "Review Member",
                "reviewer@example.test",
                {
                    name: "Ivana Malá",
                    email: "newhire@example.test",
                },
            );
            const { access } = await learn("u-reviewer", mail);
            await acceptAddress(
                "u-reviewer",
                access,
                "newhire@example.test",
                target.id,
            );
            const [assigned] = await db()
                .select()
                .from(people)
                .where(
                    and(eq(people.id, target.id), eq(people.userId, orgUserId)),
                );
            expect(assigned?.primaryEmailHash).toBe(
                lookupHash("newhire@example.test"),
            );
            expect(decryptText(assigned?.displayName ?? "")).toBe("Ivana Malá");

            const firstSignInAt = new Date();
            await member("u-newhire", "newhire@example.test", firstSignInAt);
            const inheritedId = await recordSsoUserInAlmanac({
                id: "u-newhire",
                name: "Nora Newhire",
                email: "newhire@example.test",
            });
            expect(inheritedId).toBe(target.id);
            const [inherited] = await db()
                .select()
                .from(people)
                .where(
                    and(eq(people.id, target.id), eq(people.userId, orgUserId)),
                );
            expect(decryptText(inherited?.displayName ?? "")).toBe(
                "Nora Newhire",
            );
            const attended = RECORDING_TOOLS.find(
                (tool) => tool.name === "list_attended_recordings",
            );
            if (!attended) throw new Error("attendance tool missing");
            const list = () =>
                attended.run(
                    {
                        caller: userCaller(
                            "u-newhire",
                            "newhire@example.test",
                            ["tasks:read"],
                            orgUserId,
                        ),
                        touched: [],
                    },
                    {
                        from: "2026-09-01",
                        to: new Date(
                            firstSignInAt.getTime() + 60_000,
                        ).toISOString(),
                    },
                );
            expect(await list()).toEqual({ recordings: [], truncated: false });

            await nameTarget("after-inherited-sign-in", target.id);
            const afterSignInAt = new Date(firstSignInAt.getTime() + 1);
            await db()
                .update(chatterItems)
                .set({ occurredAt: afterSignInAt })
                .where(
                    and(
                        eq(chatterItems.id, "after-inherited-sign-in"),
                        eq(chatterItems.userId, OWNER),
                    ),
                );
            expect(await list()).toEqual({
                recordings: [
                    {
                        title: "Recording after-inherited-sign-in",
                        recorded_at: afterSignInAt.toISOString(),
                        duration_ms: 60_000,
                    },
                ],
                truncated: false,
            });
        });

        it("resolves a login address to its holder at ingest instead of proposing the target", async () => {
            await member("u-ada", "ada@example.test");
            const holder = await recordSsoUserInAlmanac({
                id: "u-ada",
                name: "Ada Member",
                email: "ada@example.test",
            });
            expect(holder).toEqual(expect.any(String));
            const target = await createPerson({
                userId: orgUserId,
                displayName: "Jitka Dvořáková",
            });
            await nameTarget("ingest-target", target.id);
            const mail = await deliver(
                "u-ada",
                "Jitka Dvořáková",
                "ada@example.test",
            );
            const [participant] = await db()
                .select()
                .from(mailParticipants)
                .where(
                    and(
                        eq(mailParticipants.itemId, mail),
                        eq(mailParticipants.userId, "u-ada"),
                        eq(mailParticipants.ref, "p1"),
                    ),
                );
            expect(participant).toMatchObject({ personId: holder });
            const { access, result } = await learn("u-ada", mail, {
                ...EMPTY,
                newRecords: [
                    {
                        ref: "n1",
                        kind: "person",
                        typeKey: null,
                        name: "Jitka Dvořáková",
                        speakerLabel: participant?.ref,
                        evidence: ["00:00"],
                        reason: "Named sender",
                    },
                ],
            });
            expect(result).toMatchObject({ status: "finished", items: 0 });
            expect((await loadReview(access)).items).toHaveLength(0);
            await expectBlocked("u-ada", "ada@example.test", target.id);
        });

        it("refuses a second holder when the login person is created after ingest", async () => {
            await member("u-iva", "iva@example.test");
            const target = await createPerson({
                userId: orgUserId,
                displayName: "Lenka Veselá",
            });
            await nameTarget("unique-target", target.id);
            const mail = await deliver(
                "u-iva",
                "Lenka Veselá",
                "iva@example.test",
            );
            const [participant] = await db()
                .select()
                .from(mailParticipants)
                .where(
                    and(
                        eq(mailParticipants.itemId, mail),
                        eq(mailParticipants.userId, "u-iva"),
                        eq(mailParticipants.ref, "p1"),
                    ),
                );
            expect(participant).toMatchObject({ personId: null });
            const holder = await recordSsoUserInAlmanac({
                id: "u-iva",
                name: "Iva Member",
                email: "iva@example.test",
            });
            expect(holder).toEqual(expect.any(String));
            const { access } = await learn("u-iva", mail);
            await acceptAddress("u-iva", access, "iva@example.test", target.id);
            const [linked] = await db()
                .select({ personId: mailParticipants.personId })
                .from(mailParticipants)
                .where(
                    and(
                        eq(mailParticipants.itemId, mail),
                        eq(mailParticipants.userId, "u-iva"),
                        eq(mailParticipants.ref, "p1"),
                    ),
                );
            expect(linked?.personId).toBe(target.id);
            const [held] = await db()
                .select({ primaryEmailHash: people.primaryEmailHash })
                .from(people)
                .where(
                    and(
                        eq(people.id, holder ?? ""),
                        eq(people.userId, orgUserId),
                    ),
                );
            expect(held?.primaryEmailHash).toBe(lookupHash("iva@example.test"));
            await expectBlocked("u-iva", "iva@example.test", target.id);
        });
    },
);
