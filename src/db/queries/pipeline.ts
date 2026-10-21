import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { itemProcessing } from "@/db/schema";
import { effectiveManualOnlySql } from "@/lib/pipeline/effective-profile";
import type {
    PhaseName,
    PhaseRecord,
    PipelineView,
} from "@/lib/pipeline/types";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type ProcessingGenerationResult = "stable" | "changed" | "missing";

export interface StalledPipelineRow {
    itemId: string;
    userId: string;
    view: PipelineView;
}

/** One private-view automatic transcription eligible for another pipeline run. */
export interface AutomaticTranscriptionRetryRow
    extends Record<string, unknown> {
    itemId: string;
    userId: string;
    view: "private";
    requestedGeneration: number;
    reason: string;
}

export interface OrphanedPipelineStepRow extends Record<string, unknown> {
    itemId: string;
    userId: string;
    view: PipelineView;
    phase: "transcribe" | "summary";
    step: "summary" | "title" | "topics" | null;
    errorCode: string;
    phaseGeneration: number;
}

/** Increment one owner-scoped processing request, creating its row if needed. */
export async function incrementProcessingRequestInTx(
    tx: Tx,
    itemId: string,
    view: PipelineView,
    userId: string,
): Promise<number | null> {
    const rows = await tx.execute<{ requestedGeneration: number }>(sql`
        insert into item_processing (
            item_id,
            user_id,
            view,
            requested_generation,
            created_at,
            updated_at
        )
        select
            chatter_items.id,
            chatter_items.user_id,
            ${view},
            1,
            now(),
            now()
        from chatter_items
        where chatter_items.id = ${itemId}
          and chatter_items.user_id = ${userId}
          and chatter_items.deleted_at is null
        on conflict (item_id, view) do update
        set requested_generation = item_processing.requested_generation + 1,
            updated_at = now()
        where item_processing.user_id = ${userId}
        returning requested_generation as "requestedGeneration"
    `);
    return rows[0]?.requestedGeneration ?? null;
}

/** Bring one owner-scoped pending pipeline driver out of deferred backoff. */
export async function wakePendingPipelineAdvanceInTx(
    tx: Tx,
    userId: string,
    subjectId: string,
): Promise<boolean> {
    const rows = await tx.execute<{ updated: number }>(sql`
        update async_jobs
        set next_attempt_at = now(),
            updated_at = now()
        where user_id = ${userId}
          and kind = 'pipeline.advance'
          and subject_id = ${subjectId}
          and status = 'pending'
          and next_attempt_at > now()
        returning 1 as updated
    `);
    return rows.length > 0;
}

/** Read one owner-scoped processing row. */
export async function readProcessingRow(
    itemId: string,
    view: PipelineView,
    userId: string,
): Promise<typeof itemProcessing.$inferSelect | null> {
    const [row] = await db
        .select()
        .from(itemProcessing)
        .where(
            and(
                eq(itemProcessing.itemId, itemId),
                eq(itemProcessing.view, view),
                eq(itemProcessing.userId, userId),
            ),
        )
        .limit(1);
    return row ?? null;
}

/** Upsert one phase unless the stored phase has a higher generation. */
export async function updateProcessingPhaseInTx(
    tx: Tx,
    itemId: string,
    view: PipelineView,
    userId: string,
    phase: PhaseName,
    record: PhaseRecord,
): Promise<boolean> {
    const rows = await tx.execute<{ updated: number }>(sql`
        insert into item_processing (
            item_id,
            user_id,
            view,
            phases,
            created_at,
            updated_at
        )
        select
            chatter_items.id,
            chatter_items.user_id,
            ${view},
            jsonb_build_object(${phase}::text, ${JSON.stringify(record)}::jsonb),
            now(),
            now()
        from chatter_items
        where chatter_items.id = ${itemId}
          and chatter_items.user_id = ${userId}
          and chatter_items.deleted_at is null
        on conflict (item_id, view) do update
        set phases = jsonb_set(
                item_processing.phases,
                array[${phase}]::text[],
                ${JSON.stringify(record)}::jsonb,
                true
            ),
            updated_at = now()
        where item_processing.user_id = ${userId}
          and coalesce(
                (item_processing.phases -> ${phase}::text ->> 'generation')::integer,
                -1
              ) <= ${record.generation}
        returning 1 as updated
    `);
    return rows.length > 0;
}

/** Lock one owner-scoped row and finish the generation only if it stayed current. */
export async function completeProcessingGenerationInTx(
    tx: Tx,
    itemId: string,
    view: PipelineView,
    userId: string,
    generation: number,
): Promise<ProcessingGenerationResult> {
    const rows = await tx.execute<{ requestedGeneration: number }>(sql`
        select requested_generation as "requestedGeneration"
        from item_processing
        where item_id = ${itemId}
          and view = ${view}
          and user_id = ${userId}
        for update
    `);
    const row = rows[0];
    if (!row) return "missing";
    if (row.requestedGeneration !== generation) return "changed";

    await tx.execute(sql`
        update item_processing
        set processed_generation = ${generation},
            updated_at = now()
        where item_id = ${itemId}
          and view = ${view}
          and user_id = ${userId}
          and requested_generation = ${generation}
    `);
    return "stable";
}

/** Rows whose requested work lost its active driver wake-up. */
export async function listStalledPipelineRows(
    limit: number,
): Promise<StalledPipelineRow[]> {
    const rows = await db.execute<{
        itemId: string;
        userId: string;
        view: PipelineView;
    }>(sql`
        select
            item_processing.item_id as "itemId",
            item_processing.user_id as "userId",
            item_processing.view as "view"
        from item_processing
        where item_processing.processed_generation < item_processing.requested_generation
          and item_processing.updated_at < now() - interval '2 minutes'
          and not exists (
              select 1
              from async_jobs
              where async_jobs.user_id = item_processing.user_id
                and async_jobs.kind = 'pipeline.advance'
                and async_jobs.subject_id = case
                    when item_processing.view = 'org'
                        then 'org:' || item_processing.item_id
                    else item_processing.item_id
                end
                and async_jobs.status in ('pending', 'processing')
          )
          and (
              select count(*)
              from async_jobs
              where async_jobs.user_id = item_processing.user_id
                and async_jobs.kind = 'pipeline.advance'
                and async_jobs.subject_id = case
                    when item_processing.view = 'org'
                        then 'org:' || item_processing.item_id
                    else item_processing.item_id
                end
                and async_jobs.status = 'failed'
                and async_jobs.completed_at >= now() - interval '24 hours'
          ) < 3
        order by item_processing.updated_at asc
        limit ${limit}
    `);
    return rows;
}

/** Failed automatic transcriptions eligible for a bounded delayed retry. */
export async function listAutomaticTranscriptionRetryRows(
    limit: number,
    scope?: { userId: string; itemId: string },
): Promise<AutomaticTranscriptionRetryRow[]> {
    const retryBefore = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const rows = await db.execute<AutomaticTranscriptionRetryRow>(sql`
        select
            item_processing.item_id as "itemId",
            item_processing.user_id as "userId",
            item_processing.view as "view",
            item_processing.requested_generation as "requestedGeneration",
            item_processing.phases -> 'transcribe' ->> 'reason' as reason
        from item_processing
        inner join chatter_items
            on chatter_items.id = item_processing.item_id
           and chatter_items.user_id = item_processing.user_id
        inner join recordings
            on recordings.id = item_processing.item_id
           and recordings.user_id = item_processing.user_id
        where item_processing.view = 'private'
          and (${scope?.userId ?? null}::text is null or item_processing.user_id = ${scope?.userId ?? null})
          and (${scope?.itemId ?? null}::text is null or item_processing.item_id = ${scope?.itemId ?? null})
          and chatter_items.deleted_at is null
          and chatter_items.content_reaped_at is null
          and recordings.deleted_at is null
          and recordings.audio_reaped_at is null
          and item_processing.phases -> 'transcribe' ->> 'state' = 'failed'
          and coalesce(
                (item_processing.phases -> 'transcribe' ->> 'automatic')::boolean,
                false
              )
          and item_processing.phases -> 'transcribe' ->> 'at' < ${retryBefore}
          and not exists (
              select 1
              from async_jobs
              where async_jobs.user_id = item_processing.user_id
                and async_jobs.kind = 'transcription'
                and async_jobs.subject_id = item_processing.item_id
                and async_jobs.status in ('pending', 'processing')
          )
          and (
              select count(*)
              from async_jobs
              where async_jobs.user_id = item_processing.user_id
                and async_jobs.kind = 'transcription'
                and async_jobs.subject_id = item_processing.item_id
                and async_jobs.status = 'failed'
                and async_jobs.payload ->> 'trigger' <> 'manual'
                and async_jobs.completed_at >= now() - interval '24 hours'
          ) < 3
        order by item_processing.phases -> 'transcribe' ->> 'at' asc
        limit ${limit}
    `);
    return rows;
}

/** Running pipeline steps whose worker job ended without settling the phase. */
export async function listOrphanedPipelineStepRows(
    limit: number,
): Promise<OrphanedPipelineStepRow[]> {
    const rows = await db.execute<OrphanedPipelineStepRow>(sql`
        select *
        from (
            select
                item_processing.item_id as "itemId",
                item_processing.user_id as "userId",
                item_processing.view as "view",
                'transcribe'::text as phase,
                null::text as step,
                (item_processing.phases -> 'transcribe' ->> 'generation')::integer as "phaseGeneration",
                coalesce(failed.error_code, 'JOB_STALE_EXHAUSTED') as "errorCode",
                failed.completed_at as failed_at
            from item_processing
            cross join lateral (
                select async_jobs.error_code, async_jobs.completed_at
                from async_jobs
                where async_jobs.user_id = item_processing.user_id
                  and async_jobs.kind = 'transcription'
                  and async_jobs.subject_id = case
                        when item_processing.view = 'org'
                            then 'org:' || item_processing.item_id
                        else item_processing.item_id
                      end
                  and async_jobs.status = 'failed'
                  and async_jobs.payload ->> 'trigger' <> 'manual'
                  and async_jobs.completed_at >=
                        (item_processing.phases -> 'transcribe' ->> 'at')::timestamptz
                order by async_jobs.completed_at desc, async_jobs.created_at desc
                limit 1
            ) failed
            where item_processing.phases -> 'transcribe' ->> 'state' = 'running'
              and coalesce(
                    (item_processing.phases -> 'transcribe' ->> 'automatic')::boolean,
                    false
                  )
              and not exists (
                  select 1
                  from async_jobs
                  where async_jobs.user_id = item_processing.user_id
                    and async_jobs.kind = 'transcription'
                    and async_jobs.subject_id = case
                          when item_processing.view = 'org'
                              then 'org:' || item_processing.item_id
                          else item_processing.item_id
                        end
                    and async_jobs.status in ('pending', 'processing')
              )

            union all

            select
                item_processing.item_id as "itemId",
                item_processing.user_id as "userId",
                item_processing.view as "view",
                'summary'::text as phase,
                summary_step.step,
                (item_processing.phases -> 'summary' ->> 'generation')::integer as "phaseGeneration",
                case when failed.status = 'completed' then 'JOB_COMPLETED_WITHOUT_SETTLEMENT'
                     else coalesce(failed.error_code, 'JOB_STALE_EXHAUSTED')
                end as "errorCode",
                failed.completed_at as failed_at
            from item_processing
            cross join (
                values
                    ('summary'::text, 'summary'::text),
                    ('title'::text, 'title.generate'::text),
                    ('topics'::text, 'topics'::text)
            ) summary_step(step, job_kind)
            cross join lateral (
                select async_jobs.error_code, async_jobs.completed_at, async_jobs.status, async_jobs.payload, async_jobs.result
                from async_jobs
                where async_jobs.user_id = item_processing.user_id
                  and async_jobs.kind = summary_step.job_kind
                  and async_jobs.subject_id = case
                        when item_processing.view = 'org'
                            then 'org:' || item_processing.item_id
                        else item_processing.item_id
                      end
                order by async_jobs.created_at desc, async_jobs.completed_at desc
                limit 1
            ) failed
            where failed.status in ('failed', 'completed')
              and (summary_step.step = 'title' or failed.payload ->> 'trigger' <> 'manual')
              and (failed.status = 'failed' or coalesce(failed.result ->> 'skipped', '') <> 'held')
              and (failed.status = 'completed' or failed.completed_at >=
                    (item_processing.phases -> 'summary' ->> 'at')::timestamptz)
              and (
                  failed.status = 'failed'
                  or (
                      coalesce(
                          item_processing.phases -> 'summary' -> 'steps' -> summary_step.step ->> 'state',
                          'pending'
                      ) in ('pending', 'running')
                      and (item_processing.phases -> 'summary' ->> 'at')::timestamptz
                            < now() - interval '2 minutes'
                      and not exists (
                          select 1
                          from chatter_items
                          where chatter_items.id = item_processing.item_id
                            and chatter_items.user_id = item_processing.user_id
                            and chatter_items.summary_due_at is not null
                      )
                  )
              )
              and item_processing.phases -> 'summary' ->> 'state' <> 'outdated'
              and item_processing.phases -> 'summary' -> 'steps' -> summary_step.step is not null
              and coalesce(
                    item_processing.phases -> 'summary' -> 'steps' -> summary_step.step ->> 'state',
                    'pending'
                  ) not in ('done', 'failed', 'skipped', 'outdated')
              and not exists (
                  select 1
                  from async_jobs
                  where async_jobs.user_id = item_processing.user_id
                    and async_jobs.kind = summary_step.job_kind
                    and async_jobs.subject_id = case
                          when item_processing.view = 'org'
                              then 'org:' || item_processing.item_id
                          else item_processing.item_id
                        end
                    and async_jobs.status in ('pending', 'processing')
              )
        ) orphaned
        order by failed_at asc
        limit ${limit}
    `);
    return rows;
}

export interface ProviderRecoveryRow extends Record<string, unknown> {
    itemId: string;
    userId: string;
    view: PipelineView;
}

/** Select recent provider-blocked items, taking equal bounded batches per owner. */
export async function listProviderRecoveryRowsInTx(
    tx: Tx,
    userId: string,
    organization: boolean,
    limit = 200,
    perUserLimit = 20,
): Promise<ProviderRecoveryRow[]> {
    const owners = organization
        ? sql`(p.user_id = ${userId} or exists (
                select 1 from users organization_user
                where organization_user.id = ${userId} and organization_user.role = 'org'
            ))`
        : sql`p.user_id = ${userId}`;
    return tx.execute<ProviderRecoveryRow>(sql`
        with affected as (
            select p.item_id as "itemId", p.user_id as "userId", p.view,
                p.updated_at,
                row_number() over (partition by p.user_id order by p.updated_at desc, p.item_id) as owner_rank
            from item_processing p
            inner join chatter_items i on i.id = p.item_id and i.user_id = p.user_id
            where ${owners}
              and p.view = 'private'
              and not ${effectiveManualOnlySql(sql`p.manual_only`, sql`p.phases`)}
              and i.deleted_at is null
              and i.content_reaped_at is null
              and p.updated_at >= now() - interval '30 days'
              and exists (
                  select 1 from jsonb_each(p.phases) phase
                  where (phase.value ->> 'state' in ('skipped', 'failed')
                      and phase.value ->> 'reason' in ('no_provider', 'NO_TRANSCRIPTION_PROVIDER', 'NO_PROVIDER'))
                    or exists (
                        select 1 from jsonb_each(coalesce(phase.value -> 'steps', '{}'::jsonb)) step
                        where step.value ->> 'state' in ('skipped', 'failed')
                          and step.value ->> 'reason' in ('no_provider', 'NO_TRANSCRIPTION_PROVIDER', 'NO_PROVIDER')
                    )
              )
        )
        select "itemId", "userId", view from affected
        where owner_rank <= ${perUserLimit}
        order by owner_rank, updated_at desc, "userId", "itemId"
        limit ${limit}
    `);
}
