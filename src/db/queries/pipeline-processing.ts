import { sql } from "drizzle-orm";
import { db } from "@/db";
import { jobBindings } from "@/db/queries/pipeline-jobs";
import { JOB_STALE_MS } from "@/lib/jobs/timing";
import type { ProcessingQueueJob } from "@/lib/pipeline/processing-status";
import type { PipelinePhases } from "@/lib/pipeline/types";

/** Read authorized bound jobs and their position in the worker's pending claim order. */
export async function loadPipelineProcessingJobs(
    ownerUserId: string,
    itemId: string,
    phases: PipelinePhases,
): Promise<ProcessingQueueJob[]> {
    const ids = [
        ...new Set(
            Object.values(phases)
                .flatMap((phase) => [
                    phase.jobId,
                    ...Object.values(phase.steps ?? {}).map(
                        (step) => step.jobId,
                    ),
                ])
                .filter((id): id is string => Boolean(id)),
        ),
    ];
    const rows = await db.execute<
        ProcessingQueueJob & { payload: Record<string, unknown> } & Record<
                string,
                unknown
            >
    >(sql`
        with targets as (
            select j.* from async_jobs j
            where (j.id in (select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))
                or (j.user_id = ${ownerUserId} and j.subject_id in (${itemId}, ${`org:${itemId}`})
                    and j.status in ('pending', 'processing')
                    and j.kind in ('transcription', 'summary', 'topics', 'title.generate', 'learn.run', 'learn.correct', 'learn.release')
                    and coalesce(j.payload -> 'pipelineSteps', '[]'::jsonb) = '[]'::jsonb))
              and (j.user_id = ${ownerUserId} or coalesce(j.payload -> 'pipelineSteps', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('itemId', ${itemId}::text, 'userId', ${ownerUserId}::text)))
        ), fair as (
            select q.id, q.kind, q.user_id,
                row_number() over (partition by q.kind, q.user_id order by q.priority desc, q.next_attempt_at, q.created_at) as user_rank,
                min(q.next_attempt_at) over (partition by q.kind, q.user_id) as oldest_waiting,
                exists (select 1 from async_jobs running where running.kind = q.kind and running.user_id = q.user_id and running.status = 'processing') as blocked
            from async_jobs q
            where q.status = 'pending' and q.next_attempt_at <= now()
              and q.kind in ('pipeline.action', 'pipeline.advance') and q.kind in (select kind from targets where status = 'pending')
        )
        select j.id, j.kind, j.status, j.payload, j.result, j.error_code as "errorCode",
            (j.status = 'processing' and coalesce(j.heartbeat_at, j.started_at, j.updated_at)
                < now() - make_interval(secs => ${JOB_STALE_MS / 1_000}::double precision)) as stale,
            case when j.status = 'pending' and j.next_attempt_at > now()
                then to_char(j.next_attempt_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end as "retryAt",
            case when j.status <> 'pending' then 1
            when j.kind in ('pipeline.action', 'pipeline.advance') then
                (1 + (select count(*) from fair ahead left join fair target on target.id = j.id
                    where ahead.kind = j.kind and ahead.id <> j.id and not ahead.blocked
                        and (target.id is null or target.blocked or ahead.user_rank < target.user_rank
                            or (ahead.user_rank = target.user_rank and ahead.oldest_waiting < target.oldest_waiting))))::int
            else (1 + (select count(*) from async_jobs ahead
                where ahead.kind = j.kind and ahead.status = 'pending' and ahead.id <> j.id
                  and ahead.next_attempt_at <= now()
                  and (j.next_attempt_at > now() or ahead.priority > j.priority
                    or (ahead.priority = j.priority and ahead.next_attempt_at < j.next_attempt_at)
                    or (ahead.priority = j.priority and ahead.next_attempt_at = j.next_attempt_at and ahead.created_at < j.created_at))
            ))::int end as position
        from targets j
    `);
    return rows.map((row) => {
        const allBindings = jobBindings(row.payload);
        return {
            ...row,
            bindings: allBindings.filter(
                (binding) =>
                    binding.itemId === itemId && binding.userId === ownerUserId,
            ),
            unbound: allBindings.length === 0,
        };
    });
}
