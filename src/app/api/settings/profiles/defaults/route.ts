import { NextResponse } from "next/server";
import { z } from "zod";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { profileChannelSchema } from "@/lib/profiles/settings";
import {
    ProfilePermissionError,
    setDefaultProfile,
} from "@/lib/profiles/store";
import { profileRouteActor, validationError } from "../_shared";

const selectionSchema = z
    .object({
        channel: profileChannelSchema,
        profileId: z.string().min(1).nullable(),
    })
    .strict();

export const POST = apiHandler(async (request: Request) => {
    const routeActor = await profileRouteActor(request);
    const parsed = selectionSchema.safeParse(
        await request.json().catch(() => null),
    );
    if (!parsed.success) throw validationError(parsed.error);
    try {
        const changed = await setDefaultProfile({
            ownerUserId: routeActor.userId,
            actor: routeActor.actor,
            channel: parsed.data.channel,
            profileId: parsed.data.profileId,
        });
        if (!changed) {
            throw new AppError(ErrorCode.NOT_FOUND, "Profile not found", 404);
        }
        return NextResponse.json({ success: true });
    } catch (error) {
        if (error instanceof ProfilePermissionError) {
            throw new AppError(
                ErrorCode.FORBIDDEN,
                "This profile is not available as your default",
                403,
            );
        }
        throw error;
    }
});
