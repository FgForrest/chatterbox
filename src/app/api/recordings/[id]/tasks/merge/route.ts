import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/errors";
import {
    invalid,
    readTaskBody,
    requireTaskViewer,
} from "@/lib/tasks/route-helpers";
import { mergeProposals } from "@/lib/tasks/tasks";

type RecordingContext = { params: Promise<{ id: string }> };

/** Fold proposals into the first of `{taskIds}`; returns the one left. */
export const POST = apiHandler<RecordingContext>(async (request, context) => {
    const { id } = await (context as RecordingContext).params;
    const viewer = await requireTaskViewer(request);
    const body = await readTaskBody(request);
    const ids = body.taskIds;
    if (
        !Array.isArray(ids) ||
        ids.length > 50 ||
        !ids.every((value) => typeof value === "string")
    ) {
        throw invalid("taskIds is a list of task ids", "taskIds");
    }
    return NextResponse.json(await mergeProposals(viewer, id, ids));
});
