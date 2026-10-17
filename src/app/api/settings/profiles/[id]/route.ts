import { NextResponse } from "next/server";
import { z } from "zod";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { validateProfileProviderPins } from "@/lib/profiles/providers";
import {
    archiveProfile,
    DefaultProfileArchiveError,
    deletePersonalProfile,
    ProfileVersionConflictError,
    updateProfile,
} from "@/lib/profiles/store";
import {
    availableProfile,
    builtinPromptTexts,
    editableProfile,
    parseSettings,
    profileDetail,
    profileRouteActor,
    validationError,
} from "../_shared";

type IdContext = { params: Promise<{ id: string }> };

const updateSchema = z
    .object({
        expectedVersion: z.number().int().min(1),
        name: z.string().trim().min(1).max(200).optional(),
        description: z.string().max(2000).nullable().optional(),
        settings: z.unknown().optional(),
    })
    .strict();

export const GET = apiHandler<IdContext>(async (request, context) => {
    const routeActor = await profileRouteActor(request);
    const { id } = await (context as IdContext).params;
    const { profile } = await availableProfile(id, routeActor);
    return NextResponse.json({
        profile: await profileDetail(profile, routeActor.actor),
        ...builtinPromptTexts(profile),
    });
});

export const PUT = apiHandler<IdContext>(async (request, context) => {
    const routeActor = await profileRouteActor(request);
    const { id } = await (context as IdContext).params;
    const current = await editableProfile(id, routeActor);
    const parsed = updateSchema.safeParse(
        await request.json().catch(() => null),
    );
    if (!parsed.success) throw validationError(parsed.error);
    const body = parsed.data;
    const settings =
        body.settings === undefined
            ? undefined
            : parseSettings(current.profile.channel, body.settings);
    if (settings) {
        await validateProfileProviderPins({
            actorUserId: routeActor.userId,
            profileOwnerUserId: current.profile.ownerUserId,
            profileScope: current.profile.scope,
            settings,
        });
    }
    try {
        const profile = await updateProfile({
            ownerUserId: current.profile.ownerUserId,
            profileId: id,
            actor: routeActor.actor,
            expectedVersion: body.expectedVersion,
            name: body.name,
            description: body.description,
            settings,
        });
        if (!profile) {
            throw new AppError(ErrorCode.NOT_FOUND, "Profile not found", 404);
        }
        return NextResponse.json({
            profile: await profileDetail(profile, routeActor.actor),
        });
    } catch (error) {
        if (error instanceof ProfileVersionConflictError) {
            throw new AppError(ErrorCode.CONFLICT, error.message, 409, {
                currentVersion: error.actualVersion,
            });
        }
        throw error;
    }
});

export const DELETE = apiHandler<IdContext>(async (request, context) => {
    const routeActor = await profileRouteActor(request);
    const { id } = await (context as IdContext).params;
    const current = await editableProfile(id, routeActor);
    try {
        if (current.profile.scope === "personal") {
            const result = await deletePersonalProfile({
                ownerUserId: current.profile.ownerUserId,
                profileId: id,
                actor: routeActor.actor,
            });
            if (!result) {
                throw new AppError(
                    ErrorCode.NOT_FOUND,
                    "Profile not found",
                    404,
                );
            }
            return NextResponse.json({
                success: true,
                disposition: result.disposition,
            });
        }
        const archived = await archiveProfile({
            ownerUserId: current.profile.ownerUserId,
            profileId: id,
            actor: routeActor.actor,
        });
        if (!archived) {
            throw new AppError(ErrorCode.NOT_FOUND, "Profile not found", 404);
        }
        return NextResponse.json({ success: true, disposition: "archive" });
    } catch (error) {
        if (error instanceof DefaultProfileArchiveError) {
            throw new AppError(ErrorCode.CONFLICT, error.message, 409);
        }
        throw error;
    }
});
