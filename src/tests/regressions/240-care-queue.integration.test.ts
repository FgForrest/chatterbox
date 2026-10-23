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
import { POST as restore } from "@/app/api/knowledge/care/restore/route";
import { POST as fix, GET as list } from "@/app/api/knowledge/care/route";
import {
    POST as shareAction,
    GET as shares,
} from "@/app/api/knowledge/care/shares/route";
import {
    almanacDuplicateDismissals,
    almanacShareChanges,
    almanacShareEvents,
    chatterItems,
    knowledgeAliases,
    knowledgeEntities,
    knowledgeFactEvidence,
    knowledgeFacts,
    knowledgeRelationTypes,
    knowledgeScopeGenerations,
    learnRuns,
    mailContents,
    mailMessages,
    people,
    recordingFolderAssignments,
    recordingFolders,
    transcriptCorrections,
    transcriptions,
    transcriptSpeakers,
    userAccessStates,
    users,
} from "@/db/schema";
import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import { buildAndUploadExportArchive } from "@/lib/export/build-archive";
import { addRecordingToFolder, unshareRecording } from "@/lib/folders/folders";
import {
    detectCareProblems,
    fixCareProblem,
    openCareProblems,
} from "@/lib/knowledge/care";
import { canOpenCare } from "@/lib/knowledge/care-access";
import {
    careArchiveSchema,
    collectCareArchive,
} from "@/lib/knowledge/care-archive";
import { careCount } from "@/lib/knowledge/care-summary";
import { createEntity } from "@/lib/knowledge/entities";
import { folderCareFor } from "@/lib/knowledge/folder-care";
import { domainLookupHash } from "@/lib/knowledge/lookup-hash";
import {
    createPerson,
    mergePeople,
    updatePerson,
} from "@/lib/knowledge/people";
import { restoreCareArchive } from "@/lib/knowledge/restore-care";
import { bumpScopeInTx } from "@/lib/knowledge/scope-generation";
import { shareEventInTx } from "@/lib/knowledge/share-provenance";
import {
    listSharedAdditions,
    reviewShare,
    shareReviewCount,
    undoShareAdditions,
} from "@/lib/knowledge/share-review";
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
            ORG_ACCOUNT_PASSWORD: undefined,
            AUTHZ_MODE: "idp",
            OIDC_ISSUER_URL: "https://identity.example.test/realms/test",
            OIDC_CLIENT_ID: "chatterbox",
            OIDC_CLIENT_SECRET: "test-secret",
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
        user: { id: request.headers.get("x-test-user") ?? "curator" },
    }),
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
const testUrl = getTestDatabaseUrl();
const withDatabase = testUrl ? describe : describe.skip;
const old = new Date("2025-01-01T00:00:00Z");
type Handler = (request: Request) => Response | Promise<Response>;
function call(handler: Handler, user = "curator", body?: unknown, query = "") {
    return handler(
        new Request(`http://localhost/api/knowledge/care${query}`, {
            method: body === undefined ? "GET" : "POST",
            headers: {
                "x-test-user": user,
                "content-type": "application/json",
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        }),
    );
}

withDatabase("Care queue with Organization provenance", () => {
    let database: TestPostgresDatabase;
    const db = () => database.db;
    let generation = 0;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testUrl ?? "",
            "care_queue",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120000);
    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30000);
    beforeEach(async () => {
        mockEnv.IS_HOSTED = false;
        mockEnv.SELF_HOST_MODE = "shared";
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
                ["curator", "member"].map((userId) => ({
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
                nameHash: "root",
                kind: "public",
            });
        await db()
            .insert(knowledgeScopeGenerations)
            .values({ userId: "org", generation: ++generation * 1000 });
        await seedCoreVocabulary();
    });
    async function audio(id = "audio") {
        await insertRecording(db(), { id, userId: "member" });
        const transcript = await insertTranscript(db(), id, "member");
        await db()
            .update(transcriptions)
            .set({
                turns: encryptJsonField([
                    {
                        speaker: "speaker_0",
                        startMs: 0,
                        endMs: 1000,
                        text: "Invented evidence",
                    },
                ]),
            })
            .where(eq(transcriptions.id, transcript));
        return transcript;
    }
    async function share(recordingId = "audio") {
        const transcripts = await db()
            .select()
            .from(transcriptions)
            .where(eq(transcriptions.recordingId, recordingId));
        for (const transcript of transcripts) {
            const [speaker] = await db()
                .select()
                .from(transcriptSpeakers)
                .where(eq(transcriptSpeakers.transcriptionId, transcript.id));
            if (!speaker)
                await db().insert(transcriptSpeakers).values({
                    userId: "member",
                    transcriptionId: transcript.id,
                    label: "speaker_0",
                    source: "user",
                    status: "confirmed",
                    markedUnknown: true,
                });
        }
        return addRecordingToFolder({
            userId: "member",
            recordingId,
            folderId: "org-root",
        });
    }
    async function speaker() {
        const transcriptionId = await audio();
        const person = await createPerson({
            userId: "member",
            displayName: "Nela Starling",
        });
        await attributeSpeaker(db(), {
            userId: "member",
            transcriptionId,
            label: "speaker_0",
            personId: person.id,
        });
        await share();
        const [event] = await db().select().from(almanacShareEvents);
        if (!event) throw new Error("missing provenance");
        return { event, person, transcriptionId };
    }
    async function literalFact(
        subjectId: string,
        value: string,
        scope = "org",
        relation = "means",
    ) {
        const [row] = await db()
            .insert(knowledgeFacts)
            .values({
                userId: scope,
                subjectEntityId: subjectId,
                subjectKey: `e:${subjectId}`,
                relationKey: relation,
                objectLiteral: encryptText(value),
                objectKey: `l:${domainLookupHash("fact-literal", value)}`,
                origin: "manual",
            })
            .returning();
        if (!row) throw new Error("missing fact");
        return row;
    }
    async function conflict() {
        const subject = await createEntity("org", {
            name: "Velnaro",
            typeKey: "term",
        });
        const a = await literalFact(subject.id, "First meaning");
        const b = await literalFact(subject.id, "Second meaning");
        await db().transaction((tx) => bumpScopeInTx(tx, ["org"]));
        const problem = (await detectCareProblems("org")).find(
            (p) => p.kind === "fact_conflict",
        );
        if (!problem) throw new Error("missing conflict");
        return { subject, a, b, problem };
    }
    async function correction(
        transcriptionId: string,
        entityId: string,
        heard: string,
        charStart: number,
        scope = "org",
    ) {
        const [c] = await db()
            .insert(transcriptCorrections)
            .values({
                userId: scope,
                transcriptionId,
                transcriptRevision: 0,
                turnIndex: 0,
                charStart,
                charEnd: charStart + 1,
                heard: encryptText(heard),
                heardHmac: domainLookupHash("correction-heard", heard),
                kind: "correct",
                replacement: encryptText("Velnaro"),
                targetEntityId: entityId,
            })
            .returning();
        if (!c) throw new Error("missing correction");
        await db()
            .insert(knowledgeAliases)
            .values({
                userId: scope,
                entityId,
                kind: "heard_as",
                text: encryptText(heard),
                textHmac: domainLookupHash("alias", heard),
                correctionId: c.id,
            });
        return c;
    }

    it("records one event for speaker and task promotions and removes only untouched additions, idempotently", async () => {
        const transcriptionId = await audio();
        const person = await createPerson({
            userId: "member",
            displayName: "Nela Starling",
            primaryEmail: "nela@example.test",
        });
        const assignee = await createPerson({
            userId: "member",
            displayName: "Jitka Dvořáková",
        });
        await attributeSpeaker(db(), {
            userId: "member",
            transcriptionId,
            label: "speaker_0",
            personId: person.id,
        });
        await insertTask(db(), {
            userId: "member",
            recordingId: "audio",
            assigneePersonId: assignee.id,
        });
        await share();
        const events = await db().select().from(almanacShareEvents);
        expect(events).toHaveLength(1);
        const eventId = events[0]?.id ?? "";
        const changes = await db()
            .select()
            .from(almanacShareChanges)
            .where(eq(almanacShareChanges.added, true));
        expect(changes.map((row) => row.targetId).sort()).toEqual(
            [person.id, assignee.id].sort(),
        );
        const result = await undoShareAdditions("curator", eventId);
        expect(result.removed).toHaveLength(2);
        expect(result.kept).toEqual([]);
        expect(await db().select().from(people)).toEqual([]);
        expect(
            await db().select().from(recordingFolderAssignments),
        ).toHaveLength(1);
        expect(await undoShareAdditions("curator", eventId)).toEqual(result);
        const [event] = await db().select().from(almanacShareEvents);
        expect(event?.undoneByUserId).toBe("curator");
        expect(event?.undoneAt).toBeInstanceOf(Date);
    });
    it("timestamps a share at publication rather than transaction start", async () => {
        await audio();
        await db().transaction(async (tx) => {
            const [start] = await tx
                .insert(almanacShareEvents)
                .values({
                    id: "transaction-start",
                    userId: "org",
                    itemId: "audio",
                    sharedByUserId: "member",
                })
                .returning();
            await new Promise((resolve) => setTimeout(resolve, 20));
            const event = await shareEventInTx(tx, "audio", "member", "org");
            const [published] = await tx
                .select()
                .from(almanacShareEvents)
                .where(eq(almanacShareEvents.id, event.id));
            expect(published?.createdAt.getTime()).toBeGreaterThan(
                start?.createdAt.getTime() ?? 0,
            );
        });
    });
    it("keeps an edited person", async () => {
        const { event, person } = await speaker();
        await updatePerson("curator", person.id, {
            displayName: "Nela Starlingová",
        });
        expect((await undoShareAdditions("curator", event.id)).kept).toEqual([
            expect.objectContaining({ reason: "changed" }),
        ]);
    });
    it.each([
        "into",
        "from",
    ])("keeps a record merged %s another record", async (direction) => {
        const { event, person } = await speaker();
        const other = await createPerson({
            userId: "org",
            displayName: "Nela",
        });
        await mergePeople(
            "curator",
            direction === "into" ? other.id : person.id,
            direction === "into" ? person.id : other.id,
        );
        expect((await undoShareAdditions("curator", event.id)).kept).toEqual([
            expect.objectContaining({ reason: "merged" }),
        ]);
    });
    it("keeps a record reused by a later share, even if that later item is withdrawn", async () => {
        const { event, person } = await speaker();
        const transcript = await audio("later");
        await attributeSpeaker(db(), {
            userId: "member",
            transcriptionId: transcript,
            label: "speaker_0",
            personId: person.id,
        });
        await share("later");
        await unshareRecording("member", "later", { withdraw: true });
        expect((await undoShareAdditions("curator", event.id)).kept).toEqual([
            expect.objectContaining({ reason: "later_share" }),
        ]);
        const second = (await db().select().from(almanacShareEvents)).find(
            (row) => row.id !== event.id,
        );
        expect(
            await db()
                .select()
                .from(almanacShareChanges)
                .where(
                    and(
                        eq(almanacShareChanges.eventId, second?.id ?? ""),
                        eq(almanacShareChanges.added, true),
                    ),
                ),
        ).toEqual([]);
    });
    it("keeps records with private notes or facts and never cascades to another source", async () => {
        const { event, person } = await speaker();
        await db()
            .insert(knowledgeFacts)
            .values({
                userId: "other",
                subjectPersonId: person.id,
                subjectKey: `p:${person.id}`,
                relationKey: "has_role",
                objectLiteral: encryptText("Coordinator"),
                objectKey: "l:coordinator",
                origin: "manual",
            });
        const result = await undoShareAdditions("curator", event.id);
        expect(result.kept[0]?.reason).toBe("other_source");
        expect(await db().select().from(knowledgeFacts)).toHaveLength(1);
    });
    it("records corrections, heard-as forms, facts and their promoted entities in the publish transaction", async () => {
        const transcript = await audio();
        const subject = await createEntity("member", {
            name: "Velnaro",
            typeKey: "term",
        });
        const c = await correction(
            transcript,
            subject.id,
            "vel naro",
            0,
            "member",
        );
        const fact = await literalFact(
            subject.id,
            "Invented meaning",
            "member",
        );
        await db()
            .update(knowledgeFacts)
            .set({ origin: "recording" })
            .where(eq(knowledgeFacts.id, fact.id));
        await db()
            .insert(knowledgeFactEvidence)
            .values({
                userId: "member",
                factId: fact.id,
                transcriptionId: transcript,
                itemId: "audio",
                transcriptRevision: 0,
                startMs: 0,
                endMs: 1000,
                quote: encryptText("Invented evidence"),
            });
        await share();
        const [event] = await db().select().from(almanacShareEvents);
        const changes = await db()
            .select()
            .from(almanacShareChanges)
            .where(eq(almanacShareChanges.added, true));
        expect(changes.map((row) => row.kind).sort()).toEqual([
            "alias",
            "correction",
            "entity",
            "fact",
        ]);
        expect(changes.find((row) => row.kind === "correction")?.targetId).toBe(
            c.id,
        );
        const outcome = await undoShareAdditions("curator", event?.id ?? "");
        expect(outcome.removed).toHaveLength(3);
        expect(outcome.kept[0]?.reason).toBe("other_source");
        expect(await db().select().from(knowledgeFacts)).toHaveLength(1);
        expect(await db().select().from(transcriptCorrections)).toEqual([]);
    });
    it("promotes unreferenced records from the finished Learn path into the same event", async () => {
        const transcript = await audio();
        const person = await createPerson({
            userId: "member",
            displayName: "Jitka Dvořáková",
        });
        await db()
            .insert(learnRuns)
            .values({
                userId: "member",
                scopeUserId: "member",
                itemId: "audio",
                transcriptionId: transcript,
                view: "private",
                actorUserId: "member",
                trigger: "manual",
                status: "finished",
                transcriptRevision: 0,
                vocabularyVersion: 1,
                inputs: {
                    contentId: transcript,
                    contentRevision: 0,
                    contentSourceId: "riffado",
                    confirmedRecords: [{ personId: person.id }],
                },
                finishedAt: new Date(),
            });
        await share();
        expect(
            (await db().select().from(almanacShareChanges)).some(
                (row) =>
                    row.kind === "person" &&
                    row.targetId === person.id &&
                    row.added,
            ),
        ).toBe(true);
    });
    it("protects records used by a finished Learn receipt on reshare", async () => {
        const transcript = await audio();
        const person = await createPerson({
            userId: "member",
            displayName: "Jitka Dvořáková",
        });
        await db()
            .insert(learnRuns)
            .values({
                userId: "member",
                scopeUserId: "member",
                itemId: "audio",
                transcriptionId: transcript,
                view: "private",
                trigger: "manual",
                status: "finished",
                transcriptRevision: 0,
                vocabularyVersion: 1,
                inputs: {
                    contentId: transcript,
                    contentRevision: 0,
                    contentSourceId: "riffado",
                    confirmedRecords: [{ personId: person.id }],
                },
                finishedAt: new Date(),
            });
        await share();
        const [first] = await db().select().from(almanacShareEvents);
        await unshareRecording("member", "audio", { withdraw: true });
        await share();
        const result = await undoShareAdditions("curator", first?.id ?? "");
        expect(result.kept).toEqual([
            expect.objectContaining({ reason: "later_share" }),
        ]);
        expect(result.removed).toEqual([]);
    });

    it("records mail Learn and task-assignee promotions", async () => {
        const itemId = "mail";
        await db()
            .insert(chatterItems)
            .values({
                id: itemId,
                userId: "member",
                kind: "mail",
                title: encryptText("Invented mail"),
                occurredAt: new Date(),
            });
        await db()
            .insert(mailMessages)
            .values({
                id: itemId,
                userId: "member",
                rawHash: "mail",
                receivedAt: new Date(),
                sizeBytes: 1,
                auth: encryptJsonField({}),
                senderVerified: true,
            });
        const [content] = await db()
            .insert(mailContents)
            .values({
                itemId,
                userId: "member",
                parserVersion: 1,
                segments: encryptJsonField([]),
            })
            .returning();
        const person = await createPerson({
            userId: "member",
            displayName: "Jitka Dvořáková",
        });
        await db()
            .insert(learnRuns)
            .values({
                userId: "member",
                scopeUserId: "member",
                itemId,
                view: "private",
                trigger: "manual",
                status: "finished",
                transcriptRevision: 0,
                vocabularyVersion: 1,
                inputs: {
                    contentId: content?.id,
                    contentRevision: 0,
                    confirmedRecords: [{ personId: person.id }],
                },
                finishedAt: new Date(),
            });
        await insertTask(db(), {
            recordingId: itemId,
            userId: "member",
            assigneePersonId: person.id,
        });
        await share(itemId);
        expect(await db().select().from(almanacShareEvents)).toHaveLength(1);
        expect(
            (await db().select().from(almanacShareChanges)).filter(
                (row) => row.added,
            ),
        ).toHaveLength(1);
    });
    it("does not expose a title after withdrawal and counts unreviewed groups only", async () => {
        const { event } = await speaker();
        expect(await shareReviewCount("curator")).toBe(1);
        expect(
            (await listSharedAdditions("curator")).groups[0]?.item?.title,
        ).toBe("Recording audio");
        await unshareRecording("member", "audio", { withdraw: true });
        await db()
            .update(chatterItems)
            .set({ title: encryptText("Private renamed title") })
            .where(eq(chatterItems.id, "audio"));
        expect(
            (await listSharedAdditions("curator")).groups[0]?.item,
        ).toBeNull();
        await reviewShare("curator", event.id);
        expect(await shareReviewCount("curator")).toBe(0);
    });
    it("detects single-valued conflicts, retires losing facts with evidence intact, and excludes private and multi-valued facts", async () => {
        const { subject, a, b, problem } = await conflict();
        await literalFact(subject.id, "Private meaning", "member");
        await db()
            .insert(knowledgeRelationTypes)
            .values({
                key: "o_many",
                userId: "org",
                label: encryptText("Many"),
                labelHmac: "many",
                subjectTypes: ["term"],
                objectTypes: [],
                objectKind: "literal",
                cardinality: "many",
            });
        await literalFact(subject.id, "A", "org", "o_many");
        await literalFact(subject.id, "B", "org", "o_many");
        expect(
            (await detectCareProblems("org")).filter(
                (p) => p.kind === "fact_conflict",
            ),
        ).toHaveLength(1);
        await fixCareProblem("curator", problem.key, "keep", a.id);
        const [loser] = await db()
            .select()
            .from(knowledgeFacts)
            .where(eq(knowledgeFacts.id, b.id));
        expect(loser?.replacedByFactId).toBe(a.id);
        expect(
            (await detectCareProblems("org")).filter(
                (p) => p.kind === "fact_conflict",
            ),
        ).toHaveLength(0);
    });
    it("remembers dismissals and reopens a changed conflict", async () => {
        const { subject, problem } = await conflict();
        await fixCareProblem("curator", problem.key, "dismiss");
        expect(await openCareProblems("curator")).toEqual([]);
        await literalFact(subject.id, "Third meaning");
        await db().transaction((tx) => bumpScopeInTx(tx, ["org"]));
        expect(await openCareProblems("curator")).toHaveLength(1);
        await expect(
            fixCareProblem("curator", problem.key, "keep", "missing"),
        ).rejects.toMatchObject({ statusCode: 409 });
    });
    it("detects two-way corrections, excludes private aliases, and keeps only the selected target", async () => {
        const transcript = await audio();
        await shareRecording(db(), "audio", "org");
        const first = await createEntity("org", {
            name: "Velnaro",
            typeKey: "term",
        });
        const second = await createEntity("org", {
            name: "Nulvaro",
            typeKey: "term",
        });
        await correction(transcript, first.id, "velno", 0);
        await correction(transcript, second.id, "velno", 2);
        const privateTarget = await createEntity("member", {
            name: "Private",
            typeKey: "term",
        });
        await correction(transcript, privateTarget.id, "velno", 4, "member");
        const problem = (await detectCareProblems("org")).find(
            (p) => p.kind === "correction_conflict",
        );
        expect(problem?.records).toHaveLength(2);
        await fixCareProblem(
            "curator",
            problem?.key ?? "",
            "keep",
            `entity:${first.id}`,
        );
        expect(await db().select().from(transcriptCorrections)).toHaveLength(2);
        expect(
            (await detectCareProblems("org")).filter(
                (p) => p.kind === "correction_conflict",
            ),
        ).toEqual([]);
    });
    it("detects only one old mention without facts and supports keeping and deleting thin people and things", async () => {
        const transcript = await audio();
        await shareRecording(db(), "audio", "org");
        const person = await createPerson({
            userId: "org",
            displayName: "Jitka Dvořáková",
        });
        const thing = await createEntity("org", {
            name: "Thin term",
            typeKey: "term",
        });
        await attributeSpeaker(db(), {
            userId: "member",
            transcriptionId: transcript,
            label: "speaker_0",
            personId: person.id,
        });
        await correction(transcript, thing.id, "thin", 0);
        await db()
            .update(people)
            .set({ updatedAt: old })
            .where(eq(people.id, person.id));
        await db()
            .update(knowledgeEntities)
            .set({ updatedAt: old })
            .where(eq(knowledgeEntities.id, thing.id));
        await db().update(transcriptSpeakers).set({ updatedAt: old });
        await db().update(transcriptCorrections).set({ updatedAt: old });
        const problems = (await detectCareProblems("org")).filter(
            (p) => p.kind === "thin",
        );
        expect(problems).toHaveLength(2);
        await fixCareProblem(
            "curator",
            problems.find((p) => p.records[0]?.kind === "person")?.key ?? "",
            "dismiss",
        );
        await fixCareProblem(
            "curator",
            problems.find((p) => p.records[0]?.kind === "entity")?.key ?? "",
            "delete",
        );
        expect(await openCareProblems("curator")).toEqual([]);
        expect(await db().select().from(people)).toHaveLength(1);
        expect(await db().select().from(knowledgeEntities)).toHaveLength(0);
    });
    it("sums duplicates, unreviewed shares and other open problems, and returns curator-only folder flags", async () => {
        const { person } = await speaker();
        const { subject } = await conflict();
        expect(await careCount("curator")).toBe(2);
        expect(
            (await folderCareFor("curator", [subject.id])).care?.problems,
        ).toHaveLength(1);
        expect(await folderCareFor("member", [subject.id, person.id])).toEqual(
            {},
        );
    });
    it("round-trips decisions using semantic content after re-encryption; private archives exclude them", async () => {
        const { a, problem } = await conflict();
        await fixCareProblem("curator", problem.key, "dismiss");
        const archive = await collectCareArchive({
            kind: "organization",
            orgUserId: "org",
        });
        expect(archive?.problems).toHaveLength(1);
        expect(archive?.provenance).toBe("not-included");
        expect(
            await collectCareArchive({ kind: "personal", userId: "curator" }),
        ).toBeNull();
        await db().delete(almanacDuplicateDismissals);
        await db()
            .update(knowledgeFacts)
            .set({ objectLiteral: encryptText("First meaning") })
            .where(eq(knowledgeFacts.id, a.id));
        if (!archive) throw new Error("missing archive");
        expect(await restoreCareArchive("curator", archive)).toEqual({
            restored: 1,
            skipped: 0,
        });
        expect(await openCareProblems("curator")).toEqual([]);
    });
    it.each([
        ["list", list, undefined],
        ["fix", fix, { key: "a".repeat(64), action: "dismiss" }],
        ["shares", shares, undefined],
        ["share action", shareAction, { eventId: "missing", action: "undo" }],
        [
            "restore",
            restore,
            {
                archive: {
                    version: 1,
                    provenance: "not-included",
                    duplicates: [],
                    problems: [],
                },
            },
        ],
    ] as const)("authorizes %s for curator and Organization account, denies members and returns 404 without Organization", async (_name, handler, body) => {
        expect((await call(handler, "member", body)).status).toBe(403);
        const admittedStatus =
            _name === "fix" ? 409 : _name === "share action" ? 404 : 200;
        expect((await call(handler, "curator", body)).status).toBe(
            admittedStatus,
        );
        expect((await call(handler, "org", body)).status).toBe(admittedStatus);
        mockEnv.IS_HOSTED = true;
        expect((await call(handler, "curator", body)).status).toBe(404);
        mockEnv.IS_HOSTED = false;
        mockEnv.SELF_HOST_MODE = "local";
        expect((await call(handler, "curator", body)).status).toBe(404);
    });
    it("excludes recent, unused, multi-mention, fact-bearing and private records from thin suggestions", async () => {
        const first = await audio();
        const second = await audio("second");
        await shareRecording(db(), "audio", "org");
        await shareRecording(db(), "second", "org");
        for (const [index, label] of [
            "recent",
            "unused",
            "twice",
            "fact",
            "private",
        ].entries()) {
            const person = await createPerson({
                userId: label === "private" ? "member" : "org",
                displayName: `Invented ${label}`,
            });
            if (label !== "unused")
                await attributeSpeaker(db(), {
                    userId: "member",
                    transcriptionId: first,
                    label: `speaker_${index}`,
                    personId: person.id,
                });
            if (label === "twice")
                await attributeSpeaker(db(), {
                    userId: "member",
                    transcriptionId: second,
                    label: "speaker_1",
                    personId: person.id,
                });
            if (label === "fact")
                await db()
                    .insert(knowledgeFacts)
                    .values({
                        userId: "org",
                        subjectPersonId: person.id,
                        subjectKey: `p:${person.id}`,
                        relationKey: "has_role",
                        objectLiteral: encryptText("Coordinator"),
                        objectKey: "l:coordinator",
                        origin: "manual",
                    });
            if (label !== "recent")
                await db()
                    .update(people)
                    .set({ updatedAt: old })
                    .where(eq(people.id, person.id));
        }
        await db().update(transcriptSpeakers).set({ updatedAt: old });
        expect(
            (await detectCareProblems("org")).filter((p) => p.kind === "thin"),
        ).toEqual([]);
    });
    it("keeps a shared fact confirmed again elsewhere", async () => {
        const transcript = await audio();
        const subject = await createEntity("org", {
            name: "Velnaro",
            typeKey: "term",
        });
        const fact = await literalFact(
            subject.id,
            "Invented meaning",
            "member",
        );
        await db()
            .update(knowledgeFacts)
            .set({ origin: "recording" })
            .where(eq(knowledgeFacts.id, fact.id));
        await db()
            .insert(knowledgeFactEvidence)
            .values({
                userId: "member",
                factId: fact.id,
                transcriptionId: transcript,
                itemId: "audio",
                transcriptRevision: 0,
                startMs: 0,
                endMs: 1000,
                quote: encryptText("Invented evidence"),
            });
        await share();
        const [event] = await db().select().from(almanacShareEvents);
        const [addition] = await db()
            .select()
            .from(almanacShareChanges)
            .where(
                and(
                    eq(almanacShareChanges.kind, "fact"),
                    eq(almanacShareChanges.added, true),
                ),
            );
        const later = await audio("confirmed");
        await db()
            .insert(knowledgeFactEvidence)
            .values({
                userId: "org",
                factId: addition?.targetId ?? "",
                transcriptionId: later,
                itemId: "confirmed",
                transcriptRevision: 0,
                startMs: 0,
                endMs: 1000,
                quote: encryptText("Invented evidence"),
            });
        expect(
            (await undoShareAdditions("curator", event?.id ?? "")).kept,
        ).toEqual([expect.objectContaining({ reason: "changed" })]);
    });
    it("deletes one addition without changing the other additions or the share's review state", async () => {
        const transcript = await audio();
        const a = await createPerson({
            userId: "member",
            displayName: "Nela Starling",
        });
        const b = await createPerson({
            userId: "member",
            displayName: "Jitka Dvořáková",
        });
        await attributeSpeaker(db(), {
            userId: "member",
            transcriptionId: transcript,
            label: "speaker_0",
            personId: a.id,
        });
        await insertTask(db(), {
            recordingId: "audio",
            userId: "member",
            assigneePersonId: b.id,
        });
        await share();
        const [event] = await db().select().from(almanacShareEvents);
        const [addition] = await db()
            .select()
            .from(almanacShareChanges)
            .where(eq(almanacShareChanges.targetId, a.id));
        expect(
            (await undoShareAdditions("curator", event?.id ?? "", addition?.id))
                .removed,
        ).toEqual([addition?.id]);
        expect((await db().select().from(people)).map((row) => row.id)).toEqual(
            [b.id],
        );
        expect(await shareReviewCount("curator")).toBe(1);
    });
    it("rejects private provenance ids and private problem targets on every write", async () => {
        await audio();
        await db().insert(almanacShareEvents).values({
            id: "private-event",
            userId: "member",
            itemId: "audio",
            sharedByUserId: "member",
        });
        expect(
            (
                await call(shareAction, "curator", {
                    eventId: "private-event",
                    action: "undo",
                })
            ).status,
        ).toBe(404);
        expect(
            (await call(shares, "curator", undefined, "?eventId=private-event"))
                .status,
        ).toBe(404);
        expect(
            (
                await call(fix, "curator", {
                    key: "b".repeat(64),
                    action: "delete",
                })
            ).status,
        ).toBe(409);
        const person = await createPerson({
            userId: "member",
            displayName: "Private person",
        });
        const response = await call(restore, "curator", {
            archive: {
                version: 1,
                provenance: "not-included",
                duplicates: [
                    { kind: "person", left: person.id, right: "missing" },
                ],
                problems: [],
            },
        });
        expect(await response.json()).toEqual({ restored: 0, skipped: 1 });
    });
    it("flags every displayed record even when its share is beyond the first page of groups", async () => {
        const records = await db()
            .insert(people)
            .values(
                Array.from({ length: 25 }, (_, i) => ({
                    userId: "org",
                    displayName: encryptText(`Invented person ${i}`),
                })),
            )
            .returning({ id: people.id });
        await db()
            .insert(almanacShareEvents)
            .values(
                records.map((record, i) => ({
                    id: `share-${record.id}`,
                    userId: "org",
                    sharedByUserId: "member",
                    createdAt: new Date(Date.now() - i * 1000),
                })),
            );
        await db()
            .insert(almanacShareChanges)
            .values(
                records.map((record) => ({
                    userId: "org",
                    eventId: `share-${record.id}`,
                    kind: "person" as const,
                    targetId: record.id,
                    recordPersonId: record.id,
                    added: true,
                    fingerprint: "a".repeat(64),
                })),
            );
        const care = await folderCareFor(
            "curator",
            records.map((record) => record.id),
        );
        expect(care.care?.shareRefs).toHaveLength(25);
        expect(care.care?.shareRefs?.map((ref) => ref.id).sort()).toEqual(
            records.map((record) => record.id).sort(),
        );
    });

    it("hides Care when no Organization account exists, even for a verified curator", async () => {
        expect(await canOpenCare("curator")).toBe(true);
        expect(await canOpenCare("org")).toBe(true);
        expect(await canOpenCare("member")).toBe(false);
        await db().delete(users).where(eq(users.id, "org"));
        expect(await canOpenCare("curator")).toBe(false);
        expect((await call(list, "curator")).status).toBe(404);
    });

    it("writes restorable decisions into the actual Organization archive and excludes them from personal archives", async () => {
        const { problem } = await conflict();
        await fixCareProblem("curator", problem.key, "dismiss");
        const storage = new ArchiveStorage();
        await buildAndUploadExportArchive({
            scope: { kind: "organization", orgUserId: "org" },
            sourceStorage: storage,
            destinationStorage: storage,
            storageKey: "archive.zip",
        });
        const zip = await unzipper.Open.buffer(storage.uploaded);
        const entry = zip.files.find(
            (entry) => entry.path === "knowledge/care-decisions.json",
        );
        expect(entry).toBeDefined();
        const archive = careArchiveSchema.parse(
            JSON.parse((await entry?.buffer())?.toString() ?? "{}"),
        );
        expect(archive.problems).toHaveLength(1);
        await db().delete(almanacDuplicateDismissals);
        const response = await call(restore, "org", { archive });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ restored: 1, skipped: 0 });
        expect(await openCareProblems("curator")).toEqual([]);
        await buildAndUploadExportArchive({
            scope: { kind: "personal", userId: "curator" },
            sourceStorage: storage,
            destinationStorage: storage,
            storageKey: "personal.zip",
        });
        expect(
            (await unzipper.Open.buffer(storage.uploaded)).files.some(
                (entry) => entry.path === "knowledge/care-decisions.json",
            ),
        ).toBe(false);
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
