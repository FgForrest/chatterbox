import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
    type AsyncJobRow,
    settleTerminalJobInTx,
} from "@/db/queries/async-jobs";
import {
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
    const count = await db.transaction(async (tx) => {
        const rows = await tx.execute<{
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
                        (j.status = 'processing' and coalesce(j.heartbeat_at, j.started_at, j.updated_at) < ${now.toISOString()}::timestamp - interval '120 seconds')
                      else
                        (leaf.record -> 'waitingFor' ->> 'until' is not null and
                            leaf.record -> 'waitingFor' ->> 'until' <= ${now.toISOString()})
                        or (leaf.record -> 'waitingFor' is null and
                            (coalesce(leaf.record ->> 'state', 'pending') <> 'waiting' or leaf.record ->> 'reason' is null))
                      end
                  )
            )
            select p.item_id as "itemId", p.user_id as "userId", p.phases
            from candidates c inner join item_processing p on p.item_id = c.item_id and p.user_id = c.user_id and p.view = 'private'
            where c.owner_rank <= ${perUserLimit}
            order by c.owner_rank, c.updated_at, c.user_id, c.item_id
            limit ${limit}
            for update of p skip locked
        `);
        let repaired = 0;
        for (const row of rows) {
            for (const { phase, step, record } of leaves(row.phases)) {
                if (
                    !["pending", "running", "waiting"].includes(
                        record.state ?? "pending",
                    )
                )
                    continue;
                if (record.jobId) {
                    const [job] = await tx
                        .select()
                        .from(asyncJobs)
                        .where(
                            and(
                                eq(asyncJobs.id, record.jobId),
                                sql`(${asyncJobs.userId} = ${row.userId} or coalesce(${asyncJobs.payload} -> 'pipelineSteps', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('itemId', ${row.itemId}::text, 'userId', ${row.userId}::text)))`,
                            ),
                        )
                        .for("update", { skipLocked: true })
                        .limit(1);
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
                        job?.status === "processing" &&
                        (
                            job.heartbeatAt ??
                            job.startedAt ??
                            job.updatedAt
                        ).getTime() <
                            now.getTime() - 120_000;
                    if (stale && job.claimToken) {
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
                        if (!job)
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
                    const phases = { ...current.phases };
                    if (step && phases[phase]) {
                        const steps = { ...phases[phase].steps };
                        delete steps[step];
                        phases[phase] = { ...phases[phase], steps };
                    } else {
                        const currentPhase = phases[phase];
                        if (currentPhase?.waitingFor?.until)
                            phases[phase] = {
                                ...currentPhase,
                                waitingFor: undefined,
                            };
                    }
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
                    await wakePipelineInTx(tx, row.itemId, row.userId);
                    repaired++;
                }
            }
        }
        return repaired;
    });
    if (afterFailure) for (const job of ended) await afterFailure(job);
    return count;
}
