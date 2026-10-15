import { NextResponse } from "next/server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { setDefaultProfile } from "@/lib/profiles/store";
import { editableProfile, profileRouteActor } from "../../_shared";

type IdContext = { params: Promise<{ id: string }> };

export const POST = apiHandler<IdContext>(async (request, context) => {
    const routeActor = await profileRouteActor(request);
    const { id } = await (context as IdContext).params;
    const current = await editableProfile(id, routeActor);
    const changed = await setDefaultProfile({
        ownerUserId: current.profile.ownerUserId,
        profileId: id,
        actor: routeActor.actor,
    });
    if (!changed) {
        throw new AppError(ErrorCode.NOT_FOUND, "Profile not found", 404);
    }
    return NextResponse.json({ success: true });
});
