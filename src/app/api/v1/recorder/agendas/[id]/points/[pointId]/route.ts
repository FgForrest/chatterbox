import { patchPointInput } from "@/lib/meetings/model";
import { meetingRoute } from "@/lib/meetings/route";
import { changePoint } from "@/lib/meetings/service";
export const PATCH = meetingRoute(
    async ({ userId, params, request }) =>
        changePoint(
            userId,
            params.id,
            params.pointId,
            patchPointInput
                .pick({ version: true, discussed: true, note: true })
                .strict()
                .parse(await request.json()),
        ),
    true,
);
