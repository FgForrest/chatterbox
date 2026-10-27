import { db } from "@/db";
import { findMeeting, type MeetingExecutor } from "@/db/queries/meetings";
import { userCuratesOrganizationNow } from "@/lib/authz/curator";
import { AppError, ErrorCode } from "@/lib/errors";
import { assertOrgScopeWritable, getOrgUserId } from "@/lib/org/config";
import { isRecordingShared } from "@/lib/sharing/shared";

export interface MeetingViewer {
    userId: string;
    orgUserId: string | null;
    curator: boolean;
}

/** Resolve authority before entering a transaction to avoid pooled connection recursion. */
export async function meetingViewer(userId: string): Promise<MeetingViewer> {
    const [orgUserId, curator] = await Promise.all([
        getOrgUserId(),
        userCuratesOrganizationNow(userId),
    ]);
    return { userId, orgUserId, curator };
}

/** One access boundary for web, recorder and MCP; absorbed agendas are read-only. */
export async function requireMeetingAccess(
    userId: string,
    id: string,
    mode: "view" | "edit" | "manage" = "view",
    options: {
        viewer?: MeetingViewer;
        executor?: MeetingExecutor;
        lock?: boolean;
    } = {},
) {
    const viewer = options.viewer ?? (await meetingViewer(userId));
    const executor = options.executor ?? db;
    const row = await findMeeting(
        userId,
        viewer.orgUserId,
        id,
        executor,
        options.lock,
    );
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, "Meeting not found", 404);
    const shared = viewer.orgUserId
        ? await isRecordingShared(row.item.id, viewer.orgUserId, executor)
        : false;
    const manage = row.agenda.userId === userId || (shared && viewer.curator);
    if (mode !== "view") {
        if (row.agenda.recordingItemId)
            throw new AppError(
                ErrorCode.CONFLICT,
                "An absorbed agenda is read-only",
                409,
            );
        if (shared) assertOrgScopeWritable();
        if (mode === "manage" && !manage)
            throw new AppError(
                ErrorCode.FORBIDDEN,
                "Only the author or an Organization curator may manage this meeting",
                403,
            );
    }
    return {
        ...row,
        viewer,
        shared,
        permissions: {
            view: true,
            edit: !row.agenda.recordingItemId,
            manage: manage && !row.agenda.recordingItemId,
        },
    };
}
