import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/errors";
import {
    enforceTaskWriteRateLimit,
    requireTaskViewer,
} from "@/lib/tasks/route-helpers";
import { undoTaskMatch } from "@/lib/tasks/tasks";

type MatchContext = { params: Promise<{ id: string; taskId: string }> };

/** Undo an accepted match from this item while retaining applied task fields. */
export const DELETE = apiHandler<MatchContext>(async (request, context) => {
    const { id, taskId } = await (context as MatchContext).params;
    const viewer = await requireTaskViewer(request);
    await enforceTaskWriteRateLimit(viewer);
    await undoTaskMatch(viewer, id, taskId);
    return new NextResponse(null, { status: 204 });
});
