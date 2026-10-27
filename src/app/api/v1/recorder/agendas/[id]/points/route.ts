import { createPointInput } from "@/lib/meetings/model";
import { meetingRoute } from "@/lib/meetings/route";
import { addPoint } from "@/lib/meetings/service";
export const POST = meetingRoute(
    async ({ userId, params, request }) =>
        addPoint(userId, params.id, {
            ...createPointInput.parse(await request.json()),
            origin: "live",
        }),
    true,
);
