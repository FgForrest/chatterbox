import { z } from "zod";
import {
    agendaRecordingShareOffer,
    inviteAgendaPeopleToRecording,
} from "@/lib/meetings/person-sharing";
import { meetingRoute } from "@/lib/meetings/route";

export const GET = meetingRoute(async ({ userId, params, url }) =>
    agendaRecordingShareOffer(
        userId,
        params.id,
        z
            .string()
            .min(1)
            .max(255)
            .parse(url.searchParams.get("recordingItemId")),
    ),
);

export const POST = meetingRoute(async ({ userId, params, request }) => {
    const input = z
        .object({
            recordingItemId: z.string().min(1).max(255),
            taskSource: z.boolean().optional(),
        })
        .parse(await request.json());
    return {
        recordingShare: await inviteAgendaPeopleToRecording(
            userId,
            params.id,
            input.recordingItemId,
            input.taskSource,
        ),
    };
});
