/**
 * Automatic Learn holding the title, summary and topics back (Task 5.5),
 * against a real PostgreSQL: when it holds, what releases it, and that it
 * releases once.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { and, eq, isNull } from "drizzle-orm";
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
    aiEnhancements,
    apiCredentials,
    apiRateLimitBuckets,
    asyncJobs,
    chatterItems,
    itemProcessing,
    learnRuns,
    mailPendingShares,
    recordingFolderAssignments,
    recordingFolders,
    recordingTasks,
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
            AUTO_SUMMARY_RATE_LIMIT_PER_HOUR: 20,
        },
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/webhooks/emit", () => ({
    emitEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/ai/generate-title", () => ({
    generateTitleFromTranscription: vi.fn().mockResolvedValue("Held title"),
}));
vi.mock("@/lib/export/document-sidecars", () => ({
    refreshExistingRecordingSidecars: vi.fn().mockResolvedValue(undefined),
}));

import { encrypt } from "@/lib/encryption";
import {
    decryptText,
    encryptJsonField,
    encryptText,
} from "@/lib/encryption/fields";
import { JobDeferredError } from "@/lib/jobs/retryable";
import {
    AUTO_LEARN_HOLD_MS,
    learnReleaseJobHandler,
    releaseAutoLearnHold,
    startAutomaticLearn,
    sweepAutoLearnHolds,
} from "@/lib/learn/auto-learn";
import { recordingFollowUps } from "@/lib/learn/follow-ups";
import * as learnJob from "@/lib/learn/learn-job";
import { finishReview } from "@/lib/learn/review";
import { ensureOrgAccount } from "@/lib/org/account";
import { pipelineAdvanceJobHandler } from "@/lib/pipeline/advance-job";
import { gatherFacts } from "@/lib/pipeline/facts";
import { planAdvance } from "@/lib/pipeline/plan";
import { recordIntendedPlacementInTx } from "@/lib/pipeline/share-intent";
import { updatePhaseInTx } from "@/lib/pipeline/state";
import { requestAdvance } from "@/lib/pipeline/trigger";
import { resolveDefaultProfile } from "@/lib/profiles/resolve";
import { updateProfile } from "@/lib/profiles/store";
import { consumeRateLimitBucket } from "@/lib/rate-limit";
import * as titleQueue from "@/lib/recordings/title-job";
import { titleJobHandler } from "@/lib/recordings/title-job-handler";
import { requireRecordingView } from "@/lib/sharing/access";
import { loadShareGate } from "@/lib/sharing/load-share-gate";
import * as autoSummary from "@/lib/summary/auto-summary";
import * as topicsQueue from "@/lib/topics/topics-job";
import { enqueueTopicsJob } from "@/lib/topics/topics-job";
import { upsertTranscription } from "@/lib/transcription/persist";
import { emitEvent } from "@/lib/webhooks/emit";
import { insertRecordings } from "@/tests/integration/items";
import { seedExistingPersonalProfiles } from "@/tests/integration/profile-fixtures";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const OWNER = "user-owner";
const REC = "rec-auto";

describeWithDatabase("automatic Learn holds (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let riffadoId = "";
    let plaudId = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "auto_learn",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        vi.restoreAllMocks();
        await db().delete(users);
        await db().delete(asyncJobs);
        await db().insert(users).values({ id: OWNER, email: "o@example.test" });
        await ensureOrgAccount();
        await db().insert(userSettings).values({
            userId: OWNER,
            autoLearn: true,
            autoSummarize: true,
            autoDetectTopics: true,
            autoGenerateTitle: true,
        });
        await seedExistingPersonalProfiles(OWNER, mockEnv);
        await db()
            .insert(apiCredentials)
            .values({
                userId: OWNER,
                provider: "OpenAI",
                apiKey: encrypt("sk-test"),
                defaultModel: "gpt-test",
                isDefaultEnhancement: true,
            });
        await insertRecordings(db(), {
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
        const turns = [
            { speaker: "speaker_0", startMs: 0, endMs: 5_000, text: "Ahoj." },
        ];
        const inserted = await db()
            .insert(transcriptions)
            .values(
                (["riffado", "plaud"] as const).map((source) => ({
                    recordingId: REC,
                    userId: OWNER,
                    text: encryptText("Ahoj."),
                    turns: encryptJsonField(turns),
                    provider: "openai",
                    model: "gpt-4o-transcribe-diarize",
                    source,
                })),
            )
            .returning({
                id: transcriptions.id,
                source: transcriptions.source,
            });
        riffadoId = inserted.find((row) => row.source === "riffado")?.id ?? "";
        plaudId = inserted.find((row) => row.source === "plaud")?.id ?? "";
        await db()
            .insert(recordingFolders)
            .values([
                {
                    id: "auto-learn-root",
                    userId: OWNER,
                    parentId: null,
                    name: "Private",
                    nameHash: "auto-learn-root-hash",
                    kind: "private",
                },
                {
                    id: "auto-learn-folder",
                    userId: OWNER,
                    parentId: "auto-learn-root",
                    name: "Learn",
                    nameHash: "auto-learn-folder-hash",
                    kind: "custom",
                },
            ]);
        await db().insert(recordingFolderAssignments).values({
            userId: OWNER,
            itemId: REC,
            folderId: "auto-learn-folder",
        });
    });

    const dueAt = async () =>
        (
            await db()
                .select({ at: chatterItems.summaryDueAt })
                .from(chatterItems)
                .where(eq(chatterItems.id, REC))
        )[0]?.at ?? null;

    const processing = async () =>
        (
            await db()
                .select()
                .from(itemProcessing)
                .where(
                    and(
                        eq(itemProcessing.itemId, REC),
                        eq(itemProcessing.userId, OWNER),
                        eq(itemProcessing.view, "private"),
                    ),
                )
                .limit(1)
        )[0];

    const kinds = async () =>
        (
            await db()
                .select({ kind: asyncJobs.kind })
                .from(asyncJobs)
                .where(eq(asyncJobs.userId, OWNER))
        )
            .map((row) => row.kind)
            .sort();

    function run(
        status: "queued" | "running" | "ready" | "finished" | "failed",
        transcriptionId = riffadoId,
    ) {
        return db()
            .insert(learnRuns)
            .values({
                userId: OWNER,
                scopeUserId: OWNER,
                itemId: REC,
                transcriptionId,
                view: "private",
                actorUserId: OWNER,
                trigger: "auto",
                transcriptRevision: 0,
                vocabularyVersion: 0,
                status,
            })
            .returning({ id: learnRuns.id })
            .then((rows) => rows[0]?.id ?? "");
    }

    /** Drain a release job queued before the processing pipeline deployed. */
    const runLegacyRelease = async () => {
        await learnReleaseJobHandler.run({
            jobId: "job-release",
            userId: OWNER,
            payload: { recordingId: REC },
            attempt: 1,
            maxAttempts: 5,
            signal: new AbortController().signal,
            reportProgress: vi.fn(),
        } as unknown as Parameters<typeof learnReleaseJobHandler.run>[0]);
        await db().delete(asyncJobs).where(eq(asyncJobs.kind, "learn.release"));
    };

    /** Run the queued pipeline driver, as the worker would. */
    const runAdvance = async () => {
        const profile = await resolveDefaultProfile(OWNER, "audio");
        await db()
            .insert(itemProcessing)
            .values({
                itemId: REC,
                userId: OWNER,
                view: "private",
                profileId: profile.profile.id,
                profileRevisionId: profile.revisionId,
            })
            .onConflictDoUpdate({
                target: [itemProcessing.itemId, itemProcessing.view],
                set: {
                    profileId: profile.profile.id,
                    profileRevisionId: profile.revisionId,
                },
            });
        const [processing] = await db()
            .select({ generation: itemProcessing.requestedGeneration })
            .from(itemProcessing)
            .where(
                and(
                    eq(itemProcessing.itemId, REC),
                    eq(itemProcessing.userId, OWNER),
                    eq(itemProcessing.view, "private"),
                ),
            );
        await db().transaction((tx) =>
            updatePhaseInTx(tx, REC, "private", OWNER, "categorize", {
                state: "done",
                reason: "categorized",
                generation: processing?.generation ?? 0,
                at: new Date().toISOString(),
            }),
        );
        await pipelineAdvanceJobHandler.run({
            jobId: "job-advance",
            userId: OWNER,
            payload: {
                itemId: REC,
                view: "private",
                reason: "learn-released",
            },
            attempt: 1,
            maxAttempts: 10,
            signal: new AbortController().signal,
            reportProgress: vi.fn(),
        } as unknown as Parameters<typeof pipelineAdvanceJobHandler.run>[0]);
        await db()
            .delete(asyncJobs)
            .where(eq(asyncJobs.kind, "pipeline.advance"));
    };

    const setStatus = (id: string, status: "finished" | "failed") =>
        db().update(learnRuns).set({ status }).where(eq(learnRuns.id, id));

    const hold = () =>
        db()
            .update(chatterItems)
            .set({ summaryDueAt: new Date(Date.now() + AUTO_LEARN_HOLD_MS) })
            .where(eq(chatterItems.id, REC));

    async function setLearnAutomation(input: {
        automatic: boolean;
        followUpsAutomatic?: boolean;
    }): Promise<void> {
        const resolved = await resolveDefaultProfile(OWNER, "audio");
        const settings = resolved.settings;
        if (!("transcribe" in settings.steps)) {
            throw new Error("audio profile");
        }
        await updateProfile({
            ownerUserId: OWNER,
            profileId: resolved.profile.id,
            actor: {
                kind: "user",
                actorId: OWNER,
                issuer: null,
                subject: null,
                capabilities: new Set(["use"]),
                clientId: null,
                clientPermissions: new Set(),
                verifiedAt: null,
            },
            expectedVersion: resolved.profile.version,
            settings: {
                ...settings,
                steps: {
                    ...settings.steps,
                    learn: {
                        ...settings.steps.learn,
                        automatic: input.automatic,
                        correctAfterLearn: false,
                    },
                    ...(input.followUpsAutomatic === false
                        ? {
                              title: {
                                  ...settings.steps.title,
                                  automatic: false,
                              },
                              summary: {
                                  ...settings.steps.summary,
                                  automatic: false,
                              },
                              topics: {
                                  ...settings.steps.topics,
                                  automatic: false,
                              },
                          }
                        : {}),
                },
            },
        });
    }

    it("holds the title, summary and topics and starts Learn, queuing nothing else", async () => {
        const before = Date.now();

        expect(
            await startAutomaticLearn({
                userId: OWNER,
                itemId: REC,
                source: "riffado",
                timed: true,
            }),
        ).toEqual({ status: "started" });

        const due = await dueAt();
        expect(due?.getTime()).toBeGreaterThanOrEqual(
            before + AUTO_LEARN_HOLD_MS - 1_000,
        );
        // No phantom summary, title or topics job: only the run's.
        expect(await kinds()).toEqual(["learn.run"]);
        const runs = await db()
            .select({ trigger: learnRuns.trigger, status: learnRuns.status })
            .from(learnRuns);
        expect(runs).toEqual([{ trigger: "auto", status: "queued" }]);
    });

    it("refuses untimed Learn and Learn with automation off", async () => {
        const tryStart = (timed = true) =>
            startAutomaticLearn({
                userId: OWNER,
                itemId: REC,
                source: "riffado",
                timed,
            });

        expect(await tryStart(false)).toEqual({
            status: "skipped",
            reason: "no_timings",
        });
        await setLearnAutomation({ automatic: false });
        expect(await tryStart()).toEqual({
            status: "skipped",
            reason: "profile_off",
        });
        expect(await dueAt()).toBeNull();
        expect(await kinds()).toEqual([]);
    });

    it("refuses hosted and shared Learn, but defers rate-limited work", async () => {
        mockEnv.IS_HOSTED = true;
        await expect(
            startAutomaticLearn({
                userId: OWNER,
                itemId: REC,
                source: "riffado",
                timed: true,
            }),
        ).resolves.toEqual({ status: "skipped", reason: "hosted" });
        mockEnv.IS_HOSTED = false;

        const [org] = await db()
            .select({ id: users.id })
            .from(users)
            .where(eq(users.email, "org@example.test"))
            .limit(1);
        const [orgRoot] = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(
                and(
                    eq(recordingFolders.userId, org?.id ?? ""),
                    isNull(recordingFolders.parentId),
                ),
            )
            .limit(1);
        await db()
            .insert(recordingFolderAssignments)
            .values({
                userId: OWNER,
                itemId: REC,
                folderId: orgRoot?.id ?? "",
            });
        await expect(
            startAutomaticLearn({
                userId: OWNER,
                itemId: REC,
                source: "riffado",
                timed: true,
            }),
        ).resolves.toEqual({ status: "skipped", reason: "shared" });
        await db()
            .delete(recordingFolderAssignments)
            .where(eq(recordingFolderAssignments.folderId, orgRoot?.id ?? ""));

        for (let index = 0; index < 20; index++) {
            await consumeRateLimitBucket(`auto-learn:user:${OWNER}`, {
                limit: 20,
                windowMs: 60 * 60 * 1000,
            });
        }
        await expect(
            startAutomaticLearn({
                userId: OWNER,
                itemId: REC,
                source: "riffado",
                timed: true,
            }),
        ).resolves.toEqual({
            status: "deferred",
            delayMs: expect.any(Number),
        });
        expect(await dueAt()).toBeNull();
        expect(await kinds()).toEqual([]);
    });

    it("starts one automatic Learn run and consumes its bucket once after a transcript write", async () => {
        await db().delete(apiRateLimitBuckets);
        await setLearnAutomation({ automatic: true });
        await db()
            .delete(transcriptions)
            .where(eq(transcriptions.id, riffadoId));

        await upsertTranscription({
            userId: OWNER,
            recordingId: REC,
            text: "A new timed transcript.",
            detectedLanguage: "en",
            source: "riffado",
            provider: "openai",
            model: "gpt-4o-transcribe-diarize",
            turns: [
                {
                    speaker: "speaker_0",
                    startMs: 0,
                    endMs: 5_000,
                    text: "A new timed transcript.",
                },
            ],
        });
        await runAdvance();

        expect(
            await db()
                .select({ id: learnRuns.id })
                .from(learnRuns)
                .where(eq(learnRuns.itemId, REC)),
        ).toHaveLength(1);
        const next = await consumeRateLimitBucket(`auto-learn:user:${OWNER}`, {
            limit: 20,
            windowMs: 60 * 60 * 1000,
        });
        expect(next.remaining).toBe(18);
    });

    it("does not start automatic Learn after a failed manual run on the current input", async () => {
        const [transcript] = await db()
            .select({ revision: transcriptions.revision })
            .from(transcriptions)
            .where(
                and(
                    eq(transcriptions.id, riffadoId),
                    eq(transcriptions.userId, OWNER),
                ),
            )
            .limit(1);
        const input = {
            contentId: riffadoId,
            contentSourceId: "riffado",
            contentRevision: transcript?.revision ?? 0,
        };
        const now = new Date().toISOString();
        await db()
            .insert(itemProcessing)
            .values({
                itemId: REC,
                userId: OWNER,
                view: "private",
                phases: {
                    categorize: {
                        state: "done",
                        reason: "categorized",
                        generation: 0,
                        at: now,
                    },
                    transcribe: {
                        state: "done",
                        reason: "content-available",
                        generation: 0,
                        inputs: input,
                        at: now,
                    },
                    learn: {
                        state: "running",
                        reason: "manual",
                        generation: 0,
                        inputs: input,
                        at: now,
                    },
                },
            });
        await db().insert(learnRuns).values({
            userId: OWNER,
            scopeUserId: OWNER,
            itemId: REC,
            transcriptionId: riffadoId,
            view: "private",
            actorUserId: OWNER,
            trigger: "manual",
            transcriptRevision: input.contentRevision,
            vocabularyVersion: 0,
            inputs: input,
            status: "failed",
            errorCode: "AI_PROVIDER_API_ERROR",
        });

        await runAdvance();

        expect(
            await db()
                .select({
                    trigger: learnRuns.trigger,
                    status: learnRuns.status,
                })
                .from(learnRuns)
                .where(
                    and(eq(learnRuns.itemId, REC), eq(learnRuns.userId, OWNER)),
                ),
        ).toEqual([{ trigger: "manual", status: "failed" }]);
        expect((await processing())?.phases.learn).toMatchObject({
            state: "done",
            reason: "manual_finished",
            inputs: input,
        });
        expect(await kinds()).not.toContain("learn.run");
    });

    it("waits while a run is queued or awaits review, and releases once when the last review is done", async () => {
        await hold();
        const ready = await run("ready");

        expect(await releaseAutoLearnHold(REC)).toBe(false);
        expect(await dueAt()).not.toBeNull();

        await setStatus(ready, "finished");
        expect(await releaseAutoLearnHold(REC)).toBe(true);
        expect(await dueAt()).toBeNull();
        // Cleared and queued in one transaction: one durable job.
        expect(await kinds()).toEqual(["pipeline.advance"]);

        // Released already: nothing is queued twice.
        expect(await releaseAutoLearnHold(REC)).toBe(false);
        expect(await kinds()).toEqual(["pipeline.advance"]);

        await runAdvance();
        expect(await kinds()).toEqual(["summary", "title.generate", "topics"]);
    });

    it("tells the page what waits and which of its jobs are still to finish", async () => {
        await hold();
        const ready = await run("ready");
        expect(await recordingFollowUps(OWNER, REC)).toEqual({
            held: true,
            pending: [],
        });

        await setStatus(ready, "finished");
        await releaseAutoLearnHold(REC);
        expect(await recordingFollowUps(OWNER, REC)).toEqual({
            held: false,
            pending: ["pipeline.advance"],
        });

        await runAdvance();
        expect(await recordingFollowUps(OWNER, REC)).toEqual({
            held: false,
            pending: ["summary", "title.generate", "topics"],
        });

        await db()
            .update(asyncJobs)
            .set({ status: "completed" })
            .where(eq(asyncJobs.kind, "title.generate"));
        expect((await recordingFollowUps(OWNER, REC))?.pending).toEqual([
            "summary",
            "topics",
        ]);
        // Someone else's recording is not found, whatever it waits for.
        expect(await recordingFollowUps("someone-else", REC)).toBeNull();
    });

    it("releases when the run failed", async () => {
        await hold();
        const queued = await run("queued");
        expect(await releaseAutoLearnHold(REC)).toBe(false);

        await setStatus(queued, "failed");

        expect(await releaseAutoLearnHold(REC)).toBe(true);
    });

    it("with two transcripts, waits for both reviews", async () => {
        await hold();
        const riffado = await run("ready", riffadoId);
        const plaud = await run("ready", plaudId);

        await setStatus(riffado, "finished");
        expect(await releaseAutoLearnHold(REC)).toBe(false);

        await setStatus(plaud, "finished");
        expect(await releaseAutoLearnHold(REC)).toBe(true);
    });

    it("releases when the time is up, even with a review still waiting", async () => {
        await hold();
        const runId = await run("ready");

        expect(await sweepAutoLearnHolds(new Date())).toBe(0);
        expect(
            await sweepAutoLearnHolds(
                new Date(Date.now() + AUTO_LEARN_HOLD_MS + 60_000),
            ),
        ).toBe(1);
        expect(await dueAt()).toBeNull();
        expect(await kinds()).toEqual(["pipeline.advance"]);

        await runAdvance();
        const [processing] = await db()
            .select({ phases: itemProcessing.phases })
            .from(itemProcessing)
            .where(
                and(
                    eq(itemProcessing.itemId, REC),
                    eq(itemProcessing.userId, OWNER),
                    eq(itemProcessing.view, "private"),
                ),
            );
        expect(processing?.phases.learn).toMatchObject({
            state: "waiting",
            reason: "review_pending_timeout",
        });
        expect(processing?.phases.summary).toMatchObject({ state: "pending" });
        expect(await kinds()).toContain("summary");
        expect(
            (
                await db()
                    .select({ status: learnRuns.status })
                    .from(learnRuns)
                    .where(eq(learnRuns.id, runId))
            )[0]?.status,
        ).toBe("ready");
    });

    it("reviews privately, decides proposals, and shares an intended placement once", async () => {
        await setLearnAutomation({
            automatic: true,
            followUpsAutomatic: false,
        });
        const [org] = await db()
            .select({ id: users.id })
            .from(users)
            .where(eq(users.email, "org@example.test"))
            .limit(1);
        const [orgRoot] = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(
                and(
                    eq(recordingFolders.userId, org?.id ?? ""),
                    isNull(recordingFolders.parentId),
                ),
            )
            .limit(1);
        const folderId = "auto-learn-org-folder";
        await db()
            .insert(recordingFolders)
            .values({
                id: folderId,
                userId: org?.id ?? "",
                parentId: orgRoot?.id ?? "",
                name: encryptText("Reviewed"),
                nameHash: "auto-learn-org-folder-hash",
                kind: "custom",
            });
        await db().transaction((tx) =>
            recordIntendedPlacementInTx(tx, {
                ownerUserId: OWNER,
                itemId: REC,
                folderId,
                requestPipeline: false,
            }),
        );
        const [proposal] = await db()
            .insert(recordingTasks)
            .values({
                itemId: REC,
                userId: OWNER,
                status: "proposed",
                source: "riffado",
                text: encryptText("Send the notes"),
            })
            .returning({ id: recordingTasks.id });

        expect(
            await startAutomaticLearn({
                userId: OWNER,
                itemId: REC,
                source: "riffado",
                timed: true,
            }),
        ).toEqual({ status: "started" });
        const [learn] = await db()
            .select({ id: learnRuns.id, view: learnRuns.view })
            .from(learnRuns)
            .where(eq(learnRuns.itemId, REC));
        expect(learn?.view).toBe("private");
        await db()
            .update(learnRuns)
            .set({ status: "ready" })
            .where(eq(learnRuns.id, learn?.id ?? ""));
        await runAdvance();
        expect(
            await db()
                .select()
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.folderId, folderId)),
        ).toEqual([]);

        const access = await requireRecordingView(OWNER, REC, "private");
        await expect(
            finishReview(access, OWNER, { versions: {} }),
        ).resolves.toMatchObject({ status: "finished" });
        await runAdvance();
        expect((await processing())?.phases.share).toMatchObject({
            state: "waiting",
            reason: "gate_blocked",
        });
        await db()
            .insert(transcriptSpeakers)
            .values(
                [riffadoId, plaudId].map((transcriptionId) => ({
                    userId: OWNER,
                    transcriptionId,
                    label: "speaker_0",
                    personId: null,
                    source: "user" as const,
                    status: "confirmed" as const,
                    markedUnknown: true,
                    confirmedByUserId: OWNER,
                })),
            );
        await db()
            .update(recordingTasks)
            .set({ status: "open" })
            .where(eq(recordingTasks.id, proposal?.id ?? ""));
        await requestAdvance({
            itemId: REC,
            userId: OWNER,
            view: "private",
            reason: "review-finished",
        });
        await expect(loadShareGate(db(), REC, OWNER)).resolves.toEqual([]);
        expect(
            planAdvance(await gatherFacts(REC, "private", OWNER)).actions,
        ).toContainEqual({ type: "executeShares" });

        await pipelineAdvanceJobHandler.run({
            jobId: "job-share",
            userId: OWNER,
            payload: {
                itemId: REC,
                view: "private",
                reason: "review-finished",
            },
            attempt: 1,
            maxAttempts: 10,
            signal: new AbortController().signal,
            reportProgress: vi.fn(),
        } as unknown as Parameters<typeof pipelineAdvanceJobHandler.run>[0]);
        expect((await processing())?.phases.share).toMatchObject({
            state: "done",
            reason: "shared",
        });
        expect(
            await db()
                .select()
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.folderId, folderId)),
        ).toHaveLength(1);
        expect(
            await db()
                .select()
                .from(mailPendingShares)
                .where(eq(mailPendingShares.itemId, REC)),
        ).toEqual([]);

        await requestAdvance({
            itemId: REC,
            userId: OWNER,
            view: "private",
            reason: "placement",
        });
        await pipelineAdvanceJobHandler.run({
            jobId: "job-share-repeat",
            userId: OWNER,
            payload: {
                itemId: REC,
                view: "private",
                reason: "placement",
            },
            attempt: 1,
            maxAttempts: 10,
            signal: new AbortController().signal,
            reportProgress: vi.fn(),
        } as unknown as Parameters<typeof pipelineAdvanceJobHandler.run>[0]);
        expect(
            await db()
                .select()
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.folderId, folderId)),
        ).toHaveLength(1);
    });

    it("does not let holds still waiting for their review crowd out one to release", async () => {
        // First in line: a review waiting, its time not up.
        await hold();
        await run("ready");
        // Behind it: a hold nothing holds any more.
        await insertRecordings(db(), {
            id: "rec-free",
            userId: OWNER,
            deviceSn: "SN-1",
            plaudFileId: "plaud-free",
            filename: encryptText("Free"),
            duration: 5_000,
            startTime: new Date("2026-09-01T11:00:00Z"),
            endTime: new Date("2026-09-01T11:00:05Z"),
            filesize: 11,
            fileMd5: "1".repeat(32),
            storageType: "local",
            storagePath: `${OWNER}/free.mp3`,
            plaudVersion: "1",
            summaryDueAt: new Date(Date.now() + AUTO_LEARN_HOLD_MS + 1_000),
        });

        // A batch of one.
        expect(await sweepAutoLearnHolds(new Date(), 1)).toBe(1);
        const [free] = await db()
            .select({ at: chatterItems.summaryDueAt })
            .from(chatterItems)
            .where(eq(chatterItems.id, "rec-free"));
        expect(free?.at).toBeNull();
        expect(await dueAt()).not.toBeNull();
    });

    it("never lets an expired sweep release a hold that was renewed", async () => {
        await hold();
        const later = new Date(Date.now() + AUTO_LEARN_HOLD_MS + 60_000);
        // Renewed after the sweep read it as due.
        expect(
            await releaseAutoLearnHold(REC, {
                expired: true,
                now: new Date(Date.now() + 60_000),
            }),
        ).toBe(false);
        expect(await dueAt()).not.toBeNull();
        expect(
            await releaseAutoLearnHold(REC, { expired: true, now: later }),
        ).toBe(true);
    });

    it("lets the sweep release a hold whose run's job died, without waiting 72 h", async () => {
        await hold();
        const [job] = await db()
            .insert(asyncJobs)
            .values({
                userId: OWNER,
                kind: "learn.run",
                subjectId: "gone",
                status: "failed",
            })
            .returning({ id: asyncJobs.id });
        const dead = await run("running");
        await db()
            .update(learnRuns)
            .set({ jobId: job?.id ?? "" })
            .where(eq(learnRuns.id, dead));

        expect(await sweepAutoLearnHolds(new Date())).toBe(1);
        expect(await dueAt()).toBeNull();
    });

    it("releases when the run's job died, however its row reads", async () => {
        await hold();
        const [job] = await db()
            .insert(asyncJobs)
            .values({
                userId: OWNER,
                kind: "learn.run",
                subjectId: "other",
                status: "failed",
            })
            .returning({ id: asyncJobs.id });
        const dead = await run("running");
        await db()
            .update(learnRuns)
            .set({ jobId: job?.id ?? "" })
            .where(eq(learnRuns.id, dead));

        expect(await releaseAutoLearnHold(REC)).toBe(true);
    });

    it("drops the hold when a new Riffado transcript is written, not a Plaud one", async () => {
        await hold();
        const rewrite = (source: "riffado" | "plaud") =>
            upsertTranscription({
                userId: OWNER,
                recordingId: REC,
                text: "Ahoj všem.",
                detectedLanguage: "cs",
                source,
                provider: "openai",
                model: "gpt-4o-transcribe-diarize",
                turns: [
                    {
                        speaker: "speaker_0",
                        startMs: 0,
                        endMs: 5_000,
                        text: "Ahoj všem.",
                    },
                ],
            });

        await rewrite("plaud");
        expect(await dueAt()).not.toBeNull();
        await rewrite("riffado");
        expect(await dueAt()).toBeNull();
        // The transcript write durably requests the pipeline in its transaction.
        expect(await kinds()).toEqual(["pipeline.advance"]);
    });

    it("makes the summary again where the one there was made from an older reading", async () => {
        await hold();
        await db()
            .insert(aiEnhancements)
            .values({
                itemId: REC,
                userId: OWNER,
                transcriptionId: riffadoId,
                summary: encryptText("Made before the review."),
                provider: "openai",
                model: "gpt-test",
                source: "riffado",
                inputFingerprint: "an-older-reading",
            });

        expect(await releaseAutoLearnHold(REC)).toBe(true);
        await runAdvance();

        expect(await kinds()).toEqual(["summary", "title.generate", "topics"]);
    });

    it("queues what waited for when the hourly limit opens again, rather than dropping it", async () => {
        for (let i = 0; i < 20; i++) {
            await consumeRateLimitBucket(`auto-summary:user:${OWNER}`, {
                limit: 20,
                windowMs: 60 * 60 * 1000,
            });
        }
        await hold();

        expect(await releaseAutoLearnHold(REC)).toBe(true);
        await runAdvance();

        const [summary] = await db()
            .select({ nextAttemptAt: asyncJobs.nextAttemptAt })
            .from(asyncJobs)
            .where(eq(asyncJobs.kind, "summary"));
        expect(summary?.nextAttemptAt.getTime()).toBeGreaterThan(
            Date.now() + 30 * 60 * 1000,
        );
    });

    it("waits for the other transcript's topics job, spending the caps once", async () => {
        await db().delete(apiRateLimitBuckets);
        await enqueueTopicsJob({
            userId: OWNER,
            recordingId: REC,
            source: "plaud",
            trigger: "auto",
        });
        await hold();
        expect(await releaseAutoLearnHold(REC)).toBe(true);

        // Put off while the Plaud topics are detected, twice.
        await expect(runAdvance()).rejects.toBeInstanceOf(JobDeferredError);
        await expect(runAdvance()).rejects.toBeInstanceOf(JobDeferredError);
        await db().delete(asyncJobs).where(eq(asyncJobs.kind, "topics"));
        await runAdvance();

        expect(await kinds()).toEqual(["summary", "title.generate", "topics"]);
        const [topics] = await db()
            .select({ payload: asyncJobs.payload })
            .from(asyncJobs)
            .where(eq(asyncJobs.kind, "topics"));
        expect(topics?.payload.source).toBe("riffado");
        for (const cap of ["auto-summary", "auto-topics"]) {
            const next = await consumeRateLimitBucket(`${cap}:user:${OWNER}`, {
                limit: 20,
                windowMs: 60 * 60 * 1000,
            });
            // The release's one, and this one.
            expect(next.remaining).toBe(18);
        }
    });

    it("keeps a summary the person made while it waited", async () => {
        await hold();
        await db()
            .insert(aiEnhancements)
            .values({
                itemId: REC,
                userId: OWNER,
                summary: encryptText("Their own summary."),
                provider: "openai",
                model: "gpt-test",
                source: "riffado",
            });

        expect(await releaseAutoLearnHold(REC)).toBe(true);
        await runAdvance();

        expect(await kinds()).toEqual(["title.generate", "topics"]);
        const summaries = await db()
            .select({ id: aiEnhancements.id })
            .from(aiEnhancements)
            .where(
                and(
                    eq(aiEnhancements.itemId, REC),
                    eq(aiEnhancements.userId, OWNER),
                ),
            );
        expect(summaries).toHaveLength(1);
    });

    it("takes the release path when Learn settles before the hold is set", async () => {
        vi.spyOn(learnJob, "startLearnRun").mockResolvedValueOnce({
            runId: "settled-before-hold",
            jobId: null,
            created: true,
        });
        const summary = vi.spyOn(autoSummary, "queueAutoSummary");
        const topics = vi.spyOn(topicsQueue, "queueAutoTopics");
        const title = vi.spyOn(titleQueue, "enqueueTitleJob");

        expect(
            await startAutomaticLearn({
                userId: OWNER,
                itemId: REC,
                source: "riffado",
                timed: true,
            }),
        ).toEqual({ status: "started" });
        expect(await dueAt()).toBeNull();
        expect(await kinds()).toEqual(["pipeline.advance"]);

        await runAdvance();

        expect(summary).toHaveBeenCalledOnce();
        expect(summary).toHaveBeenCalledWith(OWNER, REC, null, {
            strict: true,
        });
        expect(topics).toHaveBeenCalledOnce();
        expect(topics).toHaveBeenCalledWith(OWNER, REC, "riffado", {
            strict: true,
        });
        expect(title).toHaveBeenCalledOnce();
        expect(await kinds()).toEqual(["summary", "title.generate", "topics"]);
    });

    it("drains a learn.release job queued before the pipeline deploy", async () => {
        await db()
            .insert(asyncJobs)
            .values({
                userId: OWNER,
                kind: "learn.release",
                subjectId: REC,
                payload: { recordingId: REC },
                maxAttempts: 5,
            });

        await runLegacyRelease();
        expect(await kinds()).toEqual(["pipeline.advance"]);

        await runAdvance();
        expect(await kinds()).toEqual(["summary", "title.generate", "topics"]);
    });

    describe("the title job", () => {
        const runTitle = () =>
            titleJobHandler.run({
                jobId: "job-1",
                userId: OWNER,
                payload: { recordingId: REC },
                attempt: 1,
                maxAttempts: 3,
                signal: new AbortController().signal,
                reportProgress: vi.fn(),
            } as unknown as Parameters<typeof titleJobHandler.run>[0]);
        const title = async () =>
            decryptText(
                (
                    await db()
                        .select({ filename: chatterItems.title })
                        .from(chatterItems)
                        .where(eq(chatterItems.id, REC))
                )[0]?.filename ?? "",
            );

        it("names the recording from its transcript and says so with recording.updated", async () => {
            vi.mocked(emitEvent).mockClear();

            expect(await runTitle()).toEqual({ retitled: true });

            expect(await title()).toBe("Held title");
            expect(emitEvent).toHaveBeenCalledWith(
                "recording.updated",
                OWNER,
                REC,
            );
        });

        it("waits while a newer hold is on the recording", async () => {
            await hold();
            expect(await runTitle()).toEqual({ skipped: "held" });
            expect(await title()).toBe("Weekly");
        });

        it("keeps a title the person set while it waited", async () => {
            await db()
                .update(chatterItems)
                .set({
                    title: encryptText("Their name"),
                    titleEditedAt: new Date(),
                })
                .where(eq(chatterItems.id, REC));
            vi.mocked(emitEvent).mockClear();

            expect(await runTitle()).toEqual({ retitled: false });

            expect(await title()).toBe("Their name");
            expect(emitEvent).not.toHaveBeenCalled();
        });
    });
});
