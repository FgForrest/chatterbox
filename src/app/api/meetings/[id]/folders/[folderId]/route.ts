import { meetingRoute } from "@/lib/meetings/route";
import { removeMeetingFromFolder } from "@/lib/meetings/service";

export const DELETE = meetingRoute(async ({ userId, params }) => {
    await removeMeetingFromFolder(userId, params.id, params.folderId);
});
