import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/errors";
import {
    enforceTaskWriteRateLimit,
    invalid,
    optionalNullableString,
    readTaskBody,
    requireTaskViewer,
} from "@/lib/tasks/route-helpers";
import { isoDateOrNull } from "@/lib/tasks/summary-items";
import {
    createPersonalTask,
    listTasks,
    type TaskDueFilter,
    type TaskSort,
    type TaskStateFilter,
    type TaskTab,
} from "@/lib/tasks/tasks";

const STATES = new Set<TaskStateFilter>(["open", "done", "dropped", "all"]);
const DUES = new Set<string>(["overdue", "week", "none"]);

/**
 * The caller's tasks: `?tab=mine|followed|all&state=&folder=&assignee=&due=&today=&sort=`.
 * `assignee` is a person id or `none` for unassigned; ignored on Mine.
 * Unknown values fall back to the defaults (mine, open, newest first).
 */
export const GET = apiHandler(async (request) => {
    const viewer = await requireTaskViewer(request);
    const params = new URL(request.url).searchParams;
    const state = params.get("state") as TaskStateFilter | null;
    const due = params.get("due");
    const tasks = await listTasks(viewer, {
        tab: (params.get("tab") === "all"
            ? "all"
            : ["tracked", "followed"].includes(params.get("tab") ?? "")
              ? "followed"
              : "mine") as TaskTab,
        organization: params.get("organization") === "true",
        state: state && STATES.has(state) ? state : "open",
        folderId: params.get("folder") || null,
        assignee: params.get("assignee") || null,
        due: (due && DUES.has(due) ? due : null) as TaskDueFilter,
        today: isoDateOrNull(params.get("today")),
        sort: (params.get("sort") === "due" ? "due" : "created") as TaskSort,
    });
    return NextResponse.json({ tasks });
});

/** Add an own task for the signed-in person. */
export const POST = apiHandler(async (request) => {
    const viewer = await requireTaskViewer(request);
    await enforceTaskWriteRateLimit(viewer);
    const body = await readTaskBody(request);
    if (typeof body.text !== "string")
        throw invalid("text is required", "text");
    if (
        body.dueDate !== undefined &&
        body.dueDate !== null &&
        typeof body.dueDate !== "string"
    )
        throw invalid("dueDate must be a string or null");
    return NextResponse.json(
        await createPersonalTask(viewer, {
            text: body.text,
            dueDate: body.dueDate as string | null | undefined,
            folderId: optionalNullableString(body, "folderId"),
        }),
        { status: 201 },
    );
});
