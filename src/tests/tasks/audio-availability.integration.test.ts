import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
    chatterItems,
    knowledgeFactEvidence,
    knowledgeFacts,
    people,
    recordings,
    recordingTasks,
    taskMentions,
    taskUpdateProposals,
    transcriptions,
    users,
} from "@/db/schema";
import { encryptText } from "@/lib/encryption/fields";
import { factsForPage } from "@/lib/knowledge/fact-page";
import type { TaskViewer } from "@/lib/tasks/access";
import { loadVisibleTaskMentions } from "@/lib/tasks/mentions";
import { listRoutedTaskProposals } from "@/lib/tasks/routing";
import { listRecordingTasks, listTasks } from "@/lib/tasks/tasks";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";
import { insertRecording } from "@/tests/mcp/fixtures";

const { databaseRef, databaseProxy } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    return {
        databaseRef: ref,
        databaseProxy: new Proxy(
            {},
            {
                get: (_target, key) => {
                    if (!ref.current)
                        throw new Error("Test database not initialized");
                    const value = ref.current[key];
                    return typeof value === "function"
                        ? value.bind(ref.current)
                        : value;
                },
            },
        ),
    };
});
vi.mock("@/db", () => ({ db: databaseProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({
    env: {
        IS_HOSTED: false,
        SELF_HOST_MODE: "single",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
        DATABASE_URL: "postgres://unused",
    },
}));
vi.mock("@/lib/export/document-sidecars", () => ({
    exportRecordingSidecarsIfEnabled: vi.fn(),
    refreshExistingRecordingSidecars: vi.fn(),
}));

const url = getTestDatabaseUrl();
const viewer: TaskViewer = {
    userId: "user-neri",
    emailHash: "test-email-hash",
    isOrg: false,
    isCurator: false,
    orgUserId: null,
};

describe.skipIf(!url)("task evidence audio availability", () => {
    let database: TestPostgresDatabase;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            url ?? "",
            "playback_availability",
        );
        databaseRef.current = database.db as unknown as Record<
            PropertyKey,
            unknown
        >;
        await database.db.insert(users).values({
            id: viewer.userId,
            email: "neri@example.test",
            name: "Neri Vosk",
        });
    }, 120_000);
    afterAll(async () => {
        databaseRef.current = null;
        await database?.dispose();
    });

    it("uses the evidence recording's availability rather than the task home's", async () => {
        for (const id of ["mention-home", "mention-source"]) {
            await insertRecording(database.db, { id, userId: viewer.userId });
        }
        await database.db
            .update(recordings)
            .set({ audioReapedAt: new Date() })
            .where(
                and(
                    eq(recordings.id, "mention-source"),
                    eq(recordings.userId, viewer.userId),
                ),
            );
        const [task] = await database.db
            .insert(recordingTasks)
            .values({
                itemId: "mention-home",
                userId: viewer.userId,
                status: "open",
                text: encryptText("Send the plan"),
                source: "manual",
            })
            .returning({ id: recordingTasks.id });
        if (!task) throw new Error("Task missing");
        await database.db.insert(taskMentions).values({
            taskId: task.id,
            itemId: "mention-source",
            userId: viewer.userId,
            view: "private",
            statementAt: new Date(),
            matchDecision: "accepted",
            evidenceStartMs: 5000,
        });
        const rows = await listTasks(viewer, {
            tab: "tracked",
            state: "all",
            folderId: null,
            due: null,
            today: null,
            sort: "created",
        });
        expect(rows.find((row) => row.id === task.id)).toMatchObject({
            evidenceItemId: "mention-source",
            evidenceAudioAvailable: false,
            evidence: { id: "mention-source", audioAvailable: false },
        });
        const mention = (
            await loadVisibleTaskMentions(viewer, [task.id])
        ).latest.get(task.id);
        expect(mention?.audioAvailable).toBe(false);
        for (const field of ["audioId", "audioReapedAt", "audioDeletedAt"]) {
            expect(mention).not.toHaveProperty(field);
        }
    });

    it("reports no audio for mail evidence", async () => {
        await insertRecording(database.db, {
            id: "mail-home",
            userId: viewer.userId,
        });
        await database.db.insert(chatterItems).values({
            id: "mail-source",
            userId: viewer.userId,
            kind: "mail",
            title: encryptText("Delivery date"),
            occurredAt: new Date(),
        });
        const [task] = await database.db
            .insert(recordingTasks)
            .values({
                itemId: "mail-home",
                userId: viewer.userId,
                status: "open",
                text: encryptText("Confirm the delivery date"),
                source: "manual",
            })
            .returning({ id: recordingTasks.id });
        if (!task) throw new Error("Task missing");
        await database.db.insert(taskMentions).values({
            taskId: task.id,
            itemId: "mail-source",
            userId: viewer.userId,
            view: "private",
            statementAt: new Date(),
            matchDecision: "accepted",
        });
        const rows = await listTasks(viewer, {
            tab: "tracked",
            state: "all",
            folderId: null,
            due: null,
            today: null,
            sort: "created",
        });
        expect(rows.find((row) => row.id === task.id)).toMatchObject({
            evidenceItemId: "mail-source",
            evidenceAudioAvailable: false,
            evidence: { id: "mail-source", audioAvailable: false },
        });
        const mention = (
            await loadVisibleTaskMentions(viewer, [task.id])
        ).latest.get(task.id);
        expect(mention?.audioAvailable).toBe(false);
    });

    it.each([
        false,
        true,
    ])("reports routed source availability with audio reaped=%s", async (reaped) => {
        const homeId = `routed-home-${reaped}`;
        const sourceId = `routed-source-${reaped}`;
        for (const id of [homeId, sourceId]) {
            await insertRecording(database.db, { id, userId: viewer.userId });
        }
        if (reaped)
            await database.db
                .update(recordings)
                .set({ audioReapedAt: new Date() })
                .where(
                    and(
                        eq(recordings.id, sourceId),
                        eq(recordings.userId, viewer.userId),
                    ),
                );
        const [task] = await database.db
            .insert(recordingTasks)
            .values({
                itemId: homeId,
                userId: viewer.userId,
                status: "open",
                text: encryptText("Check the drawing"),
                source: "manual",
            })
            .returning({ id: recordingTasks.id });
        if (!task) throw new Error("Task missing");
        const [proposal] = await database.db
            .insert(taskUpdateProposals)
            .values({
                taskId: task.id,
                itemId: sourceId,
                userId: viewer.userId,
                kind: "done",
                state: "awaiting_target_review",
                routedTo: [viewer.userId],
                evidenceStartMs: 5000,
            })
            .returning({ id: taskUpdateProposals.id });
        const routed = (await listRoutedTaskProposals(viewer)).find(
            (row) => row.id === proposal?.id,
        );
        expect(routed?.sourceItem).toEqual({
            id: sourceId,
            kind: "audio",
            title: `Recording ${sourceId}`,
            audioAvailable: !reaped,
        });
        for (const field of [
            "sourceAudioId",
            "sourceAudioReapedAt",
            "sourceAudioDeletedAt",
        ])
            expect(routed).not.toHaveProperty(field);
    });

    it.each([
        false,
        true,
    ])("reports fact evidence availability with audio reaped=%s", async (reaped) => {
        const itemId = `fact-source-${reaped}`;
        await insertRecording(database.db, {
            id: itemId,
            userId: viewer.userId,
        });
        if (reaped)
            await database.db
                .update(recordings)
                .set({ audioReapedAt: new Date() })
                .where(
                    and(
                        eq(recordings.id, itemId),
                        eq(recordings.userId, viewer.userId),
                    ),
                );
        const [person] = await database.db
            .insert(people)
            .values({
                userId: viewer.userId,
                displayName: encryptText("Luma Veln"),
            })
            .returning({ id: people.id });
        if (!person) throw new Error("Person missing");
        const [transcript] = await database.db
            .insert(transcriptions)
            .values({
                recordingId: itemId,
                userId: viewer.userId,
                text: encryptText("I am a designer."),
                provider: "test",
                model: "test",
                source: "riffado",
            })
            .returning({ id: transcriptions.id });
        if (!transcript) throw new Error("Transcript missing");
        const [fact] = await database.db
            .insert(knowledgeFacts)
            .values({
                userId: viewer.userId,
                subjectPersonId: person.id,
                subjectKey: `p:${person.id}`,
                relationKey: "has_role",
                objectLiteral: encryptText("Designer"),
                objectKey: "l:designer",
                origin: "recording",
            })
            .returning({ id: knowledgeFacts.id });
        if (!fact) throw new Error("Fact missing");
        await database.db.insert(knowledgeFactEvidence).values({
            userId: viewer.userId,
            factId: fact.id,
            itemId,
            transcriptionId: transcript.id,
            transcriptRevision: 0,
            startMs: 5000,
            endMs: 7000,
            quote: encryptText("I am a designer."),
        });
        const relations = await factsForPage(viewer.userId, null, {
            personId: person.id,
        });
        expect(
            relations
                .flatMap((relation) => relation.facts)
                .find((row) => row.id === fact.id)?.evidence,
        ).toEqual([
            expect.objectContaining({
                recordingId: itemId,
                kind: "audio",
                audioAvailable: !reaped,
            }),
        ]);
    });

    it("marks an earlier review candidate's reaped audio unavailable", async () => {
        for (const id of ["candidate-home", "candidate-source"]) {
            await insertRecording(database.db, { id, userId: viewer.userId });
        }
        await database.db
            .update(recordings)
            .set({ audioReapedAt: new Date() })
            .where(
                and(
                    eq(recordings.id, "candidate-home"),
                    eq(recordings.userId, viewer.userId),
                ),
            );
        const [task] = await database.db
            .insert(recordingTasks)
            .values({
                itemId: "candidate-home",
                userId: viewer.userId,
                status: "open",
                text: encryptText("Check the plan"),
                source: "manual",
                evidenceStartMs: 5000,
            })
            .returning({ id: recordingTasks.id });
        if (!task) throw new Error("Task missing");
        await database.db.insert(taskMentions).values({
            taskId: task.id,
            itemId: "candidate-source",
            userId: viewer.userId,
            view: "private",
            statementAt: new Date(),
            matchDecision: "suggested",
            evidenceStartMs: 7000,
        });
        const review = await listRecordingTasks(viewer, "candidate-source");
        expect(review?.matches[0]?.candidate.homeItem).toMatchObject({
            id: "candidate-home",
            audioAvailable: false,
        });
    });

    it.each([
        "available",
        "reaped",
        "deleted",
    ] as const)("reports %s audio for legacy and mention evidence without exposing storage fields", async (state) => {
        const itemId = `recording-${state}`;
        await insertRecording(database.db, {
            id: itemId,
            userId: viewer.userId,
        });
        await database.db
            .update(recordings)
            .set({
                audioReapedAt: state === "reaped" ? new Date() : null,
                deletedAt: state === "deleted" ? new Date() : null,
            })
            .where(
                and(
                    eq(recordings.id, itemId),
                    eq(recordings.userId, viewer.userId),
                ),
            );
        const [legacy] = await database.db
            .insert(recordingTasks)
            .values({
                itemId,
                userId: viewer.userId,
                status: "open",
                text: encryptText("Send the sketch"),
                source: "manual",
                evidenceStartMs: 5000,
            })
            .returning({ id: recordingTasks.id });
        if (!legacy) throw new Error("Task missing");
        const read = async () =>
            (
                await listTasks(viewer, {
                    tab: "tracked",
                    state: "all",
                    folderId: null,
                    due: null,
                    today: null,
                    sort: "created",
                })
            ).find((row) => row.id === legacy.id);
        for (const withMention of [false, true]) {
            if (withMention)
                await database.db.insert(taskMentions).values({
                    taskId: legacy.id,
                    itemId,
                    userId: viewer.userId,
                    view: "private",
                    statementAt: new Date(),
                    matchDecision: "home",
                    evidenceStartMs: 5000,
                });
            const row = await read();
            expect(row?.evidence?.audioAvailable).toBe(state === "available");
            expect(row?.evidenceAudioAvailable).toBe(state === "available");
            expect(row).not.toHaveProperty("homeAudioReapedAt");
            expect(row?.evidence).not.toHaveProperty("storagePath");
            expect(
                (await listRecordingTasks(viewer, itemId))?.tasks[0]
                    ?.evidenceAudioAvailable,
            ).toBe(state === "available");
        }
    });
});
