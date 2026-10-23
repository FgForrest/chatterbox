import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/errors";
import { readBoundedJson } from "@/lib/http/bounded-json";
import { restoreTaskArchive } from "@/lib/tasks/restore";
import {
    enforceTaskWriteRateLimit,
    invalid,
    requireTaskViewer,
} from "@/lib/tasks/route-helpers";

/** Import extracted task files after restoring the referenced items and people. */
export const POST = apiHandler(async (request) => {
    const viewer = await requireTaskViewer(request);
    await enforceTaskWriteRateLimit(viewer);
    const read = await readBoundedJson(request, 16 * 1024 * 1024);
    if (read.tooLarge) throw invalid("Task archive is too large");
    return NextResponse.json(await restoreTaskArchive(viewer, read.body));
});
