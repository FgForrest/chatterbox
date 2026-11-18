import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/errors";
import { requireTaskViewer } from "@/lib/tasks/route-helpers";
import { listTrackedAssignees } from "@/lib/tasks/tasks";

/** Assignees of the caller's task tab and folder, across states and due dates. */
export const GET = apiHandler(async (request) => {
    const viewer = await requireTaskViewer(request);
    const params = new URL(request.url).searchParams;
    const assignees = await listTrackedAssignees(
        viewer,
        params.get("organization") === "true",
        params.get("tab") === "all" ? "all" : "followed",
        params.get("folder") || null,
    );
    return NextResponse.json({ assignees });
});
