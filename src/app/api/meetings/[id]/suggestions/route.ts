import { z } from "zod";
import { dismissSuggestions } from "@/lib/meetings/dismiss-suggestions";
import { meetingRoute } from "@/lib/meetings/route";
import { enqueueAgendaSuggestions } from "@/lib/meetings/suggestions-job";
export const POST = meetingRoute(async ({ userId, params }) =>
    enqueueAgendaSuggestions(userId, params.id),
);

export const PATCH = meetingRoute(async ({ userId, params, request }) => {
    const { kind } = z
        .object({
            state: z.literal("dismissed"),
            kind: z.enum(["ai", "carry_over"]),
        })
        .strict()
        .parse(await request.json());
    await dismissSuggestions(userId, params.id, kind);
});
