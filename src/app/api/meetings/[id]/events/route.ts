import { agendaEventStream } from "@/lib/meetings/event-stream";
import { meetingRoute } from "@/lib/meetings/route";

export const dynamic = "force-dynamic";
export const GET = meetingRoute(({ request, userId, params }) =>
    agendaEventStream(request, userId, params.id),
);
