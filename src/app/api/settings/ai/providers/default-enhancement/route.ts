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

/** Set the authoritative summary-provider pointer and its row mirror. */
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

    // The managed transcription entry is not a credential row and holds
    // no key that could reach a chat/completions endpoint.
    if (isRiffadoIncludedProviderId(providerId)) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            `${RIFFADO_INCLUDED_PROVIDER_LABEL} transcribes only. Pick another provider for summaries.`,
            400,
            { field: "providerId" },
        );
    }

    await validateDefaultProviderSelection({
        actorUserId: session.user.id,
        role: "summary",
        providerId,
    });
    await setDefaultProvider(session.user.id, "summary", providerId);

    return NextResponse.json({ success: true });
});

export const DELETE = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);
    await setDefaultProvider(session.user.id, "summary", null);
    return NextResponse.json({ success: true });
});
