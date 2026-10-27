import { z } from "zod";
import { meetingRoute } from "@/lib/meetings/route";
import { getMeeting } from "@/lib/meetings/service";
export const GET = meetingRoute(
    async ({ userId, params, url }) =>
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
    true,
);
