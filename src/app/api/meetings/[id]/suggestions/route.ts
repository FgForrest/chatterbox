import { meetingRoute } from "@/lib/meetings/route";
import { enqueueAgendaSuggestions } from "@/lib/meetings/suggestions-job";
export const POST = meetingRoute(async ({ userId, params }) =>
    enqueueAgendaSuggestions(userId, params.id),
);
