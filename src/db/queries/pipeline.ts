import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { itemProcessing } from "@/db/schema";
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
