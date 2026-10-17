import { NextResponse } from "next/server";
import { z } from "zod";
import { setDefaultProvider } from "@/lib/ai/default-provider";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { validateDefaultProviderSelection } from "@/lib/profiles/providers";

const bodySchema = z.object({ providerId: z.string().min(1) });

export const PUT = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Invalid request body",
            400,
        );
    }
    const providerId = parsed.data.providerId;
    await validateDefaultProviderSelection({
        actorUserId: session.user.id,
        role: "title",
        providerId,
    });
    await setDefaultProvider(session.user.id, "title", providerId);
    return NextResponse.json({ success: true });
});

export const DELETE = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);
    await setDefaultProvider(session.user.id, "title", null);
    return NextResponse.json({ success: true });
});
