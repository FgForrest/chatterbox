import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/errors";
import { readEventOrigin } from "@/lib/events/origin";
import {
    searchAssignedMergeCandidates,
    searchMergeCandidates,
} from "@/lib/tasks/proposals";
import {
    enforceTaskMergeSearchRateLimit,
    enforceTaskWriteRateLimit,
    invalid,
    readTaskBody,
    readVersion,
    requireTaskViewer,
} from "@/lib/tasks/route-helpers";
import {
    getCallerTask,
    mergeTaskIntoTask,
    previewTaskMerge,
} from "@/lib/tasks/tasks";

type TaskContext = { params: Promise<{ taskId: string }> };

/** Merge this task into `{targetTaskId}` under the task merge rights. */
export const POST = apiHandler<TaskContext>(async (request, context) => {
    const { taskId } = await (context as TaskContext).params;
    const viewer = await requireTaskViewer(request);
    await enforceTaskWriteRateLimit(viewer);
    const body = await readTaskBody(request);
    if (typeof body.targetTaskId !== "string") {
        throw invalid("targetTaskId is required", "targetTaskId");
    }
    return NextResponse.json(
        await mergeTaskIntoTask(
            viewer,
            taskId,
            body.targetTaskId,
            {
                sourceVersion: readVersion(body.sourceVersion),
                targetVersion: readVersion(body.targetVersion),
                confirmPrivateToShared: body.confirmPrivateToShared === true,
            },
            readEventOrigin(request.headers),
        ),
    );
});

/** Search candidates, or preview a selected merge without changing either task. */
export const GET = apiHandler<TaskContext>(async (request, context) => {
    const { taskId } = await (context as TaskContext).params;
    const viewer = await requireTaskViewer(request);
    await enforceTaskMergeSearchRateLimit(viewer);
    const params = new URL(request.url).searchParams;
    const target = params.get("target");
    if (target)
        return NextResponse.json(
            await previewTaskMerge(viewer, taskId, target),
        );
    const task = await getCallerTask(viewer, taskId);
    if (!task?.canMerge) throw invalid("Task cannot be merged");
    const query = {
        text: params.get("q") ?? "",
        offset: Math.max(0, Number(params.get("offset")) || 0),
        limit: 20,
        sourceTaskId: taskId,
    };
    const assigned = await searchAssignedMergeCandidates(viewer, taskId, query);
    return NextResponse.json(
        assigned ??
            (task.recordingId
                ? await searchMergeCandidates(viewer, task.recordingId, query)
                : { candidates: [], nextOffset: null }),
    );
});
