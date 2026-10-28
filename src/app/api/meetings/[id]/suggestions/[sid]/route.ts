import { z } from "zod";
import { meetingRoute } from "@/lib/meetings/route";
import { decideSuggestion } from "@/lib/meetings/service";
export const PATCH = meetingRoute(async ({ userId, params, request }) => {
    const { state } = z
        .object({ state: z.enum(["added", "dismissed"]) })
        .parse(await request.json());
    await decideSuggestion(userId, params.id, params.sid, state);
});
