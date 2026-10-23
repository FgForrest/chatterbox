import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/errors";
import { listMyFolderInvitations } from "@/lib/sharing/folder-shares";
import { requirePersonShareSession } from "@/lib/sharing/person-share-routes";
import { listMyInvitations } from "@/lib/sharing/person-shares";

export const GET = apiHandler(async (request) => {
    const session = await requirePersonShareSession(request);
    return NextResponse.json({
        invitations: (
            await Promise.all([
                listMyInvitations(session.user.id),
                listMyFolderInvitations(session.user.id),
            ])
        )
            .flat()
            .sort((a, b) => a.invitedAt.getTime() - b.invitedAt.getTime()),
    });
});
