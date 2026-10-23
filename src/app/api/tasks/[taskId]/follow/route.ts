import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/errors";
import {
    enforceTaskWriteRateLimit,
    invalid,
    readTaskBody,
    requireTaskViewer,
} from "@/lib/tasks/route-helpers";
import { followTask } from "@/lib/tasks/tasks";

type TaskContext = { params: Promise<{ taskId: string }> };

/** Set the caller's follow state. */
export const POST = apiHandler<TaskContext>(async (request, context) => {
    const { taskId } = await (context as TaskContext).params;
    const viewer = await requireTaskViewer(request);
    await enforceTaskWriteRateLimit(viewer);
    const body = await readTaskBody(request);
    if (typeof body.follow !== "boolean")
        throw invalid("follow must be true or false");
    return NextResponse.json(await followTask(viewer, taskId, body.follow));
});
