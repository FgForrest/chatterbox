import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/errors";
import {
    invalid,
    optionalNullableString,
    readTaskBody,
    readVersion,
    requireTaskViewer,
} from "@/lib/tasks/route-helpers";
import { updateTask } from "@/lib/tasks/tasks";

type TaskContext = { params: Promise<{ taskId: string }> };

const STATUSES = new Set(["open", "done", "dropped"]);

/**
 * Change a task: `{version, text?, assigneePersonId?, dueDate?, ticked?,
 * status?}`. 409 when it changed since `version`.
 */
export const PATCH = apiHandler<TaskContext>(async (request, context) => {
    const { taskId } = await (context as TaskContext).params;
    const viewer = await requireTaskViewer(request);
    const body = await readTaskBody(request);
    const text = body.text;
    if (text !== undefined && typeof text !== "string") {
        throw invalid("text must be a string", "text");
    }
    if (body.ticked !== undefined && typeof body.ticked !== "boolean") {
        throw invalid("ticked must be true or false", "ticked");
    }
    const status = body.status;
    if (status !== undefined && !STATUSES.has(status as string)) {
        throw invalid("status is open, done or dropped", "status");
    }
    return NextResponse.json(
        await updateTask(viewer, taskId, {
            version: readVersion(body.version),
            text,
            assigneePersonId: optionalNullableString(body, "assigneePersonId"),
            dueDate: optionalNullableString(body, "dueDate"),
            ticked: body.ticked as boolean | undefined,
            status: status as "open" | "done" | "dropped" | undefined,
        }),
    );
});
