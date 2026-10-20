import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/errors";
import { requireTaskViewer } from "@/lib/tasks/route-helpers";
import { listTrackedAssignees } from "@/lib/tasks/tasks";

/** Assignees of all the caller's Tracked tasks, across states and filters. */
export const GET = apiHandler(async (request) => {
    const viewer = await requireTaskViewer(request);
    const assignees = await listTrackedAssignees(viewer);
    return NextResponse.json({ assignees });
});
