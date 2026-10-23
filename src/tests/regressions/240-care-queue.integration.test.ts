import { writeFile } from "node:fs/promises";
import type { Readable } from "node:stream";
import { and, eq, type SQLWrapper, sql } from "drizzle-orm";
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
    conflictingCareCorrections,
    conflictingCareFacts,
    thinCareRecords,
} from "@/db/queries/almanac-care";
import * as shareQueries from "@/db/queries/almanac-share";
import {
    almanacDuplicateDismissals,
    almanacShareChanges,
    almanacShareEvents,
    chatterItems,
    knowledgeAliases,
    knowledgeEntities,
    knowledgeEntityNotes,
    knowledgeFactEvidence,
    knowledgeFacts,
    knowledgeRelationTypes,
    knowledgeScopeGenerations,
    learnRuns,
    mailContents,
    mailMessages,
    mailParticipants,
    people,
    personEmails,
    personNotes,
    recordingFolderAssignments,
    recordingFolders,
    recordingTasks,
    taskUpdateProposals,
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
    CARE_RESTORE_MAX_BYTES,
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
    it("keeps a share's original person and private speaker link after the source item is withdrawn", async () => {
        const { event, person, transcriptionId } = await speaker();
        await unshareRecording("member", "audio", { withdraw: true });
        const result = await undoShareAdditions("curator", event.id);
        expect(result.kept).toEqual([
            expect.objectContaining({ reason: "other_source" }),
        ]);
        expect(result.removed).toEqual([]);
        expect(
            await db().select().from(people).where(eq(people.id, person.id)),
        ).toHaveLength(1);
        const [link] = await db()
            .select()
            .from(transcriptSpeakers)
            .where(eq(transcriptSpeakers.transcriptionId, transcriptionId));
        expect(link?.personId).toBe(person.id);
    });
    it("waits for existing recording writers before taking parent locks, preserving their assignment", async () => {
        const { event, person } = await speaker();
        const transcript = await audio("other-source");
        await attributeSpeaker(db(), {
            userId: "member",
            transcriptionId: transcript,
            label: "speaker_0",
            personId: person.id,
        });
        const writer = await database.sql.reserve();
        const [connection] = await writer`select pg_backend_pid() as pid`;
        await writer`begin`;
        await writer`select id from recordings where id = 'other-source' and user_id = 'member' for update`;
        const undo = undoShareAdditions("curator", event.id);
        let open = true;
        try {
            await expect
                .poll(async () => {
                    const [row] = await database.sql`select exists (
                    select 1 from pg_stat_activity where datname = current_database()
                    and ${connection?.pid} = any(pg_blocking_pids(pid))
                ) as waiting`;
                    return row?.waiting;
                })
                .toBe(true);
            await writer`select id from people where id = ${person.id} and user_id = 'org' for key share nowait`;
            await writer`insert into recording_tasks (id, user_id, recording_id, status, text, source, assignee_person_id)
                values ('prior-assignment', 'member', 'other-source', 'open', ${encryptText("Invented task")}, 'manual', ${person.id})`;
            await writer`commit`;
            open = false;
            expect((await undo).kept).toEqual([
                expect.objectContaining({ reason: "other_source" }),
            ]);
            const [task] = await db()
                .select()
                .from(recordingTasks)
                .where(eq(recordingTasks.id, "prior-assignment"));
            expect(task?.assigneePersonId).toBe(person.id);
        } finally {
            if (open) await writer`rollback`;
            writer.release();
            await undo;
        }
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
    async function thinTarget(kind: "person" | "entity") {
        const transcript = await audio();
        await shareRecording(db(), "audio", "org");
        const target =
            kind === "person"
                ? await createPerson({
                      userId: "org",
                      displayName: "Nela Starling",
                  })
                : await createEntity("org", {
                      name: "Velnaro",
                      typeKey: "term",
                  });
        if (kind === "person")
            await attributeSpeaker(db(), {
                userId: "member",
                transcriptionId: transcript,
                label: "speaker_0",
                personId: target.id,
            });
        else await correction(transcript, target.id, "vel naro", 0);
        const table = kind === "person" ? people : knowledgeEntities;
        await db()
            .update(table)
            .set({ updatedAt: old })
            .where(eq(table.id, target.id));
        await db().update(transcriptSpeakers).set({ updatedAt: old });
        await db().update(transcriptCorrections).set({ updatedAt: old });
        const problem = (await detectCareProblems("org")).find(
            (p) => p.kind === "thin",
        );
        if (!problem) throw new Error("missing thin target");
        return { target, problem, transcript };
    }
    it.each(
        (["person", "entity"] as const).flatMap((kind) =>
            [
                "note",
                "subject fact",
                "object fact",
                "alias",
                "correction",
                "merge",
                ...(kind === "person" ? ["email", "task", "proposal"] : []),
            ].map((dependency) => ({ kind, dependency })),
        ),
    )("keeps thin $kind with a member's $dependency, including stale delete requests", async ({
        kind,
        dependency,
    }) => {
        const { target, problem, transcript } = await thinTarget(kind);
        if (dependency === "note") {
            if (kind === "person")
                await db()
                    .insert(personNotes)
                    .values({
                        userId: "other",
                        personId: target.id,
                        notes: encryptText("Private note"),
                    });
            else
                await db()
                    .insert(knowledgeEntityNotes)
                    .values({
                        userId: "other",
                        entityId: target.id,
                        notes: encryptText("Private note"),
                    });
        } else if (dependency.includes("fact")) {
            const other = await createEntity("other", {
                name: "Private project",
                typeKey: "project",
            });
            await db()
                .insert(knowledgeFacts)
                .values({
                    userId: "other",
                    relationKey: "works_on",
                    origin: "manual",
                    ...(dependency === "subject fact"
                        ? {
                              subjectPersonId:
                                  kind === "person" ? target.id : null,
                              subjectEntityId:
                                  kind === "entity" ? target.id : null,
                              subjectKey: `${kind === "person" ? "p" : "e"}:${target.id}`,
                              objectEntityId: other.id,
                              objectKey: `e:${other.id}`,
                          }
                        : {
                              subjectEntityId: other.id,
                              subjectKey: `e:${other.id}`,
                              objectPersonId:
                                  kind === "person" ? target.id : null,
                              objectEntityId:
                                  kind === "entity" ? target.id : null,
                              objectKey: `${kind === "person" ? "p" : "e"}:${target.id}`,
                          }),
                });
        } else if (dependency === "alias") {
            await db()
                .insert(knowledgeAliases)
                .values({
                    userId: "other",
                    kind: "alias",
                    text: encryptText("Private nickname"),
                    textHmac: "private",
                    personId: kind === "person" ? target.id : null,
                    entityId: kind === "entity" ? target.id : null,
                });
        } else if (dependency === "correction") {
            await db()
                .insert(transcriptCorrections)
                .values({
                    userId: "other",
                    transcriptionId: transcript,
                    transcriptRevision: 0,
                    turnIndex: 0,
                    charStart: 4,
                    charEnd: 5,
                    heard: encryptText("Private"),
                    heardHmac: "private",
                    kind: "link",
                    targetPersonId: kind === "person" ? target.id : null,
                    targetEntityId: kind === "entity" ? target.id : null,
                });
        } else if (dependency === "email") {
            await db()
                .insert(personEmails)
                .values({
                    userId: "other",
                    personId: target.id,
                    email: encryptText("nela@example.test"),
                    emailHash: "private",
                });
        } else if (dependency === "merge") {
            const table = kind === "person" ? people : knowledgeEntities;
            await db()
                .update(table)
                .set({ mergedIntoId: target.id })
                .where(
                    eq(
                        table.id,
                        kind === "person"
                            ? (
                                  await createPerson({
                                      userId: "org",
                                      displayName: "Nela",
                                  })
                              ).id
                            : (
                                  await createEntity("org", {
                                      name: "Old Velnaro",
                                      typeKey: "term",
                                  })
                              ).id,
                    ),
                );
        } else {
            const task = await insertTask(db(), {
                userId: "member",
                recordingId: "audio",
                assigneePersonId: dependency === "task" ? target.id : null,
            });
            if (dependency === "proposal")
                await db().insert(taskUpdateProposals).values({
                    userId: "member",
                    itemId: "audio",
                    taskId: task,
                    kind: "assignee",
                    proposedAssigneePersonId: target.id,
                });
        }
        expect(
            (await detectCareProblems("org")).filter((p) => p.kind === "thin"),
        ).toEqual([]);
        const response = await call(fix, "curator", {
            key: problem.key,
            action: "delete",
        });
        expect(response.status).toBe(409);
        const table = kind === "person" ? people : knowledgeEntities;
        expect(
            await db().select().from(table).where(eq(table.id, target.id)),
        ).toHaveLength(1);
    });
    it("keeps shared entities with private notes on whole-share and single-addition undo", async () => {
        const transcript = await audio();
        const thing = await createEntity("member", {
            name: "Velnaro",
            typeKey: "term",
        });
        await correction(transcript, thing.id, "vel naro", 0, "member");
        await share();
        const [addition] = await db()
            .select()
            .from(almanacShareChanges)
            .where(eq(almanacShareChanges.kind, "entity"));
        await db()
            .insert(knowledgeEntityNotes)
            .values({
                userId: "other",
                entityId: thing.id,
                notes: encryptText("Private note"),
            });
        expect(
            (
                await undoShareAdditions(
                    "curator",
                    addition?.eventId ?? "",
                    addition?.id,
                )
            ).kept,
        ).toEqual([expect.objectContaining({ reason: "other_source" })]);
        expect(
            (await undoShareAdditions("curator", addition?.eventId ?? "")).kept,
        ).toContainEqual(expect.objectContaining({ reason: "other_source" }));
        expect(await db().select().from(knowledgeEntityNotes)).toHaveLength(1);
    });
    it.each(
        (["share", "addition", "thin"] as const).flatMap((mode) =>
            ["assignment", "task insert", "proposal", "mail participant"].map(
                (writerKind) => ({ mode, writerKind }),
            ),
        ),
    )("blocks a concurrent $writerKind after $mode deletion's dependency check and rejects its FK reference", async ({
        mode,
        writerKind,
    }) => {
        const shared = mode === "thin" ? null : await speaker();
        const thin = mode === "thin" ? await thinTarget("person") : null;
        const person = shared?.person ?? thin?.target;
        if (!person) throw new Error("missing person");
        const [addition] = await db()
            .select()
            .from(almanacShareChanges)
            .where(eq(almanacShareChanges.kind, "person"));
        await audio("other-source");
        const taskId = await insertTask(db(), {
            userId: "member",
            recordingId: "other-source",
        });
        await db()
            .insert(chatterItems)
            .values({
                id: "other-mail",
                userId: "member",
                kind: "mail",
                title: encryptText("Invented mail"),
                occurredAt: new Date(),
            });
        await db()
            .insert(mailMessages)
            .values({
                id: "other-mail",
                userId: "member",
                rawHash: "other-mail",
                receivedAt: new Date(),
                sizeBytes: 1,
                auth: encryptJsonField({}),
                senderVerified: true,
            });
        const checked = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const original = shareQueries.shareRecordHasOtherSources;
        const spy = vi
            .spyOn(shareQueries, "shareRecordHasOtherSources")
            .mockImplementationOnce(async (...args) => {
                const used = await original(...args);
                checked.resolve();
                await release.promise;
                return used;
            });
        const writer = await database.sql.reserve();
        const [connection] = await writer`select pg_backend_pid() as pid`;
        const undo = thin
            ? fixCareProblem("curator", thin.problem.key, "delete").then(
                  () => ({ removed: [person.id] }),
              )
            : undoShareAdditions(
                  "curator",
                  shared?.event.id ?? "",
                  mode === "addition" ? addition?.id : undefined,
              );
        try {
            await checked.promise;
            const statement =
                writerKind === "assignment"
                    ? writer`update recording_tasks set assignee_person_id = ${person.id} where id = ${taskId} and user_id = 'member'`
                    : writerKind === "task insert"
                      ? writer`insert into recording_tasks (id, user_id, recording_id, status, text, source, assignee_person_id)
                      values ('concurrent-task', 'member', 'other-source', 'open', ${encryptText("Invented task")}, 'manual', ${person.id})`
                      : writerKind === "proposal"
                        ? writer`insert into task_update_proposals (id, user_id, recording_id, task_id, kind, proposed_assignee_person_id)
                        values ('concurrent-proposal', 'member', 'other-source', ${taskId}, 'assignee', ${person.id})`
                        : writer`insert into mail_participants (id, user_id, item_id, ref, roles, person_id)
                        values ('concurrent-participant', 'member', 'other-mail', 'p1', '[]', ${person.id})`;
            const outcome = statement.then(
                () => "committed",
                (error: { code: string }) => error.code,
            );
            await expect
                .poll(async () => {
                    const [row] =
                        await database.sql`select cardinality(pg_blocking_pids(${connection?.pid})) as blockers`;
                    return row?.blockers;
                })
                .toBeGreaterThan(0);
            release.resolve();
            expect((await undo).removed).toHaveLength(1);
            expect(await outcome).toBe("23503");
            const [task] = await db()
                .select()
                .from(recordingTasks)
                .where(eq(recordingTasks.id, taskId));
            expect(task?.assigneePersonId).toBeNull();
        } finally {
            release.resolve();
            await undo;
            writer.release();
            spy.mockRestore();
        }
    });
    it.each([
        "speaker",
        "mail participant",
    ])("excludes thin people used by a private %s", async (source) => {
        const { target, problem } = await thinTarget("person");
        if (source === "speaker") {
            const transcript = await audio("private-source");
            await attributeSpeaker(db(), {
                userId: "member",
                transcriptionId: transcript,
                label: "speaker_0",
                personId: target.id,
            });
        } else {
            await db()
                .insert(chatterItems)
                .values({
                    id: "private-mail",
                    userId: "member",
                    kind: "mail",
                    title: encryptText("Invented private mail"),
                    occurredAt: new Date(),
                });
            await db()
                .insert(mailMessages)
                .values({
                    id: "private-mail",
                    userId: "member",
                    rawHash: "private-mail",
                    receivedAt: new Date(),
                    sizeBytes: 1,
                    auth: encryptJsonField({}),
                    senderVerified: true,
                });
            await db()
                .insert(mailParticipants)
                .values({
                    userId: "member",
                    itemId: "private-mail",
                    ref: "p1",
                    roles: ["from"],
                    personId: target.id,
                });
        }
        expect(
            (await detectCareProblems("org")).filter((p) => p.kind === "thin"),
        ).toEqual([]);
        expect(
            (await call(fix, "curator", { key: problem.key, action: "delete" }))
                .status,
        ).toBe(409);
        expect(
            await db().select().from(people).where(eq(people.id, target.id)),
        ).toHaveLength(1);
    });
    it("skips saturated thin usage rather than declaring one sampled item to be the whole history", async () => {
        const { target, transcript } = await thinTarget("person");
        await db()
            .insert(transcriptSpeakers)
            .values(
                Array.from({ length: 65 }, (_, i) => ({
                    userId: "member",
                    transcriptionId: transcript,
                    label: `extra_${i}`,
                    personId: target.id,
                    source: "user" as const,
                    status: "confirmed" as const,
                    updatedAt: old,
                })),
            );
        expect(
            (await detectCareProblems("org")).filter((p) => p.kind === "thin"),
        ).toEqual([]);
    });
    it("round-trips an exported archive larger than 16 KiB through the real restore route", async () => {
        const records = await db()
            .insert(people)
            .values(
                Array.from({ length: 32 }, (_, i) => ({
                    id: `archive-person-${String(i).padStart(7, "0")}`,
                    userId: "org",
                    displayName: encryptText(`Invented person ${i}`),
                })),
            )
            .returning();
        const pairs = records.flatMap((left, i) =>
            records.slice(i + 1).map((right) => ({
                userId: "org",
                kind: "person" as const,
                leftPersonId: left.id,
                rightPersonId: right.id,
            })),
        );
        await db().insert(almanacDuplicateDismissals).values(pairs);
        const archive = await collectCareArchive({
            kind: "organization",
            orgUserId: "org",
        });
        expect(Buffer.byteLength(JSON.stringify({ archive }))).toBeGreaterThan(
            16 * 1024,
        );
        await db().delete(almanacDuplicateDismissals);
        const response = await call(restore, "curator", { archive });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ restored: 496, skipped: 0 });
        expect(
            await collectCareArchive({
                kind: "organization",
                orgUserId: "org",
            }),
        ).toEqual(archive);
    });

    it("accepts one decision at all content caps and rejects oversized restore requests before writing", async () => {
        const archive = careArchiveSchema.parse({
            version: 1,
            provenance: "not-included",
            duplicates: [],
            problems: [
                {
                    kind: "correction_conflict",
                    records: Array.from({ length: 2000 }, (_, i) => ({
                        id: String(i).padStart(64, "x"),
                        kind: "entity",
                        name: "\u0000".repeat(200),
                    })),
                    relationKey: "r".repeat(64),
                    heard: "\u0000".repeat(200),
                    values: Array(2000).fill("\u0000".repeat(500)),
                    lastAt: old.toISOString(),
                },
            ],
        });
        const bytes = Buffer.byteLength(JSON.stringify({ archive }));
        expect(bytes).toBeGreaterThan(8 * 1024 * 1024);
        expect(bytes).toBeLessThan(CARE_RESTORE_MAX_BYTES);
        const accepted = await call(restore, "curator", { archive });
        expect(accepted.status).toBe(200);
        expect(await accepted.json()).toEqual({ restored: 0, skipped: 1 });
        const rejected = await restore(
            new Request("http://localhost/api/knowledge/care/restore", {
                method: "POST",
                headers: {
                    "x-test-user": "curator",
                    "content-type": "application/json",
                    "content-length": String(CARE_RESTORE_MAX_BYTES + 1),
                },
                body: "{}",
            }),
        );
        expect(rejected.status).toBe(413);
        expect(await db().select().from(almanacDuplicateDismissals)).toEqual(
            [],
        );
    });

    it("uses bounded indexes with 50,000 heard-as forms, 40,000 facts and 100,000 historical dismissals", async () => {
        const transcript = await audio();
        await shareRecording(db(), "audio", "org");
        const outside = await createEntity("org", {
            name: "Older term",
            typeKey: "term",
        });
        await db()
            .update(knowledgeEntities)
            .set({ createdAt: old })
            .where(eq(knowledgeEntities.id, outside.id));
        const c = await correction(transcript, outside.id, "old term", 0);
        await database.sql`insert into knowledge_entities (id, user_id, type_key, name, name_hmac, updated_at)
            select 'plan-entity-' || i, 'org', 'term', ${encryptText("Invented term")}, 'plan-name-' || i, '2025-01-01'::timestamp from generate_series(1,3000) i`;
        await database.sql`insert into people (id, user_id, display_name, updated_at)
            select 'plan-person-' || i, 'org', ${encryptText("Invented person")}, '2025-01-01'::timestamp from generate_series(1,3000) i`;
        await database.sql`insert into knowledge_aliases (id, user_id, entity_id, kind, text, text_hmac, correction_id)
            select 'plan-alias-' || i, 'org', ${outside.id}, 'heard_as', ${encryptText("Invented heard form")}, 'plan-form-' || i, ${c.id}
            from generate_series(1,50000) i`;
        await database.sql`insert into knowledge_facts (id, user_id, subject_entity_id, subject_key, relation_key, object_literal, object_key, origin)
            select 'plan-fact-' || i, 'org', case when i <= 30000 then ${outside.id} else 'plan-entity-3000' end,
                'e:' || case when i <= 30000 then ${outside.id} else 'plan-entity-3000' end,
                'means', ${encryptText("Invented meaning")}, 'l:plan-value-' || i, 'manual' from generate_series(1,40000) i`;
        await database.sql`insert into almanac_duplicate_dismissals (id, user_id, kind, problem_key)
            select 'plan-dismissal-' || i, 'org', 'thin', lpad(i::text,64,'0') from generate_series(1,100000) i`;
        await correction(transcript, "plan-entity-1", "thin plan term", 4);
        await db().update(transcriptCorrections).set({ updatedAt: old });
        await database.sql`insert into chatter_items (id, user_id, kind, title, occurred_at)
            select 'plan-item-' || i, 'member', 'audio', ${encryptText("Invented item")}, now() from generate_series(1,10000) i`;
        await database.sql`insert into recording_folder_assignments (user_id, recording_id, folder_id)
            select 'member', 'plan-item-' || i, 'org-root' from generate_series(1,10000) i`;
        await database.sql`vacuum analyze`;
        const queries: SQLWrapper[] = [];
        const execute: typeof database.db.execute = (query) => {
            if (typeof query === "string")
                throw new Error("expected a bound query");
            queries.push(query);
            return database.db.execute(query);
        };
        const executor = { execute };
        await conflictingCareFacts("org", executor);
        await conflictingCareCorrections("org", executor);
        const thin = await thinCareRecords(
            "org",
            new Date(Date.now() - 120 * 86400000),
            executor,
        );
        expect(thin.some((row) => row.id === "plan-entity-1")).toBe(true);
        const plans = [];
        for (const query of queries) {
            const plan = await db().execute(
                sql`explain (analyze, buffers, format json) ${query}`,
            );
            plans.push(plan[0]?.["QUERY PLAN"]);
        }
        const dismissalPlan =
            await database.sql`explain (analyze, buffers, format json)
            select problem_key from almanac_duplicate_dismissals
            where user_id = 'org' and problem_key = any(array[lpad('50000',64,'0')])`;
        plans.push(dismissalPlan[0]?.["QUERY PLAN"]);
        const serialized = JSON.stringify(plans, null, 2);
        await writeFile("/tmp/almanac-care-query-plans.json", serialized);
        for (const index of [
            "knowledge_facts_scope_current_updated_idx",
            "knowledge_aliases_scope_heard_updated_idx",
            "knowledge_entities_scope_live_created_idx",
            "people_scope_live_created_idx",
            "almanac_dismissals_scope_problem_key_idx",
        ])
            expect(
                serialized.includes(index),
                `missing candidate index ${index}`,
            ).toBe(true);
        function nodes(value: unknown): Record<string, unknown>[] {
            if (Array.isArray(value)) return value.flatMap(nodes);
            if (!value || typeof value !== "object") return [];
            const row = value as Record<string, unknown>;
            return [row, ...Object.values(row).flatMap(nodes)];
        }
        const allNodes = nodes(plans);
        expect(
            nodes(plans[2]).some(
                (row) =>
                    row["Node Type"] === "Seq Scan" &&
                    [
                        "knowledge_aliases",
                        "knowledge_facts",
                        "almanac_duplicate_dismissals",
                    ].includes(String(row["Relation Name"])) &&
                    Number(row["Actual Loops"]) > 0,
            ),
        ).toBe(false);
        const candidateIndexes = allNodes.filter(
            (row) =>
                typeof row["Index Name"] === "string" &&
                /scope_(current|heard|live|problem)/.test(
                    String(row["Index Name"]),
                ),
        );
        console.info(
            "Care EXPLAIN candidates",
            candidateIndexes.map((row) => ({
                index: row["Index Name"],
                rows: row["Actual Rows"],
                loops: row["Actual Loops"],
                removed: row["Rows Removed by Filter"] ?? 0,
            })),
        );
        expect(
            allNodes
                .filter(
                    (row) =>
                        row["Relation Name"] === "knowledge_aliases" &&
                        row["Index Name"] ===
                            "knowledge_aliases_scope_heard_updated_idx",
                )
                .every((row) => Number(row["Actual Rows"]) <= 16000),
        ).toBe(true);
        expect(
            allNodes
                .filter(
                    (row) =>
                        row["Relation Name"] === "knowledge_facts" &&
                        row["Index Name"] ===
                            "knowledge_facts_scope_current_updated_idx",
                )
                .every((row) => Number(row["Actual Rows"]) <= 32000),
        ).toBe(true);
    }, 30000);

    it("refuses correction fixes that would cascade into a member's heard-as form", async () => {
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
        const losing = await correction(transcript, second.id, "velno", 2);
        await db()
            .insert(knowledgeAliases)
            .values({
                userId: "other",
                entityId: first.id,
                kind: "heard_as",
                text: encryptText("Private heard form"),
                textHmac: "private-form",
                correctionId: losing.id,
            });
        const problem = (await detectCareProblems("org")).find(
            (p) => p.kind === "correction_conflict",
        );
        await expect(
            fixCareProblem(
                "curator",
                problem?.key ?? "",
                "keep",
                `entity:${first.id}`,
            ),
        ).rejects.toMatchObject({ statusCode: 409 });
        expect(
            await db()
                .select()
                .from(knowledgeAliases)
                .where(eq(knowledgeAliases.userId, "other")),
        ).toHaveLength(1);
        expect(await db().select().from(transcriptCorrections)).toHaveLength(2);
    });
    it("keeps a thin entity if an Organization correction also belongs to an item outside the Organization", async () => {
        const { target, problem } = await thinTarget("entity");
        const privateTranscript = await audio("outside-organization");
        await correction(privateTranscript, target.id, "another form", 0);
        const response = await call(fix, "curator", {
            key: problem.key,
            action: "delete",
        });
        expect(response.status).toBe(409);
        expect(await db().select().from(transcriptCorrections)).toHaveLength(2);
        expect(
            await db()
                .select()
                .from(knowledgeEntities)
                .where(eq(knowledgeEntities.id, target.id)),
        ).toHaveLength(1);
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
