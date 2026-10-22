import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
    type AsyncJobRow,
    pipelineJobTransaction,
    settleTerminalJobInTx,
} from "@/db/queries/async-jobs";
import {
    jobBindings,
    lockPipelineTargetsInTx,
    type PipelineJobBinding,
    settlePipelineBindingInTx,
    terminalStepOutcome,
    wakePipelineInTx,
} from "@/db/queries/pipeline-jobs";
import { asyncJobs, itemProcessing } from "@/db/schema";
import type { StepOutcome } from "@/lib/pipeline/outcome";
import type {
    PhaseName,
    PhaseRecord,
    PhaseStepRecord,
    PipelinePhases,
    SummaryStepName,
} from "@/lib/pipeline/types";

export const PIPELINE_RECONCILE_LIMIT = 100;
export const PIPELINE_RECONCILE_PER_USER = 5;

function leaves(phases: PipelinePhases): {
    phase: PhaseName;
    step?: SummaryStepName;
    record: PhaseRecord | PhaseStepRecord;
}[] {
    return Object.entries(phases).flatMap<{
        phase: PhaseName;
        step?: SummaryStepName;
        record: PhaseRecord | PhaseStepRecord;
    }>(([name, phase]) => {
        const steps = Object.entries(phase.steps ?? {});
        return steps.length > 0
            ? steps.map(([step, record]) => ({
                  phase: name as PhaseName,
                  step: step as SummaryStepName,
                  record,
              }))
            : [{ phase: name as PhaseName, record: phase }];
    });
}

/** Repair the unfinished-step invariant in fair, locked owner batches. */
export async function reconcilePipelineSteps(
    limit = PIPELINE_RECONCILE_LIMIT,
    perUserLimit = PIPELINE_RECONCILE_PER_USER,
    now = new Date(),
    afterFailure?: (job: AsyncJobRow) => Promise<void>,
): Promise<number> {
    if (limit <= 0 || perUserLimit <= 0) return 0;
    const ended: AsyncJobRow[] = [];
    const rows = await db.execute<{
        itemId: string;
        userId: string;
        phases: PipelinePhases;
    }>(sql`
            with candidates as (
                select p.item_id, p.user_id, p.updated_at,
                    row_number() over (partition by p.user_id order by p.updated_at, p.item_id) as owner_rank
                from item_processing p
                inner join chatter_items i on i.id = p.item_id and i.user_id = p.user_id
                where p.view = 'private' and i.deleted_at is null
                  and exists (
                    select 1 from jsonb_each(p.phases) phase
                    cross join lateral (
                        select phase.value as record where coalesce(phase.value -> 'steps', '{}'::jsonb) = '{}'::jsonb
                        union all select value from jsonb_each(coalesce(phase.value -> 'steps', '{}'::jsonb))
                    ) leaf
                    left join async_jobs j on j.id = leaf.record ->> 'jobId'
                        and (j.user_id = p.user_id or coalesce(j.payload -> 'pipelineSteps', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('itemId', p.item_id, 'userId', p.user_id)))
                    where coalesce(leaf.record ->> 'state', 'pending') in ('pending', 'running', 'waiting')
                      and case when leaf.record ->> 'jobId' is not null then
                        j.id is null or j.status in ('completed', 'failed') or
                        (j.status = 'processing' and coalesce(j.heartbeat_at, j.started_at, j.updated_at) < now() - interval '120 seconds')
                      else
                        coalesce(leaf.record ->> 'at', phase.value ->> 'at')::timestamp <= ${now.toISOString()}::timestamp - interval '120 seconds'
                        and (leaf.record ->> 'replannedAt' is null or
                            (leaf.record ->> 'replannedAt')::timestamp <= ${now.toISOString()}::timestamp -
                            case coalesce((leaf.record ->> 'replanAttempts')::int, 0)
                                when 1 then interval '2 minutes'
                                when 2 then interval '10 minutes'
                                else interval '60 minutes' end)
                        and ((leaf.record -> 'waitingFor' ->> 'until' is not null and
                            leaf.record -> 'waitingFor' ->> 'until' <= ${now.toISOString()})
                        or (leaf.record -> 'waitingFor' is null and
                            (coalesce(leaf.record ->> 'state', 'pending') <> 'waiting' or leaf.record ->> 'reason' is null)))
                      end
                  )
            )
            select p.item_id as "itemId", p.user_id as "userId", p.phases
            from candidates c inner join item_processing p on p.item_id = c.item_id and p.user_id = c.user_id and p.view = 'private'
            where c.owner_rank <= ${perUserLimit}
            order by c.owner_rank, c.updated_at, c.user_id, c.item_id
            limit ${limit}
        `);
    let count = 0;
    for (const candidate of rows) {
        const result = await pipelineJobTransaction(async (tx) => {
            const ids = leaves(candidate.phases).flatMap(({ record }) =>
                record.jobId ? [record.jobId] : [],
            );
            const snapshots =
                ids.length > 0
                    ? await tx
                          .select({ payload: asyncJobs.payload })
                          .from(asyncJobs)
                          .where(
                              and(
                                  inArray(asyncJobs.id, ids),
                                  sql`(${asyncJobs.userId} = ${candidate.userId} or coalesce(${asyncJobs.payload} -> 'pipelineSteps', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('itemId', ${candidate.itemId}::text, 'userId', ${candidate.userId}::text)))`,
                              ),
                          )
                    : [];
            const targets = [
                candidate,
                ...snapshots.flatMap((job) => jobBindings(job.payload)),
            ];
            if (!(await lockPipelineTargetsInTx(tx, targets, false, true)))
                return { repaired: 0, ended: [] as AsyncJobRow[] };
            const [row] = await tx
                .select()
                .from(itemProcessing)
                .where(
                    and(
                        eq(itemProcessing.itemId, candidate.itemId),
                        eq(itemProcessing.userId, candidate.userId),
                        eq(itemProcessing.view, "private"),
                    ),
                )
                .for("update", { skipLocked: true })
                .limit(1);
            if (!row) return { repaired: 0, ended: [] as AsyncJobRow[] };
            let repaired = 0;
            const ended: AsyncJobRow[] = [];
            for (const leaf of leaves(row.phases)) {
                const { phase, step } = leaf;
                const [current] = await tx
                    .select({ phases: itemProcessing.phases })
                    .from(itemProcessing)
                    .where(
                        and(
                            eq(itemProcessing.itemId, row.itemId),
                            eq(itemProcessing.userId, row.userId),
                            eq(itemProcessing.view, "private"),
                        ),
                    )
                    .limit(1);
                if (!current) continue;
                row.phases = current.phases;
                const record = step
                    ? row.phases[phase]?.steps?.[step]
                    : row.phases[phase];
                if (!record) continue;
                if (
                    !["pending", "running", "waiting"].includes(
                        record.state ?? "pending",
                    )
                )
                    continue;
                if (record.jobId) {
                    const [selected] = await tx
                        .select({
                            job: asyncJobs,
                            stale: sql<boolean>`coalesce(${asyncJobs.heartbeatAt}, ${asyncJobs.startedAt}, ${asyncJobs.updatedAt}) < now() - interval '120 seconds'`,
                        })
                        .from(asyncJobs)
                        .where(
                            and(
                                eq(asyncJobs.id, record.jobId),
                                sql`(${asyncJobs.userId} = ${row.userId} or coalesce(${asyncJobs.payload} -> 'pipelineSteps', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('itemId', ${row.itemId}::text, 'userId', ${row.userId}::text)))`,
                            ),
                        )
                        .for("update", { skipLocked: true })
                        .limit(1);
                    const job = selected?.job;
                    if (
                        job &&
                        jobBindings(job.payload).some(
                            (binding) =>
                                !targets.some(
                                    (target) =>
                                        target.itemId === binding.itemId &&
                                        target.userId === binding.userId,
                                ),
                        )
                    )
                        continue;
                    if (!job) {
                        const [exists] = await tx
                            .select({ id: asyncJobs.id })
                            .from(asyncJobs)
                            .where(
                                and(
                                    eq(asyncJobs.id, record.jobId),
                                    sql`(${asyncJobs.userId} = ${row.userId} or coalesce(${asyncJobs.payload} -> 'pipelineSteps', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('itemId', ${row.itemId}::text, 'userId', ${row.userId}::text)))`,
                                ),
                            )
                            .limit(1);
                        if (exists) continue;
                    }
                    const binding: PipelineJobBinding = {
                        itemId: row.itemId,
                        userId: row.userId,
                        phase,
                        ...(step ? { step } : {}),
                        generation: record.generation,
                    };
                    const stale =
                        job?.status === "processing" && selected?.stale;
                    if (stale && job.claimToken) {
                        if (job.attempts < job.maxAttempts) {
                            await tx
                                .update(asyncJobs)
                                .set({
                                    status: "pending",
                                    claimToken: null,
                                    startedAt: null,
                                    heartbeatAt: null,
                                    nextAttemptAt: new Date(),
                                    updatedAt: new Date(),
                                    lastError:
                                        "Worker stopped responding; job reclaimed",
                                })
                                .where(
                                    and(
                                        eq(asyncJobs.id, job.id),
                                        eq(asyncJobs.userId, job.userId),
                                        eq(
                                            asyncJobs.claimToken,
                                            job.claimToken,
                                        ),
                                        eq(asyncJobs.status, "processing"),
                                    ),
                                );
                            repaired++;
                            continue;
                        }
                        if (
                            await settleTerminalJobInTx(tx, {
                                jobId: job.id,
                                claimToken: job.claimToken,
                                status: "failed",
                                code: "lost",
                                message: "Processing was interrupted",
                                retryable: true,
                            })
                        ) {
                            await settlePipelineBindingInTx(
                                tx,
                                binding,
                                job.id,
                                {
                                    kind: "failed",
                                    code: "lost",
                                    retryable: true,
                                },
                            );
                            ended.push({
                                ...job,
                                status: "failed",
                                errorCode: "lost",
                                lastError: "Processing was interrupted",
                            });
                            repaired++;
                        }
                    } else if (
                        !job ||
                        job.status === "completed" ||
                        job.status === "failed"
                    ) {
                        let outcome: StepOutcome;
                        const superseded =
                            job &&
                            jobBindings(job.payload).some(
                                (named) =>
                                    named.itemId === binding.itemId &&
                                    named.userId === binding.userId &&
                                    named.phase === binding.phase &&
                                    named.step === binding.step &&
                                    named.generation !== binding.generation,
                            );
                        if (!job || superseded)
                            outcome = {
                                kind: "failed",
                                code: "lost",
                                retryable: true,
                            };
                        else if (step === "title" && job.result?.titleOutcome)
                            outcome = job.result.titleOutcome as StepOutcome;
                        else outcome = terminalStepOutcome(job);
                        if (
                            await settlePipelineBindingInTx(
                                tx,
                                binding,
                                record.jobId,
                                outcome,
                            )
                        )
                            repaired++;
                    }
                } else {
                    if (
                        record.waitingFor &&
                        (!record.waitingFor.until ||
                            record.waitingFor.until > now.toISOString())
                    )
                        continue;
                    if (
                        !record.waitingFor &&
                        record.state === "waiting" &&
                        record.reason
                    )
                        continue;
                    const phaseRecord = row.phases[phase];
                    if (!phaseRecord) continue;
                    const createdAt = Date.parse(
                        ("at" in record ? record.at : undefined) ??
                            phaseRecord.at,
                    );
                    const attempts = record.replanAttempts ?? 0;
                    const delay =
                        attempts === 1
                            ? 120_000
                            : attempts === 2
                              ? 600_000
                              : 3_600_000;
                    if (
                        !Number.isFinite(createdAt) ||
                        createdAt > now.getTime() - 120_000 ||
                        (record.replannedAt &&
                            Date.parse(record.replannedAt) >
                                now.getTime() - delay)
                    )
                        continue;
                    let outcome: StepOutcome | undefined;
                    if (step) {
                        const [legacy] = await tx
                            .select()
                            .from(asyncJobs)
                            .where(
                                and(
                                    eq(asyncJobs.userId, row.userId),
                                    eq(asyncJobs.subjectId, row.itemId),
                                    eq(
                                        asyncJobs.kind,
                                        step === "title"
                                            ? "title.generate"
                                            : step,
                                    ),
                                ),
                            )
                            .orderBy(desc(asyncJobs.createdAt))
                            .limit(1);
                        if (
                            legacy?.status === "failed" &&
                            legacy.completedAt &&
                            legacy.completedAt.getTime() >=
                                Date.parse(phaseRecord.at)
                        )
                            outcome = terminalStepOutcome(legacy);
                    }
                    if (!outcome && attempts >= 3)
                        outcome = {
                            kind: "failed",
                            code: "lost",
                            retryable: true,
                        };
                    const next = {
                        ...record,
                        replannedAt: now.toISOString(),
                        replanAttempts: attempts + (outcome ? 0 : 1),
                        waitingFor: undefined,
                        ...(outcome
                            ? {
                                  state: "failed" as const,
                                  reason:
                                      outcome.kind === "failed"
                                          ? outcome.code
                                          : "lost",
                                  outcome,
                                  retryable: true,
                              }
                            : {}),
                    };
                    const phases: PipelinePhases = {
                        ...row.phases,
                        [phase]: step
                            ? {
                                  ...phaseRecord,
                                  ...(outcome
                                      ? {
                                            state: "failed" as const,
                                            reason: next.reason,
                                        }
                                      : {}),
                                  steps: {
                                      ...phaseRecord.steps,
                                      [step]: next,
                                  },
                              }
                            : { ...phaseRecord, ...next },
                    };
                    await tx
                        .update(itemProcessing)
                        .set({ phases, updatedAt: now })
                        .where(
                            and(
                                eq(itemProcessing.itemId, row.itemId),
                                eq(itemProcessing.userId, row.userId),
                                eq(itemProcessing.view, "private"),
                            ),
                        );
                    row.phases = phases;
                    await wakePipelineInTx(tx, row.itemId, row.userId);
                    repaired++;
                }
            }
            return { repaired, ended };
        }).catch((error: unknown) => {
            console.error(
                "[pipeline] reconciliation failed",
                { itemId: candidate.itemId, userId: candidate.userId },
                error,
            );
            return { repaired: 0, ended: [] as AsyncJobRow[] };
        });
        count += result.repaired;
        ended.push(...result.ended);
    }
    if (afterFailure) for (const job of ended) await afterFailure(job);
    return count;
}
