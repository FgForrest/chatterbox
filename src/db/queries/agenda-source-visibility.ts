import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { meetingVisibility } from "@/db/queries/meetings";
import {
    ANY_TASK_ITEM,
    type TaskViewer,
    taskVisible,
} from "@/db/queries/task-visibility";
import { type agendaPoints, chatterItems, recordingTasks } from "@/db/schema";

type AgendaSources = typeof agendaPoints.$inferSelect.sources;
type VisibleIds = Pick<ReadonlySet<string>, "has">;

/** Derived agenda text is visible only while every recorded source is visible. */
export function hasVisibleAgendaSources(
    sources: AgendaSources,
    visibleItems: VisibleIds,
    visibleTasks: VisibleIds,
) {
    return (
        (sources?.itemIds ?? []).every((id) => visibleItems.has(id)) &&
        (sources?.taskIds ?? []).every((id) => visibleTasks.has(id))
    );
}

/** Check all agenda context provenance in one query, without loading source text. */
export async function loadAgendaSourceVisibility(
    viewer: TaskViewer,
    sources: readonly AgendaSources[],
) {
    const itemIds = [...new Set(sources.flatMap((row) => row?.itemIds ?? []))];
    const taskIds = [...new Set(sources.flatMap((row) => row?.taskIds ?? []))];
    const rows =
        itemIds.length || taskIds.length
            ? await db
                  .select({ kind: sql<string>`'item'`, id: chatterItems.id })
                  .from(chatterItems)
                  .where(
                      and(
                          inArray(chatterItems.id, itemIds),
                          meetingVisibility(viewer.userId, viewer.orgUserId),
                      ),
                  )
                  .unionAll(
                      db
                          .select({
                              kind: sql<string>`'task'`,
                              id: recordingTasks.id,
                          })
                          .from(recordingTasks)
                          .leftJoin(
                              chatterItems,
                              eq(chatterItems.id, recordingTasks.itemId),
                          )
                          .where(
                              and(
                                  inArray(recordingTasks.id, taskIds),
                                  ne(recordingTasks.status, "proposed"),
                                  isNull(chatterItems.deletedAt),
                                  sql`(${chatterItems.id} is null or ${chatterItems.kind} in ('audio', 'mail'))`,
                                  taskVisible(viewer, ANY_TASK_ITEM, true),
                              ),
                          ),
                  )
            : [];
    const items = new Set(
        rows.filter((row) => row.kind === "item").map((row) => row.id),
    );
    const tasks = new Set(
        rows.filter((row) => row.kind === "task").map((row) => row.id),
    );
    return (source: AgendaSources) =>
        hasVisibleAgendaSources(source, items, tasks);
}
