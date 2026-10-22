/**
 * Queue operations for `async_jobs`.
 *
 * Every statement that a worker uses to change a job it is running is scoped
 * to the claim token it holds, so a job reclaimed out from under a stalled
 * worker cannot then be corrupted by that worker's late write -- it simply
 * matches zero rows. See `asyncJobs.claimToken` in the schema.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
    bindAvailableCorrectionInTx,
    bindPipelineJobInTx,
    jobBindings,
    type PipelineJobTarget,
    settlePipelineBindingInTx,
    terminalStepOutcome,
    wakePipelineInTx,
} from "@/db/queries/pipeline-jobs";
import {
    asyncJobs,
    chatterItems,
    itemProcessing,
    learnRuns,
    transcriptCorrectionPasses,
} from "@/db/schema";
import type { StepOutcome } from "@/lib/pipeline/outcome";

export type AsyncJobStatus = "pending" | "processing" | "completed" | "failed";

export interface AsyncJobRow {
    id: string;
    userId: string;
    kind: string;
    subjectId: string | null;
    priority: number;
    payload: Record<string, unknown>;
    status: AsyncJobStatus;
    attempts: number;
    maxAttempts: number;
    nextAttemptAt: Date;
    claimToken: string | null;
    progress: Record<string, unknown> | null;
    result: Record<string, unknown> | null;
    lastError: string | null;
    errorCode: string | null;
    heartbeatAt: Date | null;
    createdAt: Date;
    startedAt: Date | null;
    completedAt: Date | null;
    updatedAt: Date;
}

/** A claimed job as the worker sees it: the row plus the token that owns it. */
export interface ClaimedAsyncJob {
    id: string;
    userId: string;
    kind: string;
    subjectId: string | null;
    payload: Record<string, unknown>;
    attempts: number;
    maxAttempts: number;
    claimToken: string;
}

/**
 * A job still to be finished. Also the predicate of `async_jobs_active_unique`,
 * which `enqueueJob` names as its conflict target, so the two must match.
 */
function isActive() {
    return sql`${asyncJobs.status} in ('pending', 'processing')`;
}

/**
 * A queued job that finishes between a conflicting insert and the read that
 * follows it leaves nothing to return; the next insert then succeeds. More
 * than a couple of such races in a row means something else is wrong.
 */
const ENQUEUE_ATTEMPTS = 3;

/**
 * `db.execute` returns an array on some drivers and `{ rows }` on others.
 * Normalising here keeps every call site below from repeating the check.
 */
function rowsOf<T>(result: unknown): T[] {
    if (Array.isArray(result)) return result as T[];
    return ((result as { rows?: T[] })?.rows ?? []) as T[];
}

type EnqueueExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface EnqueueJobInput {
    userId: string;
    kind: string;
    pipeline?: PipelineJobTarget;
    /** Domain object this job acts on. Enforces one live job per subject. */
    subjectId?: string | null;
    /** Higher runs first. */
    priority?: number;
    payload?: Record<string, unknown>;
    maxAttempts?: number;
    /** Delay before the job first becomes claimable. */
    delayMs?: number;
    /**
     * A job of this kind and subject queued to start later (an automatic
     * one a rate limit put off) is taken over by this one: it starts now,
     * as this caller asks. A person clicking does not wait for the window
     * a background job was waiting for. `payload` names the fields that
     * job's payload must share with this one (the same transcript): one
     * doing other work is left alone.
     */
    takeOverDelayed?: { payload?: Record<string, string> };
}

export interface EnqueueJobResult {
    job: AsyncJobRow;
    /**
     * False when an equivalent job was already queued or running and this
     * call returned that one instead. Callers that report "started" to a user
     * want to know the difference; callers that just want the work to happen
     * do not.
     */
    created: boolean;
}

/**
 * Queue a job, or hand back the one already queued for the same subject.
 *
 * The real "one live job per (kind, subject)" guard is the partial unique
 * index, not a check here: two requests racing the same check would both pass
 * it. When the insert loses that race this returns the winner, so a
 * double-clicked button and a single click are indistinguishable to the
 * caller instead of one of them erroring.
 *
 * The insert skips the conflict (`on conflict ... do nothing`) rather than
 * catching a unique violation: Postgres logs every violation as an ERROR,
 * and a click that joins a running job is not one.
 */
/**
 * Queue a job in the caller's transaction, so it exists exactly when what
 * it follows from commits. An active job of the same kind and subject
 * already does the work: nothing is inserted then, and false returned.
 */
export async function enqueueJobInTx(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    input: EnqueueJobInput,
): Promise<boolean> {
    const [row] = await tx
        .insert(asyncJobs)
        .values({
            userId: input.userId,
            kind: input.kind,
            subjectId: input.subjectId ?? null,
            priority: input.priority ?? 0,
            payload: input.payload ?? {},
            maxAttempts: input.maxAttempts ?? 3,
            nextAttemptAt: new Date(Date.now() + (input.delayMs ?? 0)),
        })
        .onConflictDoNothing({
            target: [asyncJobs.kind, asyncJobs.subjectId],
            where: isActive(),
        })
        .returning({ id: asyncJobs.id });
    return row !== undefined;
}

export async function enqueueJob(
    input: EnqueueJobInput,
    executor?: EnqueueExecutor,
): Promise<EnqueueJobResult> {
    if (!executor) return db.transaction((tx) => enqueueJob(input, tx));
    const bind = async (
        result: EnqueueJobResult,
    ): Promise<EnqueueJobResult> => {
        await bindPipelineJobInTx(
            executor as Parameters<Parameters<typeof db.transaction>[0]>[0],
            result.job,
            input.pipeline,
            input.payload?.trigger !== "manual",
        );
        return result;
    };
    const values = {
        userId: input.userId,
        kind: input.kind,
        subjectId: input.subjectId ?? null,
        priority: input.priority ?? 0,
        payload: input.payload ?? {},
        maxAttempts: input.maxAttempts ?? 3,
        nextAttemptAt: new Date(Date.now() + (input.delayMs ?? 0)),
    };

    for (let attempt = 0; attempt < ENQUEUE_ATTEMPTS; attempt++) {
        const [row] = await executor
            .insert(asyncJobs)
            .values(values)
            .onConflictDoNothing({
                target: [asyncJobs.kind, asyncJobs.subjectId],
                where: isActive(),
            })
            .returning();
        if (row) return bind({ job: row as AsyncJobRow, created: true });
        // Only a subject can conflict: NULLs are distinct in the index.
        if (!input.subjectId) break;
        if (input.takeOverDelayed) {
            const [taken] = await executor
                .update(asyncJobs)
                .set({
                    ...values,
                    payload: sql`case when ${asyncJobs.payload} -> 'pipelineSteps' is null then ${JSON.stringify(values.payload)}::jsonb else ${JSON.stringify(values.payload)}::jsonb || jsonb_build_object('pipelineSteps', ${asyncJobs.payload} -> 'pipelineSteps') end`,
                    nextAttemptAt: new Date(),
                })
                .where(
                    and(
                        eq(asyncJobs.userId, input.userId),
                        eq(asyncJobs.kind, input.kind),
                        eq(asyncJobs.subjectId, input.subjectId),
                        eq(asyncJobs.status, "pending"),
                        eq(asyncJobs.attempts, 0),
                        sql`${asyncJobs.nextAttemptAt} > clock_timestamp()`,
                        ...Object.entries(
                            input.takeOverDelayed.payload ?? {},
                        ).map(
                            ([key, value]) =>
                                sql`${asyncJobs.payload}->>${key} = ${value}`,
                        ),
                    ),
                )
                .returning();
            if (taken)
                return bind({ job: taken as AsyncJobRow, created: true });
        }
        const active = await getActiveJob(
            input.kind,
            input.subjectId,
            executor,
        );
        if (active && active.userId === input.userId) {
            const [locked] = await executor
                .select()
                .from(asyncJobs)
                .where(
                    and(
                        eq(asyncJobs.id, active.id),
                        eq(asyncJobs.userId, input.userId),
                        isActive(),
                    ),
                )
                .for("update")
                .limit(1);
            if (locked)
                return bind({ job: locked as AsyncJobRow, created: false });
        }
    }
    throw new Error(
        `Could not queue a ${input.kind} job for ${input.subjectId ?? "no subject"}`,
    );
}

/**
 * How many jobs of a kind a rate limit put off for a user and have not
 * passed the cap yet (payload `rateLimited`, never attempted: a deferral
 * refunds its attempt): the backlog the next ones queue behind. One that
 * passed it, running or waiting out a retry, needs no window any more.
 */
export async function countRateLimitedJobs(
    userId: string,
    kind: string,
): Promise<number> {
    const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(asyncJobs)
        .where(
            and(
                eq(asyncJobs.userId, userId),
                eq(asyncJobs.kind, kind),
                eq(asyncJobs.status, "pending"),
                eq(asyncJobs.attempts, 0),
                sql`${asyncJobs.payload}->>'rateLimited' = 'true'`,
            ),
        );
    return row?.count ?? 0;
}

/**
 * When a rate-limited automatic job may start: when the window opens again,
 * behind the backlog already waiting, `limit` of it per window. The jobs
 * themselves do not count against the cap, so without the spread a
 * released backlog would all start together at the window's edge.
 */
export function delayBehindBacklog(input: {
    resetAt: Date;
    backlog: number;
    limit: number;
    windowMs: number;
}): number {
    const windows = Math.floor(input.backlog / Math.max(1, input.limit));
    return (
        Math.max(0, input.resetAt.getTime() - Date.now()) +
        windows * input.windowMs
    );
}

/** The pending-or-processing job for a subject, if there is one. */
export async function getActiveJob(
    kind: string,
    subjectId: string,
    executor: Pick<typeof db, "select"> = db,
): Promise<AsyncJobRow | null> {
    const [row] = await executor
        .select()
        .from(asyncJobs)
        .where(
            and(
                eq(asyncJobs.kind, kind),
                eq(asyncJobs.subjectId, subjectId),
                isActive(),
            ),
        )
        .limit(1);
    return (row as AsyncJobRow) ?? null;
}

/**
 * Most recent job for a subject regardless of status, scoped to its owner.
 *
 * Used when a client reattaches: a page reloaded after the work finished
 * needs to learn that it finished (and how), not just that nothing is
 * running.
 */
export async function getLatestJobForSubject(
    kind: string,
    subjectId: string,
    userId: string,
): Promise<AsyncJobRow | null> {
    const [row] = await db
        .select()
        .from(asyncJobs)
        .where(
            and(
                eq(asyncJobs.kind, kind),
                eq(asyncJobs.subjectId, subjectId),
                eq(asyncJobs.userId, userId),
            ),
        )
        .orderBy(desc(asyncJobs.createdAt))
        .limit(1);
    return (row as AsyncJobRow) ?? null;
}

/** One job by id, scoped to its owner so an id alone grants nothing. */
export async function getJobForUser(
    jobId: string,
    userId: string,
): Promise<AsyncJobRow | null> {
    const [row] = await db
        .select()
        .from(asyncJobs)
        .where(and(eq(asyncJobs.id, jobId), eq(asyncJobs.userId, userId)))
        .limit(1);
    return (row as AsyncJobRow) ?? null;
}

/**
 * Atomically claim up to `limit` due jobs of one kind.
 *
 * A single `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`, so
 * two worker processes ticking at the same moment can never both take the
 * same job. Claiming per kind (rather than taking whatever is oldest) is
 * what lets each kind carry its own concurrency: the summary handler runs
 * one job at a time because three parallel passes already saturate the agent
 * bridge, while a cheaper kind can run several.
 *
 * `heartbeat_at` is seeded at claim time so a job that dies before its
 * handler reports anything is still reclaimable on the normal schedule.
 *
 * `attempts` is incremented HERE, at claim time, not when an attempt fails.
 * That is the difference between bounding retries and bounding only the
 * failures a worker survived long enough to report: a job that kills its
 * process -- an OOM on a huge transcript, say -- never reaches any failure
 * path, so an increment on failure would let it be reclaimed and crash the
 * container again forever. Counting the attempt when it starts means such a
 * job runs `max_attempts` times and is then buried.
 */
export async function claimDueJobs(
    kind: string,
    limit: number,
): Promise<ClaimedAsyncJob[]> {
    if (limit <= 0) return [];
    const result =
        kind === "pipeline.advance" || kind === "pipeline.action"
            ? await db.execute(sql`
        with eligible_users as (
            select
                queued.user_id,
                min(queued.next_attempt_at) as oldest_waiting
            from ${asyncJobs} queued
            where queued.status = 'pending'
              and queued.kind = ${kind}
              and queued.next_attempt_at <= now()
              and not exists (
                  select 1
                  from ${asyncJobs} running
                  where running.kind = ${kind}
                    and running.user_id = queued.user_id
                    and running.status = 'processing'
              )
            group by queued.user_id
            order by oldest_waiting asc
        ), locked_users as (
            select user_id, oldest_waiting
            from eligible_users
            where pg_try_advisory_xact_lock(
                hashtext(${`riffado:${kind}`}),
                hashtext(user_id)
            )
            order by oldest_waiting asc
            limit ${limit}
        ), picked as (
            select picked_job.id
            from locked_users
            cross join lateral (
                select queued.id
                from ${asyncJobs} queued
                where queued.status = 'pending'
                  and queued.kind = ${kind}
                  and queued.user_id = locked_users.user_id
                  and queued.next_attempt_at <= now()
                order by
                    queued.priority desc,
                    queued.next_attempt_at asc,
                    queued.created_at asc
                limit 1
                for update skip locked
            ) picked_job
        )
        update ${asyncJobs}
        set status = 'processing',
            started_at = now(),
            heartbeat_at = now(),
            updated_at = now(),
            attempts = attempts + 1,
            claim_token = gen_random_uuid()::text
        where id in (select id from picked)
        returning id, user_id, kind, subject_id, payload, attempts, max_attempts, claim_token
    `)
            : await db.execute(sql`
        update ${asyncJobs}
        set status = 'processing',
            started_at = now(),
            heartbeat_at = now(),
            updated_at = now(),
            attempts = attempts + 1,
            claim_token = gen_random_uuid()::text
        where id in (
            select id from ${asyncJobs}
            where status = 'pending'
              and kind = ${kind}
              and next_attempt_at <= now()
            order by priority desc, next_attempt_at asc, created_at asc
            limit ${limit}
            for update skip locked
        )
        returning id, user_id, kind, subject_id, payload, attempts, max_attempts, claim_token
    `);

    return rowsOf<{
        id: string;
        user_id: string;
        kind: string;
        subject_id: string | null;
        payload: Record<string, unknown>;
        attempts: number;
        max_attempts: number;
        claim_token: string;
    }>(result).map((r) => ({
        id: r.id,
        userId: r.user_id,
        kind: r.kind,
        subjectId: r.subject_id,
        payload: r.payload ?? {},
        attempts: r.attempts,
        maxAttempts: r.max_attempts,
        claimToken: r.claim_token,
    }));
}

/**
 * Record that a claimed job is alive, optionally with a progress snapshot.
 *
 * Returns false when the claim no longer matches, which is the signal the
 * worker uses to abandon work it no longer owns: the job was reclaimed while
 * this process was (from the queue's point of view) unresponsive, and
 * continuing would mean two workers running the same job.
 */
export async function heartbeatJob(
    jobId: string,
    claimToken: string,
    progress?: Record<string, unknown> | null,
): Promise<boolean> {
    const result = await db
        .update(asyncJobs)
        .set({
            heartbeatAt: new Date(),
            updatedAt: new Date(),
            ...(progress === undefined ? {} : { progress }),
        })
        .where(
            and(
                eq(asyncJobs.id, jobId),
                eq(asyncJobs.claimToken, claimToken),
                eq(asyncJobs.status, "processing"),
            ),
        )
        .returning({ id: asyncJobs.id });
    return result.length > 0;
}

/** Adopt pre-deployment jobs under the current claim before their handler runs. */
export async function prepareClaimedPipelineJob(
    jobId: string,
    claimToken: string,
): Promise<boolean> {
    return db.transaction(async (tx) => {
        const [job] = await tx
            .select()
            .from(asyncJobs)
            .where(
                and(
                    eq(asyncJobs.id, jobId),
                    eq(asyncJobs.claimToken, claimToken),
                    eq(asyncJobs.status, "processing"),
                ),
            )
            .for("update")
            .limit(1);
        if (!job) return false;
        if (jobBindings(job.payload).length > 0) return true;
        let pipeline: PipelineJobTarget | undefined;
        if (job.kind === "learn.run" && typeof job.payload.runId === "string") {
            const [run] = await tx
                .select()
                .from(learnRuns)
                .where(
                    and(
                        eq(learnRuns.id, job.payload.runId),
                        eq(learnRuns.actorUserId, job.userId),
                    ),
                )
                .limit(1);
            if (run)
                pipeline = {
                    itemId: run.itemId,
                    userId: run.userId,
                    phase: "learn",
                    existingOnly: run.trigger === "manual",
                };
        } else if (
            job.kind === "learn.correct" &&
            typeof job.payload.passId === "string"
        ) {
            const [pass] = await tx
                .select()
                .from(transcriptCorrectionPasses)
                .where(
                    and(
                        eq(transcriptCorrectionPasses.id, job.payload.passId),
                        eq(transcriptCorrectionPasses.actorUserId, job.userId),
                    ),
                )
                .limit(1);
            if (pass)
                pipeline = {
                    itemId: pass.recordingId,
                    userId: pass.userId,
                    phase: "learn",
                    existingOnly: true,
                };
        } else if (
            job.kind === "learn.release" &&
            typeof job.payload.recordingId === "string"
        )
            pipeline = {
                itemId: job.payload.recordingId,
                userId: job.userId,
                phase: "learn",
            };
        if (job.kind === "learn.correct" && pipeline) {
            const [processing] = await tx
                .select({ phases: itemProcessing.phases })
                .from(itemProcessing)
                .where(
                    and(
                        eq(itemProcessing.itemId, pipeline.itemId),
                        eq(itemProcessing.userId, pipeline.userId),
                        eq(itemProcessing.view, "private"),
                    ),
                )
                .for("update")
                .limit(1);
            const learn = processing?.phases.learn;
            if (
                learn?.jobId &&
                learn.jobId !== job.id &&
                ["pending", "running", "waiting"].includes(learn.state)
            ) {
                const now = new Date();
                await tx
                    .update(asyncJobs)
                    .set({
                        status: "pending",
                        claimToken: null,
                        heartbeatAt: null,
                        startedAt: null,
                        attempts: sql`greatest(0, ${asyncJobs.attempts} - 1)`,
                        nextAttemptAt: new Date(now.getTime() + 1000),
                        updatedAt: now,
                    })
                    .where(
                        and(
                            eq(asyncJobs.id, job.id),
                            eq(asyncJobs.userId, job.userId),
                            eq(asyncJobs.claimToken, claimToken),
                            eq(asyncJobs.status, "processing"),
                        ),
                    );
                return false;
            }
        }
        await bindPipelineJobInTx(tx, job, pipeline);
        return true;
    });
}

/**
 * Mark a job done. Scoped to the claim, so a superseded worker finishing late
 * cannot overwrite whatever the current owner has since done with the job.
 */
export async function completeJob(input: {
    jobId: string;
    claimToken: string;
    result?: Record<string, unknown> | null;
}): Promise<boolean> {
    const outcome = terminalStepOutcome({
        status: "completed",
        result: input.result ?? null,
        errorCode: null,
    });
    return db.transaction((tx) =>
        settleTerminalJobInTx(tx, {
            ...input,
            status: outcome.kind === "failed" ? "failed" : "completed",
            ...(outcome.kind === "failed"
                ? {
                      code: outcome.code,
                      retryable: outcome.retryable,
                      message: outcome.code,
                  }
                : {}),
        }),
    );
}

/** Settle the claimed job and all of its still-current step bindings atomically. */
export async function settleTerminalJobInTx(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    input: {
        jobId: string;
        claimToken: string;
        status: "completed" | "failed";
        result?: Record<string, unknown> | null;
        message?: string;
        code?: string | null;
        retryable?: boolean;
    },
): Promise<boolean> {
    const [job] = await tx
        .select()
        .from(asyncJobs)
        .where(
            and(
                eq(asyncJobs.id, input.jobId),
                eq(asyncJobs.claimToken, input.claimToken),
                eq(asyncJobs.status, "processing"),
            ),
        )
        .for("update")
        .limit(1);
    if (!job) {
        console.debug("[pipeline] superseded job claim", {
            jobId: input.jobId,
        });
        return false;
    }
    const bindings = jobBindings(job.payload);
    for (const binding of bindings) {
        const [processing] = await tx
            .select({ phases: itemProcessing.phases })
            .from(itemProcessing)
            .where(
                and(
                    eq(itemProcessing.itemId, binding.itemId),
                    eq(itemProcessing.userId, binding.userId),
                    eq(itemProcessing.view, "private"),
                ),
            )
            .for("update")
            .limit(1);
        const phase = processing?.phases[binding.phase];
        const step = binding.step ? phase?.steps?.[binding.step] : phase;
        if (step?.jobId !== job.id || step.generation !== binding.generation) {
            console.debug("[pipeline] superseded step generation", {
                jobId: job.id,
                generation: binding.generation,
            });
            return false;
        }
    }
    const now = new Date();
    let outcome: StepOutcome =
        input.status === "failed"
            ? {
                  kind: "failed",
                  code: input.code ?? "INTERNAL_ERROR",
                  retryable: input.retryable ?? true,
              }
            : terminalStepOutcome({
                  status: input.status,
                  result: input.result ?? null,
                  errorCode: null,
              });
    if (
        outcome.kind === "waiting" &&
        outcome.waitingFor.kind === "learnReview" &&
        bindings[0]
    ) {
        const binding = bindings[0];
        const [item] = await tx
            .select({ until: chatterItems.summaryDueAt })
            .from(chatterItems)
            .where(
                and(
                    eq(chatterItems.id, binding.itemId),
                    eq(chatterItems.userId, binding.userId),
                ),
            )
            .limit(1);
        if (item?.until)
            outcome = {
                ...outcome,
                waitingFor: {
                    ...outcome.waitingFor,
                    until: item.until.toISOString(),
                },
            };
    }
    const result =
        bindings.length > 0 || input.result?.outcome
            ? { ...input.result, outcome }
            : (input.result ?? null);
    await tx
        .update(asyncJobs)
        .set({
            status: input.status,
            result,
            lastError: input.message ?? null,
            errorCode: input.code ?? null,
            completedAt: now,
            heartbeatAt: now,
            updatedAt: now,
        })
        .where(
            and(
                eq(asyncJobs.id, job.id),
                eq(asyncJobs.userId, job.userId),
                eq(asyncJobs.claimToken, input.claimToken),
                eq(asyncJobs.status, "processing"),
            ),
        );
    for (const binding of bindings) {
        const titleOutcome = input.result?.titleOutcome;
        await settlePipelineBindingInTx(
            tx,
            binding,
            job.id,
            binding.step === "title" &&
                titleOutcome &&
                typeof titleOutcome === "object"
                ? (titleOutcome as StepOutcome)
                : outcome,
        );
    }
    if (input.status === "completed") {
        for (const binding of bindings)
            if (binding.phase === "learn")
                await bindAvailableCorrectionInTx(
                    tx,
                    binding.itemId,
                    binding.userId,
                );
    }
    if (
        job.kind === "pipeline.advance" &&
        typeof job.payload.itemId === "string"
    ) {
        const [processing] = await tx
            .select({
                requested: itemProcessing.requestedGeneration,
                processed: itemProcessing.processedGeneration,
            })
            .from(itemProcessing)
            .where(
                and(
                    eq(itemProcessing.itemId, job.payload.itemId),
                    eq(itemProcessing.userId, job.userId),
                    eq(itemProcessing.view, "private"),
                ),
            )
            .for("update")
            .limit(1);
        if (processing && processing.requested > processing.processed)
            await wakePipelineInTx(tx, job.payload.itemId, job.userId);
    }
    return true;
}

/** Terminate matching active jobs in another transaction and revoke their claims. */
export async function cancelActiveJobsInTx(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    input: {
        userId: string;
        kind: string;
        subjectId: string;
        payloadValues: { key: string; values: string[] };
        message: string;
        now?: Date;
    },
): Promise<void> {
    const now = input.now ?? new Date();
    await tx
        .update(asyncJobs)
        .set({
            status: "failed",
            completedAt: now,
            updatedAt: now,
            claimToken: null,
            heartbeatAt: null,
            lastError: input.message,
        })
        .where(
            and(
                eq(asyncJobs.userId, input.userId),
                eq(asyncJobs.kind, input.kind),
                eq(asyncJobs.subjectId, input.subjectId),
                isActive(),
                inArray(
                    sql<string>`${asyncJobs.payload} ->> ${input.payloadValues.key}`,
                    input.payloadValues.values,
                ),
            ),
        );
}

export interface FailJobOutcome {
    status: AsyncJobStatus;
    attempts: number;
}

/**
 * Record a failed attempt, requeueing it with backoff or burying it.
 *
 * A job is buried when the error is not worth retrying (a deleted recording,
 * an unconfigured provider -- nothing about waiting makes those succeed) or
 * when it has used its attempts. Otherwise it goes back to `pending` with
 * `next_attempt_at` pushed out by `delayMs`, which is where exponential
 * backoff actually takes effect.
 *
 * The claim token is deliberately kept on a buried job and cleared on a
 * requeued one: clearing it is what lets the next claim take the job, so
 * keeping it on a terminal row means a late write from the failed attempt
 * still matches nothing.
 *
 * Returns null if the claim no longer matches -- there is nothing to record
 * against a job this worker no longer owns.
 */
export async function failJobAttempt(input: {
    jobId: string;
    claimToken: string;
    message: string;
    code?: string | null;
    retryable: boolean;
    delayMs: number;
}): Promise<FailJobOutcome | null> {
    return db.transaction(async (tx) => {
        const [job] = await tx
            .select()
            .from(asyncJobs)
            .where(
                and(
                    eq(asyncJobs.id, input.jobId),
                    eq(asyncJobs.claimToken, input.claimToken),
                    eq(asyncJobs.status, "processing"),
                ),
            )
            .for("update")
            .limit(1);
        if (!job) return null;
        if (!input.retryable || job.attempts >= job.maxAttempts) {
            const settled = await settleTerminalJobInTx(tx, {
                ...input,
                status: "failed",
            });
            return settled
                ? { status: "failed", attempts: job.attempts }
                : null;
        }
        await tx
            .update(asyncJobs)
            .set({
                status: "pending",
                claimToken: null,
                startedAt: null,
                lastError: input.message,
                errorCode: input.code ?? null,
                updatedAt: new Date(),
                nextAttemptAt: new Date(Date.now() + input.delayMs),
            })
            .where(
                and(
                    eq(asyncJobs.id, job.id),
                    eq(asyncJobs.userId, job.userId),
                    eq(asyncJobs.claimToken, input.claimToken),
                    eq(asyncJobs.status, "processing"),
                ),
            );
        return { status: "pending", attempts: job.attempts };
    });
}

/**
 * Reclaim jobs whose worker stopped heartbeating.
 *
 * This is the whole point of the table. A container upgrade, an OOM kill or a
 * crash leaves a row stuck in `processing` with nothing in the process that
 * owned it left to notice -- no in-process timer survives its own process. A
 * missed heartbeat is the only evidence available, and unlike elapsed runtime
 * it does not force a choice between reclaiming long-but-healthy jobs early
 * and leaving genuinely dead ones for hours.
 *
 * A reclaimed job keeps its `attempts` count, so a job that reliably kills
 * the process (rather than merely being interrupted by an unlucky restart)
 * still exhausts its attempts and is buried instead of restarting the
 * process forever.
 */
export async function reclaimStaleJobs(staleMs: number): Promise<number> {
    const result = await db.execute(sql`
        update ${asyncJobs}
        set status = 'pending',
            claim_token = null,
            started_at = null,
            next_attempt_at = now(),
            last_error = coalesce(last_error, 'Worker stopped responding; job reclaimed'),
            updated_at = now()
        where status = 'processing'
          and attempts < max_attempts
          and coalesce(payload -> 'pipelineSteps', '[]'::jsonb) = '[]'::jsonb
          and coalesce(heartbeat_at, started_at) < now() - make_interval(secs => ${staleMs / 1000}::double precision)
        returning id
    `);
    return rowsOf<{ id: string }>(result).length;
}

/**
 * Bury expired pipeline claims and unbound jobs that exhausted their attempts.
 *
 * Separate from `reclaimStaleJobs` because the two say different things: one
 * is "try again", this is "this job has now killed as many workers as it is
 * allowed to". Without it, a job whose handler reliably crashes the process
 * would be reclaimed forever, taking the container with it each time.
 */
export async function buryExhaustedStaleJobs(
    staleMs: number,
    afterFailure?: (job: AsyncJobRow) => Promise<void>,
): Promise<number> {
    const ended: AsyncJobRow[] = [];
    const count = await db.transaction(async (tx) => {
        const jobs = await tx
            .select()
            .from(asyncJobs)
            .where(
                and(
                    eq(asyncJobs.status, "processing"),
                    sql`(${asyncJobs.attempts} >= ${asyncJobs.maxAttempts} or coalesce(${asyncJobs.payload} -> 'pipelineSteps', '[]'::jsonb) <> '[]'::jsonb)`,
                    sql`${asyncJobs.id} in (
                        select id from (
                            select id, row_number() over (partition by user_id order by coalesce(heartbeat_at, started_at), id) as owner_rank
                            from async_jobs where status = 'processing'
                              and (attempts >= max_attempts or coalesce(payload -> 'pipelineSteps', '[]'::jsonb) <> '[]'::jsonb)
                              and coalesce(heartbeat_at, started_at) < now() - make_interval(secs => ${staleMs / 1000}::double precision)
                        ) candidates where owner_rank <= 5
                    )`,
                    sql`coalesce(${asyncJobs.heartbeatAt}, ${asyncJobs.startedAt}) < now() - make_interval(secs => ${staleMs / 1000}::double precision)`,
                ),
            )
            .limit(100)
            .for("update", { skipLocked: true });
        let settled = 0;
        for (const job of jobs) {
            if (
                job.claimToken &&
                (await settleTerminalJobInTx(tx, {
                    jobId: job.id,
                    claimToken: job.claimToken,
                    status: "failed",
                    message: "Worker stopped responding and no attempts remain",
                    code: "lost",
                    retryable: true,
                }))
            ) {
                settled++;
                ended.push({
                    ...job,
                    status: "failed",
                    errorCode: "lost",
                    lastError: "Processing was interrupted",
                });
            }
        }
        return settled;
    });
    if (afterFailure) for (const job of ended) await afterFailure(job);
    return count;
}

/**
 * Hand claimed jobs straight back to the queue, claim-scoped.
 *
 * Called on a clean shutdown. Unlike `reclaimStaleJobs`, this REFUNDS the
 * attempt: the job did not fail and did not kill anything, it was interrupted
 * by a deploy, and charging it for that would mean three upgrades in a row
 * could bury work that never once misbehaved. The distinction is only safe
 * because reaching this code proves the process is shutting down in an
 * orderly way -- a job that crashes its host never gets here, and takes the
 * non-refunding `reclaimStaleJobs` path instead.
 */
export async function releaseClaimedJobs(
    claims: { jobId: string; claimToken: string }[],
): Promise<number> {
    if (claims.length === 0) return 0;
    const pairs = sql.join(
        claims.map((c) => sql`(${c.jobId}, ${c.claimToken})`),
        sql`, `,
    );
    const result = await db.execute(sql`
        update ${asyncJobs}
        set status = 'pending',
            claim_token = null,
            started_at = null,
            next_attempt_at = now(),
            attempts = greatest(attempts - 1, 0),
            updated_at = now()
        where (id, claim_token) in (${pairs})
          and status = 'processing'
        returning id
    `);
    return rowsOf<{ id: string }>(result).length;
}

/**
 * Put a claimed job back to start again after `delayMs`, its attempt not
 * counted: it did not fail, it was not time yet (`JobDeferredError`).
 */
export async function deferJob(input: {
    jobId: string;
    claimToken: string;
    delayMs: number;
}): Promise<boolean> {
    const result = await db.execute(sql`
        update ${asyncJobs}
        set status = 'pending',
            claim_token = null,
            started_at = null,
            next_attempt_at = now() + make_interval(secs => ${input.delayMs / 1000}::double precision),
            attempts = greatest(attempts - 1, 0),
            updated_at = now()
        where id = ${input.jobId}
          and claim_token = ${input.claimToken}
          and status = 'processing'
        returning id
    `);
    return rowsOf<{ id: string }>(result).length > 0;
}

/**
 * Delete up to `limit` finished rows past their retention window.
 *
 * Jobs are kept for a while after they settle so a client that reconnects can
 * still be told how the work went, but they are bookkeeping, not history --
 * nothing reads them once that window has passed. Rows another process is
 * already deleting are skipped, so concurrent prunes split the work.
 */
export async function pruneFinishedJobs(
    olderThanMs: number,
    limit: number,
): Promise<number> {
    const result = await db.execute(sql`
        delete from ${asyncJobs}
        where id in (
            select id from ${asyncJobs}
            where status in ('completed', 'failed')
              and completed_at is not null
              and completed_at < now() - make_interval(secs => ${olderThanMs / 1000}::double precision)
            order by completed_at asc
            limit ${limit}
            for update skip locked
        )
        returning id
    `);
    return rowsOf<{ id: string }>(result).length;
}

/**
 * Jobs left `pending` by a process that enqueued them and then died before
 * running them. They need nothing done to them -- `claimDueJobs` picks them
 * up on its own -- but counting them is how the worker log can say whether a
 * restart actually left work behind.
 */
export async function countPendingJobs(kind?: string): Promise<number> {
    const rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(asyncJobs)
        .where(
            kind
                ? and(eq(asyncJobs.status, "pending"), eq(asyncJobs.kind, kind))
                : eq(asyncJobs.status, "pending"),
        );
    return Number(rows[0]?.count ?? 0);
}

/**
 * Jobs for a user, newest first. Powers any "what is running" view and makes
 * a stuck queue diagnosable without database access.
 */
export async function listJobsForUser(
    userId: string,
    opts: { kind?: string; limit?: number; activeOnly?: boolean } = {},
): Promise<AsyncJobRow[]> {
    const filters = [eq(asyncJobs.userId, userId)];
    if (opts.kind) filters.push(eq(asyncJobs.kind, opts.kind));
    if (opts.activeOnly) {
        filters.push(isActive());
    }
    const rows = await db
        .select()
        .from(asyncJobs)
        .where(and(...filters))
        .orderBy(desc(asyncJobs.createdAt))
        .limit(opts.limit ?? 20);
    return rows as AsyncJobRow[];
}

/**
 * One job by id with no owner scope.
 *
 * Only for callers that authorize by other means -- an Organization job is
 * visible to everyone who can see the shared recording it acts on.
 */
export async function getJobById(jobId: string): Promise<AsyncJobRow | null> {
    const [row] = await db
        .select()
        .from(asyncJobs)
        .where(eq(asyncJobs.id, jobId))
        .limit(1);
    return (row as AsyncJobRow) ?? null;
}
