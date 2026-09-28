/**
 * Knowledge through sharing and withdrawal, against a real PostgreSQL: a
 * share publishes the owner's corrections, heard-as forms and facts on the
 * recording to the Organization (promoting who and what they name), keeps
 * what cannot be shared private, and a withdrawal takes back the
 * Organization's evidence while the owner gets the corrections back.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

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
    knowledgeAliases,
    knowledgeEntities,
    knowledgeFactEvidence,
    knowledgeFacts,
    knowledgeRelationTypes,
    people,
    recordingFolders,
    recordings,
    transcriptCorrections,
    transcriptions,
    transcriptSpeakers,
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
            SELF_HOST_MODE: "shared",
            ORG_ACCOUNT_EMAIL: "org@example.test",
            ORG_ACCOUNT_PASSWORD: "organization-password",
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            DATABASE_URL: "postgres://unused",
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

import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import { addRecordingToFolder, unshareRecording } from "@/lib/folders/folders";
import { acceptCorrection } from "@/lib/knowledge/corrections";
import { createEntity } from "@/lib/knowledge/entities";
import {
    confirmFactFromRecording,
    confirmManualFact,
} from "@/lib/knowledge/facts";
import {
    createOrgType,
    createPrivateType,
    seedCoreVocabulary,
} from "@/lib/knowledge/vocabulary";
import { ensureOrgAccount } from "@/lib/org/account";
import type { TranscriptTurn } from "@/lib/transcription/turns";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const OWNER = "user-owner";
const REC = "rec-shared";

const TURNS: TranscriptTurn[] = [
    {
        speaker: "speaker_0",
        startMs: 0,
        endMs: 12_000,
        text: "Tady Novák, vedu Orion a zítra volám Akme a Honzovi.",
    },
];
const at = (heard: string) => {
    const charStart = TURNS[0]?.text.indexOf(heard) ?? -1;
    return {
        turnIndex: 0,
        charStart,
        charEnd: charStart + heard.length,
        heard,
    };
};

describeWithDatabase("knowledge through sharing (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";
    let transcriptId = "";
    let jan = "";
    let pavel = "";
    let orion = "";
    let acme = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "share_knowledge",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    async function share() {
        const [root] = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, orgUserId));
        await addRecordingToFolder({
            userId: OWNER,
            recordingId: REC,
            folderId: root?.id ?? "",
        });
    }

    function correct(
        heard: string,
        target: { personId: string } | { entityId: string },
        actorUserId = OWNER,
        replacement = "X",
    ) {
        return acceptCorrection({
            userId: OWNER,
            transcriptionId: transcriptId,
            revision: 0,
            anchor: at(heard),
            kind: "correct",
            target,
            replacement,
            actorUserId,
            orgUserId,
        });
    }

    const scopeOf = async (id: string) =>
        (
            await db()
                .select({ userId: transcriptCorrections.userId })
                .from(transcriptCorrections)
                .where(eq(transcriptCorrections.id, id))
        )[0]?.userId;

    beforeEach(async () => {
        await db().delete(users);
        await db().insert(users).values({ id: OWNER, email: "o@example.test" });
        orgUserId = (await ensureOrgAccount()) ?? "";
        await seedCoreVocabulary();
        await db()
            .insert(recordings)
            .values({
                id: REC,
                userId: OWNER,
                deviceSn: "SN-1",
                plaudFileId: "plaud-1",
                filename: encryptText("Weekly"),
                duration: 12_000,
                startTime: new Date("2026-09-01T10:00:00Z"),
                endTime: new Date("2026-09-01T10:00:12Z"),
                filesize: 11,
                fileMd5: "0".repeat(32),
                storageType: "local",
                storagePath: `${OWNER}/rec.mp3`,
                plaudVersion: "1",
            });
        const [transcript] = await db()
            .insert(transcriptions)
            .values({
                recordingId: REC,
                userId: OWNER,
                text: encryptText(TURNS[0]?.text ?? ""),
                turns: encryptJsonField(TURNS),
                detectedLanguage: "cs",
                provider: "openai",
                model: "gpt-4o-transcribe-diarize",
                source: "riffado",
            })
            .returning({ id: transcriptions.id });
        transcriptId = transcript?.id ?? "";
        const inserted = await db()
            .insert(people)
            .values([
                { userId: OWNER, displayName: encryptText("Jan Novotný") },
                { userId: OWNER, displayName: encryptText("Pavel") },
            ])
            .returning({ id: people.id });
        jan = inserted[0]?.id ?? "";
        pavel = inserted[1]?.id ?? "";
        await db().insert(transcriptSpeakers).values({
            userId: OWNER,
            transcriptionId: transcriptId,
            label: "speaker_0",
            personId: jan,
            source: "user",
            status: "confirmed",
            confirmedByUserId: OWNER,
        });
        orion = (
            await createEntity(OWNER, { typeKey: "project", name: "Orion" })
        ).id;
        const supplier = await createPrivateType(OWNER, {
            kind: "entity",
            label: "Supplier",
        });
        acme = (await createEntity(OWNER, { typeKey: supplier, name: "Acme" }))
            .id;
    });

    it("publishes what can be shared, promoting who and what it names, and keeps the rest private", async () => {
        const toJan = await correct(
            "Novák",
            { personId: jan },
            OWNER,
            "Novotný",
        );
        const toAcme = await correct("Akme", { entityId: acme }, OWNER, "Acme");
        const leads = await confirmFactFromRecording({
            subject: { personId: jan },
            relationKey: "leads",
            object: { entityId: orion },
            ownerUserId: OWNER,
            transcriptionId: transcriptId,
            revision: 0,
            actorUserId: OWNER,
            orgUserId,
            startMs: 0,
            endMs: 12_000,
            speakerLabel: "speaker_0",
        });
        const mentors = await createPrivateType(OWNER, {
            kind: "relation",
            label: "mentors",
            subjectTypes: ["person"],
            objectTypes: ["person"],
            objectKind: "entity",
            cardinality: "many",
        });
        await confirmFactFromRecording({
            subject: { personId: jan },
            relationKey: mentors,
            object: { personId: pavel },
            ownerUserId: OWNER,
            transcriptionId: transcriptId,
            revision: 0,
            actorUserId: OWNER,
            orgUserId,
            startMs: 0,
            endMs: 12_000,
        });

        await share();

        const owners = async (
            table: typeof people | typeof knowledgeEntities,
            id: string,
        ) =>
            (
                await db()
                    .select({ userId: table.userId })
                    .from(table)
                    .where(eq(table.id, id))
            )[0]?.userId;
        expect(await owners(people, jan)).toBe(orgUserId);
        expect(await owners(knowledgeEntities, orion)).toBe(orgUserId);
        expect(await owners(knowledgeEntities, acme)).toBe(OWNER);
        expect(await scopeOf(toJan)).toBe(orgUserId);
        expect(await scopeOf(toAcme)).toBe(OWNER);
        const heardAs = await db()
            .select({ userId: knowledgeAliases.userId })
            .from(knowledgeAliases)
            .where(eq(knowledgeAliases.correctionId, toJan));
        expect(heardAs.map((row) => row.userId)).toEqual([orgUserId]);

        const orgFacts = await db()
            .select()
            .from(knowledgeFacts)
            .where(eq(knowledgeFacts.userId, orgUserId));
        expect(orgFacts.map((fact) => fact.relationKey)).toEqual(["leads"]);
        const evidence = await db()
            .select({
                userId: knowledgeFactEvidence.userId,
                transcriptionId: knowledgeFactEvidence.transcriptionId,
            })
            .from(knowledgeFactEvidence)
            .where(eq(knowledgeFactEvidence.factId, orgFacts[0]?.id ?? ""));
        expect(evidence).toEqual([
            { userId: orgUserId, transcriptionId: transcriptId },
        ]);
        // The owner's own fact and its evidence stay as they were.
        expect(
            await db()
                .select({ id: knowledgeFactEvidence.id })
                .from(knowledgeFactEvidence)
                .where(eq(knowledgeFactEvidence.factId, leads)),
        ).toHaveLength(1);
    });

    it("keeps a fact private that the Organization's relation does not fit, and still shares", async () => {
        const mentors = await createPrivateType(OWNER, {
            kind: "relation",
            label: "mentors",
            subjectTypes: ["person"],
            objectTypes: ["person"],
            objectKind: "entity",
            cardinality: "many",
        });
        // Adopted as an Organization relation between organizations only.
        const partners = await createOrgType(orgUserId, {
            kind: "relation",
            label: "partners with",
            subjectTypes: ["organization"],
            objectTypes: ["organization"],
            objectKind: "entity",
            cardinality: "many",
        });
        await confirmFactFromRecording({
            subject: { personId: jan },
            relationKey: mentors,
            object: { personId: pavel },
            ownerUserId: OWNER,
            transcriptionId: transcriptId,
            revision: 0,
            actorUserId: OWNER,
            orgUserId,
            startMs: 0,
            endMs: 12_000,
        });
        await db()
            .update(knowledgeRelationTypes)
            .set({ adoptedAsKey: partners })
            .where(eq(knowledgeRelationTypes.key, mentors));

        await share();

        expect(
            await db()
                .select()
                .from(knowledgeFacts)
                .where(eq(knowledgeFacts.userId, orgUserId)),
        ).toEqual([]);
        expect(
            await db()
                .select({ id: knowledgeFacts.id })
                .from(knowledgeFacts)
                .where(eq(knowledgeFacts.userId, OWNER)),
        ).toHaveLength(1);
    });

    it("does not overwrite what the Organization knows of a single-valued relation", async () => {
        const [orgJan] = await db()
            .insert(people)
            .values({ userId: orgUserId, displayName: encryptText("Jan N.") })
            .returning({ id: people.id });
        const tavesi = await createEntity(orgUserId, {
            typeKey: "organization",
            name: "Tavesi",
        });
        const orgSaid = await confirmManualFact(orgUserId, {
            subject: { personId: orgJan?.id ?? "" },
            relationKey: "works_for",
            object: { entityId: tavesi.id },
        });
        const ownersOrg = await createEntity(OWNER, {
            typeKey: "organization",
            name: "Orion s.r.o.",
        });
        await db()
            .update(transcriptSpeakers)
            .set({ personId: orgJan?.id ?? "" })
            .where(eq(transcriptSpeakers.transcriptionId, transcriptId));
        await confirmFactFromRecording({
            subject: { personId: orgJan?.id ?? "" },
            relationKey: "works_for",
            object: { entityId: ownersOrg.id },
            ownerUserId: OWNER,
            transcriptionId: transcriptId,
            revision: 0,
            actorUserId: OWNER,
            orgUserId,
            startMs: 0,
            endMs: 12_000,
            speakerLabel: "speaker_0",
        });

        await share();

        const orgWorksFor = await db()
            .select({ id: knowledgeFacts.id })
            .from(knowledgeFacts)
            .where(
                and(
                    eq(knowledgeFacts.userId, orgUserId),
                    eq(knowledgeFacts.relationKey, "works_for"),
                ),
            );
        expect(orgWorksFor.map((fact) => fact.id)).toEqual([orgSaid]);
    });

    it("takes the Organization's evidence back on withdrawal, gives the owner the corrections, and publishes again on a new share", async () => {
        const toJan = await correct(
            "Novák",
            { personId: jan },
            OWNER,
            "Novotný",
        );
        await confirmFactFromRecording({
            subject: { personId: jan },
            relationKey: "leads",
            object: { entityId: orion },
            ownerUserId: OWNER,
            transcriptionId: transcriptId,
            revision: 0,
            actorUserId: OWNER,
            orgUserId,
            startMs: 0,
            endMs: 12_000,
            speakerLabel: "speaker_0",
        });
        await share();
        // The curator's own correction, while shared.
        const curators = await correct(
            "Honzovi",
            { personId: jan },
            orgUserId,
            "Janovi",
        );

        await unshareRecording(OWNER, REC);

        expect(
            await db()
                .select()
                .from(knowledgeFactEvidence)
                .where(eq(knowledgeFactEvidence.userId, orgUserId)),
        ).toEqual([]);
        expect(
            await db()
                .select()
                .from(knowledgeFacts)
                .where(eq(knowledgeFacts.userId, orgUserId)),
        ).toEqual([]);
        expect(await scopeOf(toJan)).toBe(OWNER);
        expect(await scopeOf(curators)).toBe(OWNER);
        const heardAs = await db()
            .select({ userId: knowledgeAliases.userId })
            .from(knowledgeAliases)
            .where(eq(knowledgeAliases.kind, "heard_as"));
        expect(heardAs.map((row) => row.userId)).toEqual([OWNER, OWNER]);
        // Promoted people and entities stay the Organization's; the owner's
        // fact is untouched.
        const [stillOrg] = await db()
            .select({ userId: people.userId })
            .from(people)
            .where(eq(people.id, jan));
        expect(stillOrg?.userId).toBe(orgUserId);
        expect(
            await db()
                .select()
                .from(knowledgeFacts)
                .where(eq(knowledgeFacts.userId, OWNER)),
        ).toHaveLength(1);

        await share();
        expect(await scopeOf(toJan)).toBe(orgUserId);
        expect(
            await db()
                .select()
                .from(knowledgeFacts)
                .where(eq(knowledgeFacts.userId, orgUserId)),
        ).toHaveLength(1);
    });
});
