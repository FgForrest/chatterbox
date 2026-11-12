import { z } from "zod";
import { removeRecorderPresence } from "@/db/queries/recorder-rooms";
import { AppError, ErrorCode } from "@/lib/errors";
import { recorderRoomKey } from "@/lib/meetings/room-key";
import { recorderPanelPresence } from "@/lib/meetings/rooms";
import { meetingRoute } from "@/lib/meetings/route";

const input = z.object({
    meetCode: z.string().max(64),
    agendaId: z.string().min(1).max(255).nullable().default(null),
});

export const POST = meetingRoute(async ({ userId, request }) => {
    const body = input.parse(await request.json());
    return recorderPanelPresence(userId, body.meetCode, body.agendaId);
}, true);

export const DELETE = meetingRoute(async ({ userId, request }) => {
    const body = input.parse(await request.json());
    const key = recorderRoomKey(body.meetCode);
    if (!key)
        throw new AppError(ErrorCode.INVALID_INPUT, "Invalid room code", 400);
    await removeRecorderPresence(userId, key);
}, true);
