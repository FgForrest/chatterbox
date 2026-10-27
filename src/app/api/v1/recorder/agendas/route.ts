import { AppError, ErrorCode } from "@/lib/errors";
import { meetingDate, meetingRoute } from "@/lib/meetings/route";
import { listMeetings, meetingFolderPaths } from "@/lib/meetings/service";
export const GET = meetingRoute(async ({ userId, url }) => {
    const from = meetingDate(url.searchParams.get("from"), new Date());
    const to = meetingDate(
        url.searchParams.get("to"),
        new Date(from.getTime() + 86400000),
    );
    if (to <= from || to.getTime() - from.getTime() > 31 * 86400000)
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Choose an agenda window of at most 31 days",
            400,
        );
    const rows = await listMeetings(userId, { from, to, includePast: true });
    const folderPath = await meetingFolderPaths(userId);
    return {
        data: rows
            .filter((row) => row.timeSet)
            .map((row) => ({ ...row, folderPath: folderPath(row.folders) })),
    };
}, true);
