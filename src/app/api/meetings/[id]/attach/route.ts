import { z } from "zod";
import { attachAgenda } from "@/lib/meetings/attachment";
import { meetingRoute } from "@/lib/meetings/route";
export const POST = meetingRoute(async ({ userId, params, request }) => {
    const input = z
        .object({
            recordingItemId: z.string().min(1).max(255),
            shareRecording: z.boolean().optional(),
        })
        .parse(await request.json());
    return attachAgenda(
        userId,
        params.id,
        input.recordingItemId,
        input.shareRecording,
    );
});
