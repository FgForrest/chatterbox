import { sql } from "drizzle-orm";
import type { db } from "@/db";

/** Upsert a review marker only while its item still belongs to the supplied owner. */
export async function writeTaskReviewMarkerInTx(
    executor: Pick<typeof db, "execute">,
    scope: { itemId: string; userId: string; view: "private" | "org" },
    marker: "changed" | "skipped",
): Promise<void> {
    const column = sql.identifier(
        marker === "changed"
            ? "task_review_changed_at"
            : "task_review_skipped_at",
    );
    const now = new Date().toISOString();
    await executor.execute(sql`
        insert into item_processing (item_id, user_id, view, ${column})
        select id, user_id, ${scope.view}, ${now}::timestamp
        from chatter_items
        where id = ${scope.itemId} and user_id = ${scope.userId}
        on conflict (item_id, view) do update
        set ${column} = ${now}::timestamp
        where item_processing.user_id = ${scope.userId}
    `);
}
