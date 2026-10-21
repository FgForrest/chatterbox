import { NextResponse } from "next/server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { isLearnAvailableFor } from "@/lib/knowledge/availability";
import { loadReview, requestedReviewSource } from "@/lib/learn/review";
import { resolveItemProfile } from "@/lib/profiles/resolve";
import { requireLearnAccess } from "@/lib/sharing/learn-access";

type IdContext = { params: Promise<{ id: string }> };

/**
 * The latest Learn run in this view and what it proposed: open when ready,
 * with each item's outcome once finished, and why it failed when it did.
 */
export const GET = apiHandler<IdContext>(async (request, context) => {
    const { id } = await (context as IdContext).params;
    const { access, actorUserId } = await requireLearnAccess(request, id);
    let available = false;
    let availabilityReason: "profile_unavailable" | undefined;
    let profile: Awaited<ReturnType<typeof resolveItemProfile>> | null = null;
    try {
        profile = await resolveItemProfile(
            id,
            access.view,
            access.ownerUserId,
            actorUserId,
        );
    } catch (error) {
        if (!(error instanceof AppError) || error.code !== ErrorCode.CONFLICT) {
            throw error;
        }
        availabilityReason = "profile_unavailable";
    }
    if (profile) {
        available = await isLearnAvailableFor(
            actorUserId,
            profile.settings.steps.learn.provider,
        );
    }
    return NextResponse.json({
        ...(await loadReview(access, requestedReviewSource(request))),
        available,
        ...(availabilityReason ? { availabilityReason } : {}),
    });
});
