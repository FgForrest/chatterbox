import type { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import unzipper from "unzipper";
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
    GET as compare,
    POST as join,
} from "@/app/api/knowledge/duplicates/compare/route";
import {
    POST as dismiss,
    GET as list,
} from "@/app/api/knowledge/duplicates/route";
import * as duplicateQueries from "@/db/queries/almanac-duplicates";
import {
    almanacDuplicateDismissals,
    chatterItems,
    knowledgeAliases,
    knowledgeEntities,
    knowledgeFactEvidence,
    knowledgeFacts,
    knowledgeRelationTypes,
    knowledgeScopeGenerations,
    mailMessages,
    mailParticipants,
    people,
    personEmails,
    recordingFolders,
    recordingTasks,
    transcriptCorrections,
    transcriptSpeakers,
    userAccessStates,
    users,
} from "@/db/schema";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { buildAndUploadExportArchive } from "@/lib/export/build-archive";
import type { DuplicateComparison } from "@/lib/knowledge/duplicate-comparison";
import {
    type DuplicatePage,
    loadDuplicateRecords,
} from "@/lib/knowledge/duplicates";
import { createEntity, getEntity } from "@/lib/knowledge/entities";
import { domainLookupHash, lookupHash } from "@/lib/knowledge/lookup-hash";
import {
    createPerson,
    getPerson,
    mergePeople,
    updatePerson,
} from "@/lib/knowledge/people";
import { seedCoreVocabulary } from "@/lib/knowledge/vocabulary";
import type { StorageProvider } from "@/lib/storage/types";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";
import {
    attributeSpeaker,
    insertRecording,
    insertTask,
    insertTranscript,
    shareRecording,
} from "@/tests/mcp/fixtures";

const { dbRef, dbProxy, mockEnv } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    return {
        dbRef: ref,
        dbProxy: new Proxy(
            {},
            {
                get: (_target, key) => {
                    const value = ref.current?.[key];
                    return typeof value === "function"
                        ? value.bind(ref.current)
                        : value;
                },
            },
        ),
        mockEnv: {
            IS_HOSTED: false,
            SELF_HOST_MODE: "shared",
            ORG_ACCOUNT_EMAIL: "org@example.test",
            ORG_ACCOUNT_PASSWORD: undefined as string | undefined,
            OIDC_ISSUER_URL: "https://identity.example.test/realms/test",
            OIDC_CLIENT_ID: "chatterbox",
            OIDC_CLIENT_SECRET: "test-secret",
            AUTHZ_MODE: "idp" as "idp" | "local",
            AUTHZ_VERIFICATION_MAX_AGE: 1800,
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            DATABASE_URL: "postgres://unused",
        },
    };
});
vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async (request: Request) => ({
        user: {
            id: request.headers.get("x-test-user") ?? "curator",
            email: "curator@example.test",
        },
    }),
}));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));

type Handler = (request: Request) => Response | Promise<Response>;
function call(handler: Handler, user = "curator", body?: unknown, query = "") {
    return handler(
        new Request(`http://localhost/api/knowledge/duplicates${query}`, {
            method: body === undefined ? "GET" : "POST",
            headers: {
                "x-test-user": user,
                "content-type": "application/json",
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        }),
    );
}
const testUrl = getTestDatabaseUrl();
const withDatabase = testUrl ? describe : describe.skip;

withDatabase("curator duplicate queue and compare-and-join", () => {
    let database: TestPostgresDatabase;
    const db = () => database.db;
    let generation = 0;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testUrl ?? "",
            "curator_duplicates",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);
    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);
    beforeEach(async () => {
        mockEnv.AUTHZ_MODE = "idp";
        await db().delete(users);
        await db()
            .insert(users)
            .values([
                { id: "org", email: "org@example.test", role: "org" },
                { id: "curator", email: "curator@example.test" },
                { id: "member", email: "member@example.test" },
                { id: "other", email: "other@example.test" },
            ]);
        await db()
            .insert(userAccessStates)
            .values(
                ["curator", "member", "other"].map((userId) => ({
                    userId,
                    issuer: mockEnv.OIDC_ISSUER_URL,
                    subject: userId,
                    capabilities:
                        userId === "curator" ? ["use", "org.curate"] : ["use"],
                    verifiedAt: new Date(),
                    source: "login" as const,
                })),
            );
        await db()
            .insert(recordingFolders)
            .values({
                id: "org-root",
                userId: "org",
                name: encryptText("Organization"),
                nameHash: "org",
                kind: "public",
            });
        await db()
            .insert(knowledgeScopeGenerations)
            .values({ userId: "org", generation: ++generation * 1000 });
        await seedCoreVocabulary();
        await db()
            .insert(knowledgeRelationTypes)
            .values({
                userId: "org",
                key: "o_position",
                label: encryptText("Position"),
                labelHmac: domainLookupHash("relation-type-label", "Position"),
                subjectTypes: ["person"],
                objectTypes: [],
                objectKind: "literal",
                cardinality: "one",
            });
    });
    async function pair() {
        const left = await createPerson({
            userId: "org",
            displayName: "Ondřej Kalous",
            primaryEmail: "ondrej@kestrel.example",
        });
        const right = await createPerson({
            userId: "org",
            displayName: "Ondra Kalous",
            primaryEmail: "ondra@moravia.example",
        });
        return { left, right };
    }
    async function comparison(
        kind: "person" | "entity",
        left: string,
        right: string,
    ) {
        const response = await call(
            compare,
            "curator",
            undefined,
            `?kind=${kind}&left=${left}&right=${right}`,
        );
        expect(response.status).toBe(200);
        return (await response.json()) as DuplicateComparison;
    }
    function choices(
        data: DuplicateComparison,
        extra: Record<string, unknown> = {},
    ) {
        return {
            kind: data.kind,
            survivorId: data.survivorId,
            loserId:
                data.survivorId === data.left.id ? data.right.id : data.left.id,
            nameSourceId: data.right.id,
            factChoices: {},
            version: data.version,
            ...extra,
        };
    }
    async function fact(
        personId: string,
        value: string,
        relationKey = "o_position",
    ) {
        const [row] = await db()
            .insert(knowledgeFacts)
            .values({
                userId: "org",
                subjectPersonId: personId,
                subjectKey: `p:${personId}`,
                relationKey,
                objectLiteral: encryptText(value),
                objectKey: `l:${domainLookupHash("fact-literal", value)}`,
                origin: "manual",
            })
            .returning();
        return row;
    }

    it("rejects a member on every endpoint, including malformed requests", async () => {
        const { left, right } = await pair();
        for (const [handler, body, query] of [
            [list, undefined, "?limit=bad"],
            [dismiss, { kind: "person", left: left.id, right: right.id }, ""],
            [
                compare,
                undefined,
                `?kind=person&left=${left.id}&right=${right.id}`,
            ],
            [join, {}, ""],
        ] as const) {
            expect((await call(handler, "member", body, query)).status).toBe(
                403,
            );
        }
    });
    it("includes only live Organization records, including in comparisons and dismissals", async () => {
        const { left, right } = await pair();
        const privatePerson = await createPerson({
            userId: "curator",
            displayName: "Ondřej Kalous",
        });
        const gone = await createPerson({
            userId: "org",
            displayName: "Ondřej Kalous",
        });
        await db()
            .update(people)
            .set({ mergedIntoId: left.id })
            .where(eq(people.id, gone.id));
        const response = await call(list);
        expect(response.status).toBe(200);
        const data = (await response.json()) as DuplicatePage;
        expect(data.candidates).toHaveLength(1);
        expect(
            new Set([data.candidates[0].left.id, data.candidates[0].right.id]),
        ).toEqual(new Set([left.id, right.id]));
        expect(
            (
                await call(
                    compare,
                    "curator",
                    undefined,
                    `?kind=person&left=${left.id}&right=${privatePerson.id}`,
                )
            ).status,
        ).toBe(404);
        expect(
            (
                await call(dismiss, "curator", {
                    kind: "person",
                    left: left.id,
                    right: privatePerson.id,
                })
            ).status,
        ).toBe(404);
    });
    it("remembers unordered dismissal across curators and cascades on deletion", async () => {
        const { left, right } = await pair();
        for (const ids of [
            [left.id, right.id],
            [right.id, left.id],
        ])
            expect(
                (
                    await call(dismiss, "curator", {
                        kind: "person",
                        left: ids[0],
                        right: ids[1],
                    })
                ).status,
            ).toBe(200);
        expect(
            await db().select().from(almanacDuplicateDismissals),
        ).toHaveLength(1);
        expect((await (await call(list)).json()).candidates).toEqual([]);
        await db()
            .update(userAccessStates)
            .set({ capabilities: ["use", "org.curate"] })
            .where(eq(userAccessStates.userId, "other"));
        expect((await (await call(list, "other")).json()).candidates).toEqual(
            [],
        );
        await db().delete(people).where(eq(people.id, left.id));
        expect(await db().select().from(almanacDuplicateDismissals)).toEqual(
            [],
        );
    });
    it("bounds pagination and preserves a cursor when earlier pairs are dismissed", async () => {
        for (let index = 0; index < 4; index++)
            await createPerson({ userId: "org", displayName: "Ondřej Kalous" });
        const first = (await (
            await call(list, "curator", undefined, "?limit=2")
        ).json()) as DuplicatePage;
        expect(first.candidates).toHaveLength(2);
        expect(first.nextCursor).toBeTypeOf("string");
        const removed = first.candidates[0];
        await call(dismiss, "curator", {
            kind: "person",
            left: removed.left.id,
            right: removed.right.id,
        });
        const second = (await (
            await call(
                list,
                "curator",
                undefined,
                `?limit=2&cursor=${first.nextCursor}`,
            )
        ).json()) as DuplicatePage;
        expect(second.candidates).toHaveLength(2);
        expect(
            second.candidates.every(
                (pair) =>
                    !first.candidates.some((prior) => prior.key === pair.key),
            ),
        ).toBe(true);
        for (const query of [
            "?limit=0",
            "?limit=51",
            "?limit=1.5",
            "?cursor=bad",
            "?kind=private",
        ])
            expect((await call(list, "curator", undefined, query)).status).toBe(
                400,
            );
    });
    it("shows co-speakers and different-email signals, without exposing private items or tasks", async () => {
        const { left, right } = await pair();
        for (const id of ["shared", "private"]) {
            await insertRecording(db(), { id, userId: "member", title: id });
            const transcriptionId = await insertTranscript(db(), id, "member");
            for (const [index, personId] of [left.id, right.id].entries())
                await attributeSpeaker(db(), {
                    userId: "member",
                    transcriptionId,
                    label: `speaker_${index}`,
                    personId,
                });
            await insertTask(db(), {
                recordingId: id,
                userId: "member",
                assigneePersonId: right.id,
                text: id,
            });
        }
        await shareRecording(db(), "shared", "org");
        const data = (await (await call(list)).json()) as DuplicatePage;
        expect(data.candidates[0]).toMatchObject({
            confidence: "low",
            against: expect.arrayContaining([
                "both_speakers",
                "different_emails",
            ]),
        });
        const compared = await comparison("person", left.id, right.id);
        expect(compared.right.appearances.map((item) => item.title)).toEqual([
            "shared",
        ]);
        expect(compared.right.tasks.map((task) => task.text)).toEqual([
            "shared",
        ]);
    });
    it("joins chosen name, email and alias unions, facts, evidence, speakers and tasks atomically", async () => {
        const { left, right } = await pair();
        await db()
            .insert(personEmails)
            .values({
                userId: "org",
                personId: right.id,
                email: encryptText("o.kalous@kestrel.example"),
                emailHash: lookupHash("o.kalous@kestrel.example"),
            });
        await db()
            .insert(knowledgeAliases)
            .values([
                {
                    userId: "org",
                    personId: left.id,
                    kind: "alias",
                    text: encryptText("Kalous"),
                    textHmac: domainLookupHash("alias", "Kalous"),
                },
                {
                    userId: "org",
                    personId: right.id,
                    kind: "alias",
                    text: encryptText("OK"),
                    textHmac: domainLookupHash("alias", "OK"),
                },
            ]);
        const a = await fact(left.id, "Coordinator");
        const b = await fact(right.id, "Lead");
        await insertRecording(db(), { id: "rec", userId: "member" });
        await shareRecording(db(), "rec", "org");
        const transcriptionId = await insertTranscript(db(), "rec", "member");
        await attributeSpeaker(db(), {
            userId: "member",
            transcriptionId,
            label: "speaker_0",
            personId: right.id,
        });
        const taskId = await insertTask(db(), {
            recordingId: "rec",
            userId: "member",
            assigneePersonId: right.id,
        });
        const [correction] = await db()
            .insert(transcriptCorrections)
            .values({
                userId: "org",
                transcriptionId,
                transcriptRevision: 0,
                turnIndex: 0,
                charStart: 0,
                charEnd: 3,
                heard: encryptText("Kalus"),
                heardHmac: domainLookupHash("correction-heard", "Kalus"),
                kind: "correct",
                targetPersonId: right.id,
                replacement: encryptText("Kalous"),
            })
            .returning();
        await db()
            .insert(knowledgeAliases)
            .values({
                userId: "org",
                personId: right.id,
                kind: "heard_as",
                text: encryptText("Kalus"),
                textHmac: domainLookupHash("alias", "Kalus"),
                correctionId: correction.id,
            });
        await db()
            .insert(knowledgeFactEvidence)
            .values(
                [a.id, b.id].map((factId) => ({
                    userId: "org",
                    factId,
                    transcriptionId,
                    itemId: "rec",
                    transcriptRevision: 0,
                    startMs: 0,
                    endMs: 1000,
                    quote: encryptText("Invented evidence"),
                })),
            );
        const data = await comparison("person", left.id, right.id);
        expect(data.clashes).toEqual([
            {
                relationKey: "o_position",
                factIds: expect.arrayContaining([a.id, b.id]),
            },
        ]);
        expect(
            (
                await call(
                    join,
                    "curator",
                    choices(data, {
                        survivorId: left.id,
                        loserId: right.id,
                        factChoices: { o_position: b.id },
                    }),
                )
            ).status,
        ).toBe(200);
        expect(await getPerson("member", left.id)).toMatchObject({
            displayName: right.displayName,
            primaryEmail: left.primaryEmail,
        });
        expect(await getPerson("member", right.id)).toMatchObject({
            mergedIntoId: left.id,
        });
        const emails = await db()
            .select()
            .from(personEmails)
            .where(eq(personEmails.userId, "org"));
        expect(emails.map((email) => decryptText(email.email)).sort()).toEqual(
            [right.primaryEmail, "o.kalous@kestrel.example"].sort(),
        );
        expect(emails.every((email) => email.personId === left.id)).toBe(true);
        const aliases = await db()
            .select()
            .from(knowledgeAliases)
            .where(eq(knowledgeAliases.personId, left.id));
        expect(aliases.map((alias) => decryptText(alias.text))).toEqual(
            expect.arrayContaining(["Kalous", "OK", "Kalus", left.displayName]),
        );
        expect(
            (
                await db()
                    .select()
                    .from(knowledgeFacts)
                    .where(eq(knowledgeFacts.id, a.id))
            )[0].replacedByFactId,
        ).toBe(b.id);
        expect(
            (
                await db()
                    .select()
                    .from(knowledgeFacts)
                    .where(eq(knowledgeFacts.id, b.id))
            )[0],
        ).toMatchObject({ subjectPersonId: left.id, replacedByFactId: null });
        expect(await db().select().from(knowledgeFactEvidence)).toHaveLength(2);
        expect((await db().select().from(transcriptSpeakers))[0].personId).toBe(
            left.id,
        );
        expect(
            (
                await db()
                    .select()
                    .from(recordingTasks)
                    .where(eq(recordingTasks.id, taskId))
            )[0].assigneePersonId,
        ).toBe(left.id);
        expect(
            (await db().select().from(transcriptCorrections))[0].targetPersonId,
        ).toBe(left.id);
        expect(await db().select().from(mailParticipants)).toEqual([]);
    });
    it("moves a member's extra address and private mail participant in a plain private-to-Organization merge", async () => {
        const winner = await createPerson({
            userId: "org",
            displayName: "Zavi Duspektor",
        });
        const loser = await createPerson({
            userId: "member",
            displayName: "Zavi Duspektar",
        });
        await db()
            .insert(personEmails)
            .values({
                userId: "member",
                personId: loser.id,
                email: encryptText("zavi@invented.example"),
                emailHash: lookupHash("zavi@invented.example"),
            });
        await db()
            .insert(chatterItems)
            .values({
                id: "private-mail",
                userId: "member",
                kind: "mail",
                title: encryptText("Invented mail"),
                occurredAt: new Date(),
            });
        await db()
            .insert(mailMessages)
            .values({
                id: "private-mail",
                userId: "member",
                rawHash: "a".repeat(64),
                receivedAt: new Date(),
                sizeBytes: 100,
                auth: {},
                senderVerified: false,
            });
        await db()
            .insert(mailParticipants)
            .values({
                itemId: "private-mail",
                userId: "member",
                ref: "p1",
                roles: ["from"],
                personId: loser.id,
            });
        await mergePeople("member", winner.id, loser.id);
        expect(
            (
                await db()
                    .select()
                    .from(personEmails)
                    .where(eq(personEmails.userId, "member"))
            )[0],
        ).toMatchObject({ personId: winner.id, userId: "member" });
        expect(
            (
                await db()
                    .select()
                    .from(mailParticipants)
                    .where(eq(mailParticipants.userId, "member"))
            )[0],
        ).toMatchObject({
            personId: winner.id,
            userId: "member",
            itemId: "private-mail",
        });
        expect((await getPerson("member", loser.id))?.mergedIntoId).toBe(
            winner.id,
        );
    });
    it("keeps a promoted primary address out of extras when only the loser had one", async () => {
        const left = await createPerson({
            userId: "org",
            displayName: "Zavi Duspektor",
        });
        const right = await createPerson({
            userId: "org",
            displayName: "Zavi Duspektar",
            primaryEmail: "zavi@invented.example",
        });
        const data = await comparison("person", left.id, right.id);
        expect(
            (
                await call(
                    join,
                    "curator",
                    choices(data, { survivorId: left.id, loserId: right.id }),
                )
            ).status,
        ).toBe(200);
        expect((await getPerson("member", left.id))?.primaryEmail).toBe(
            right.primaryEmail,
        );
        expect(
            await db()
                .select()
                .from(personEmails)
                .where(eq(personEmails.personId, left.id)),
        ).toEqual([]);
    });
    it("cleans retained names through the existing alias writer", async () => {
        const left = await createPerson({
            userId: "org",
            displayName: "Zavi   Duspektor",
        });
        const right = await createPerson({
            userId: "org",
            displayName: "Zavi Duspektar",
        });
        const data = await comparison("person", left.id, right.id);
        expect(
            (
                await call(
                    join,
                    "curator",
                    choices(data, {
                        survivorId: left.id,
                        loserId: right.id,
                        nameSourceId: right.id,
                    }),
                )
            ).status,
        ).toBe(200);
        const aliases = await db()
            .select()
            .from(knowledgeAliases)
            .where(
                and(
                    eq(knowledgeAliases.userId, "org"),
                    eq(knowledgeAliases.personId, left.id),
                ),
            );
        expect(aliases.map((alias) => decryptText(alias.text))).toContain(
            "Zavi Duspektor",
        );
        expect(
            aliases.find(
                (alias) => decryptText(alias.text) === "Zavi Duspektor",
            )?.textHmac,
        ).toBe(domainLookupHash("alias", "Zavi Duspektor"));
    });
    it("slices a cached ranking and refreshes after database generation changes or expiration", async () => {
        const { left, right } = await pair();
        await createPerson({ userId: "org", displayName: left.displayName });
        const forms = vi.spyOn(duplicateQueries, "duplicateForms");
        try {
            const first = (await (
                await call(list, "curator", undefined, "?kind=person&limit=1")
            ).json()) as DuplicatePage;
            expect(forms).toHaveBeenCalledTimes(1);
            const second = await (
                await call(list, "other", undefined, "?kind=person")
            ).json();
            expect(second.code).toBe("FORBIDDEN");
            await call(
                list,
                "curator",
                undefined,
                `?kind=person&limit=1&cursor=${first.nextCursor}`,
            );
            expect(forms).toHaveBeenCalledTimes(1);
            await updatePerson("curator", right.id, {
                displayName: "Nelo Xavitor",
            });
            const refreshed = (await (
                await call(list, "curator", undefined, "?kind=person")
            ).json()) as DuplicatePage;
            expect(forms).toHaveBeenCalledTimes(2);
            expect(
                refreshed.candidates.every(
                    (pair) =>
                        pair.left.id !== right.id && pair.right.id !== right.id,
                ),
            ).toBe(true);
            const now = vi
                .spyOn(Date, "now")
                .mockReturnValue(Date.now() + 6 * 60_000);
            try {
                const cold = (await (
                    await call(list, "curator", undefined, "?kind=person")
                ).json()) as DuplicatePage;
                expect(cold).toEqual(refreshed);
                expect(forms).toHaveBeenCalledTimes(3);
            } finally {
                now.mockRestore();
            }
            const callsBeforeDismissal = forms.mock.calls.length;
            const generationsBefore = await db()
                .select()
                .from(knowledgeScopeGenerations);
            const removed = refreshed.candidates[0];
            await call(dismiss, "curator", {
                kind: "person",
                left: removed.left.id,
                right: removed.right.id,
            });
            const dismissed = (await (
                await call(list, "curator", undefined, "?kind=person")
            ).json()) as DuplicatePage;
            expect(dismissed.candidates).toEqual([]);
            expect(forms).toHaveBeenCalledTimes(callsBeforeDismissal);
            expect(await db().select().from(knowledgeScopeGenerations)).toEqual(
                generationsBefore,
            );
        } finally {
            forms.mockRestore();
        }
    });
    it("returns an uncached scan when a concurrent writer changes the Organization generation", async () => {
        const { left, right } = await pair();
        const original = duplicateQueries.duplicateForms;
        const forms = vi
            .spyOn(duplicateQueries, "duplicateForms")
            .mockImplementationOnce(async (...args) => {
                const result = await original(...args);
                await updatePerson("curator", right.id, {
                    displayName: "Nelo Xavitor",
                });
                return result;
            });
        try {
            const page = (await (
                await call(list, "curator", undefined, "?kind=person")
            ).json()) as DuplicatePage;
            expect(page.candidates).toHaveLength(1);
            expect(forms).toHaveBeenCalledTimes(1);
            const fresh = (await (
                await call(list, "curator", undefined, "?kind=person")
            ).json()) as DuplicatePage;
            expect(fresh.candidates).toEqual([]);
            expect(forms).toHaveBeenCalledTimes(2);
            await call(list, "curator", undefined, "?kind=person");
            expect(forms).toHaveBeenCalledTimes(2);
            expect(
                (await getPerson("curator", left.id))?.mergedIntoId,
            ).toBeNull();
        } finally {
            forms.mockRestore();
        }
    });
    it("shares identical cold scans and cleans up a failed in-flight scan", async () => {
        await pair();
        const original = duplicateQueries.duplicateForms;
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const forms = vi
            .spyOn(duplicateQueries, "duplicateForms")
            .mockImplementationOnce(async (...args) => {
                await gate;
                return original(...args);
            });
        try {
            const first = call(list, "curator", undefined, "?kind=person");
            const second = call(list, "curator", undefined, "?kind=person");
            await vi.waitFor(() => expect(forms).toHaveBeenCalledTimes(1));
            release();
            const responses = await Promise.all([first, second]);
            expect(responses.map((response) => response.status)).toEqual([
                200, 200,
            ]);
            expect(await responses[0].json()).toEqual(
                await responses[1].json(),
            );
            expect(forms).toHaveBeenCalledTimes(1);
            forms.mockRejectedValueOnce(new Error("Invented query failure"));
            const query = "?kind=entity";
            expect((await call(list, "curator", undefined, query)).status).toBe(
                500,
            );
            expect((await call(list, "curator", undefined, query)).status).toBe(
                200,
            );
            expect(forms).toHaveBeenCalledTimes(3);
        } finally {
            release();
            forms.mockRestore();
        }
    });
    it("expires idle decrypted scans after five minutes and cancels stale-generation timers for both kinds", async () => {
        const { right } = await pair();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const forms = vi.spyOn(duplicateQueries, "duplicateForms");
        try {
            await call(list, "curator", undefined, "?kind=person");
            await call(list, "curator", undefined, "?kind=entity");
            expect(vi.getTimerCount()).toBe(2);
            await updatePerson("curator", right.id, {
                displayName: "Nelo Xavitor",
            });
            await call(list, "curator", undefined, "?kind=entity");
            expect(vi.getTimerCount()).toBe(1);
            const callsBeforeExpiry = forms.mock.calls.length;
            await vi.advanceTimersByTimeAsync(5 * 60_000);
            expect(vi.getTimerCount()).toBe(0);
            expect(forms).toHaveBeenCalledTimes(callsBeforeExpiry);
            await call(list, "curator", undefined, "?kind=entity");
            expect(forms).toHaveBeenCalledTimes(callsBeforeExpiry + 1);
            expect(vi.getTimerCount()).toBe(1);
            await vi.advanceTimersByTimeAsync(5 * 60_000);
        } finally {
            forms.mockRestore();
            vi.useRealTimers();
        }
    });
    it("keeps picker scans out of the shared cache", async () => {
        const { left, right } = await pair();
        const forms = vi.spyOn(duplicateQueries, "duplicateForms");
        try {
            const query = "?kind=person";
            await call(list, "curator", undefined, query);
            for (const sourceId of [left.id, right.id, left.id])
                await call(
                    list,
                    "curator",
                    undefined,
                    `${query}&sourceId=${sourceId}`,
                );
            expect(forms).toHaveBeenCalledTimes(4);
            await call(list, "curator", undefined, query);
            expect(forms).toHaveBeenCalledTimes(4);
        } finally {
            forms.mockRestore();
        }
    });
    it("filters fresh entity dismissals without reranking or changing the knowledge generation", async () => {
        const left = await createEntity("org", {
            typeKey: "project",
            name: "Zavil Path",
        });
        const right = await createEntity("org", {
            typeKey: "product",
            name: "Zavil Path",
        });
        const forms = vi.spyOn(duplicateQueries, "duplicateForms");
        const dismissals = vi.spyOn(duplicateQueries, "duplicateDismissals");
        try {
            const query = "?kind=entity";
            const initial = await (
                await call(list, "curator", undefined, query)
            ).json();
            expect(initial.candidates).toHaveLength(1);
            const before = await db().select().from(knowledgeScopeGenerations);
            await call(dismiss, "curator", {
                kind: "entity",
                left: left.id,
                right: right.id,
            });
            expect(await db().select().from(knowledgeScopeGenerations)).toEqual(
                before,
            );
            expect(
                (await (await call(list, "curator", undefined, query)).json())
                    .candidates,
            ).toEqual([]);
            expect(forms).toHaveBeenCalledTimes(1);
            expect(dismissals).toHaveBeenCalledTimes(2);
        } finally {
            forms.mockRestore();
            dismissals.mockRestore();
        }
    });
    it("sends pair signals to Postgres in bounded chunks", async () => {
        const execute = vi.spyOn(db(), "execute");
        try {
            const pairs = Array.from({ length: 1001 }, (_, index) => ({
                left: `left-${index}`,
                right: `right-${index}`,
            }));
            expect(
                await duplicateQueries.duplicatePairSignals(
                    "org",
                    "person",
                    pairs,
                ),
            ).toEqual({ speakers: [] });
            expect(execute).toHaveBeenCalledTimes(3);
        } finally {
            execute.mockRestore();
        }
    });
    it("requires clash choices and rejects a stale comparison without partial writes", async () => {
        const { left, right } = await pair();
        await fact(left.id, "Coordinator");
        await fact(right.id, "Lead");
        const data = await comparison("person", left.id, right.id);
        const missing = await call(join, "curator", choices(data));
        expect(missing.status).toBe(409);
        expect((await missing.json()).details.reason).toBe(
            "missing_clash_choice",
        );
        await updatePerson("curator", left.id, {
            displayName: "Ondřej Kalous Updated",
        });
        expect(
            (
                await call(
                    join,
                    "curator",
                    choices(data, {
                        factChoices: { o_position: data.clashes[0].factIds[0] },
                    }),
                )
            ).status,
        ).toBe(409);
        expect((await getPerson("member", right.id))?.mergedIntoId).toBeNull();
    });
    it("merges different entity types through comparison and preserves descriptions and name aliases", async () => {
        const left = await createEntity("org", {
            typeKey: "project",
            name: "Kestrel Path",
            description: "First description",
        });
        const right = await createEntity("org", {
            typeKey: "product",
            name: "Kestrel Path",
            description: "Second description",
        });
        expect(
            (
                await (
                    await call(list, "curator", undefined, "?kind=entity")
                ).json()
            ).candidates[0].for,
        ).toContain("different_types");
        const data = await comparison("entity", left.id, right.id);
        expect(
            (
                await call(
                    join,
                    "curator",
                    choices(data, { survivorId: left.id, loserId: right.id }),
                )
            ).status,
        ).toBe(200);
        expect(await getEntity("member", left.id)).toMatchObject({
            name: "Kestrel Path",
            typeKey: "project",
            description: "First description\n\nSecond description",
        });
        expect(
            (
                await db()
                    .select()
                    .from(knowledgeEntities)
                    .where(eq(knowledgeEntities.id, right.id))
            )[0].mergedIntoId,
        ).toBe(left.id);
    });
    it("bounds the live records loaded for an Organization scan", async () => {
        for (let offset = 0; offset < 2001; offset += 500) {
            await db()
                .insert(people)
                .values(
                    Array.from(
                        { length: Math.min(500, 2001 - offset) },
                        (_, index) => ({
                            id: `record-${String(offset + index).padStart(4, "0")}`,
                            userId: "org",
                            createdAt: new Date(
                                1_700_000_000_000 + offset + index,
                            ),
                            displayName: encryptText(
                                domainLookupHash(
                                    "invented-fixture",
                                    String(offset + index),
                                ).slice(0, 20),
                            ),
                        }),
                    ),
                );
        }
        const response = await call(
            list,
            "curator",
            undefined,
            "?kind=person&limit=2",
        );
        expect(response.status).toBe(200);
        const page = (await response.json()) as DuplicatePage;
        expect(page.limited).toBe(true);
        const loaded = await loadDuplicateRecords("org", "person");
        expect(loaded.records[0].id).toBe("record-2000");
        expect(
            loaded.records.some((record) => record.id === "record-0000"),
        ).toBe(false);
        expect(page.candidates.length).toBeLessThanOrEqual(2);
        expect(
            page.candidates.every(
                (pair) =>
                    pair.left.id !== "record-0000" &&
                    pair.right.id !== "record-0000",
            ),
        ).toBe(true);
    }, 60_000);

    it("unions colliding facts and mail evidence without violating the text anchor key", async () => {
        const { left, right } = await pair();
        const a = await fact(left.id, "Coordinator");
        const b = await fact(right.id, "Coordinator");
        await insertRecording(db(), { id: "evidence-item", userId: "member" });
        for (const factId of [a.id, b.id]) {
            await db()
                .insert(knowledgeFactEvidence)
                .values([
                    {
                        userId: "org",
                        factId,
                        itemId: "evidence-item",
                        transcriptRevision: 0,
                        segmentIndex: 0,
                        charStart: 0,
                        charEnd: 10,
                        quote: encryptText("Shared proof"),
                    },
                    {
                        userId: "org",
                        factId,
                        itemId: "evidence-item",
                        transcriptRevision: 0,
                        segmentIndex: factId === a.id ? 1 : 2,
                        charStart: 0,
                        charEnd: 10,
                        quote: encryptText("Other proof"),
                    },
                ]);
        }
        const data = await comparison("person", left.id, right.id);
        expect(data.clashes).toEqual([]);
        expect(
            (
                await call(
                    join,
                    "curator",
                    choices(data, { survivorId: left.id, loserId: right.id }),
                )
            ).status,
        ).toBe(200);
        expect(await db().select().from(knowledgeFacts)).toHaveLength(1);
        const evidence = await db().select().from(knowledgeFactEvidence);
        expect(evidence).toHaveLength(3);
        expect(new Set(evidence.map((item) => item.segmentIndex))).toEqual(
            new Set([0, 1, 2]),
        );
    });

    it("archives dismissal decisions only in the Organization backup with restorable references", async () => {
        const { left, right } = await pair();
        await call(dismiss, "curator", {
            kind: "person",
            left: left.id,
            right: right.id,
        });
        const storage = new ArchiveStorage();
        await buildAndUploadExportArchive({
            scope: { kind: "organization", orgUserId: "org" },
            sourceStorage: storage,
            destinationStorage: storage,
            storageKey: "archive.zip",
        });
        const archive = await unzipper.Open.buffer(storage.uploaded);
        const entry = archive.files.find(
            (entry) => entry.path === "knowledge/duplicate-dismissals.json",
        );
        expect(entry).toBeDefined();
        const dismissals = JSON.parse(
            (await entry?.buffer())?.toString() ?? "[]",
        ) as {
            leftPersonId: string;
            rightPersonId: string;
            dismissedByUserId: string;
        }[];
        expect(dismissals).toHaveLength(1);
        expect(
            new Set([dismissals[0].leftPersonId, dismissals[0].rightPersonId]),
        ).toEqual(new Set([left.id, right.id]));
        expect(dismissals[0].dismissedByUserId).toBe("curator");
        const peopleEntry = archive.files.find(
            (entry) => entry.path === "knowledge/people.json",
        );
        const archivedPeople = JSON.parse(
            (await peopleEntry?.buffer())?.toString() ?? "{}",
        ).people as { id: string }[];
        expect(archivedPeople.map((person) => person.id)).toEqual(
            expect.arrayContaining([left.id, right.id]),
        );
        await buildAndUploadExportArchive({
            scope: { kind: "personal", userId: "curator" },
            sourceStorage: storage,
            destinationStorage: storage,
            storageKey: "personal.zip",
        });
        expect(
            (await unzipper.Open.buffer(storage.uploaded)).files.some(
                (entry) => entry.path === "knowledge/duplicate-dismissals.json",
            ),
        ).toBe(false);
    });

    it("uses the same contrary evidence and dismissals for an Organization merge source", async () => {
        const { left, right } = await pair();
        const privatePerson = await createPerson({
            userId: "curator",
            displayName: "Ondřej Kalous",
        });
        const query = `?kind=person&sourceId=${left.id}&limit=50`;
        const page = (await (
            await call(list, "curator", undefined, query)
        ).json()) as DuplicatePage;
        expect(page.candidates).toHaveLength(1);
        expect(page.candidates[0].against).toContain("different_emails");
        expect(
            (
                await call(
                    list,
                    "curator",
                    undefined,
                    `?kind=person&sourceId=${privatePerson.id}`,
                )
            ).status,
        ).toBe(404);
        expect(
            (await call(list, "curator", undefined, `?sourceId=${left.id}`))
                .status,
        ).toBe(400);
        await call(dismiss, "curator", {
            kind: "person",
            left: left.id,
            right: right.id,
        });
        expect(
            (await (await call(list, "curator", undefined, query)).json())
                .candidates,
        ).toEqual([]);
    });

    it("supports local Organization account authorization and observes revoked curator access", async () => {
        const { left, right } = await pair();
        const data = await comparison("person", left.id, right.id);
        await db()
            .update(userAccessStates)
            .set({ capabilities: ["use"] })
            .where(eq(userAccessStates.userId, "curator"));
        expect((await call(join, "curator", choices(data))).status).toBe(403);
        mockEnv.AUTHZ_MODE = "local";
        expect((await call(list, "org")).status).toBe(200);
        expect((await call(list, "curator")).status).toBe(403);
    });
});

class ArchiveStorage implements StorageProvider {
    uploaded = Buffer.alloc(0);
    async uploadFile(key: string): Promise<string> {
        return key;
    }
    async downloadFile(): Promise<Buffer> {
        throw new Error("not found");
    }
    async downloadStream(): Promise<Readable> {
        throw new Error("not found");
    }
    async uploadStream(key: string, stream: Readable): Promise<string> {
        const chunks: Buffer[] = [];
        for await (const chunk of stream)
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        this.uploaded = Buffer.concat(chunks);
        return key;
    }
    async exists(): Promise<boolean> {
        return false;
    }
    async getSignedUrl(): Promise<string> {
        return "";
    }
    async deleteFile(): Promise<void> {}
    async testConnection(): Promise<boolean> {
        return true;
    }
}
