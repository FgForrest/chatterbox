import { agendaCandidates } from "@/lib/meetings/attachment";
import { meetingRoute } from "@/lib/meetings/route";
export const GET = meetingRoute(async ({ userId, params }) => ({
    candidates: await agendaCandidates(userId, params.id),
}));
