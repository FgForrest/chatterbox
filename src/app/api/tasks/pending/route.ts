import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/errors";
import { requireTaskViewer } from "@/lib/tasks/route-helpers";
import { listRoutedTaskProposals } from "@/lib/tasks/routing";
import { countNewTasks, markTasksSeen } from "@/lib/tasks/tasks";

/** Tasks assigned to the caller since they last opened the list: the badge. */
export const GET = apiHandler(async (request) => {
    const viewer = await requireTaskViewer(request);
    const includeProposals =
        new URL(request.url).searchParams.get("include") === "proposals";
    const [count, proposals] = await Promise.all([
        countNewTasks(viewer),
        includeProposals
            ? listRoutedTaskProposals(viewer)
            : Promise.resolve([]),
    ]);
    return NextResponse.json({ count, ...(includeProposals && { proposals }) });
});

/** The caller opened their task list. */
export const POST = apiHandler(async (request) => {
    const viewer = await requireTaskViewer(request);
    await markTasksSeen(viewer);
    return NextResponse.json({ count: 0 });
});
