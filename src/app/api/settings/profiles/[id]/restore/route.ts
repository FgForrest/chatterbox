import { NextResponse } from "next/server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { restoreProfile } from "@/lib/profiles/store";
import { editableArchivedProfile, profileRouteActor } from "../../_shared";

type IdContext = { params: Promise<{ id: string }> };

export const POST = apiHandler<IdContext>(async (request, context) => {
    const routeActor = await profileRouteActor(request);
    const { id } = await (context as IdContext).params;
    const current = await editableArchivedProfile(id, routeActor);
    const restored = await restoreProfile({
        ownerUserId: current.profile.ownerUserId,
        profileId: id,
        actor: routeActor.actor,
    });
    if (!restored) {
        throw new AppError(ErrorCode.NOT_FOUND, "Profile not found", 404);
    }
    return NextResponse.json({ success: true });
});
