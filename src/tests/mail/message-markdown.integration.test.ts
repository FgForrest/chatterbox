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
    chatterItems,
    itemShares,
    mailAddresses,
    mailContents,
    mailMessages,
    mailParticipants,
    recordingFolderAssignments,
    recordingFolders,
    restrictedFolderMembers,
    users,
} from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbRef, dbProxy, mockEnv } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    return {
        dbRef: ref,
        dbProxy: new Proxy(
            {},
            {
                get: (_, key) => {
                    const value = ref.current?.[key];
                    return typeof value === "function"
                        ? value.bind(ref.current)
                        : value;
                },
            },
        ),
        mockEnv: {
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            DATABASE_URL: "postgres://unused",
            DEFAULT_STORAGE_TYPE: "local",
            SELF_HOST_MODE: "shared",
            ORG_ACCOUNT_EMAIL: "org@example.com",
            ORG_ACCOUNT_PASSWORD: "organization-password",
            MAIL_DOMAIN: "mail.example.com",
            MAIL_ADDRESS_HASH_SECRET: "m".repeat(40),
        },
    };
});
vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async (request: Request) => ({
        user: { id: request.headers.get("x-test-user") },
    }),
}));

import { GET } from "@/app/api/mail/[id]/markdown/route";
import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { loadMailDetail } from "@/lib/mail/detail";
import { buildMailMarkdown } from "@/lib/mail/export-document";
import { localPartHash } from "@/lib/mail/hash";

const databaseUrl = getTestDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const owner = "message-owner";
const member = "message-reader";
const org = "message-org";
const itemId = "message-mail";
const date = "2026-10-18T12:00:00.000Z";

suite("mail message Markdown route (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    function call(userId: string, view = "private") {
        return GET(
            new Request(
                `http://localhost/api/mail/${itemId}/markdown?view=${view}`,
                { headers: { "x-test-user": userId } },
            ),
            { params: Promise.resolve({ id: itemId }) },
        );
    }
    async function share(restricted = false) {
        await database.db.insert(recordingFolders).values({
            id: "org-folder",
            userId: org,
            name: encryptText("Team"),
            nameHash: lookupHash("Team"),
            restrictedAt: restricted ? new Date(date) : null,
        });
        await database.db.insert(recordingFolderAssignments).values({
            userId: owner,
            itemId,
            folderId: "org-folder",
            withheld: restricted,
        });
    }
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            databaseUrl ?? "",
            "message_markdown",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    });
    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    });
    beforeEach(async () => {
        await database.db.delete(mailAddresses);
        await database.db.delete(users);
        await database.db.insert(users).values([
            { id: owner, email: "mira@example.com", name: "Mira Vale" },
            { id: member, email: "oren@example.com", name: "Oren Moss" },
            { id: org, email: "org@example.com", role: "org" },
        ]);
        await database.db.insert(chatterItems).values({
            id: itemId,
            userId: owner,
            kind: "mail",
            title: encryptText("Harbor / proposal"),
            occurredAt: new Date(date),
        });
        await database.db.insert(mailMessages).values({
            id: itemId,
            userId: owner,
            rawHash: "message-hash",
            receivedAt: new Date(date),
            sentAt: new Date(date),
            sizeBytes: 100,
            auth: {},
            senderVerified: true,
            rawStoragePath: "mail/example/message.eml.enc",
        });
        await database.db.insert(mailParticipants).values([
            {
                itemId,
                userId: owner,
                ref: "p0",
                roles: ["from"],
                name: encryptText("Mira Vale"),
                address: encryptText("mira@example.com"),
                position: 0,
            },
            {
                itemId,
                userId: owner,
                ref: "p1",
                roles: ["to"],
                name: encryptText("Oren Moss"),
                address: encryptText("oren@example.com"),
                position: 1,
            },
            {
                itemId,
                userId: owner,
                ref: "p2",
                roles: ["cc"],
                address: encryptText("team@example.com"),
                position: 2,
            },
        ]);
        await database.db.insert(mailContents).values({
            itemId,
            userId: owner,
            parserVersion: 1,
            segments: encryptJsonField([
                {
                    index: 0,
                    role: "body",
                    depth: 0,
                    text: "The proposal is ready.",
                    participantRef: null,
                    at: null,
                },
                {
                    index: 1,
                    role: "signature",
                    depth: 0,
                    text: "Mira",
                    participantRef: "p0",
                    at: null,
                },
                {
                    index: 2,
                    role: "quoted",
                    depth: 1,
                    text: "Please send it.\nThanks.",
                    participantRef: "p1",
                    at: date,
                },
                {
                    index: 3,
                    role: "quoted_signature",
                    depth: 1,
                    text: "Oren",
                    participantRef: "p1",
                    at: null,
                },
                {
                    index: 4,
                    role: "disclaimer",
                    depth: 0,
                    text: "For the project team.",
                    participantRef: null,
                    at: null,
                },
            ]),
        });
    });
    it("renders the owner's visible headers and ordered text, with quotes and a safe filename", async () => {
        const response = await call(owner);
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toBe(
            "text/markdown; charset=utf-8",
        );
        expect(response.headers.get("Cache-Control")).toBe("private, no-store");
        expect(response.headers.get("Content-Disposition")).toBe(
            "attachment; filename=\"Harbor - proposal.md\"; filename*=UTF-8''Harbor%20-%20proposal.md",
        );
        expect(await response.text()).toBe(
            [
                "# Harbor / proposal",
                "",
                "**From:** Mira Vale <mira@example.com>  ",
                "**To:** Oren Moss <oren@example.com>  ",
                "**Cc:** team@example.com  ",
                `**Date:** ${date}`,
                "",
                "The proposal is ready.",
                "",
                "-- ",
                "Mira",
                "",
                "On 2026-10-18, Oren Moss <oren@example.com> wrote:",
                "",
                "> Please send it.",
                "> Thanks.",
                "",
                "Oren Moss <oren@example.com> wrote:",
                "",
                "> Oren",
                "",
                "For the project team.",
                "",
            ].join("\n"),
        );
    });
    it("preserves the exact full export with an ordinary signature", async () => {
        const detail = await loadMailDetail(owner, itemId);
        if (!detail) throw new Error("mail detail missing");
        expect(
            buildMailMarkdown(
                {
                    ...detail,
                    segments: detail.segments.filter(
                        (segment) => segment.role !== "quoted_signature",
                    ),
                },
                null,
            ),
        ).toBe(
            [
                "---",
                'title: "Harbor / proposal"',
                `sent: ${date}`,
                `received: ${date}`,
                "from:",
                '  - "Mira Vale <mira@example.com>"',
                "to:",
                '  - "Oren Moss <oren@example.com>"',
                "cc:",
                '  - "team@example.com"',
                "sender_verified: true",
                "---",
                "",
                "# Harbor / proposal",
                "",
                "**From:** Mira Vale <mira@example.com>  ",
                "**To:** Oren Moss <oren@example.com>  ",
                "**Cc:** team@example.com  ",
                `**Date:** ${date}`,
                "",
                "The proposal is ready.",
                "",
                "-- ",
                "Mira",
                "",
                "On 2026-10-18, Oren Moss <oren@example.com> wrote:",
                "",
                "> Please send it.",
                "> Thanks.",
                "",
                "For the project team.",
                "",
            ].join("\n"),
        );
    });
    it("permits an Organization reader only in its Organization view", async () => {
        expect((await call(member, "org")).status).toBe(404);
        await share();
        expect((await call(member)).status).toBe(404);
        const response = await call(member, "org");
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("The proposal is ready.");
    });
    it("permits an accepted receiver and denies it after revocation", async () => {
        await database.db.insert(itemShares).values({
            id: "message-share",
            userId: owner,
            receiverUserId: member,
            itemId,
            state: "accepted",
        });
        expect((await call(member)).status).toBe(404);
        const response = await call(member, "received");
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("> Please send it.");
        await database.db
            .update(itemShares)
            .set({ state: "removed" })
            .where(
                and(
                    eq(itemShares.id, "message-share"),
                    eq(itemShares.userId, owner),
                ),
            );
        expect((await call(member, "received")).status).toBe(404);
    });
    it("denies a member without access to a restricted folder", async () => {
        await share(true);
        expect((await call(member, "org")).status).toBe(404);
        expect((await call(member, "received")).status).toBe(404);
        expect((await call(owner)).status).toBe(200);
    });
    it("permits a restricted-folder audience member through received", async () => {
        await share(true);
        await database.db.insert(restrictedFolderMembers).values({
            folderId: "org-folder",
            userId: member,
        });
        expect((await call(member, "org")).status).toBe(404);
        const response = await call(member, "received");
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("The proposal is ready.");
    });
    it("ends received access when restricted-folder audience membership is removed", async () => {
        await share(true);
        await database.db.insert(restrictedFolderMembers).values({
            folderId: "org-folder",
            userId: member,
        });
        expect((await call(member, "received")).status).toBe(200);
        await database.db
            .delete(restrictedFolderMembers)
            .where(
                and(
                    eq(restrictedFolderMembers.folderId, "org-folder"),
                    eq(restrictedFolderMembers.userId, member),
                ),
            );
        expect((await call(member, "received")).status).toBe(404);
        expect((await call(member, "org")).status).toBe(404);
    });
    it("permits the configured local curator to read withheld mail through received", async () => {
        await share(true);
        expect((await call(org, "org")).status).toBe(404);
        const response = await call(org, "received");
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("The proposal is ready.");
    });
    it("denies soft-deleted mail in private, Organization and received views", async () => {
        await share();
        await database.db.insert(itemShares).values({
            userId: owner,
            receiverUserId: member,
            itemId,
            state: "accepted",
        });
        expect((await call(owner)).status).toBe(200);
        expect((await call(member, "org")).status).toBe(200);
        expect((await call(member, "received")).status).toBe(200);
        await database.db
            .update(chatterItems)
            .set({ deletedAt: new Date(date) })
            .where(
                and(
                    eq(chatterItems.id, itemId),
                    eq(chatterItems.userId, owner),
                ),
            );
        expect((await call(owner)).status).toBe(404);
        expect((await call(member, "org")).status).toBe(404);
        expect((await call(member, "received")).status).toBe(404);
    });
    it("omits hidden identifiers and metadata from received Markdown", async () => {
        await share(true);
        await database.db.insert(itemShares).values({
            id: "hidden-person-share",
            userId: owner,
            receiverUserId: member,
            itemId,
            state: "accepted",
        });
        const detail = await loadMailDetail(owner, itemId);
        if (!detail) throw new Error("mail detail missing");
        await database.db
            .update(mailContents)
            .set({
                segments: encryptJsonField(
                    detail.segments.map((segment) => ({
                        ...segment,
                        ...(segment.role === "quoted"
                            ? { knownItemId: "hidden-quoted-item" }
                            : {}),
                    })),
                ),
            })
            .where(
                and(
                    eq(mailContents.itemId, itemId),
                    eq(mailContents.userId, owner),
                ),
            );
        await database.db
            .update(mailMessages)
            .set({
                auth: encryptJsonField({ rawHeader: "hidden-auth-header" }),
                attachments: encryptJsonField([
                    {
                        index: 0,
                        filename: "hidden-attachment.pdf",
                        contentType: "application/pdf",
                        size: 100,
                    },
                ]),
            })
            .where(
                and(
                    eq(mailMessages.id, itemId),
                    eq(mailMessages.userId, owner),
                ),
            );
        const response = await call(member, "received");
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).toContain("> Please send it.");
        for (const hidden of [
            itemId,
            owner,
            "org-folder",
            "hidden-person-share",
            "hidden-quoted-item",
            "hidden-auth-header",
            "hidden-attachment.pdf",
            "mail/example/message.eml.enc",
        ]) {
            expect(text).not.toContain(hidden);
        }
    });
    it.each([
        "org",
        "received",
    ])("uses exactly the detail's masking in the %s view", async (view) => {
        const localPart = "mira.secret-token";
        await database.db.insert(mailAddresses).values({
            id: "message-mailbox",
            namespaceUserId: owner,
            kind: "mailbox",
            localPart: encryptText("mira"),
            localPartHash: localPartHash("mira"),
        });
        await database.db.insert(mailAddresses).values({
            id: "message-address",
            namespaceUserId: owner,
            baseAddressId: "message-mailbox",
            localPart: encryptText(localPart),
            localPartHash: localPartHash(localPart),
            kind: "secret",
            label: encryptText("Test address"),
        });
        await database.db
            .update(chatterItems)
            .set({
                title: encryptText(`Write to ${localPart}@mail.example.com`),
            })
            .where(
                and(
                    eq(chatterItems.id, itemId),
                    eq(chatterItems.userId, owner),
                ),
            );
        if (view === "org") await share();
        else
            await database.db.insert(itemShares).values({
                userId: owner,
                receiverUserId: member,
                itemId,
                state: "accepted",
            });
        const detail = await loadMailDetail(
            member,
            itemId,
            view as "org" | "received",
        );
        const response = await call(member, view);
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).toContain(`# ${detail?.subject}`);
        expect(text).not.toContain(localPart);
        expect(response.headers.get("Content-Disposition")).not.toContain(
            localPart,
        );
    });
});
