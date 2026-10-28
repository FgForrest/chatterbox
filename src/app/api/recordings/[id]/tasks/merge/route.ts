import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/errors";
import { readEventOrigin } from "@/lib/events/origin";
import { searchMergeCandidates } from "@/lib/tasks/proposals";
import {
    enforceTaskMergeSearchRateLimit,
    invalid,
    readTaskBody,
    requireTaskViewer,
} from "@/lib/tasks/route-helpers";
import { mergeProposals, mergeTaskIntoTask } from "@/lib/tasks/tasks";

type RecordingContext = { params: Promise<{ id: string }> };

function boundedInteger(
    value: string | null,
    fallback: number,
    maximum: number,
): number {
    if (value === null) return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > maximum) {
        throw invalid(`Value must be an integer from 0 to ${maximum}`);
    }
    return parsed;
}

/** Search all open merge targets in this item's folder scope. */
export const GET = apiHandler<RecordingContext>(async (request, context) => {
    const { id } = await (context as RecordingContext).params;
    const viewer = await requireTaskViewer(request);
    await enforceTaskMergeSearchRateLimit(viewer);
    const params = new URL(request.url).searchParams;
    const limit = boundedInteger(params.get("limit"), 20, 50);
    if (limit === 0) throw invalid("limit must be at least 1", "limit");
    return NextResponse.json(
        await searchMergeCandidates(viewer, id, {
            text: params.get("q") ?? "",
            sourceTaskId: params.get("sourceTaskId"),
            offset: boundedInteger(params.get("offset"), 0, 10_000),
            limit,
        }),
    );
});

/** Fold proposals into the first of `{taskIds}`; returns the one left. */
export const POST = apiHandler<RecordingContext>(async (request, context) => {
    const { id } = await (context as RecordingContext).params;
    const viewer = await requireTaskViewer(request);
    const body = await readTaskBody(request);
    if (
        typeof body.sourceTaskId === "string" &&
        typeof body.targetTaskId === "string"
    ) {
        return NextResponse.json(
            await mergeTaskIntoTask(
                viewer,
                body.sourceTaskId,
                body.targetTaskId,
                { reviewItemId: id },
                readEventOrigin(request.headers),
            ),
        );
    }
    const ids = body.taskIds;
    if (
        !Array.isArray(ids) ||
        ids.length > 50 ||
        !ids.every((value) => typeof value === "string")
    ) {
        throw invalid("taskIds is a list of task ids", "taskIds");
    }
    return NextResponse.json(
        await mergeProposals(viewer, id, ids, readEventOrigin(request.headers)),
    );
});
