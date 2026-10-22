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
    asyncJobs,
    chatterItems,
    itemProcessing,
    recordings,
    transcriptCorrectionPasses,
    transcriptions,
    users,
} from "@/db/schema";
import type { StepOutcome } from "@/lib/pipeline/outcome";
import { markLearnReleasedInTx } from "@/lib/pipeline/state";
import type {
    PhaseName,
    PipelinePhases,
    SummaryStepName,
} from "@/lib/pipeline/types";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbRef, dbProxy } = vi.hoisted(() => {
    const dbRef: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    return {
        dbRef,
        dbProxy: new Proxy(
            {},
            {
                get: (_, key) => {
                    if (!dbRef.current) throw new Error("database not ready");
                    const value = dbRef.current[key];
                    return typeof value === "function"
                        ? value.bind(dbRef.current)
                        : value;
                },
            },
        ),
    };
});
vi.mock("@/db", () => ({ db: dbProxy }));

vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));
vi.mock("@/lib/env", () => ({
    env: { DATABASE_URL: "postgres://unused", IS_HOSTED: false },
}));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async () => ({ user: { id: "owner-veln" } }),
}));
vi.mock("@/lib/profiles/resolve", () => ({
    resolveItemProfile: async () => ({
        settings: { steps: { learn: { automatic: false } } },
    }),
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: () => {} }));

import { POST as retryProcessing } from "@/app/api/recordings/[id]/process-again/route";

import {
    buryExhaustedStaleJobs,
    claimDueJobs,
    completeJob,
    enqueueJob,
    failJobAttempt,
    getJobForUser,
    prepareClaimedPipelineJob,
    pruneFinishedJobs,
    reclaimStaleJobs,
} from "@/db/queries/async-jobs";
import { settlePipelineBindingInTx } from "@/db/queries/pipeline-jobs";
import { reconcilePipelineSteps } from "@/db/queries/pipeline-reconciler";

const url = getTestDatabaseUrl();
const owner = "owner-veln";
const other = "owner-tavro";
const at = "2026-10-01T00:00:00.000Z";
const input = {
    contentId: "content-veln",
    contentSourceId: "mail",
    contentRevision: 1,
};

(url ? describe : describe.skip)(
    "#221 atomic pipeline settlement and invariant reconciliation",
    () => {
        let database: TestPostgresDatabase;
        const db = () => database.db;
        beforeAll(async () => {
            database = await createMigratedTestDatabase(
                url ?? "",
                "pipeline_settlement_221",
            );
            dbRef.current = database.db as unknown as Record<
                PropertyKey,
                unknown
            >;
        }, 120_000);
        afterAll(async () => {
            dbRef.current = null;
            await database?.dispose();
        }, 30_000);
        beforeEach(async () => {
            await db().delete(users);
            await db()
                .insert(users)
                .values(
                    [owner, other].map((id) => ({
                        id,
                        email: `${id}@example.test`,
                    })),
                );
        });
        async function seed(
            itemId = "item-veln",
            userId = owner,
            phases: PipelinePhases = {},
        ) {
            await db()
                .insert(chatterItems)
                .values({
                    id: itemId,
                    userId,
                    kind: "mail",
                    title: "Fictional planning note",
                    occurredAt: new Date(at),
                });
            await db().insert(itemProcessing).values({
                itemId,
                userId,
                view: "private",
                phases,
                requestedGeneration: 1,
            });
        }
        async function stored(itemId = "item-veln", userId = owner) {
            const [row] = await db()
                .select()
                .from(itemProcessing)
                .where(
                    and(
                        eq(itemProcessing.itemId, itemId),
                        eq(itemProcessing.userId, userId),
                        eq(itemProcessing.view, "private"),
                    ),
                );
            return row;
        }
        async function queue(
            phase: PhaseName = "learn",
            step?: SummaryStepName,
            trigger: "auto" | "manual" = "auto",
        ) {
            return enqueueJob({
                userId: owner,
                kind: "test.pipeline",
                subjectId: "item-veln",
                payload: { trigger },
                pipeline: {
                    itemId: "item-veln",
                    userId: owner,
                    phase,
                    ...(step
                        ? {
                              step,
                              record: {
                                  state: "pending",
                                  generation: 1,
                                  at,
                                  inputs: input,
                              },
                          }
                        : {}),
                    existingOnly: trigger === "manual",
                },
            });
        }
        async function claim() {
            return (await claimDueJobs("test.pipeline", 1))[0];
        }
        async function terminalWithoutSettlement(
            jobId: string,
            result: Record<string, unknown> = {},
        ) {
            await db()
                .update(asyncJobs)
                .set({ status: "completed", result, completedAt: new Date(at) })
                .where(
                    and(eq(asyncJobs.id, jobId), eq(asyncJobs.userId, owner)),
                );
        }
        async function age(jobId: string) {
            await db()
                .update(asyncJobs)
                .set({ heartbeatAt: new Date(Date.now() - 121_000) })
                .where(
                    and(eq(asyncJobs.id, jobId), eq(asyncJobs.userId, owner)),
                );
        }

        it("rolls back the inserted job and running binding together", async () => {
            await seed();
            await expect(
                db().transaction(async (tx) => {
                    await enqueueJob(
                        {
                            userId: owner,
                            kind: "test.pipeline",
                            pipeline: {
                                itemId: "item-veln",
                                userId: owner,
                                phase: "learn",
                            },
                        },
                        tx,
                    );
                    throw new Error("forced failure after insert");
                }),
            ).rejects.toThrow("forced failure after insert");
            expect((await stored()).phases).toEqual({});
            expect(await db().select().from(asyncJobs)).toEqual([]);
            const queued = await queue();
            expect((await stored()).phases.learn).toMatchObject({
                state: "running",
                jobId: queued.job.id,
                generation: 1,
            });
        });

        it.each<StepOutcome>([
            { kind: "done" },
            { kind: "skipped", reason: "held" },
            { kind: "skipped", reason: "shared" },
            { kind: "skipped", reason: "outdated" },
            {
                kind: "waiting",
                waitingFor: {
                    kind: "learnReview",
                    until: "2099-01-01T00:00:00.000Z",
                },
            },
            { kind: "failed", code: "lost", retryable: true },
        ])("stores the $kind outcome on the step in the terminal transaction", async (outcome) => {
            await seed();
            await queue();
            const job = await claim();
            expect(
                await completeJob({
                    jobId: job.id,
                    claimToken: job.claimToken,
                    result: { outcome },
                }),
            ).toBe(true);
            expect((await stored()).phases.learn).toMatchObject({
                state: outcome.kind,
                outcome,
            });
            expect((await getJobForUser(job.id, owner))?.status).toBe(
                outcome.kind === "failed" ? "failed" : "completed",
            );
            expect(await pruneFinishedJobs(0, 10)).toBe(1);
            expect((await stored()).phases.learn?.outcome).toEqual(outcome);
        });

        it.each([
            { state: "skipped", reason: "held", binds: true },
            { state: "outdated", reason: "content_changed", binds: true },
            { state: "done", reason: "generated", binds: false },
        ] as const)("binds an eligible title with its summary after $reason", async ({
            state,
            reason,
            binds,
        }) => {
            await seed("item-veln", owner, {
                summary: {
                    state: "pending",
                    generation: 1,
                    at,
                    inputs: input,
                    steps: {
                        title: { ...input, state, reason, generation: 7 },
                    },
                },
            });
            const queued = await enqueueJob({
                userId: owner,
                kind: "summary",
                subjectId: "item-veln",
                payload: { recordingId: "item-veln", trigger: "auto" },
                pipeline: {
                    itemId: "item-veln",
                    userId: owner,
                    phase: "summary",
                    step: "summary",
                    record: {
                        state: "pending",
                        generation: 1,
                        at,
                        inputs: input,
                    },
                },
            });
            expect((await stored()).phases.summary?.steps?.title?.jobId).toBe(
                binds ? queued.job.id : undefined,
            );
            expect(
                (await stored()).phases.summary?.steps?.title?.generation,
            ).toBe(binds ? 8 : 7);
            const [job] = await claimDueJobs("summary", 1);
            expect(
                await completeJob({
                    jobId: job.id,
                    claimToken: job.claimToken,
                    result: {
                        outcome: { kind: "done" },
                        titleOutcome: { kind: "done" },
                    },
                }),
            ).toBe(true);
            expect((await stored()).phases.summary?.steps?.title?.state).toBe(
                "done",
            );
        });

        it("defers an early correction claim until its Learn predecessor settles without consuming an attempt", async () => {
            await seed();
            await db()
                .update(chatterItems)
                .set({ kind: "audio" })
                .where(
                    and(
                        eq(chatterItems.id, "item-veln"),
                        eq(chatterItems.userId, owner),
                    ),
                );
            await db()
                .insert(recordings)
                .values({
                    id: "item-veln",
                    userId: owner,
                    deviceSn: "device-veln",
                    plaudFileId: "file-veln",
                    duration: 1000,
                    endTime: new Date(at),
                    filesize: 1,
                    fileMd5: "0".repeat(32),
                    storageType: "local",
                    storagePath: "fixture.mp3",
                    plaudVersion: "1",
                });
            await db().insert(transcriptions).values({
                id: "transcript-veln",
                userId: owner,
                recordingId: "item-veln",
                text: "Fictional note",
                provider: "fixture",
                model: "fixture",
            });
            const [pass] = await db()
                .insert(transcriptCorrectionPasses)
                .values({
                    userId: owner,
                    scopeUserId: owner,
                    recordingId: "item-veln",
                    transcriptionId: "transcript-veln",
                    transcriptRevision: 0,
                    view: "private",
                    actorUserId: owner,
                })
                .returning();
            await queue();
            const predecessor = await claim();
            const correction = await enqueueJob({
                userId: owner,
                kind: "learn.correct",
                subjectId: "item-veln",
                payload: { passId: pass.id },
            });
            const [early] = await claimDueJobs("learn.correct", 1);
            expect(
                await prepareClaimedPipelineJob(early.id, early.claimToken),
            ).toBe(false);
            expect(await getJobForUser(correction.job.id, owner)).toMatchObject(
                { status: "pending", attempts: 0, claimToken: null },
            );
            expect((await stored()).phases.learn?.jobId).toBe(predecessor.id);
            expect(
                await completeJob({
                    jobId: predecessor.id,
                    claimToken: predecessor.claimToken,
                    result: { outcome: { kind: "done" } },
                }),
            ).toBe(true);
            expect((await stored()).phases.learn?.jobId).toBe(
                correction.job.id,
            );
            await db()
                .update(asyncJobs)
                .set({ nextAttemptAt: new Date(Date.now() - 1) })
                .where(
                    and(
                        eq(asyncJobs.id, correction.job.id),
                        eq(asyncJobs.userId, owner),
                    ),
                );
            const [ready] = await claimDueJobs("learn.correct", 1);
            expect(
                await prepareClaimedPipelineJob(ready.id, ready.claimToken),
            ).toBe(true);
            expect(
                await completeJob({
                    jobId: ready.id,
                    claimToken: ready.claimToken,
                    result: { outcome: { kind: "done" } },
                }),
            ).toBe(true);
            expect((await stored()).phases.learn?.state).toBe("done");
        });

        it("retains a failed Learn outcome when post-settle hold cleanup requests release", async () => {
            await seed("item-veln", owner, {
                learn: { state: "pending", generation: 1, at, inputs: input },
            });
            await queue();
            const job = await claim();
            await completeJob({
                jobId: job.id,
                claimToken: job.claimToken,
                result: {
                    outcome: { kind: "failed", code: "lost", retryable: true },
                },
            });
            const failed = await stored();
            expect(
                await db().transaction((tx) =>
                    markLearnReleasedInTx(tx, {
                        itemId: "item-veln",
                        userId: owner,
                        generation: failed.requestedGeneration + 1,
                    }),
                ),
            ).toBe(false);
            expect((await stored()).phases).toEqual(failed.phases);
        });

        it("adopts a job queued before bindings were introduced under its current claim", async () => {
            await seed("item-veln", owner, {
                transcribe: {
                    state: "running",
                    automatic: true,
                    generation: 1,
                    at,
                },
            });
            const [legacy] = await db()
                .insert(asyncJobs)
                .values({
                    userId: owner,
                    kind: "transcription",
                    subjectId: "item-veln",
                    payload: { recordingId: "item-veln", trigger: "pipeline" },
                })
                .returning();
            const [claimed] = await claimDueJobs("transcription", 1);
            expect(
                await prepareClaimedPipelineJob(legacy.id, "old-claim"),
            ).toBe(false);
            expect((await stored()).phases.transcribe?.jobId).toBeUndefined();
            expect(
                await prepareClaimedPipelineJob(legacy.id, claimed.claimToken),
            ).toBe(true);
            expect((await stored()).phases.transcribe).toMatchObject({
                state: "running",
                jobId: legacy.id,
                generation: 2,
            });
            expect(
                await completeJob({
                    jobId: legacy.id,
                    claimToken: claimed.claimToken,
                    result: { outcome: { kind: "done" } },
                }),
            ).toBe(true);
            expect((await stored()).phases.transcribe?.state).toBe("done");
        });

        it("authorizes a curator's job through the owner binding and skips its held lock", async () => {
            await seed();
            const queued = await enqueueJob({
                userId: other,
                kind: "test.curator",
                pipeline: {
                    itemId: "item-veln",
                    userId: owner,
                    phase: "learn",
                },
            });
            await db()
                .update(asyncJobs)
                .set({
                    status: "completed",
                    result: { outcome: { kind: "done" } },
                    completedAt: new Date(),
                })
                .where(
                    and(
                        eq(asyncJobs.id, queued.job.id),
                        eq(asyncJobs.userId, other),
                    ),
                );
            let unlock = () => {};
            let locked = () => {};
            const gate = new Promise<void>((resolve) => {
                unlock = resolve;
            });
            const acquired = new Promise<void>((resolve) => {
                locked = resolve;
            });
            const holder = db().transaction(async (tx) => {
                await tx
                    .select()
                    .from(asyncJobs)
                    .where(
                        and(
                            eq(asyncJobs.id, queued.job.id),
                            eq(asyncJobs.userId, other),
                        ),
                    )
                    .for("update");
                locked();
                await gate;
            });
            try {
                await acquired;
                expect(await reconcilePipelineSteps()).toBe(0);
                expect((await stored()).phases.learn?.state).toBe("running");
            } finally {
                unlock();
                await holder;
            }
            expect(await reconcilePipelineSteps()).toBe(1);
            expect((await stored()).phases.learn?.state).toBe("done");
        });

        it("rolls back the job completion when writing the step fails", async () => {
            await seed();
            await queue();
            const job = await claim();
            await database.sql`create function reject_phase_update() returns trigger language plpgsql as $$ begin raise exception 'forced step write failure'; end $$`;
            await database.sql`create trigger reject_phase before update on item_processing for each row execute function reject_phase_update()`;
            try {
                await expect(
                    completeJob({ jobId: job.id, claimToken: job.claimToken }),
                ).rejects.toThrow();
                expect((await getJobForUser(job.id, owner))?.status).toBe(
                    "processing",
                );
                expect((await stored()).phases.learn?.state).toBe("running");
            } finally {
                await database.sql`drop trigger reject_phase on item_processing`;
                await database.sql`drop function reject_phase_update()`;
            }
        });

        it("rejects a stale claim and an older step generation without changing either row", async () => {
            await seed();
            await queue();
            const job = await claim();
            expect(
                await completeJob({ jobId: job.id, claimToken: "old-claim" }),
            ).toBe(false);
            const current = await stored();
            await db()
                .update(itemProcessing)
                .set({
                    phases: {
                        learn: {
                            ...current.phases.learn,
                            state: "running",
                            generation: 9,
                            at,
                        },
                    },
                })
                .where(
                    and(
                        eq(itemProcessing.itemId, "item-veln"),
                        eq(itemProcessing.userId, owner),
                    ),
                );
            expect(
                await completeJob({
                    jobId: job.id,
                    claimToken: job.claimToken,
                }),
            ).toBe(false);
            await age(job.id);
            expect(await buryExhaustedStaleJobs(120_000)).toBe(0);
            expect((await stored()).phases.learn?.generation).toBe(9);
            expect((await getJobForUser(job.id, owner))?.status).toBe(
                "processing",
            );
        });

        it.each([
            "summary",
            "topics",
            "title",
        ] as const)("recovers completed %s jobs without inferring failure from timestamps", async (step) => {
            await seed();
            const queued = await queue("summary", step);
            await terminalWithoutSettlement(queued.job.id, {
                outcome: { kind: "done" },
            });
            expect(await reconcilePipelineSteps()).toBe(1);
            expect(
                (await stored()).phases.summary?.steps?.[step],
            ).toMatchObject({ state: "done", outcome: { kind: "done" } });
            expect(await reconcilePipelineSteps()).toBe(0);
        });

        it.each([
            "learn",
            "share",
            "transcribe",
        ] as const)("marks a missing %s job lost and allows a retry with a newer generation", async (phase) => {
            await seed();
            const queued = await queue(phase);
            const previous = (await stored()).phases[phase]?.generation ?? 0;
            await terminalWithoutSettlement(queued.job.id);
            expect(await pruneFinishedJobs(86_400_000, 10)).toBe(1);
            expect(await reconcilePipelineSteps()).toBe(1);
            expect((await stored()).phases[phase]).toMatchObject({
                state: "failed",
                reason: "lost",
                retryable: true,
            });
            const retried = await queue(phase, undefined, "manual");
            expect((await stored()).phases[phase]).toMatchObject({
                state: "running",
                jobId: retried.job.id,
            });
            expect((await stored()).phases[phase]?.generation).toBeGreaterThan(
                previous,
            );
        });

        it("buries a stale heartbeat and fails its step through the terminal path", async () => {
            await seed();
            await queue();
            const job = await claim();
            await age(job.id);
            expect(await reclaimStaleJobs(120_000)).toBe(0);
            const afterFailure = vi.fn(
                async (ended: {
                    id: string;
                    errorCode: string | null;
                    lastError: string | null;
                }) => {
                    expect(ended).toMatchObject({
                        id: job.id,
                        errorCode: "lost",
                        lastError: "Processing was interrupted",
                    });
                    expect((await getJobForUser(job.id, owner))?.status).toBe(
                        "failed",
                    );
                    expect((await stored()).phases.learn?.reason).toBe("lost");
                },
            );
            expect(
                await reconcilePipelineSteps(
                    undefined,
                    undefined,
                    undefined,
                    afterFailure,
                ),
            ).toBe(1);
            expect(afterFailure).toHaveBeenCalledOnce();
            expect((await getJobForUser(job.id, owner))?.status).toBe("failed");
            expect((await stored()).phases.learn).toMatchObject({
                state: "failed",
                reason: "lost",
                retryable: true,
            });
        });

        it("settles an exhausted stale job and a terminal attempt failure", async () => {
            await seed();
            await queue();
            const job = await claim();
            await db()
                .update(asyncJobs)
                .set({ attempts: 3, maxAttempts: 3 })
                .where(
                    and(eq(asyncJobs.id, job.id), eq(asyncJobs.userId, owner)),
                );
            await age(job.id);
            expect(await buryExhaustedStaleJobs(120_000)).toBe(1);
            expect((await stored()).phases.learn?.reason).toBe("lost");
            await queue();
            const retry = await claim();
            await failJobAttempt({
                jobId: retry.id,
                claimToken: retry.claimToken,
                message: "provider refused",
                code: "PROVIDER_FAILED",
                retryable: false,
                delayMs: 0,
            });
            expect((await stored()).phases.learn).toMatchObject({
                state: "failed",
                reason: "PROVIDER_FAILED",
                retryable: false,
            });
        });

        it("settles a manual job an automatic step deduplicates onto, including a job already claimed", async () => {
            await seed();
            const manual = await queue("learn", undefined, "manual");
            const claimed = await claim();
            expect((await stored()).phases).toEqual({});
            const automatic = await queue();
            expect(automatic.job.id).toBe(manual.job.id);
            expect((await stored()).phases.learn?.jobId).toBe(manual.job.id);
            await completeJob({
                jobId: claimed.id,
                claimToken: claimed.claimToken,
                result: { outcome: { kind: "done" } },
            });
            expect((await stored()).phases.learn?.state).toBe("done");
        });

        it("replans nameless work, leaves future waits alone, and replans expired waits", async () => {
            await seed("item-veln", owner, {
                learn: { state: "running", generation: 1, at },
                summary: {
                    state: "pending",
                    generation: 1,
                    at,
                    inputs: input,
                    steps: {
                        summary: { ...input, generation: 1, reason: "started" },
                    },
                },
                share: {
                    state: "waiting",
                    generation: 1,
                    at,
                    waitingFor: { kind: "shareConfirmation" },
                },
                taskReview: {
                    state: "waiting",
                    generation: 1,
                    at,
                    waitingFor: {
                        kind: "taskReview",
                        until: "2099-01-01T00:00:00.000Z",
                    },
                },
                transcribe: {
                    state: "waiting",
                    generation: 1,
                    at,
                    waitingFor: {
                        kind: "learnReview",
                        until: "2000-01-01T00:00:00.000Z",
                    },
                },
            });
            expect(await reconcilePipelineSteps()).toBe(3);
            expect(
                (await stored()).phases.summary?.steps?.summary,
            ).toBeUndefined();
            expect((await stored()).phases.share).toEqual({
                state: "waiting",
                generation: 1,
                at,
                waitingFor: { kind: "shareConfirmation" },
            });
            expect((await stored()).phases.taskReview?.waitingFor?.until).toBe(
                "2099-01-01T00:00:00.000Z",
            );
            expect((await stored()).requestedGeneration).toBeGreaterThan(1);
            expect(
                await db()
                    .select()
                    .from(asyncJobs)
                    .where(eq(asyncJobs.kind, "pipeline.advance")),
            ).toHaveLength(1);
        });

        it("claims Share and task actions fairly across users", async () => {
            for (const [itemId, userId] of [
                ["action-veln-one", owner],
                ["action-veln-two", owner],
                ["action-tavro", other],
            ]) {
                await seed(itemId, userId);
                await enqueueJob({
                    userId,
                    kind: "pipeline.action",
                    subjectId: itemId,
                    pipeline: { itemId, userId, phase: "share" },
                });
            }
            const claims = await claimDueJobs("pipeline.action", 2);
            expect(new Set(claims.map((job) => job.userId))).toEqual(
                new Set([owner, other]),
            );
            expect(await claimDueJobs("pipeline.action", 2)).toEqual([]);
        });

        it("takes bounded fair batches across users and concurrent reconcilers", async () => {
            const phases: PipelinePhases = {
                learn: {
                    state: "running",
                    generation: 1,
                    at,
                    jobId: "missing",
                },
            };
            for (let i = 0; i < 12; i++) await seed(`bulk-${i}`, owner, phases);
            await seed("other-item", other, phases);
            const results = await Promise.all([
                reconcilePipelineSteps(4, 2),
                reconcilePipelineSteps(4, 2),
            ]);
            expect(results.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(5);
            expect(
                (await stored("other-item", other)).phases.learn?.state,
            ).toBe("failed");
            expect(
                (await db().select().from(itemProcessing)).filter(
                    (row) =>
                        row.userId === owner &&
                        row.phases.learn?.state === "running",
                ).length,
            ).toBeGreaterThanOrEqual(8);
        });

        it("reconciles the owner's driver on a shared item and leaves the org view untouched", async () => {
            await seed();
            const queued = await queue("summary", "summary");
            const phases = (await stored()).phases;
            await db().insert(itemProcessing).values({
                itemId: "item-veln",
                userId: owner,
                view: "org",
                phases,
            });
            await terminalWithoutSettlement(queued.job.id, {
                skipped: "shared",
            });
            expect(await reconcilePipelineSteps()).toBe(1);
            expect(
                (await stored()).phases.summary?.steps?.summary,
            ).toMatchObject({ state: "skipped", reason: "shared" });
            const [org] = await db()
                .select()
                .from(itemProcessing)
                .where(
                    and(
                        eq(itemProcessing.itemId, "item-veln"),
                        eq(itemProcessing.userId, owner),
                        eq(itemProcessing.view, "org"),
                    ),
                );
            expect(org.phases).toEqual(phases);
        });

        it("retries a lost Share step through the existing processing action even on a manual profile", async () => {
            await seed("item-veln", owner, {
                share: {
                    state: "running",
                    generation: 1,
                    at,
                    jobId: "missing",
                },
            });
            await reconcilePipelineSteps();
            const response = await retryProcessing(
                new Request(
                    "http://localhost/api/recordings/item-veln/process-again",
                    { method: "POST" },
                ),
                { params: Promise.resolve({ id: "item-veln" }) },
            );
            expect(response.status).toBe(200);
            expect((await stored()).phases.share).toBeUndefined();
            expect(
                await db()
                    .select()
                    .from(asyncJobs)
                    .where(eq(asyncJobs.kind, "pipeline.advance")),
            ).toHaveLength(1);
        });

        it("fences a direct reconciliation settle against the owner and job generation", async () => {
            await seed();
            const queued = await queue();
            expect(
                await db().transaction((tx) =>
                    settlePipelineBindingInTx(
                        tx,
                        {
                            itemId: "item-veln",
                            userId: other,
                            phase: "learn",
                            generation: 2,
                        },
                        queued.job.id,
                        { kind: "done" },
                    ),
                ),
            ).toBe(false);
            expect((await stored()).phases.learn?.state).toBe("running");
        });
    },
);
