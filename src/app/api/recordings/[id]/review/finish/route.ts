import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { apiHandler } from "@/lib/errors";
import { finishReview, requestedReviewSource } from "@/lib/learn/review";
import { refreshSummaryAfterCorrections } from "@/lib/learn/summary-refresh";
import {
    requestedRecordingView,
    requireRecordingView,
} from "@/lib/sharing/access";
import { assertMayChange } from "@/lib/sharing/writer";

type IdContext = { params: Promise<{ id: string }> };

/**
 * Finish the review: apply what is ticked, remember what is not, in one
 * transaction. `{versions}` are the item versions shown (409 if any
 * changed). A transcript changed since the run answers `superseded`.
 */
export const POST = apiHandler<IdContext>(async (request, context) => {
    const { id } = await (context as IdContext).params;
    const { access, actorUserId } = await authorizeLearn(request, id);
    const body = (await request.json().catch(() => null)) as {
        versions?: unknown;
    } | null;
    const versions =
        body?.versions && typeof body.versions === "object"
            ? Object.fromEntries(
                  Object.entries(
                      body.versions as Record<string, unknown>,
                  ).filter(
                      (entry): entry is [string, number] =>
                          typeof entry[1] === "number",
                  ),
              )
            : {};
    const finished = await finishReview(access, actorUserId, {
        versions,
        source: requestedReviewSource(request),
    });
    // What it applied may change what a summary read.
    if (finished.status === "finished" && finished.applied > 0) {
        await refreshSummaryAfterCorrections({
            ownerUserId: access.ownerUserId,
            recordingId: id,
            view: access.view,
        });
    }
    return NextResponse.json(finished);
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
