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
    internalMailDbProxy,
    internalMailDbRef,
    internalMailEnv,
} from "@/tests/mail/internal-address-fixtures";

vi.mock("@/db", () => ({ db: internalMailDbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: internalMailEnv }));

import {
    chatterItems,
    learnReviewItems,
    learnRuns,
    mailMessages,
    mailParticipants,
    people,
    personEmails,
    users,
} from "@/db/schema";
import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { participantAddressHash } from "@/lib/mail/hash";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";
import { runUnlinkInternalAddresses } from "../../../scripts/unlink-internal-addresses";

const testDatabaseUrl = getTestDatabaseUrl();
const withDatabase = testDatabaseUrl ? describe : describe.skip;
const expected = {
    participants: 3,
    primaryEmails: 1,
    additionalEmails: 3,
    proposals: 3,
};
const zero = {
    participants: 0,
    primaryEmails: 0,
    additionalEmails: 0,
    proposals: 0,
};

withDatabase("unlink internal addresses (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    const db = () => database.db;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "unlink_internal_addresses",
        );
        internalMailDbRef.current = database.db as unknown as Record<
            PropertyKey,
            unknown
        >;
    }, 120_000);
    afterAll(async () => {
        internalMailDbRef.current = null;
        await database?.dispose();
    }, 30_000);
    beforeEach(async () => {
        internalMailEnv.MAIL_DOMAIN = "inbound.example.test";
        await db().delete(users);
        for (const userId of ["owner", "other"]) {
            await db()
                .insert(users)
                .values({ id: userId, email: `${userId}@example.test` });
            const personId = `${userId}-person`;
            const externalId = `${userId}-external`;
            await db()
                .insert(people)
                .values([
                    {
                        id: personId,
                        userId,
                        displayName: encryptText("Luma Veln"),
                        primaryEmail: encryptText(
                            "mailbox@INBOUND.EXAMPLE.TEST",
                        ),
                        primaryEmailHash: lookupHash(
                            "mailbox@INBOUND.EXAMPLE.TEST",
                        ),
                    },
                    {
                        id: externalId,
                        userId,
                        displayName: encryptText("Neri Voss"),
                        primaryEmail: encryptText("neri@example.test"),
                        primaryEmailHash: lookupHash("neri@example.test"),
                    },
                ]);
            const addresses = [
                "mailbox@INBOUND.EXAMPLE.TEST",
                "mailbox+folder@inbound.example.test",
                "mailbox.abcdefghij@inbound.example.test",
                "neri@example.test",
            ];
            await db()
                .insert(personEmails)
                .values(
                    addresses.map((email) => ({
                        userId,
                        personId,
                        email: encryptText(email),
                        emailHash: lookupHash(email),
                    })),
                );
            await db()
                .insert(chatterItems)
                .values({
                    id: `${userId}-mail`,
                    userId,
                    kind: "mail",
                    title: encryptText("A message"),
                    occurredAt: new Date(),
                });
            await db()
                .insert(mailMessages)
                .values({
                    id: `${userId}-mail`,
                    userId,
                    rawHash: `${userId}-mail`,
                    receivedAt: new Date(),
                    sizeBytes: 100,
                    senderVerified: false,
                    auth: encryptJsonField({}),
                });
            await db()
                .insert(mailParticipants)
                .values(
                    [...addresses, null].map((address, index) => ({
                        userId,
                        itemId: `${userId}-mail`,
                        ref: `p${index}`,
                        personId,
                        roles: ["to"],
                        address: address ? encryptText(address) : null,
                        addressHash: address
                            ? participantAddressHash(address)
                            : null,
                    })),
                );
            await db()
                .insert(learnRuns)
                .values(
                    ["ready", "finished"].map((status) => ({
                        id: `${userId}-${status}`,
                        userId,
                        scopeUserId: userId,
                        itemId: `${userId}-mail`,
                        view: "private" as const,
                        trigger: "manual" as const,
                        transcriptRevision: 0,
                        vocabularyVersion: 0,
                        status: status as "ready" | "finished",
                    })),
                );
            const records: {
                key: string;
                address?: string;
                speakerLabel?: string;
                decision?: "accepted" | "rejected";
                finished?: boolean;
                kind?: "person" | "entity";
            }[] = [
                { key: "address", address: addresses[0] },
                { key: "participant", speakerLabel: "p1" },
                { key: "explicit", address: addresses[2], speakerLabel: "p3" },
                { key: "external", address: addresses[3], speakerLabel: "p3" },
                {
                    key: "accepted",
                    address: addresses[0],
                    decision: "accepted",
                },
                {
                    key: "rejected",
                    address: addresses[0],
                    decision: "rejected",
                },
                { key: "finished", address: addresses[0], finished: true },
                { key: "entity", address: addresses[0], kind: "entity" },
            ];
            await db()
                .insert(learnReviewItems)
                .values(
                    records.map((record, index) => ({
                        id: `${userId}-${record.key}`,
                        runId: `${userId}-${record.finished ? "finished" : "ready"}`,
                        userId,
                        kind: "new_record" as const,
                        fingerprintHmac: String(index).repeat(64),
                        decision: record.decision ?? null,
                        payload: encryptJsonField({
                            ref: record.key,
                            kind: record.kind ?? "person",
                            name: "Luma Veln",
                            typeKey: null,
                            evidence: [],
                            address: record.address,
                            speakerLabel: record.speakerLabel,
                            maybe: { personId },
                        }),
                    })),
                );
        }
    });

    async function snapshot(userId: string) {
        return {
            participants: await db()
                .select()
                .from(mailParticipants)
                .where(eq(mailParticipants.userId, userId))
                .orderBy(mailParticipants.id),
            people: await db()
                .select()
                .from(people)
                .where(eq(people.userId, userId))
                .orderBy(people.id),
            emails: await db()
                .select()
                .from(personEmails)
                .where(eq(personEmails.userId, userId))
                .orderBy(personEmails.emailHash),
            proposals: await db()
                .select()
                .from(learnReviewItems)
                .where(eq(learnReviewItems.userId, userId))
                .orderBy(learnReviewItems.id),
        };
    }

    it("defaults to a dry run with aggregate counts and no writes", async () => {
        const before = await snapshot("owner");
        const other = await snapshot("other");
        const output = vi.spyOn(console, "log").mockImplementation(() => {});
        try {
            expect(
                await runUnlinkInternalAddresses(["--user", "owner"]),
            ).toEqual(expected);
            expect(await snapshot("owner")).toEqual(before);
            expect(await snapshot("other")).toEqual(other);
            expect(output.mock.calls).toEqual([
                [JSON.stringify(expected, null, 2)],
            ]);
            expect(await runUnlinkInternalAddresses([])).toEqual(
                Object.fromEntries(
                    Object.entries(expected).map(([key, count]) => [
                        key,
                        count * 2,
                    ]),
                ),
            );
        } finally {
            output.mockRestore();
        }
    });

    it("applies per user, preserves external addresses and decided proposals, and is idempotent", async () => {
        const before = await snapshot("owner");
        const other = await snapshot("other");
        const output = vi.spyOn(console, "log").mockImplementation(() => {});
        try {
            expect(
                await runUnlinkInternalAddresses([
                    "--apply",
                    "--user",
                    "owner",
                ]),
            ).toEqual(expected);
            const after = await snapshot("owner");
            expect(
                after.participants.filter((row) => row.personId === null),
            ).toHaveLength(3);
            expect(
                after.participants.filter(
                    (row) => row.ref === "p3" || row.ref === "p4",
                ),
            ).toEqual(
                before.participants.filter(
                    (row) => row.ref === "p3" || row.ref === "p4",
                ),
            );
            expect(
                after.people.find((row) => row.id === "owner-person"),
            ).toMatchObject({ primaryEmail: null, primaryEmailHash: null });
            expect(
                after.people.find((row) => row.id === "owner-external"),
            ).toEqual(before.people.find((row) => row.id === "owner-external"));
            expect(after.emails).toEqual(
                before.emails.filter(
                    (row) => row.emailHash === lookupHash("neri@example.test"),
                ),
            );
            expect(after.proposals).toEqual(
                before.proposals.filter(
                    (row) =>
                        ![
                            "owner-address",
                            "owner-participant",
                            "owner-explicit",
                        ].includes(row.id),
                ),
            );
            expect(await snapshot("other")).toEqual(other);
            expect(
                await runUnlinkInternalAddresses([
                    "--apply",
                    "--user",
                    "owner",
                ]),
            ).toEqual(zero);
            expect(await runUnlinkInternalAddresses(["--apply"])).toEqual(
                expected,
            );
            expect(await runUnlinkInternalAddresses([])).toEqual(zero);
            const printed = JSON.stringify(output.mock.calls);
            expect(printed).not.toContain("@");
            expect(printed).not.toContain("Luma");
            expect(printed).not.toContain("owner");
        } finally {
            output.mockRestore();
        }
    });

    it("does nothing without MAIL_DOMAIN", async () => {
        const before = await snapshot("owner");
        internalMailEnv.MAIL_DOMAIN = undefined;
        try {
            expect(await runUnlinkInternalAddresses(["--apply"])).toEqual(zero);
            expect(await snapshot("owner")).toEqual(before);
        } finally {
            internalMailEnv.MAIL_DOMAIN = "inbound.example.test";
        }
    });

    it("rejects invalid arguments without writing", async () => {
        const before = await snapshot("owner");
        await expect(
            runUnlinkInternalAddresses(["--user", " "]),
        ).rejects.toThrow("--user must be a non-empty id");
        await expect(
            runUnlinkInternalAddresses(["--unknown"]),
        ).rejects.toThrow();
        expect(await snapshot("owner")).toEqual(before);
        expect(
            await db()
                .select()
                .from(learnReviewItems)
                .where(
                    and(
                        eq(learnReviewItems.userId, "owner"),
                        eq(learnReviewItems.decision, "accepted"),
                    ),
                ),
        ).toHaveLength(1);
    });
});
