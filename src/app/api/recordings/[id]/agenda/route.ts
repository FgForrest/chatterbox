import { AppError, ErrorCode } from "@/lib/errors";
import { meetingRoute } from "@/lib/meetings/route";
import { getMeeting } from "@/lib/meetings/service";
import { requireRecordingAccess } from "@/lib/sharing/access";

export const GET = meetingRoute(async ({ userId, params }) => {
    await requireRecordingAccess(userId, params.id);
    try {
        return { agenda: await getMeeting(userId, params.id) };
    } catch (error) {
        if (error instanceof AppError && error.code === ErrorCode.NOT_FOUND)
            return { agenda: null };
        throw error;
    }
});
