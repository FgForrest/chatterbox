import { z } from "zod";
import { meetingRoute } from "@/lib/meetings/route";
import { changePoint } from "@/lib/meetings/service";
export const PATCH = meetingRoute(async ({ userId, params, request }) =>
    changePoint(userId, params.id, params.pointId, await request.json()),
);
export const DELETE = meetingRoute(async ({ userId, params, url }) =>
    changePoint(
        userId,
        params.id,
        params.pointId,
        {
            version: z.coerce
                .number()
                .int()
                .nonnegative()
                .parse(url.searchParams.get("version")),
        },
        true,
    ),
);
