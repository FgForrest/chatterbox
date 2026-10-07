import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/errors";
import {
    invalid,
    readTaskBody,
    requireTaskViewer,
} from "@/lib/tasks/route-helpers";
import { acceptReview } from "@/lib/tasks/tasks";

type RecordingContext = { params: Promise<{ id: string }> };

function idList(value: unknown, field: string): string[] {
    if (
        !Array.isArray(value) ||
        value.length > 500 ||
        !value.every((id) => typeof id === "string")
    ) {
        throw invalid(`${field} is a list of ids`, field);
    }
    return value;
}

/**
 * Finish the recording's task review: ticked rows become tasks. Takes the
 * `{proposals, updates}` ids the reviewer saw; 409 when they changed.
 */
export const POST = apiHandler<RecordingContext>(async (request, context) => {
    const { id } = await (context as RecordingContext).params;
    const viewer = await requireTaskViewer(request);
    const body = await readTaskBody(request);
    return NextResponse.json(
        await acceptReview(viewer, id, {
            proposals: idList(body.proposals, "proposals"),
            updates: idList(body.updates, "updates"),
        }),
    );
});
