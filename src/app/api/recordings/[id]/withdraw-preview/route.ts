import { NextResponse } from "next/server";
import { dueOnWithdrawal } from "@/db/queries/retention";
import { requireApiSession } from "@/lib/auth-server";
import { apiHandler } from "@/lib/errors";
import { requireRecordingView } from "@/lib/sharing/access";

type IdContext = { params: Promise<{ id: string }> };

/**
 * What the owner's retention would remove from a shared recording at its
 * next sweep, were it withdrawn now, for the withdraw confirmation to warn
 * about. Owner only; read-only.
 */
export const GET = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    await requireRecordingView(session.user.id, id, "private");
    return NextResponse.json({
        due: await dueOnWithdrawal(id, session.user.id),
    });
});
