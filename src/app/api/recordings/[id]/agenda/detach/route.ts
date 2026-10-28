import { detachAgenda } from "@/lib/meetings/attachment";
import { meetingRoute } from "@/lib/meetings/route";
export const POST = meetingRoute(async ({ userId, params }) =>
    detachAgenda(userId, params.id),
);
