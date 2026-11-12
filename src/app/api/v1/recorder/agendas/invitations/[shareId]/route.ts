import { z } from "zod";
import { notifyRecorderInvitation } from "@/db/queries/recorder-rooms";
import { AppError, ErrorCode } from "@/lib/errors";
import { meetingRoute } from "@/lib/meetings/route";
import {
    changePersonShare,
    listMyInvitations,
} from "@/lib/sharing/person-shares";

export const POST = meetingRoute(async ({ userId, params, request }) => {
    const input = z
        .object({
            action: z.enum(["accept", "decline"]),
            version: z.number().int().nonnegative(),
            folderId: z.string().min(1).max(255).optional(),
        })
        .parse(await request.json());
    const invitation = (await listMyInvitations(userId)).find(
        (row) => row.id === params.shareId && row.kind === "meeting",
    );
    if (!invitation)
        throw new AppError(ErrorCode.NOT_FOUND, "Invitation not found", 404);
    await changePersonShare(userId, params.shareId, input);
    await notifyRecorderInvitation(userId, params.shareId);
}, true);
