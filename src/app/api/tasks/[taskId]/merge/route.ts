import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/errors";
import {
    invalid,
    readTaskBody,
    requireTaskViewer,
} from "@/lib/tasks/route-helpers";
import { mergeTaskIntoTask } from "@/lib/tasks/tasks";

type TaskContext = { params: Promise<{ taskId: string }> };

/** Merge this task into `{targetTaskId}` under the task merge rights. */
export const POST = apiHandler<TaskContext>(async (request, context) => {
    const { taskId } = await (context as TaskContext).params;
    const viewer = await requireTaskViewer(request);
    const body = await readTaskBody(request);
    if (typeof body.targetTaskId !== "string") {
        throw invalid("targetTaskId is required", "targetTaskId");
    }
    return NextResponse.json(
        await mergeTaskIntoTask(viewer, taskId, body.targetTaskId),
    );
});
