import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { apiHandler } from "@/lib/errors";
import { loadReview } from "@/lib/learn/review";
import {
    requestedRecordingView,
    requireRecordingView,
} from "@/lib/sharing/access";
import { assertMayChange } from "@/lib/sharing/writer";

type IdContext = { params: Promise<{ id: string }> };

/** The latest Learn run in this view and, when ready, what it proposed. */
export const GET = apiHandler<IdContext>(async (request, context) => {
    const { id } = await (context as IdContext).params;
    const { access } = await authorizeLearn(request, id);
    return NextResponse.json(await loadReview(access));
});

/**
 * Whoever may change the recording in the view asked for: the owner on
 * the private view; while it is shared, the organization account on the
 * Organization view (Learn's unconfirmed suggestions are theirs alone).
 */
async function authorizeLearn(request: Request, recordingId: string) {
    const session = await requireApiSession(request);
    const access = await requireRecordingView(
        session.user.id,
        recordingId,
        requestedRecordingView(request),
    );
    assertMayChange(access, session.user.id);
    return { access, actorUserId: session.user.id };
}
