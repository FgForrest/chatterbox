import { meetingRoute } from "@/lib/meetings/route";
import { addPoint } from "@/lib/meetings/service";
export const POST = meetingRoute(async ({ userId, params, request }) =>
    addPoint(userId, params.id, await request.json()),
);
