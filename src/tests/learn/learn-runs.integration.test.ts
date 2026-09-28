/**
 * Learn runs against a real PostgreSQL: what happens to them when their
 * transcript is rewritten, and when their recording leaves the
 * Organization.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import type { Readable } from "node:stream";
import { eq } from "drizzle-orm";
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
    apiCredentials,
    asyncJobs,
    learnReviewItems,
    learnRuns,
    recordingFolderAssignments,
    recordingFolders,
    recordings,
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

const { createCompletion } = vi.hoisted(() => ({
    createCompletion: vi.fn(),
}));
vi.mock("openai", async (importOriginal) => {
    const actual = await importOriginal<typeof import("openai")>();
    return {
        ...actual,
        OpenAI: class {
            chat = { completions: { create: createCompletion } };
        },
    };
});

vi.mock("@/lib/auth-server", async () => {
    const { AppError, ErrorCode } =
        await vi.importActual<typeof import("@/lib/errors")>("@/lib/errors");
    return {
        requireApiSession: vi.fn(async (request: Request) => {
            const id = request.headers.get("x-test-user");
            if (!id) {
                throw new AppError(
                    ErrorCode.AUTH_SESSION_MISSING,
                    "Unauthorized",
                    401,
                );
            }
            return { user: { id, email: `${id}@example.test` } };
        }),
    };
});

import {
    GET as getLearnRoute,
    POST as postLearnRoute,
} from "@/app/api/recordings/[id]/learn/route";
import { encrypt } from "@/lib/encryption";
import {
    decryptJsonField,
    encryptJsonField,
    encryptText,
} from "@/lib/encryption/fields";
import { buildAndUploadExportArchive } from "@/lib/export/build-archive";
import { addRecordingToFolder, unshareRecording } from "@/lib/folders/folders";
import { createEntity } from "@/lib/knowledge/entities";
import { knowledgeStore } from "@/lib/knowledge/knowledge-loader";
import { seedCoreVocabulary } from "@/lib/knowledge/vocabulary";
import { learnJobHandler } from "@/lib/learn/learn-job-handler";
import { ensureOrgAccount } from "@/lib/org/account";
import type { StorageProvider } from "@/lib/storage/types";
import { upsertTranscription } from "@/lib/transcription/persist";
import type { TranscriptTurn } from "@/lib/transcription/turns";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const OWNER = "user-owner";
const BOB = "user-bob";
const REC = "rec-learn";
const TURNS: TranscriptTurn[] = [
    { speaker: "speaker_0", startMs: 0, endMs: 5_000, text: "Dobrý den." },
];

describeWithDatabase("Learn runs (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";
    let transcriptId = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "learn_runs",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        await db().delete(users);
        await db()
            .insert(users)
            .values([
                { id: OWNER, email: "o@example.test" },
                { id: BOB, email: "b@example.test" },
            ]);
        orgUserId = (await ensureOrgAccount()) ?? "";
        await db()
            .insert(recordings)
            .values({
                id: REC,
                userId: OWNER,
                deviceSn: "SN-1",
                plaudFileId: "plaud-1",
                filename: encryptText("Weekly"),
                duration: 5_000,
                startTime: new Date("2026-09-01T10:00:00Z"),
                endTime: new Date("2026-09-01T10:00:05Z"),
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
                provider: "openai",
                model: "gpt-4o-transcribe-diarize",
                source: "riffado",
            })
            .returning({ id: transcriptions.id });
        transcriptId = transcript?.id ?? "";
        await db().insert(transcriptSpeakers).values({
            userId: OWNER,
            transcriptionId: transcriptId,
            label: "speaker_0",
            personId: null,
            source: "user",
            status: "confirmed",
            markedUnknown: true,
            confirmedByUserId: OWNER,
        });
    });

    function run(
        view: "private" | "org",
        status: "queued" | "running" | "ready" | "finished",
    ) {
        return db()
            .insert(learnRuns)
            .values({
                userId: OWNER,
                scopeUserId: view === "org" ? orgUserId : OWNER,
                recordingId: REC,
                transcriptionId: transcriptId,
                view,
                actorUserId: view === "org" ? orgUserId : OWNER,
                trigger: "manual",
                transcriptRevision: 0,
                vocabularyVersion: 0,
                status,
            })
            .returning({ id: learnRuns.id })
            .then((rows) => rows[0]?.id ?? "");
    }

    const statusOf = async (id: string) =>
        (
            await db()
                .select({ status: learnRuns.status })
                .from(learnRuns)
                .where(eq(learnRuns.id, id))
        )[0]?.status;

    it("supersedes the pending runs of a transcript that is rewritten, and leaves finished ones", async () => {
        const queued = await run("private", "queued");
        const ready = await run("private", "ready");
        const finished = await run("private", "finished");

        await upsertTranscription({
            userId: OWNER,
            recordingId: REC,
            text: "Dobrý den všem.",
            detectedLanguage: "cs",
            source: "riffado",
            provider: "openai",
            model: "gpt-4o-transcribe-diarize",
            turns: [
                { ...(TURNS[0] as TranscriptTurn), text: "Dobrý den všem." },
            ],
        });

        expect(await statusOf(queued)).toBe("superseded");
        expect(await statusOf(ready)).toBe("superseded");
        expect(await statusOf(finished)).toBe("finished");
    });

    it("takes the Organization's runs, and what they proposed, with the recording when it leaves", async () => {
        const [root] = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, orgUserId));
        await addRecordingToFolder({
            userId: OWNER,
            recordingId: REC,
            folderId: root?.id ?? "",
        });
        const orgs = await run("org", "ready");
        await db()
            .insert(learnReviewItems)
            .values({
                runId: orgs,
                userId: orgUserId,
                kind: "fact",
                fingerprintHmac: "f",
                payload: encryptJsonField({ secret: "what the curator found" }),
            });

        await unshareRecording(OWNER, REC);

        expect(await statusOf(orgs)).toBeUndefined();
        expect(await db().select().from(learnReviewItems)).toEqual([]);
    });

    function learn(
        user: string,
        {
            view,
            method = "POST",
            source,
        }: { view?: "org"; method?: string; source?: "plaud" } = {},
    ) {
        const query = new URLSearchParams({
            ...(view ? { view } : {}),
            ...(source ? { source } : {}),
        }).toString();
        const handler = method === "POST" ? postLearnRoute : getLearnRoute;
        return handler(
            new Request(
                `http://localhost/api/recordings/${REC}/learn${query ? `?${query}` : ""}`,
                { method, headers: { "x-test-user": user } },
            ),
            { params: Promise.resolve({ id: REC }) },
        );
    }

    const provider = (userId: string) =>
        db()
            .insert(apiCredentials)
            .values({
                userId,
                provider: "openai",
                apiKey: encrypt("key"),
                defaultModel: "gpt-4o-mini",
                isDefaultEnhancement: true,
            });

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

    it("starts a run for its owner, with their chat provider, and joins it when asked again", async () => {
        const refused = await learn(OWNER);
        expect(refused.status).toBe(400);
        await expect(refused.json()).resolves.toMatchObject({
            code: "AI_PROVIDER_NOT_CONFIGURED",
        });

        await provider(OWNER);
        const started = await learn(OWNER);
        expect(started.status).toBe(202);
        const { runId, created } = (await started.json()) as {
            runId: string;
            created: boolean;
        };
        expect(created).toBe(true);
        const [row] = await db()
            .select()
            .from(learnRuns)
            .where(eq(learnRuns.id, runId));
        expect(row).toMatchObject({
            userId: OWNER,
            scopeUserId: OWNER,
            view: "private",
            status: "queued",
            transcriptionId: transcriptId,
        });
        const jobs = await db()
            .select({
                kind: asyncJobs.kind,
                subjectId: asyncJobs.subjectId,
                payload: asyncJobs.payload,
            })
            .from(asyncJobs);
        expect(jobs).toEqual([
            { kind: "learn.run", subjectId: REC, payload: { runId } },
        ]);

        const again = await learn(OWNER);
        await expect(again.json()).resolves.toMatchObject({
            runId,
            created: false,
        });
        const listed = await learn(OWNER, { method: "GET" });
        await expect(listed.json()).resolves.toMatchObject({
            runs: [{ id: runId, source: "riffado", status: "queued" }],
        });
        // Nobody else sees it.
        expect((await learn(BOB, { method: "GET" })).status).toBe(404);
    });

    it("refuses a transcript without timings, or one the recording does not have", async () => {
        await provider(OWNER);
        await db()
            .update(transcriptions)
            .set({
                turns: encryptJsonField([
                    { ...(TURNS[0] as TranscriptTurn), startMs: 0, endMs: 0 },
                ]),
            })
            .where(eq(transcriptions.id, transcriptId));
        expect((await learn(OWNER)).status).toBe(400);
        expect((await learn(OWNER, { source: "plaud" })).status).toBe(400);
    });

    it("keeps an owner's unfinished run from sharing, and lets only the organization account run it while shared", async () => {
        await provider(OWNER);
        await provider(orgUserId);
        await learn(OWNER);
        await expect(share()).rejects.toMatchObject({
            code: "SHARE_REQUIREMENTS_UNMET",
        });

        await db().delete(learnRuns);
        await share();
        const ownerTry = await learn(OWNER);
        expect(ownerTry.status).toBe(409);
        expect((await learn(BOB, { view: "org" })).status).toBe(403);
        const curated = await learn(orgUserId, { view: "org" });
        expect(curated.status).toBe(202);
        const [row] = await db()
            .select({
                scopeUserId: learnRuns.scopeUserId,
                view: learnRuns.view,
            })
            .from(learnRuns);
        expect(row).toEqual({ scopeUserId: orgUserId, view: "org" });
    });

    describe("running", () => {
        const reply = (content: object | string) =>
            createCompletion.mockResolvedValueOnce({
                choices: [
                    {
                        message: {
                            content:
                                typeof content === "string"
                                    ? content
                                    : JSON.stringify(content),
                        },
                    },
                ],
            });
        const runJob = (runId: string) =>
            learnJobHandler.run({
                payload: { runId },
                userId: OWNER,
                jobId: "job",
                attempt: 1,
                maxAttempts: 2,
                signal: new AbortController().signal,
                reportProgress: () => {},
            });
        const statusAndStats = async (runId: string) =>
            (
                await db()
                    .select({
                        status: learnRuns.status,
                        stats: learnRuns.stats,
                    })
                    .from(learnRuns)
                    .where(eq(learnRuns.id, runId))
            )[0];

        beforeEach(async () => {
            createCompletion.mockReset();
            knowledgeStore().invalidateAll();
            await seedCoreVocabulary();
            await provider(OWNER);
            await db()
                .update(transcriptions)
                .set({
                    turns: encryptJsonField([
                        {
                            speaker: "speaker_0",
                            startMs: 0,
                            endMs: 5_000,
                            text: "Dobrý den, máme tu Tavesy.",
                        },
                    ]),
                })
                .where(eq(transcriptions.id, transcriptId));
        });

        it("stores what holds as review items, encrypted, and is ready for review", async () => {
            const tavesi = (
                await createEntity(OWNER, {
                    typeKey: "organization",
                    name: "Tavesi",
                })
            ).id;
            const started = await learn(OWNER);
            const { runId } = (await started.json()) as { runId: string };
            reply({ mentions: [{ text: "Tavesy", turn: 0 }] });
            reply({
                speakers: [],
                corrections: [
                    {
                        turnIndex: 0,
                        charStart: 0,
                        charEnd: 1,
                        heard: "Tavesy",
                        kind: "correct",
                        target: { entityId: tavesi },
                        replacement: "Tavesi",
                    },
                    {
                        turnIndex: 0,
                        charStart: 0,
                        charEnd: 5,
                        heard: "Dobrý",
                        kind: "correct",
                        target: { entityId: "someone-elses" },
                        replacement: "x",
                    },
                ],
                facts: [],
                relationPhrases: [],
            });

            await expect(runJob(runId)).resolves.toMatchObject({
                status: "ready",
                items: 1,
            });
            expect(await statusAndStats(runId)).toMatchObject({
                status: "ready",
                stats: expect.objectContaining({
                    items_correction: 1,
                    dropped_outOfScope: 1,
                }),
            });
            const [item] = await db().select().from(learnReviewItems);
            expect(item).toMatchObject({
                runId,
                userId: OWNER,
                kind: "correction",
                preTicked: false,
            });
            expect(JSON.stringify(item?.payload)).not.toContain("Tavesi");
            expect(
                decryptJsonField<{ anchors: unknown[] }>(item?.payload)
                    ?.anchors,
            ).toEqual([{ turnIndex: 0, charStart: 19, charEnd: 25 }]);
        });

        it("finishes a run that found nothing new", async () => {
            const { runId } = (await (await learn(OWNER)).json()) as {
                runId: string;
            };
            reply({ mentions: [] });
            reply({
                speakers: [],
                corrections: [],
                facts: [],
                relationPhrases: [],
            });
            await runJob(runId);
            expect((await statusAndStats(runId))?.status).toBe("finished");
        });

        it("is superseded when its transcript changed, and cancelled when its recording was shared since", async () => {
            const { runId } = (await (await learn(OWNER)).json()) as {
                runId: string;
            };
            await db()
                .update(transcriptions)
                .set({ revision: 5 })
                .where(eq(transcriptions.id, transcriptId));
            await runJob(runId);
            expect((await statusAndStats(runId))?.status).toBe("superseded");
            expect(createCompletion).not.toHaveBeenCalled();

            await db().delete(learnRuns);
            await db().delete(asyncJobs);
            const second = (await (await learn(OWNER)).json()) as {
                runId: string;
            };
            // Shared meanwhile (the gate would wait for the run; a share
            // from before the gate existed, or local mode switched off, would
            // not).
            const [root] = await db()
                .select({ id: recordingFolders.id })
                .from(recordingFolders)
                .where(eq(recordingFolders.userId, orgUserId));
            await db()
                .insert(recordingFolderAssignments)
                .values({
                    userId: orgUserId,
                    recordingId: REC,
                    folderId: root?.id ?? "",
                });
            await runJob(second.runId);
            expect((await statusAndStats(second.runId))?.status).toBe(
                "cancelled",
            );
            expect(createCompletion).not.toHaveBeenCalled();
        });
    });

    it("goes into its owner's archive with what it proposed, and the Organization's runs do not", async () => {
        const mine = await run("private", "ready");
        await db()
            .insert(learnReviewItems)
            .values({
                runId: mine,
                userId: OWNER,
                kind: "correction",
                fingerprintHmac: "f",
                payload: encryptJsonField({ heard: "Tavesy" }),
                preTicked: true,
            });
        await run("org", "ready");

        const storage = new ArchiveStorage();
        await buildAndUploadExportArchive({
            userId: OWNER,
            sourceStorage: storage,
            destinationStorage: storage,
            storageKey: "exports/owner.zip",
        });
        const directory = await unzipper.Open.buffer(storage.uploaded);
        const file = directory.files.find(
            (entry) => entry.path === "knowledge/learn.json",
        );
        const learnJson = JSON.parse(
            (await file?.buffer())?.toString("utf-8") ?? "{}",
        );
        expect(learnJson.runs.map((row: { id: string }) => row.id)).toEqual([
            mine,
        ]);
        expect(learnJson.items).toEqual([
            {
                runId: mine,
                kind: "correction",
                preTicked: true,
                decision: null,
                dependsOnLabel: null,
                payload: { heard: "Tavesy" },
            },
        ]);
    });
});

/** Captures the archive; the recording's audio is not there. */
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
        for await (const chunk of stream) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
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
