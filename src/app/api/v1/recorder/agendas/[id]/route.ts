import { z } from "zod";
import { meetingRoute } from "@/lib/meetings/route";
import { getMeeting } from "@/lib/meetings/service";
export const GET = meetingRoute(async ({ userId, params, url }) => {
    const detail = await getMeeting(
        userId,
        params.id,
        url.searchParams.has("since")
            ? z
                  .string()
                  .regex(
                      /^\d+(?::(?:visible|hidden|standalone)(?::(?:queued|running|failed|idle))?)?(?::p[0-9a-f]{16})?$/,
                  )
                  .parse(url.searchParams.get("since"))
            : undefined,
    );
    if (detail.unchanged) return detail;
    const {
        outcomeUnplanned: _unplanned,
        outcomeSummaryId: _summaryId,
        taskSourceItemId: _taskSourceId,
        noTaskSource: _noTaskSource,
        snapshotSourceItemId: _snapshotSourceId,
        taskSource: _taskSource,
        redirectTo: _redirect,
        points,
        pointTree: _pointTree,
        ...agenda
    } = detail;
    return {
        ...agenda,
        own: detail.userId === userId,
        points: points.map(({ summaryOutcome: _outcome, ...point }) => ({
            ...point,
            canEditText:
                detail.permissions.edit &&
                (detail.permissions.manage || point.authorUserId === userId),
        })),
    };
}, true);
