import { NextResponse } from "next/server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { deleteProfile } from "@/lib/profiles/store";
import { editableArchivedProfile, profileRouteActor } from "../../_shared";

type IdContext = { params: Promise<{ id: string }> };

export const DELETE = apiHandler<IdContext>(async (request, context) => {
    const actor = await profileRouteActor(request);
    const { id } = await (context as IdContext).params;
    const { profile } = await editableArchivedProfile(id, actor);
    const result = await deleteProfile({
        ownerUserId: profile.ownerUserId,
        profileId: id,
        actor: actor.actor,
    });
    if (!result)
        throw new AppError(ErrorCode.NOT_FOUND, "Profile not found", 404);
    return NextResponse.json({
        success: true,
        disposition: result.disposition,
    });
});
