import { NextResponse } from "next/server";
import { requireApiSessionActor } from "@/lib/auth-server";
import { apiHandler } from "@/lib/errors";
import {
    organizationProviderManageContext,
    organizationProviderUsage,
} from "@/lib/profiles/organization-providers";

export const GET = apiHandler(async (request: Request) => {
    const { session, actor } = await requireApiSessionActor(request);
    const context = await organizationProviderManageContext({
        actor,
        userId: session.user.id,
        email: session.user.email,
    });
    return NextResponse.json({
        members: await organizationProviderUsage(context),
    });
});
