import { z } from "zod";
import {
    inviteRecorderAgendaPeople,
    recorderAgendaPeople,
} from "@/lib/meetings/rooms";
import { meetingRoute } from "@/lib/meetings/route";

export const GET = meetingRoute(
    async ({ userId, params }) => ({
        data: await recorderAgendaPeople(userId, params.id),
    }),
    true,
);

export const POST = meetingRoute(async ({ userId, params, request }) => {
    const { receiverIds } = z
        .object({
            receiverIds: z.array(z.string().min(1).max(255)).min(1).max(20),
        })
        .parse(await request.json());
    return {
        data: await inviteRecorderAgendaPeople(userId, params.id, receiverIds),
    };
}, true);
