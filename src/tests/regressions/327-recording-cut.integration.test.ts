import { execFileSync, spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
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
    agendaPoints,
    agendaSuggestions,
    aiEnhancements,
    asyncJobs,
    chatterItems,
    itemProcessing,
    itemShares,
    knowledgeFactEvidence,
    knowledgeFacts,
    learnReviewItems,
    learnRuns,
    meetingAgendas,
    people,
    plaudConnections,
    processingProfileRevisions,
    processingProfiles,
    recordingFolderAssignments,
    recordingFolders,
    recordings,
    recordingTasks,
    summaryRemarks,
    taskContentVectors,
    taskVectors,
    transcriptCorrectionPasses,
    transcriptCorrections,
    transcriptions,
    transcriptSpeakers,
    userSettings,
    users,
} from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const mocks = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    const beforeTransaction = vi.fn();
    return {
        ref,
        beforeTransaction,
        complete: vi.fn(),
        suggestionProvider: vi.fn(),
        caller: { id: "owner" },
        proxy: new Proxy(
            {},
            {
                get: (_target, key) => {
                    const value = ref.current?.[key];
                    if (key === "transaction" && typeof value === "function")
                        return async (...args: unknown[]) => {
                            await beforeTransaction();
                            return value.apply(ref.current, args);
                        };
                    return typeof value === "function"
                        ? value.bind(ref.current)
                        : value;
                },
            },
        ),
        client: {
            getRecordings: vi.fn(),
            downloadRecording: vi.fn(),
            getFileDetail: vi.fn(),
        },
        storage: {
            downloadStream: vi.fn(),
            uploadStream: vi.fn(),
            deleteFile: vi.fn(),
            exists: vi.fn(),
            uploadFile: vi.fn(),
            downloadFile: vi.fn(),
        },
    };
});
vi.mock("@/db", () => ({ db: mocks.proxy }));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async () => ({ user: { id: mocks.caller.id } }),
}));
vi.mock("@/lib/env", () => ({
    env: {
        BETTER_AUTH_SECRET: "recording-cut-test",
        AUTHZ_MODE: "local",
        IS_HOSTED: false,
        SELF_HOST_MODE: "shared",
        ORG_ACCOUNT_EMAIL: "org@example.test",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        DEFAULT_STORAGE_TYPE: "local",
    },
}));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: async () => "org",
    isOrgAccount: async (id: string) => id === "org",
    isOrgScopeVisible: () => true,
    assertOrgScopeWritable: () => {},
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn(),
}));
vi.mock("@/lib/plaud/client-factory", () => ({
    createPlaudClient: async () => mocks.client,
}));
vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: async () => mocks.storage,
}));
vi.mock("@/lib/notifications/bark", () => ({
    sendNewRecordingBarkNotification: vi.fn(),
}));
vi.mock("@/lib/notifications/email", () => ({
    sendNewRecordingEmail: vi.fn(),
}));
vi.mock("@/lib/webhooks/emit", () => ({ emitEvent: vi.fn() }));
vi.mock("@/lib/profiles/resolve-manual", () => ({
    resolveManualItemProfile: async () => ({ revisionId: "manual" }),
}));

vi.mock("@/lib/authz/curator", () => ({
    userCuratesOrganizationNow: async () => false,
}));
vi.mock("@/lib/meetings/suggestions-provider", () => ({
    agendaSuggestionsProvider: mocks.suggestionProvider,
    agendaSuggestionsAvailability: async () => ({
        available: true,
        reason: null,
    }),
}));
vi.mock("@/lib/summary/summary-model", () => ({
    summaryModelFor: async () => ({
        payerUserId: "owner",
        model: "test",
        reserveCall: async () => {},
        credentials: {
            id: "test-provider",
            provider: "Custom",
            baseUrl: "http://localhost:1234/v1",
        },
        openai: { chat: { completions: { create: mocks.complete } } },
    }),
}));
vi.mock("@/lib/ai/usage-attempt", () => ({
    chatCompletionWithUsage: async (
        _context: unknown,
        call: () => Promise<unknown>,
    ) => call(),
}));

import { POST } from "@/app/api/recordings/[id]/cut/route";
import { claimDueJobs } from "@/db/queries/async-jobs";
import {
    decryptJsonField,
    decryptText,
    encryptJsonField,
    encryptText,
} from "@/lib/encryption/fields";
import { listFacts } from "@/lib/knowledge/facts";
import { requireMeetingAccess } from "@/lib/meetings/access";
import { getMeeting } from "@/lib/meetings/service";
import { agendaSuggestionsJobHandler } from "@/lib/meetings/suggestions-job";
import { gatherFacts } from "@/lib/pipeline/facts";
import { requestRecordingCut } from "@/lib/recordings/cut";
import {
    commitRecordingCut,
    recordingCutJobHandler,
} from "@/lib/recordings/cut-job-handler";
import { restoreAudioFromPlaud } from "@/lib/recordings/erase";
import { syncRecordingsForUser } from "@/lib/sync/sync-recordings";
import { persistContentVectors } from "@/lib/tasks/proposals";
import {
    upsertEnhancement,
    upsertTranscription,
} from "@/lib/transcription/persist";
import { storeBrowserTranscription } from "@/lib/transcription/transcribe-recording";
import {
    renderTurnsAsText,
    type TranscriptTurn,
} from "@/lib/transcription/turns";
import { insertRecordings } from "@/tests/integration/items";
import { seededAudioProfileSettings } from "@/tests/profiles/seeded-profile-fixture";

function hasFfmpeg(): boolean {
    const probe = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return probe.status === 0;
}

const itIfFfmpeg = hasFfmpeg() ? it : it.skip;
const adminUrl = getTestDatabaseUrl();
const turns: TranscriptTurn[] = [
    { speaker: "S1", startMs: 0, endMs: 2000, text: "Opening private words." },
    { speaker: "S1", startMs: 3000, endMs: 6000, text: "Jitka keeps this." },
    {
        speaker: "S2",
        startMs: 6000,
        endMs: 8000,
        text: "Marek keeps this too.",
    },
    {
        speaker: "S1",
        startMs: 9000,
        endMs: 10000,
        text: "Ending private words.",
    },
];
const range = { startMs: 3000, endMs: 8000 };
describe.skipIf(!adminUrl)("recording cut routes and transaction", () => {
    let database: TestPostgresDatabase;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            adminUrl ?? "",
            "recording_cut",
        );
        mocks.ref.current = database.db as unknown as Record<
            PropertyKey,
            unknown
        >;
    }, 120000);
    afterAll(async () => {
        mocks.ref.current = null;
        await database?.dispose();
    }, 30000);
    beforeEach(async () => {
        vi.clearAllMocks();
        mocks.beforeTransaction.mockReset();
        mocks.suggestionProvider.mockReset();
        mocks.complete.mockReset();
        mocks.storage.downloadStream.mockReset();
        mocks.storage.uploadStream.mockReset();
        mocks.caller.id = "owner";
        mocks.storage.deleteFile.mockResolvedValue(undefined);
        await database.db.delete(users);
        await database.db.insert(users).values(
            ["owner", "receiver", "curator", "org"].map((id) => ({
                id,
                email: `${id}@example.test`,
            })),
        );
        await insertRecordings(database.db, {
            id: "recording",
            userId: "owner",
            filename: encryptText("Generated private title"),
            duration: 10000,
            startTime: new Date("2026-10-01T10:00:00Z"),
            endTime: new Date("2026-10-01T10:00:10Z"),
            filesize: 10,
            deviceSn: "SN-test",
            plaudFileId: "plaud-file",
            fileMd5: "a".repeat(32),
            storageType: "local",
            storagePath: "owner/Recording.ogg",
            storageFilename: "Recording.ogg",
            plaudVersion: "1",
        });
        await database.db.insert(transcriptions).values(
            ["plaud", "riffado"].map((source) => ({
                id: source,
                userId: "owner",
                recordingId: "recording",
                text: encryptText(renderTurnsAsText(turns)),
                turns: encryptJsonField(turns),
                topics: encryptJsonField([{ title: "Old topic", fromMs: 0 }]),
                provider: source,
                model: source,
                source,
                audioMd5: "a".repeat(32),
            })),
        );
    });
    const post = async (body: unknown = range) => {
        const log = vi.spyOn(console, "info");
        const response = await POST(
            new Request("http://localhost/api/recordings/recording/cut", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            }),
            { params: Promise.resolve({ id: "recording" }) },
        );
        if (response.status >= 400 && response.status < 500) {
            const body = await response.clone().json();
            expect(log).toHaveBeenCalledWith(
                `[cut] refused recording=recording code=${body.code} status=${response.status}`,
            );
        }
        log.mockRestore();
        return response;
    };
    async function share() {
        await database.db.insert(recordingFolders).values({
            id: "org-folder",
            userId: "org",
            name: encryptText("Team"),
            nameHash: "team",
        });
        await database.db.insert(recordingFolderAssignments).values({
            itemId: "recording",
            folderId: "org-folder",
            userId: "owner",
        });
    }
    async function queued() {
        const result = await requestRecordingCut("owner", "recording", {
            ...range,
        });
        await database.db
            .update(asyncJobs)
            .set({ status: "processing", attempts: 1 })
            .where(eq(asyncJobs.id, result.id));
        const [job] = await database.db
            .select()
            .from(asyncJobs)
            .where(eq(asyncJobs.id, result.id));
        return {
            id: result.id,
            payload: recordingCutJobHandler.parsePayload(job.payload),
        };
    }
    const preparedAudio = {
        storagePath: "owner/.cuts/prepared/Recording.ogg",
        storageFilename: "Recording.ogg",
        filesize: 5,
        md5: "b".repeat(32),
        duration: 5000,
        peaks: [0.5, 1],
    };
    function runCut(job: Awaited<ReturnType<typeof queued>>, attempt = 1) {
        return recordingCutJobHandler.run({
            userId: "owner",
            jobId: job.id,
            payload: job.payload,
            attempt,
            maxAttempts: 3,
            signal: new AbortController().signal,
            reportProgress: vi.fn(),
        });
    }
    async function commit(job: Awaited<ReturnType<typeof queued>>) {
        return database.db.transaction((tx) =>
            commitRecordingCut(
                tx,
                "owner",
                job.id,
                job.payload,
                preparedAudio,
                "org",
            ),
        );
    }
    async function agenda(userId = "owner") {
        const id = `agenda-${userId}`;
        const itemId = `meeting-${userId}`;
        await database.db.insert(chatterItems).values({
            id: itemId,
            userId,
            kind: "meeting",
            title: encryptText("Next meeting"),
            occurredAt: new Date(),
        });
        await database.db.insert(meetingAgendas).values({
            id,
            userId,
            meetingItemId: itemId,
            plannedStart: new Date(Date.now() + 60000),
        });
        return { id, itemId };
    }
    async function sourceAgenda() {
        const meeting = await agenda();
        await database.db.insert(recordingFolders).values({
            id: "source-folder",
            userId: "owner",
            name: encryptText("Meetings"),
            nameHash: "meetings",
        });
        await database.db.insert(recordingFolderAssignments).values(
            ["recording", meeting.itemId].map((itemId) => ({
                itemId,
                userId: "owner",
                folderId: "source-folder",
            })),
        );
        await database.db.insert(aiEnhancements).values({
            userId: "owner",
            itemId: "recording",
            source: "riffado",
            provider: "test",
            model: "test",
            summary: encryptText("Old private summary"),
        });
        mocks.suggestionProvider.mockImplementation(async () => ({
            access: await requireMeetingAccess("owner", meeting.id, "edit", {
                viewer: { userId: "owner", orgUserId: "org", curator: false },
            }),
            folders: [{ id: "source-folder" }],
            pin: null,
            outputLanguage: "en",
        }));
        return meeting;
    }
    it("queues one durable owner cut and refuses a second", async () => {
        expect((await post()).status).toBe(202);
        expect((await post()).status).toBe(409);
    });
    it.each([
        "receiver",
        "curator",
        "org",
    ])("refuses %s even when they may read the recording", async (caller) => {
        await share();
        await database.db.insert(itemShares).values({
            userId: "owner",
            receiverUserId: "receiver",
            itemId: "recording",
            state: "accepted",
        });
        mocks.caller.id = caller;
        expect((await post()).status).toBe(404);
    });
    it("queues a shared recording without withdrawal consent", async () => {
        await share();
        expect((await post()).status).toBe(202);
    });
    it.each([
        "pending",
        "processing",
    ] as const)("refuses a %s transcription", async (status) => {
        await database.db.insert(asyncJobs).values({
            userId: "owner",
            kind: "transcription",
            subjectId: "recording",
            status,
        });
        expect((await post()).status).toBe(409);
    });
    it("refuses untimed transcripts", async () => {
        await database.db
            .update(transcriptions)
            .set({ turns: null })
            .where(eq(transcriptions.id, "plaud"));
        expect((await post()).status).toBe(409);
    });
    it.each([
        { startMs: 0, endMs: 10000 },
        { startMs: 8000, endMs: 8500 },
        { startMs: 6000, endMs: 3000 },
        { startMs: 0, endMs: 10001 },
    ])("refuses an empty or invalid range %j", async (body) => {
        expect((await post(body)).status).toBe(400);
    });
    it("refuses deleted recordings", async () => {
        await database.db.update(recordings).set({ deletedAt: new Date() });
        expect((await post()).status).toBe(404);
    });
    it("rewrites every source, removes derived content, and keeps confirmed human decisions certain", async () => {
        const db = database.db;
        await db.insert(people).values({
            id: "person",
            userId: "owner",
            displayName: encryptText("Jitka Dvořáková"),
        });
        await db.insert(transcriptSpeakers).values({
            userId: "owner",
            transcriptionId: "riffado",
            label: "S1",
            personId: "person",
            source: "user",
            status: "confirmed",
            confirmedByUserId: "owner",
        });
        await db.insert(transcriptCorrections).values([
            {
                id: "kept-correction",
                userId: "owner",
                transcriptionId: "riffado",
                transcriptRevision: 0,
                turnIndex: 1,
                charStart: 0,
                charEnd: 5,
                heard: encryptText("Jitka"),
                heardHmac: "h".repeat(64),
                kind: "correct",
                targetPersonId: "person",
                replacement: encryptText("Jitka Dvořáková"),
            },
            {
                id: "cut-correction",
                userId: "owner",
                transcriptionId: "riffado",
                transcriptRevision: 0,
                turnIndex: 0,
                charStart: 0,
                charEnd: 7,
                heard: encryptText("Opening"),
                heardHmac: "o".repeat(64),
                kind: "fix",
                replacement: encryptText("Beginning"),
            },
        ]);
        await db.insert(aiEnhancements).values(
            ["plaud", "riffado"].map((source) => ({
                id: `summary-${source}`,
                userId: "owner",
                itemId: "recording",
                source,
                provider: source,
                model: source,
                summary: encryptText("Old private summary"),
            })),
        );
        await db.insert(summaryRemarks).values({
            userId: "owner",
            itemId: "recording",
            text: encryptText("Keep my remark"),
        });
        await db.insert(recordingTasks).values([
            {
                id: "proposal",
                userId: "owner",
                itemId: "recording",
                text: encryptText("Private proposed task"),
                status: "proposed",
                source: "riffado",
            },
            {
                id: "accepted",
                userId: "owner",
                itemId: "recording",
                text: encryptText("Accepted task"),
                status: "open",
                source: "riffado",
                acceptedAt: new Date(),
            },
        ]);
        await db.insert(taskVectors).values({
            userId: "owner",
            taskId: "proposal",
            vectorGeneration: "test",
            dim: 1,
            vector: encryptText("[1]"),
            inputHmac: "v".repeat(64),
        });
        await db.insert(taskContentVectors).values({
            userId: "owner",
            itemId: "recording",
            contentSourceId: "riffado",
            contentRevision: 0,
            vectorGeneration: "test",
            dim: 1,
            vector: encryptText("[1]"),
            inputHmac: "v".repeat(64),
            chunkIndex: 0,
        });
        await db.insert(knowledgeFacts).values({
            id: "fact",
            userId: "owner",
            subjectPersonId: "person",
            subjectKey: "p:person",
            relationKey: "role",
            objectLiteral: encryptText("Coordinator"),
            objectKey: "l:coordinator",
            origin: "recording",
            createdByUserId: "owner",
        });
        await db.insert(knowledgeFactEvidence).values({
            userId: "owner",
            factId: "fact",
            itemId: "recording",
            transcriptionId: "riffado",
            transcriptRevision: 0,
            startMs: 0,
            endMs: 2000,
            quote: encryptText("Opening private words."),
            status: "supported",
            confirmedAt: new Date(),
        });
        await db.insert(learnRuns).values({
            id: "old-learn",
            userId: "owner",
            scopeUserId: "owner",
            itemId: "recording",
            transcriptionId: "riffado",
            view: "private",
            trigger: "auto",
            transcriptRevision: 0,
            vocabularyVersion: 0,
            status: "ready",
        });
        await db.insert(learnReviewItems).values({
            runId: "old-learn",
            userId: "owner",
            kind: "fact",
            fingerprintHmac: "f".repeat(64),
            payload: encryptJsonField({ private: "old words" }),
        });
        await db.insert(itemProcessing).values({
            itemId: "recording",
            userId: "owner",
            view: "private",
            phases: {
                summary: {
                    state: "done",
                    generation: 1,
                    at: new Date().toISOString(),
                    steps: {
                        title: {
                            state: "done",
                            contentId: "riffado",
                            contentSourceId: "riffado",
                            contentRevision: 0,
                            generation: 1,
                        },
                    },
                },
            },
        });
        const job = await queued();
        await db.transaction((tx) =>
            commitRecordingCut(
                tx,
                "owner",
                job.id,
                job.payload,
                {
                    storagePath: "owner/.cuts/job/Recording.ogg",
                    storageFilename: "Recording.ogg",
                    filesize: 5,
                    md5: "b".repeat(32),
                    duration: 5000,
                    peaks: [0.5, 1],
                },
                "org",
            ),
        );
        const rows = await db.select().from(transcriptions);
        for (const row of rows) {
            expect(row.revision).toBe(1);
            expect(row.topics).toBeNull();
            expect(row.audioMd5).toBe("b".repeat(32));
            expect(decryptJsonField<TranscriptTurn[]>(row.turns)).toEqual(
                turns.slice(1, 3).map((turn) => ({
                    ...turn,
                    startMs: turn.startMs - 3000,
                    endMs: turn.endMs - 3000,
                })),
            );
            expect(decryptText(row.text)).not.toMatch(/private/);
        }
        expect(await db.select().from(aiEnhancements)).toEqual([]);
        expect(
            (await db.select().from(recordingTasks)).map((task) => task.id),
        ).toEqual(["accepted"]);
        expect(await db.select().from(taskVectors)).toEqual([]);
        expect(await db.select().from(taskContentVectors)).toEqual([]);
        await persistContentVectors(
            {
                itemId: "recording",
                userId: "owner",
                sourceId: "riffado",
                revision: 0,
            },
            "test",
            ["Old private text"],
            new Map([[0, Float32Array.from([1])]]),
        );
        expect(await db.select().from(taskContentVectors)).toEqual([]);
        expect(await db.select().from(learnReviewItems)).toEqual([]);
        expect((await db.select().from(learnRuns))[0].status).toBe(
            "superseded",
        );
        expect((await db.select().from(knowledgeFacts))[0].id).toBe("fact");
        expect(
            (await listFacts("owner", { personId: "person" })).map(
                (fact) => fact.id,
            ),
        ).toContain("fact");
        expect(await db.select().from(knowledgeFactEvidence)).toEqual([]);
        expect((await db.select().from(transcriptSpeakers))[0].status).toBe(
            "confirmed",
        );
        const corrections = await db.select().from(transcriptCorrections);
        expect(corrections).toHaveLength(1);
        expect(corrections[0]).toMatchObject({
            id: "kept-correction",
            turnIndex: 0,
            transcriptRevision: 1,
            preTicked: false,
        });
        expect(await db.select().from(summaryRemarks)).toHaveLength(1);
        expect((await db.select().from(recordings))[0]).toMatchObject({
            cutAt: expect.any(Date),
            duration: 5000,
            fileMd5: "b".repeat(32),
        });
        expect(
            decryptText((await db.select().from(chatterItems))[0].title),
        ).toBe("");
    });
    it("does not commit after a transcript revision changes", async () => {
        const job = await queued();
        await database.db
            .update(transcriptions)
            .set({ revision: 1 })
            .where(eq(transcriptions.id, "plaud"));
        await expect(
            database.db.transaction((tx) =>
                commitRecordingCut(
                    tx,
                    "owner",
                    job.id,
                    job.payload,
                    null,
                    "org",
                ),
            ),
        ).rejects.toMatchObject({ statusCode: 409 });
        expect(
            (await database.db.select().from(recordings))[0].cutAt,
        ).toBeNull();
    });
    it("cuts only transcripts when retention removed audio and preserves a manual title", async () => {
        await database.db.update(recordings).set({ audioReapedAt: new Date() });
        await database.db
            .update(chatterItems)
            .set({ titleEditedAt: new Date(), title: encryptText("My title") });
        const job = await queued();
        await recordingCutJobHandler.run({
            userId: "owner",
            jobId: job.id,
            payload: job.payload,
            attempt: 1,
            maxAttempts: 3,
            signal: new AbortController().signal,
            reportProgress: vi.fn(),
        });
        expect(mocks.storage.downloadFile).not.toHaveBeenCalled();
        expect(mocks.storage.deleteFile).toHaveBeenCalledTimes(8);
        expect(
            decryptText(
                (await database.db.select().from(chatterItems))[0].title,
            ),
        ).toBe("My title");
    });
    itIfFfmpeg(
        "streams a cut and resumes failed storage cleanup without cutting a second time",
        async () => {
            const original = execFileSync("ffmpeg", [
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000:duration=10",
                "-c:a",
                "libopus",
                "-f",
                "ogg",
                "pipe:1",
            ]);
            mocks.storage.downloadStream.mockResolvedValue(
                Readable.from([original]),
            );
            mocks.storage.uploadStream.mockImplementation(
                async (_key: string, stream: Readable) => {
                    let bytes = 0;
                    for await (const part of stream) bytes += part.length;
                    expect(bytes).toBeGreaterThan(0);
                },
            );
            mocks.storage.deleteFile.mockImplementation(async (key: string) => {
                if (key === "owner/Recording.ogg")
                    throw new Error("Temporary storage failure");
            });
            const job = await queued();
            const run = (attempt: number) =>
                recordingCutJobHandler.run({
                    userId: "owner",
                    jobId: job.id,
                    payload: job.payload,
                    attempt,
                    maxAttempts: 3,
                    signal: new AbortController().signal,
                    reportProgress: vi.fn(),
                });
            await expect(run(1)).rejects.toThrow(
                "The recording could not be cut.",
            );
            const [recording] = await database.db.select().from(recordings);
            expect(recording.duration).toBe(5000);
            expect(recording.cutAt).toBeInstanceOf(Date);
            expect(recording.fileMd5).not.toBe("a".repeat(32));
            expect(recording.waveformPeaks).toHaveLength(500);
            expect(recording.storagePath).toContain("owner/.cuts/");
            await database.db
                .update(asyncJobs)
                .set({ attempts: 2 })
                .where(eq(asyncJobs.id, job.id));
            mocks.storage.deleteFile.mockResolvedValue(undefined);
            await run(2);
            expect(mocks.storage.downloadStream).toHaveBeenCalledTimes(1);
            expect(mocks.storage.uploadStream).toHaveBeenCalledTimes(1);
            expect(
                (await database.db.select().from(transcriptions)).every(
                    (row) => row.revision === 1,
                ),
            ).toBe(true);
        },
    );
    it("cuts in place and preserves private and Organization facts as manual", async () => {
        await share();
        await database.db.insert(people).values({
            id: "org-person",
            userId: "org",
            displayName: encryptText("Marek Svoboda"),
        });
        await database.db.insert(knowledgeFacts).values({
            id: "org-fact",
            userId: "org",
            subjectPersonId: "org-person",
            subjectKey: "p:org-person",
            relationKey: "role",
            objectLiteral: encryptText("Coordinator"),
            objectKey: "l:coordinator",
            origin: "recording",
            createdByUserId: "owner",
        });
        await database.db.insert(knowledgeFactEvidence).values({
            userId: "org",
            factId: "org-fact",
            itemId: "recording",
            transcriptionId: "riffado",
            transcriptRevision: 0,
            startMs: 0,
            endMs: 2000,
            quote: encryptText("Opening private words."),
            status: "supported",
            confirmedAt: new Date(),
        });
        await database.db.insert(people).values({
            id: "private-person",
            userId: "owner",
            displayName: encryptText("Jitka Dvořáková"),
        });
        await database.db.insert(knowledgeFacts).values({
            id: "private-fact",
            userId: "owner",
            subjectPersonId: "private-person",
            subjectKey: "p:private-person",
            relationKey: "role",
            objectLiteral: encryptText("Coordinator"),
            objectKey: "l:coordinator",
            origin: "recording",
            createdByUserId: "owner",
        });
        await database.db.insert(knowledgeFactEvidence).values({
            userId: "owner",
            factId: "private-fact",
            itemId: "recording",
            transcriptionId: "riffado",
            transcriptRevision: 0,
            startMs: 0,
            endMs: 2000,
            quote: encryptText("Opening private words."),
            status: "supported",
            confirmedAt: new Date(),
        });
        const job = await queued();
        await database.db.transaction((tx) =>
            commitRecordingCut(
                tx,
                "owner",
                job.id,
                job.payload,
                {
                    storagePath: "owner/new.ogg",
                    storageFilename: "Recording.ogg",
                    filesize: 5,
                    md5: "b".repeat(32),
                    duration: 5000,
                    peaks: [1],
                },
                "org",
            ),
        );
        expect(
            await database.db.select().from(recordingFolderAssignments),
        ).toMatchObject([{ itemId: "recording", folderId: "org-folder" }]);
        expect(
            await database.db
                .select({
                    id: knowledgeFacts.id,
                    userId: knowledgeFacts.userId,
                    origin: knowledgeFacts.origin,
                })
                .from(knowledgeFacts),
        ).toEqual(
            expect.arrayContaining([
                { id: "private-fact", userId: "owner", origin: "manual" },
                { id: "org-fact", userId: "org", origin: "manual" },
            ]),
        );
        expect(
            (await listFacts("org", { personId: "org-person" })).map(
                (fact) => fact.id,
            ),
        ).toEqual(["org-fact"]);
        expect(
            (await listFacts("owner", { personId: "private-person" })).map(
                (fact) => fact.id,
            ),
        ).toContain("private-fact");
        expect(await database.db.select().from(knowledgeFactEvidence)).toEqual(
            [],
        );
    });
    it("refuses stale browser text and accepts browser transcription of the retained audio", async () => {
        const cutAt = new Date("2026-11-03T07:00:00Z");
        await database.db
            .update(recordings)
            .set({ cutAt, fileMd5: "b".repeat(32) });
        const input = {
            userId: "owner",
            recordingId: "recording",
            text: "Retained browser text",
            detectedLanguage: "cs",
            model: "whisper-base",
        };
        await expect(
            storeBrowserTranscription({
                ...input,
                audioMd5: "a".repeat(32),
                audioCutAt: null,
            }),
        ).rejects.toMatchObject({ statusCode: 409 });
        expect(
            (
                await storeBrowserTranscription({
                    ...input,
                    audioMd5: "b".repeat(32),
                    audioCutAt: cutAt.toISOString(),
                })
            ).success,
        ).toBe(true);
        expect(
            decryptText(
                (
                    await database.db
                        .select()
                        .from(transcriptions)
                        .where(eq(transcriptions.id, "riffado"))
                )[0].text,
            ),
        ).toBe("Retained browser text");
    });
    it("refuses stale revisions supplied by the cut preview", async () => {
        expect(
            (
                await post({
                    ...range,
                    revisions: [
                        { id: "plaud", revision: 1 },
                        { id: "riffado", revision: 0 },
                    ],
                })
            ).status,
        ).toBe(409);
    });
    it("claims at most one cut per user across worker processes", async () => {
        await database.db.insert(asyncJobs).values([
            { userId: "owner", kind: "recording.cut", subjectId: "first" },
            { userId: "owner", kind: "recording.cut", subjectId: "second" },
            { userId: "receiver", kind: "recording.cut", subjectId: "third" },
        ]);
        const jobs = await claimDueJobs("recording.cut", 3);
        expect(jobs).toHaveLength(2);
        expect(new Set(jobs.map((job) => job.userId))).toEqual(
            new Set(["owner", "receiver"]),
        );
        expect(await claimDueJobs("recording.cut", 3)).toEqual([]);
    });
    it("refuses restoring the Plaud original after a cut", async () => {
        await database.db
            .update(recordings)
            .set({ cutAt: new Date(), audioReapedAt: new Date() });
        await database.db.insert(plaudConnections).values({
            userId: "owner",
            bearerToken: encryptText("test-token"),
        });
        await expect(
            restoreAudioFromPlaud("owner", "recording"),
        ).rejects.toMatchObject({ statusCode: 409 });
        expect(mocks.client.downloadRecording).not.toHaveBeenCalled();
    });
    it("keeps a legacy audio key still used by another recording", async () => {
        await insertRecordings(database.db, {
            id: "duplicate",
            userId: "owner",
            filename: encryptText("Another copy"),
            duration: 10000,
            startTime: new Date("2026-10-01T10:00:00Z"),
            endTime: new Date("2026-10-01T10:00:10Z"),
            filesize: 10,
            deviceSn: "local",
            plaudFileId: "uploaded-copy",
            fileMd5: "a".repeat(32),
            storageType: "local",
            storagePath: "owner/Recording.ogg",
            plaudVersion: "1",
        });
        const job = await queued();
        await database.db.transaction((tx) =>
            commitRecordingCut(
                tx,
                "owner",
                job.id,
                job.payload,
                {
                    storagePath: "owner/new.ogg",
                    storageFilename: "Recording.ogg",
                    filesize: 5,
                    md5: "b".repeat(32),
                    duration: 5000,
                    peaks: [1],
                },
                "org",
            ),
        );
        await recordingCutJobHandler.run({
            userId: "owner",
            jobId: job.id,
            payload: job.payload,
            attempt: 1,
            maxAttempts: 3,
            signal: new AbortController().signal,
            reportProgress: vi.fn(),
        });
        expect(mocks.storage.deleteFile).not.toHaveBeenCalled();
        expect(
            (
                await database.db
                    .select()
                    .from(recordings)
                    .where(eq(recordings.id, "duplicate"))
            )[0].duration,
        ).toBe(10000);
    });
    it("drops quotes from a removed overlapping turn and keeps the confirmed fact visible", async () => {
        const alternate = [
            {
                speaker: "S1",
                startMs: 0,
                endMs: 4000,
                text: "A private overlapping turn.",
            },
            { speaker: "S2", startMs: 4200, endMs: 6000, text: "Kept words." },
        ];
        await database.db
            .update(transcriptions)
            .set({
                turns: encryptJsonField(alternate),
                text: encryptText(renderTurnsAsText(alternate)),
            })
            .where(eq(transcriptions.id, "riffado"));
        await database.db.insert(people).values({
            id: "person",
            userId: "owner",
            displayName: encryptText("Jitka Dvořáková"),
        });
        await database.db.insert(knowledgeFacts).values({
            id: "overlap-fact",
            userId: "owner",
            subjectPersonId: "person",
            subjectKey: "p:person",
            relationKey: "role",
            objectLiteral: encryptText("Coordinator"),
            objectKey: "l:coordinator",
            origin: "recording",
            createdByUserId: "owner",
        });
        await database.db.insert(knowledgeFactEvidence).values({
            userId: "owner",
            factId: "overlap-fact",
            itemId: "recording",
            transcriptionId: "riffado",
            transcriptRevision: 0,
            startMs: 3200,
            endMs: 3800,
            quote: encryptText("overlapping turn."),
            status: "supported",
            confirmedAt: new Date(),
        });
        await database.db.insert(recordingTasks).values({
            id: "kept-task",
            userId: "owner",
            itemId: "recording",
            text: encryptText("Accepted task"),
            status: "open",
            source: "riffado",
            quote: encryptText("overlapping turn."),
            evidenceStartMs: 3200,
            acceptedAt: new Date(),
        });
        const job = await queued();
        await database.db.transaction((tx) =>
            commitRecordingCut(
                tx,
                "owner",
                job.id,
                job.payload,
                {
                    storagePath: "owner/new.ogg",
                    storageFilename: "Recording.ogg",
                    filesize: 5,
                    md5: "b".repeat(32),
                    duration: 5000,
                    peaks: [1],
                },
                "org",
            ),
        );
        expect(await database.db.select().from(knowledgeFactEvidence)).toEqual(
            [],
        );
        expect(
            (await listFacts("owner", { personId: "person" })).map(
                (fact) => fact.id,
            ),
        ).toContain("overlap-fact");
    });
    it("a newer Plaud version never restores cut audio or imports old content", async () => {
        await database.db.update(recordings).set({ cutAt: new Date() });
        await database.db.delete(transcriptions);
        await database.db.insert(plaudConnections).values({
            userId: "owner",
            bearerToken: encryptText("test-token"),
        });
        await database.db
            .insert(userSettings)
            .values({ userId: "owner", importPlaudContent: true });
        mocks.client.getRecordings.mockResolvedValue({
            data_file_list: [
                {
                    id: "plaud-file",
                    version_ms: 999,
                    duration: 10000,
                    is_trans: true,
                    is_summary: true,
                },
            ],
        });
        const result = await syncRecordingsForUser("owner");
        expect(result.errors).toEqual([]);
        expect(mocks.client.downloadRecording).not.toHaveBeenCalled();
        expect(mocks.client.getFileDetail).not.toHaveBeenCalled();
        expect(await database.db.select().from(transcriptions)).toEqual([]);
    });
    it("refuses a Plaud import that was already in flight when the cut committed", async () => {
        await database.db.update(recordings).set({ cutAt: new Date() });
        expect(
            (
                await upsertTranscription({
                    userId: "owner",
                    recordingId: "recording",
                    text: "Old text",
                    turns,
                    source: "plaud",
                    provider: "plaud",
                    model: "plaud",
                    detectedLanguage: null,
                })
            ).committed,
        ).toBe(false);
        expect(
            (
                await upsertEnhancement({
                    userId: "owner",
                    recordingId: "recording",
                    transcriptionId: "plaud",
                    summary: "Old summary",
                    keyPoints: [],
                    actionItems: [],
                    source: "plaud",
                    provider: "plaud",
                    model: "plaud",
                })
            ).committed,
        ).toBe(false);
    });
    it.each([
        "claim",
        "reference",
        "both",
    ])("refuses stale cleanup after ownership changes (%s)", async (change) => {
        const job = await queued();
        await database.db
            .update(asyncJobs)
            .set({ claimToken: "attempt-one" })
            .where(eq(asyncJobs.id, job.id));
        await commit(job);
        mocks.beforeTransaction.mockImplementationOnce(async () => {
            if (change !== "reference")
                await database.db
                    .update(asyncJobs)
                    .set({ claimToken: "attempt-two", attempts: 2 })
                    .where(eq(asyncJobs.id, job.id));
            if (change !== "claim")
                await database.db
                    .update(recordings)
                    .set({ storagePath: "owner/Recording.ogg" })
                    .where(eq(recordings.id, "recording"));
        });
        await runCut(job);
        expect(mocks.storage.deleteFile).not.toHaveBeenCalled();
    });
    it("holds the recording and claim locks throughout a paused storage deletion", async () => {
        const job = await queued();
        await commit(job);
        const deleting = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        mocks.storage.deleteFile.mockImplementationOnce(async () => {
            deleting.resolve();
            await release.promise;
        });
        const running = runCut(job);
        await deleting.promise;
        let reclaimed = false;
        let reconciled = false;
        const reclaim = database.db
            .update(asyncJobs)
            .set({ status: "completed", claimToken: null, attempts: 2 })
            .where(eq(asyncJobs.id, job.id))
            .then(() => {
                reclaimed = true;
            });
        const reconcile = database.db
            .update(recordings)
            .set({ storagePath: "owner/Recording.ogg" })
            .where(eq(recordings.id, "recording"))
            .then(() => {
                reconciled = true;
            });
        try {
            await new Promise((resolve) => setTimeout(resolve, 30));
            expect(reclaimed).toBe(false);
            expect(reconciled).toBe(false);
        } finally {
            release.resolve();
            await Promise.all([running, reclaim, reconcile]);
        }
        expect(reclaimed && reconciled).toBe(true);
    });
    it("never deletes a prepared key referenced in another owner's row", async () => {
        const job = await queued();
        await commit(job);
        await insertRecordings(database.db, {
            id: "other-reference",
            userId: "receiver",
            filename: encryptText("Imported copy"),
            duration: 10000,
            startTime: new Date(),
            endTime: new Date(),
            filesize: 10,
            deviceSn: "local",
            plaudFileId: "imported-copy",
            fileMd5: "a".repeat(32),
            storageType: "local",
            storagePath: "owner/Recording.ogg",
            plaudVersion: "1",
        });
        await runCut(job);
        expect(mocks.storage.deleteFile).not.toHaveBeenCalled();
    });
    it.each([
        false,
        true,
    ])("cleans a crash's encrypted prepared key unless it is live (live=%s)", async (live) => {
        const job = await queued();
        const orphan = live
            ? "owner/Recording.ogg"
            : "owner/.cuts/crashed/Prepared.ogg";
        await database.db
            .update(asyncJobs)
            .set({
                attempts: 2,
                payload: {
                    ...job.payload,
                    preparedStoragePath: encryptText(orphan),
                },
            })
            .where(eq(asyncJobs.id, job.id));
        mocks.storage.downloadStream.mockRejectedValue(
            new Error("Stop before preparation"),
        );
        await expect(runCut(job, 2)).rejects.toThrow(
            "The recording could not be cut.",
        );
        if (live) expect(mocks.storage.deleteFile).not.toHaveBeenCalled();
        else expect(mocks.storage.deleteFile).toHaveBeenCalledWith(orphan);
        expect(mocks.storage.deleteFile).not.toHaveBeenCalledWith(
            "owner/Recording.ogg",
        );
    });
    itIfFfmpeg(
        "durably encrypts the prepared key before uploading and recovers it after a crash",
        async () => {
            const original = execFileSync("ffmpeg", [
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000:duration=10",
                "-c:a",
                "libopus",
                "-f",
                "ogg",
                "pipe:1",
            ]);
            mocks.storage.downloadStream.mockImplementation(async () =>
                Readable.from([original]),
            );
            const job = await queued();
            let orphan = "";
            mocks.storage.uploadStream.mockImplementation(
                async (key: string, stream: Readable) => {
                    orphan = key;
                    for await (const _chunk of stream) {
                    }
                    const [stored] = await database.db
                        .select()
                        .from(asyncJobs)
                        .where(eq(asyncJobs.id, job.id));
                    expect(stored.payload.preparedStoragePath).not.toContain(
                        key,
                    );
                    expect(
                        decryptText(
                            stored.payload.preparedStoragePath as string,
                        ),
                    ).toBe(key);
                    throw new Error("Process stopped after upload");
                },
            );
            mocks.storage.deleteFile.mockRejectedValue(
                new Error("Storage unavailable during shutdown"),
            );
            await expect(runCut(job)).rejects.toThrow(
                "The recording could not be cut.",
            );
            expect(orphan).toContain("/.cuts/");
            const [checkpoint] = await database.db
                .select()
                .from(asyncJobs)
                .where(eq(asyncJobs.id, job.id));
            expect(
                decryptText(checkpoint.payload.preparedStoragePath as string),
            ).toBe(orphan);
            expect(checkpoint.payload.preparedStoragePath).not.toContain(
                orphan,
            );
            mocks.storage.deleteFile.mockReset().mockResolvedValue(undefined);
            mocks.storage.downloadStream.mockRejectedValue(
                new Error("Stop after recovery"),
            );
            await database.db
                .update(asyncJobs)
                .set({ attempts: 2 })
                .where(eq(asyncJobs.id, job.id));
            await expect(runCut(job, 2)).rejects.toThrow();
            expect(mocks.storage.deleteFile).toHaveBeenCalledWith(orphan);
            expect(
                (await database.db.select().from(recordings))[0].storagePath,
            ).toBe("owner/Recording.ogg");
        },
    );
    it("purges AI suggestions in every owner's scope and state, preserving accepted agenda points", async () => {
        await database.db.insert(itemShares).values({
            userId: "owner",
            receiverUserId: "receiver",
            itemId: "recording",
            state: "accepted",
        });
        const cursors = new Map<string, string>();
        for (const userId of ["owner", "receiver"]) {
            const meeting = await agenda(userId);
            await database.db.insert(agendaSuggestions).values(
                (["open", "dismissed", "added"] as const).map((state) => ({
                    id: `${userId}-${state}`,
                    userId,
                    agendaId: meeting.id,
                    kind: "ai" as const,
                    state,
                    text: encryptText("Old private suggestion"),
                    sources: { itemIds: ["recording"], taskIds: [] },
                })),
            );
            await database.db.insert(agendaPoints).values({
                userId,
                agendaId: meeting.id,
                text: encryptText("Human accepted point"),
                sources: { itemIds: ["recording"], taskIds: [] },
            });
            const before = await getMeeting(userId, meeting.id);
            expect(before.unchanged).toBe(false);
            if (!before.unchanged) {
                expect(before.suggestions).toHaveLength(3);
                cursors.set(userId, before.cursor);
            }
        }
        const job = await queued();
        await commit(job);
        expect(await database.db.select().from(agendaSuggestions)).toEqual([]);
        for (const userId of ["owner", "receiver"]) {
            const after = await getMeeting(
                userId,
                `agenda-${userId}`,
                cursors.get(userId),
            );
            if (after.unchanged) throw new Error("Expected meeting detail");
            expect(after.suggestions).toEqual([]);
            expect(after.points.map((point) => point.text)).toEqual([
                "Human accepted point",
            ]);
        }
    });
    it.each([
        "pending",
        "processing",
    ] as const)("cancels %s agenda jobs in a source folder before they read context", async (status) => {
        const meeting = await sourceAgenda();
        await database.db.insert(asyncJobs).values([
            {
                id: "suggestions",
                userId: "owner",
                kind: "agenda.suggestions",
                subjectId: meeting.id,
                status,
                payload: { agendaId: meeting.id },
            },
            {
                id: "unrelated",
                userId: "receiver",
                kind: "agenda.suggestions",
                subjectId: "other-agenda",
                status,
            },
        ]);
        await commit(await queued());
        expect(
            (
                await database.db
                    .select()
                    .from(asyncJobs)
                    .where(eq(asyncJobs.id, "suggestions"))
            )[0],
        ).toMatchObject({ status: "failed", claimToken: null });
        expect(
            (
                await database.db
                    .select()
                    .from(asyncJobs)
                    .where(eq(asyncJobs.id, "unrelated"))
            )[0].status,
        ).toBe(status);
    });
    it("fences in-flight agenda generation even if its worker misses cancellation", async () => {
        const meeting = await sourceAgenda();
        await database.db.insert(asyncJobs).values({
            id: "suggestions",
            userId: "owner",
            kind: "agenda.suggestions",
            subjectId: meeting.id,
            status: "processing",
            payload: { agendaId: meeting.id },
        });
        mocks.complete.mockImplementation(async () => {
            const [running] = await database.db
                .select()
                .from(asyncJobs)
                .where(eq(asyncJobs.id, "suggestions"));
            expect(running.payload.sourceItemIds).toContain("recording");
            await database.db
                .delete(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.itemId, "recording"));
            await commit(await queued());
            expect(
                (
                    await database.db
                        .select()
                        .from(asyncJobs)
                        .where(eq(asyncJobs.id, "suggestions"))
                )[0].status,
            ).toBe("failed");
            return {
                choices: [
                    {
                        message: {
                            content: JSON.stringify({
                                suggestions: [
                                    {
                                        text: "Old private suggestion restored",
                                        sources: {
                                            itemIds: ["recording"],
                                            taskIds: [],
                                        },
                                    },
                                ],
                            }),
                        },
                    },
                ],
            };
        });
        await expect(
            agendaSuggestionsJobHandler.run({
                userId: "owner",
                jobId: "suggestions",
                payload: { agendaId: meeting.id },
                attempt: 1,
                maxAttempts: 3,
                signal: new AbortController().signal,
                reportProgress: vi.fn(),
            }),
        ).rejects.toMatchObject({ statusCode: 409 });
        expect(mocks.complete).toHaveBeenCalledTimes(1);
        expect(await database.db.select().from(agendaSuggestions)).toEqual([]);
    });
    it.each([
        "Plaud supplied title",
        "upload-name.m4a",
        "Meeting title",
        "",
    ])("preserves a non-generated title %j", async (title) => {
        await database.db
            .update(chatterItems)
            .set({ title: encryptText(title), titleEditedAt: null })
            .where(eq(chatterItems.id, "recording"));
        await database.db.insert(itemProcessing).values({
            itemId: "recording",
            userId: "owner",
            view: "private",
            phases: {
                summary: {
                    state: "done",
                    generation: 1,
                    at: new Date().toISOString(),
                    steps: {
                        title: {
                            state: "skipped",
                            reason: "first_summary_title_disabled",
                            contentId: "riffado",
                            contentRevision: 0,
                            generation: 1,
                        },
                    },
                },
            },
        });
        await commit(await queued());
        expect(
            decryptText(
                (
                    await database.db
                        .select()
                        .from(chatterItems)
                        .where(eq(chatterItems.id, "recording"))
                )[0].title,
            ),
        ).toBe(title);
    });
    it.each([
        "use",
        "also_transcribe",
    ] as const)("gathers Learn correction state from the profile's source after cutting (%s)", async (plaudTranscript) => {
        await database.db
            .delete(transcriptions)
            .where(eq(transcriptions.id, "riffado"));
        await database.db
            .update(recordings)
            .set({ cutAt: new Date() })
            .where(eq(recordings.id, "recording"));
        const settings = seededAudioProfileSettings({ autoTranscribe: true });
        settings.steps.transcribe.plaudTranscript = plaudTranscript;
        await database.db.insert(processingProfiles).values({
            id: "profile",
            ownerUserId: "owner",
            scope: "personal",
            channel: "audio",
            name: encryptText("Recording profile"),
            currentRevisionId: "revision",
        });
        await database.db.insert(processingProfileRevisions).values({
            id: "revision",
            profileId: "profile",
            settings: encryptText(JSON.stringify(settings)),
        });
        await database.db.insert(itemProcessing).values({
            itemId: "recording",
            userId: "owner",
            view: "private",
            profileId: "profile",
            profileRevisionId: "revision",
            phases: {},
        });
        await database.db.insert(transcriptCorrectionPasses).values({
            id: "pass",
            userId: "owner",
            scopeUserId: "owner",
            recordingId: "recording",
            transcriptionId: "plaud",
            transcriptRevision: 0,
            view: "private",
        });
        await database.db.insert(asyncJobs).values({
            userId: "owner",
            kind: "learn.correct",
            subjectId: "recording",
            status: "processing",
            payload: { passId: "pass" },
        });
        const facts = await gatherFacts("recording", "private", "owner", {
            legacyIfEmpty: false,
        });
        expect(facts.profile?.transcribe?.plaudTranscript).toBe(
            plaudTranscript,
        );
        expect(facts.learnCorrectionInFlight).toBe(plaudTranscript === "use");
    });
});
