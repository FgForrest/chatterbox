import { NextResponse } from "next/server";
import { z } from "zod";
import { setDefaultProvider } from "@/lib/ai/default-provider";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { validateDefaultProviderSelection } from "@/lib/profiles/providers";
import {
    isRiffadoIncludedProviderId,
    RIFFADO_INCLUDED_PROVIDER_LABEL,
} from "@/lib/transcription/included-provider";

const bodySchema = z.object({
    providerId: z.string().min(1),
});

/**
 * Mark the provider Learn runs on, where it should differ from the
 * enhancement default: a stronger model for learning than for summaries,
 * say (the same bridge added twice, with two models). The mirror of
 * `default-enhancement`: clear every other row, then mark this one, in one
 * transaction.
 */
export const PUT = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);

    const raw = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Invalid request body",
            400,
            { issues: parsed.error.flatten() },
        );
    }
    const { providerId } = parsed.data;

    if (isRiffadoIncludedProviderId(providerId)) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            `${RIFFADO_INCLUDED_PROVIDER_LABEL} transcribes only. Pick another provider for Learn.`,
            400,
            { field: "providerId" },
        );
    }

    await validateDefaultProviderSelection({
        actorUserId: session.user.id,
        role: "learn",
        providerId,
    });
    await setDefaultProvider(session.user.id, "learn", providerId);

    return NextResponse.json({ success: true });
});

/** Unmark it: Learn follows the enhancement default again. */
export const DELETE = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);
    await setDefaultProvider(session.user.id, "learn", null);
    return NextResponse.json({ success: true });
});
