import { meetingRoute } from "@/lib/meetings/route";
import { changePoint } from "@/lib/meetings/service";
export const PATCH = meetingRoute(
    async ({ userId, params, request }) =>
        changePoint(userId, params.id, params.pointId, await request.json()),
    true,
);
