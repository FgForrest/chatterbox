import { NextResponse } from "next/server";
import { z } from "zod";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { duplicateProfile } from "@/lib/profiles/store";
import {
    availableProfile,
    profileDetail,
    profileRouteActor,
    validationError,
} from "../../_shared";

type IdContext = { params: Promise<{ id: string }> };

const duplicateSchema = z
    .object({ name: z.string().trim().min(1).max(200).optional() })
    .strict();

export const POST = apiHandler<IdContext>(async (request, context) => {
    const routeActor = await profileRouteActor(request);
    const { id } = await (context as IdContext).params;
    const source = await availableProfile(id, routeActor);
    if (routeActor.actor.kind !== "user") {
        throw new AppError(
            ErrorCode.FORBIDDEN,
            "The Organization account has no personal profile scope",
            403,
        );
    }
    const parsed = duplicateSchema.safeParse(
        await request.json().catch(() => ({})),
    );
    if (!parsed.success) throw validationError(parsed.error);
    const profile = await duplicateProfile({
        sourceOwnerUserId: source.profile.ownerUserId,
        profileId: id,
        actor: routeActor.actor,
        name: parsed.data.name,
    });
    return NextResponse.json(
        { profile: await profileDetail(profile, routeActor.actor) },
        { status: 201 },
    );
});
