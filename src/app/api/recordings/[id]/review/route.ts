import { NextResponse } from "next/server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { isLearnAvailableFor } from "@/lib/knowledge/availability";
import {
    learnQuickFinishPolicy,
    loadReview,
    requestedReviewSource,
    touchLearnReview,
} from "@/lib/learn/review";
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
    const [review, quickFinish] = await Promise.all([
        loadReview(access, requestedReviewSource(request)),
        profile
            ? learnQuickFinishPolicy(access)
            : Promise.resolve({ automaticSummary: false, skipTasks: false }),
    ]);
    return NextResponse.json({
        ...review,
        available,
        quickFinish,
        ...(availabilityReason ? { availabilityReason } : {}),
    });
});

export const PATCH = apiHandler<IdContext>(async (request, context) => {
    const { id } = await (context as IdContext).params;
    const { access } = await requireLearnAccess(request, id);
    await touchLearnReview(access, requestedReviewSource(request));
    return NextResponse.json({ changed: true });
});
