import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
    internalMailDbProxy,
    internalMailDbRef,
    internalMailEnv,
} from "@/tests/mail/internal-address-fixtures";

vi.mock("@/db", () => ({ db: internalMailDbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: internalMailEnv }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/mcp/rate-limit", () => ({
    allowMcpScan: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn(async () => ({
        user: { id: "owner", email: "owner@example.test" },
    })),
}));

import { z } from "zod";
import { PATCH as updatePersonRoute } from "@/app/api/people/[id]/route";
import { POST as createPersonRoute } from "@/app/api/people/route";
import {
    chatterItems,
    learnReviewItems,
    learnRuns,
    mailAddresses,
    mailContents,
    mailMessages,
    mailParticipants,
    people,
    personEmails,
    users,
} from "@/db/schema";
import { ALL_ITEM_KINDS } from "@/lib/content/item-kinds";
import { readItemContent } from "@/lib/content/read-item-content";
import {
    decryptText,
    encryptJsonField,
    encryptText,
} from "@/lib/encryption/fields";
import { translatedSourceMessage } from "@/lib/i18n/messages";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import {
    createPerson,
    createPersonInTx,
    findPersonByEmail,
    planPersonPromotionInTx,
    promotePersonInTx,
    updatePerson,
} from "@/lib/knowledge/people";
import { finishReview } from "@/lib/learn/review";
import { localPartHash, participantAddressHash } from "@/lib/mail/hash";
import { peopleByAddress } from "@/lib/mail/known-quotes";
import { parseMessage } from "@/lib/mail/parse";
import { storeMailForOwner } from "@/lib/mail/store";
import { MAIL_TOOLS } from "@/lib/mcp/tools/mail";
import { ensureProfiles } from "@/lib/profiles/seed";
import { requireRecordingView } from "@/lib/sharing/access";
import { recordSsoUserInAlmanac } from "@/lib/sso/almanac";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";
import { userCaller } from "@/tests/mcp/fixtures";

const testDatabaseUrl = getTestDatabaseUrl();
const withDatabase = testDatabaseUrl ? describe : describe.skip;
const INTERNAL = "owner.abcdefghij@inbound.example.test";
const EXTERNAL = "luma@example.test";

withDatabase("internal addresses never belong to people (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    let storageDir = "";
    const db = () => database.db;
    beforeAll(async () => {
        storageDir = mkdtempSync(join(tmpdir(), "internal-mail-"));
        internalMailEnv.LOCAL_STORAGE_PATH = storageDir;
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "internal_addresses",
        );
        internalMailDbRef.current = database.db as unknown as Record<
            PropertyKey,
            unknown
        >;
        await db()
            .insert(users)
            .values([
                { id: "owner", email: "owner@example.test" },
                { id: "other", email: "other@example.test" },
            ]);
        await ensureProfiles("owner");
    }, 120_000);
    afterAll(async () => {
        internalMailDbRef.current = null;
        await database?.dispose();
        rmSync(storageDir, { recursive: true, force: true });
    }, 30_000);

    async function seedMail(
        id: string,
        address: string,
        personId: string | null = null,
        text = "A message",
        knownItemId?: string,
    ) {
        await db()
            .insert(chatterItems)
            .values({
                id,
                userId: "owner",
                kind: "mail",
                title: encryptText("A message"),
                occurredAt: new Date(),
            });
        await db()
            .insert(mailMessages)
            .values({
                id,
                userId: "owner",
                rawHash: id,
                senderVerified: false,
                receivedAt: new Date(),
                sizeBytes: 100,
                auth: encryptJsonField({}),
            });
        await db()
            .insert(mailContents)
            .values({
                itemId: id,
                userId: "owner",
                parserVersion: 1,
                language: "en",
                segments: encryptJsonField([
                    {
                        index: 0,
                        role: knownItemId ? "quoted" : "body",
                        participantRef: "p1",
                        depth: knownItemId ? 1 : 0,
                        at: null,
                        text,
                        ...(knownItemId ? { knownItemId } : {}),
                    },
                ]),
            });
        await db()
            .insert(mailParticipants)
            .values({
                itemId: id,
                userId: "owner",
                ref: "p1",
                roles: ["from"],
                address: encryptText(address),
                addressHash: participantAddressHash(address),
                name: encryptText("Luma Veln"),
                personId,
            });
    }

    it.each([
        { address: INTERNAL, explicit: null, known: false },
        { address: INTERNAL, explicit: EXTERNAL, known: true },
        { address: EXTERNAL, explicit: INTERNAL, known: true },
        { address: INTERNAL, explicit: INTERNAL, known: true },
    ])("confirms an old proposal by name without linking or storing $address (explicit $explicit, known $known)", async ({
        address,
        explicit,
        known,
    }) => {
        const id = `review-${address === INTERNAL}-${explicit}-${known}`;
        const name = `Luma Veln ${id}`;
        const person = known
            ? await createPerson({ userId: "owner", displayName: name })
            : null;
        await seedMail(id, address);
        const [run] = await db()
            .insert(learnRuns)
            .values({
                userId: "owner",
                scopeUserId: "owner",
                itemId: id,
                view: "private",
                actorUserId: "owner",
                trigger: "manual",
                transcriptRevision: 0,
                vocabularyVersion: 0,
                status: "ready",
            })
            .returning({ id: learnRuns.id });
        const [item] = await db()
            .insert(learnReviewItems)
            .values({
                runId: run?.id ?? "",
                userId: "owner",
                kind: "new_record",
                fingerprintHmac: "f".repeat(64),
                decision: "accepted",
                choice: person
                    ? encryptJsonField({ personId: person.id })
                    : null,
                payload: encryptJsonField({
                    ref: "new-person",
                    kind: "person",
                    name,
                    typeKey: null,
                    speakerLabel: "p1",
                    evidence: [],
                    address: explicit,
                    ...(person ? { maybe: { personId: person.id } } : {}),
                }),
            })
            .returning({ id: learnReviewItems.id });
        const access = await requireRecordingView("owner", id, "private", {
            kinds: ALL_ITEM_KINDS,
        });
        expect(
            await finishReview(access, "owner", {
                versions: { [item?.id ?? ""]: 0 },
            }),
        ).toMatchObject({ status: "finished", applied: 1 });
        const persons = await db()
            .select()
            .from(people)
            .where(eq(people.userId, "owner"));
        const named = persons.filter(
            (row) => decryptText(row.displayName) === name,
        );
        expect(named).toHaveLength(1);
        expect(named[0]).toMatchObject({
            primaryEmail: null,
            primaryEmailHash: null,
        });
        expect(
            await db()
                .select()
                .from(personEmails)
                .where(
                    and(
                        eq(personEmails.userId, "owner"),
                        eq(personEmails.personId, named[0]?.id ?? ""),
                    ),
                ),
        ).toEqual([]);
        expect(
            (
                await db()
                    .select()
                    .from(mailParticipants)
                    .where(
                        and(
                            eq(mailParticipants.userId, "owner"),
                            eq(mailParticipants.itemId, id),
                        ),
                    )
            )[0]?.personId,
        ).toBeNull();
    });

    it("rejects interactive writes and skips background writes, including SSO", async () => {
        const person = await createPerson({
            userId: "owner",
            displayName: "Neri Voss",
        });
        const error = {
            code: "INVALID_INPUT",
            statusCode: 400,
            message:
                "An inbound mail address cannot be used as a person's email address.",
        };
        await expect(
            createPerson({
                userId: "owner",
                displayName: "Luma Veln",
                primaryEmail: INTERNAL,
            }),
        ).rejects.toMatchObject(error);
        await expect(
            updatePerson("owner", person.id, { primaryEmail: INTERNAL }),
        ).rejects.toMatchObject(error);
        const created = await db().transaction((tx) =>
            createPersonInTx(tx, {
                userId: "owner",
                displayName: "Background Person",
                primaryEmail: INTERNAL,
            }),
        );
        expect(created.primaryEmail).toBeNull();
        expect(await findPersonByEmail("owner", INTERNAL)).toBeNull();
        expect(
            await recordSsoUserInAlmanac({
                id: "owner",
                name: "Luma Veln",
                email: INTERNAL,
            }),
        ).toBeNull();
        for (const response of [
            await createPersonRoute(
                new Request("http://localhost/api/people", {
                    method: "POST",
                    body: JSON.stringify({
                        displayName: "Luma Veln",
                        primaryEmail: INTERNAL,
                    }),
                }),
            ),
            await updatePersonRoute(
                new Request(`http://localhost/api/people/${person.id}`, {
                    method: "PATCH",
                    body: JSON.stringify({ primaryEmail: INTERNAL }),
                }),
                { params: Promise.resolve({ id: person.id }) },
            ),
        ]) {
            expect(response.status).toBe(400);
            expect(await response.json()).toMatchObject({
                code: "INVALID_INPUT",
                error: error.message,
            });
        }
        expect(translatedSourceMessage("cs-CZ", error.message)).toBe(
            "Adresu pro příjem pošty nelze použít jako e-mail osoby.",
        );
    });

    it("ingests internal participants without links even when primary and additional emails contain old data", async () => {
        const [person] = await db()
            .insert(people)
            .values({
                userId: "owner",
                displayName: encryptText("Legacy Person"),
                primaryEmail: encryptText(INTERNAL),
                primaryEmailHash: lookupHash(INTERNAL),
            })
            .returning({ id: people.id });
        const additional = "owner+folder@inbound.example.test";
        await db()
            .insert(personEmails)
            .values({
                userId: "owner",
                personId: person?.id ?? "",
                email: encryptText(additional),
                emailHash: lookupHash(additional),
            });
        const raw = Buffer.from(
            `From: Luma Veln <${INTERNAL}>\r\nTo: Neri Voss <${additional}>\r\nSubject: A new message\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello.`,
        );
        const parsed = await parseMessage(raw);
        const receivedAt = new Date();
        const result = await storeMailForOwner({
            delivery: {
                ownerUserId: "owner",
                senderVerified: false,
                folderIds: [],
                pendingShareFolderIds: [],
                addresses: [],
                recipients: [additional],
            },
            raw,
            parsed,
            facts: {
                fromHeaders: 1,
                fromAddresses: [INTERNAL],
                dkim: [],
                receivedAt,
            },
            spf: null,
            receivedAt,
        });
        const participants = await db()
            .select()
            .from(mailParticipants)
            .where(
                and(
                    eq(mailParticipants.userId, "owner"),
                    eq(mailParticipants.itemId, result.itemId),
                ),
            );
        expect(participants).toHaveLength(2);
        expect(participants.every((row) => row.personId === null)).toBe(true);
        expect(await peopleByAddress("owner", [INTERNAL, additional])).toEqual(
            new Map(),
        );
        await db()
            .update(mailParticipants)
            .set({ personId: person?.id })
            .where(
                and(
                    eq(mailParticipants.userId, "owner"),
                    eq(mailParticipants.itemId, result.itemId),
                ),
            );
        const content = await readItemContent("owner", result.itemId);
        expect(
            content?.participants.every((row) => row.personId === null),
        ).toBe(true);
    });

    it("finds a reply's quote when the original's only matching participant is an old internal secret link", async () => {
        const person = await createPerson({
            userId: "owner",
            displayName: "Quote Person",
            primaryEmail: EXTERNAL,
        });
        await db()
            .insert(mailAddresses)
            .values({
                id: "quote-mailbox",
                kind: "mailbox",
                namespaceUserId: "owner",
                localPart: encryptText("owner"),
                localPartHash: localPartHash("owner"),
            });
        await db()
            .insert(mailAddresses)
            .values({
                kind: "secret",
                baseAddressId: "quote-mailbox",
                namespaceUserId: "owner",
                createdByUserId: "owner",
                localPart: encryptText("owner.abcdefghij"),
                localPartHash: localPartHash("owner.abcdefghij"),
            });
        await seedMail("quote-original", INTERNAL, person.id, "Original body");
        await seedMail(
            "quote-reply",
            EXTERNAL,
            person.id,
            `Quartzneedle ${INTERNAL}`,
            "quote-original",
        );
        const caller = userCaller(
            "owner",
            "owner@example.test",
            ["mail:read", "knowledge:read"],
            null,
        );
        const tool = MAIL_TOOLS.find(
            (candidate) => candidate.name === "search_mail",
        );
        if (!tool) throw new Error("search_mail missing");
        const args = z
            .object(tool.input(caller))
            .parse({ query: "Quartzneedle", person: person.id });
        const result = (await tool.run(
            { caller, touched: [] },
            args,
        )) as unknown as {
            results: { mail: { id: string }; snippets: { text: string }[] }[];
        };
        expect(result.results.map((row) => row.mail.id)).toEqual([
            "quote-reply",
        ]);
        expect(result.results[0]?.snippets[0]?.text).toContain("Quartzneedle");
        expect(JSON.stringify(result)).not.toContain(INTERNAL);
        expect(JSON.stringify(result)).not.toContain("abcdefghij");
    });

    it("promotes an old internal email without folding people by it or carrying it into the Organization", async () => {
        await db().insert(users).values({
            id: "organization",
            role: "org",
            email: "organization@example.test",
        });
        const email = "legacy@inbound.example.test";
        await db()
            .insert(people)
            .values(
                ["owner", "organization"].map((userId) => ({
                    id: `${userId}-promoted`,
                    userId,
                    displayName: encryptText("Luma Veln"),
                    primaryEmail: encryptText(email),
                    primaryEmailHash: lookupHash(email),
                })),
            );
        await db().transaction(async (tx) => {
            expect(
                await planPersonPromotionInTx(
                    tx,
                    "owner-promoted",
                    "organization",
                ),
            ).toMatchObject({ orgPersonId: "owner-promoted", foldInto: null });
            expect(
                await promotePersonInTx(tx, "owner-promoted", "organization"),
            ).toBe("owner-promoted");
        });
        const [promoted] = await db()
            .select()
            .from(people)
            .where(
                and(
                    eq(people.id, "owner-promoted"),
                    eq(people.userId, "organization"),
                ),
            );
        expect(promoted).toMatchObject({
            primaryEmail: null,
            primaryEmailHash: null,
            mergedIntoId: null,
        });
    });

    it("preserves self-host writes without a mail domain", async () => {
        internalMailEnv.MAIL_DOMAIN = undefined;
        try {
            const person = await createPerson({
                userId: "other",
                displayName: "Local Person",
                primaryEmail: INTERNAL,
            });
            expect(person.primaryEmail).toBe(INTERNAL);
            expect(
                (await peopleByAddress("other", [INTERNAL])).get(INTERNAL),
            ).toBe(person.id);
        } finally {
            internalMailEnv.MAIL_DOMAIN = "inbound.example.test";
        }
    });
});
