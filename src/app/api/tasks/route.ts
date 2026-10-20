import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/errors";
import { requireTaskViewer } from "@/lib/tasks/route-helpers";
import { isoDateOrNull } from "@/lib/tasks/summary-items";
import {
    listTasks,
    type TaskDueFilter,
    type TaskSort,
    type TaskStateFilter,
    type TaskTab,
} from "@/lib/tasks/tasks";

const STATES = new Set<TaskStateFilter>(["open", "done", "dropped", "all"]);
const DUES = new Set<string>(["overdue", "week", "none"]);

/**
 * The caller's tasks: `?tab=mine|tracked&state=&folder=&assignee=&due=&today=&sort=`.
 * `assignee` is a person id or `none` for unassigned; ignored on Mine.
 * Unknown values fall back to the defaults (mine, open, newest first).
 */
export const GET = apiHandler(async (request) => {
    const viewer = await requireTaskViewer(request);
    const params = new URL(request.url).searchParams;
    const state = params.get("state") as TaskStateFilter | null;
    const due = params.get("due");
    const tasks = await listTasks(viewer, {
        tab: (params.get("tab") === "tracked" ? "tracked" : "mine") as TaskTab,
        state: state && STATES.has(state) ? state : "open",
        folderId: params.get("folder") || null,
        assignee: params.get("assignee") || null,
        due: (due && DUES.has(due) ? due : null) as TaskDueFilter,
        today: isoDateOrNull(params.get("today")),
        sort: (params.get("sort") === "due" ? "due" : "created") as TaskSort,
    });
    return NextResponse.json({ tasks });
});
