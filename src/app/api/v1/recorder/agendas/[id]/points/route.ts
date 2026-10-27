import { createPointInput } from "@/lib/meetings/model";
import { meetingRoute } from "@/lib/meetings/route";
import { addPoint } from "@/lib/meetings/service";
export const POST = meetingRoute(async ({ userId, params, request }) => {
    const point = await addPoint(userId, params.id, {
        ...createPointInput.parse(await request.json()),
        origin: "live",
    });
    const { summaryOutcome: _outcome, ...livePoint } = point;
    return livePoint;
}, true);
