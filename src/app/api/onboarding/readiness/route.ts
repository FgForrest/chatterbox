import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { apiHandler } from "@/lib/errors";
import {
    loadOnboardingCapabilities,
    loadOnboardingReadiness,
} from "@/lib/onboarding/readiness";

export const GET = apiHandler(async (request) => {
    const session = await requireApiSession(request);
    const capabilities = await loadOnboardingCapabilities(session.user.id);
    return NextResponse.json(
        await loadOnboardingReadiness(session.user.id, capabilities),
        {
            headers: { "Cache-Control": "private, no-store" },
        },
    );
});
