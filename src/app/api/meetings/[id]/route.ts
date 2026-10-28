import { z } from "zod";
import { meetingRoute } from "@/lib/meetings/route";
import {
    deleteMeeting,
    getMeeting,
    patchMeeting,
} from "@/lib/meetings/service";
export const GET = meetingRoute(async ({ userId, params, url }) =>
    getMeeting(
        userId,
        params.id,
        url.searchParams.has("since")
            ? z
                  .string()
                  .regex(
                      /^\d+(?::(?:visible|hidden|standalone)(?::(?:queued|running|failed|idle))?)?$/,
                  )
                  .parse(url.searchParams.get("since"))
            : undefined,
    ),
);
export const PATCH = meetingRoute(async ({ userId, params, request }) =>
    patchMeeting(userId, params.id, await request.json()),
);
export const DELETE = meetingRoute(async ({ userId, params }) =>
    deleteMeeting(userId, params.id),
);
