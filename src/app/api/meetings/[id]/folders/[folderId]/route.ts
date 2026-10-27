import { AppError, ErrorCode } from "@/lib/errors";
import { removeRecordingFromFolder } from "@/lib/folders/folders";
import { requireMeetingAccess } from "@/lib/meetings/access";
import { meetingRoute } from "@/lib/meetings/route";

export const DELETE = meetingRoute(async ({ userId, params }) => {
    const access = await requireMeetingAccess(userId, params.id);
    if (!access.agenda.meetingItemId || access.agenda.recordingItemId)
        throw new AppError(
            ErrorCode.CONFLICT,
            "An absorbed agenda is read-only",
            409,
        );
    await removeRecordingFromFolder({
        userId,
        recordingId: access.agenda.meetingItemId,
        folderId: params.folderId,
    });
});
