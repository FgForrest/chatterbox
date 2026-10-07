import { NextResponse } from "next/server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import {
    invalid,
    optionalNullableString,
    readTaskBody,
    requireTaskViewer,
} from "@/lib/tasks/route-helpers";
import { addTask, listRecordingTasks } from "@/lib/tasks/tasks";

type RecordingContext = { params: Promise<{ id: string }> };

/** The recording's tasks; for its reviewer also the proposals waiting. */
export const GET = apiHandler<RecordingContext>(async (request, context) => {
    const { id } = await (context as RecordingContext).params;
    const viewer = await requireTaskViewer(request);
    const tasks = await listRecordingTasks(viewer, id);
    if (!tasks) {
        throw new AppError(
            ErrorCode.RECORDING_NOT_FOUND,
            "Recording not found",
            404,
        );
    }
    return NextResponse.json(tasks);
});

/**
 * Add a task by hand: `{text, assigneePersonId?, dueDate?, status}`, status
 * `proposed` (a row of the review) or `open`.
 */
export const POST = apiHandler<RecordingContext>(async (request, context) => {
    const { id } = await (context as RecordingContext).params;
    const viewer = await requireTaskViewer(request);
    const body = await readTaskBody(request);
    if (typeof body.text !== "string")
        throw invalid("text is required", "text");
    if (body.status !== "proposed" && body.status !== "open") {
        throw invalid("status is proposed or open", "status");
    }
    const task = await addTask(viewer, id, {
        text: body.text,
        assigneePersonId: optionalNullableString(body, "assigneePersonId"),
        dueDate: optionalNullableString(body, "dueDate"),
        status: body.status,
    });
    return NextResponse.json(task, { status: 201 });
});
