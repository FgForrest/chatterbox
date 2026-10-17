import { NextResponse } from "next/server";
import { requireApiSessionActor } from "@/lib/auth-server";
import { actsForOrganization } from "@/lib/authz/curator";
import { ALL_ITEM_KINDS } from "@/lib/content/item-kinds";
import { apiHandler } from "@/lib/errors";
import { isLearnAvailableFor } from "@/lib/knowledge/availability";
import { loadReview, requestedReviewSource } from "@/lib/learn/review";
import { resolveItemProfile } from "@/lib/profiles/resolve";
import {
    requestedRecordingView,
    requireRecordingView,
} from "@/lib/sharing/access";
import { assertMayChange } from "@/lib/sharing/writer";

type IdContext = { params: Promise<{ id: string }> };

/**
 * The latest Learn run in this view and what it proposed: open when ready,
 * with each item's outcome once finished, and why it failed when it did.
 */
export const GET = apiHandler<IdContext>(async (request, context) => {
    const { id } = await (context as IdContext).params;
    const { access, actorUserId } = await authorizeLearn(request, id);
    const profile = await resolveItemProfile(
        id,
        access.view,
        access.ownerUserId,
        actorUserId,
    );
    return NextResponse.json({
        ...(await loadReview(access, requestedReviewSource(request))),
        available: await isLearnAvailableFor(
            actorUserId,
            profile.settings.steps.learn.provider,
        ),
    });
});

/**
 * Whoever may change the recording in the view asked for: the owner on
 * the private view; while it is shared, a curator (or the organization
 * account) on the Organization view, who acts for the Organization there
 * only (Learn's unconfirmed suggestions are theirs alone).
 */
async function authorizeLearn(request: Request, recordingId: string) {
    const { session, actor } = await requireApiSessionActor(request);
    const access = await requireRecordingView(
        session.user.id,
        recordingId,
        requestedRecordingView(request),
        { kinds: ALL_ITEM_KINDS },
    );
    const curates = access.view === "org" && (await actsForOrganization(actor));
    assertMayChange(access, session.user.id, curates);
    return { access, actorUserId: session.user.id, curates };
}
