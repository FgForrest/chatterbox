import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/errors";
import { requireTaskViewer } from "@/lib/tasks/route-helpers";
import { listTrackedAssignees } from "@/lib/tasks/tasks";

/** Assignees of all the caller's Tracked tasks, across states and filters. */
export const GET = apiHandler(async (request) => {
    const viewer = await requireTaskViewer(request);
    const assignees = await listTrackedAssignees(
        viewer,
        new URL(request.url).searchParams.get("organization") === "true",
    );
    return NextResponse.json({ assignees });
});
