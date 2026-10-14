import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { itemProcessing } from "@/db/schema";
import type {
    PhaseName,
    PhaseRecord,
    PipelineView,
} from "@/lib/pipeline/types";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

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
