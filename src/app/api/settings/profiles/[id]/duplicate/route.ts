import { NextResponse } from "next/server";
import { z } from "zod";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { getOrgUserId } from "@/lib/org/config";
import { mayEditProfile } from "@/lib/profiles/access";
import { duplicateProfile } from "@/lib/profiles/store";
import {
    availableProfile,
    profileDetail,
    profileRouteActor,
    profileScopeSchema,
    validationError,
} from "../../_shared";

type IdContext = { params: Promise<{ id: string }> };

const duplicateSchema = z
    .object({
        name: z.string().trim().min(1).max(200).optional(),
        scope: profileScopeSchema.default("personal"),
    })
    .strict();

export const POST = apiHandler<IdContext>(async (request, context) => {
    const routeActor = await profileRouteActor(request);
    const { id } = await (context as IdContext).params;
    const source = await availableProfile(id, routeActor);
    const parsed = duplicateSchema.safeParse(
        await request.json().catch(() => ({})),
    );
    if (!parsed.success) throw validationError(parsed.error);
    const scope = parsed.data.scope;
    const ownerUserId =
        scope === "organization" ? await getOrgUserId() : routeActor.userId;
    if (
        !ownerUserId ||
        !(await mayEditProfile(routeActor.actor, { ownerUserId, scope }))
    ) {
        throw new AppError(
            ErrorCode.FORBIDDEN,
            "You cannot create a profile in this scope",
            403,
        );
    }
    const profile = await duplicateProfile({
        sourceOwnerUserId: source.profile.ownerUserId,
        profileId: id,
        actor: routeActor.actor,
        name: parsed.data.name,
        scope,
        locale: routeActor.locale,
    });
    return NextResponse.json(
        { profile: await profileDetail(profile, routeActor.actor) },
        { status: 201 },
    );
});
