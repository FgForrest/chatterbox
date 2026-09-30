import { NextResponse } from "next/server";
import { dueOnWithdrawal } from "@/db/queries/retention";
import { requireApiSession } from "@/lib/auth-server";
import { apiHandler } from "@/lib/errors";
import {
    requestedRecordingView,
    requireRecordingView,
} from "@/lib/sharing/access";
import { assertMayChange } from "@/lib/sharing/writer";

type IdContext = { params: Promise<{ id: string }> };

/**
 * What the owner's retention would remove from a shared recording at its
 * next sweep, were it withdrawn now, for the withdraw confirmation to warn
 * about. Asked by whoever may withdraw it: the owner on the private view,
 * the organization account on the Organization view (Johnny, 2026-09-28:
 * the curator sees and confirms the owner's warning). Read-only.
 */
export const GET = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const view = requestedRecordingView(request);
    const access = await requireRecordingView(session.user.id, id, view);
    if (view === "org") assertMayChange(access, session.user.id);
    return NextResponse.json({
        due: await dueOnWithdrawal(id, access.ownerUserId),
    });
});
