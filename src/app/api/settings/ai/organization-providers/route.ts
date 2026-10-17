import { NextResponse } from "next/server";
import { z } from "zod";
import { parseProviderRates } from "@/lib/ai/provider-rate-input";
import { validateAiBaseUrl } from "@/lib/ai/validate-base-url";
import { requireApiSessionActor } from "@/lib/auth-server";
import { encrypt } from "@/lib/encryption";
import { env } from "@/lib/env";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import {
    createOrganizationProvider,
    listOrganizationProviders,
    organizationProviderManageContext,
    organizationProviderReadContext,
} from "@/lib/profiles/organization-providers";

const createSchema = z
    .object({
        provider: z.string().min(1).max(100),
        apiKey: z.string().min(1),
        baseUrl: z.string().nullable().optional(),
        defaultModel: z.string().max(100).nullable().optional(),
        inputUsdPerMillion: z.unknown().optional(),
        outputUsdPerMillion: z.unknown().optional(),
        audioUsdPerHour: z.unknown().optional(),
    })
    .strict();

async function actorFrom(request: Request) {
    const { session, actor } = await requireApiSessionActor(request);
    return {
        actor,
        userId: session.user.id,
        email: session.user.email,
    };
}

export const GET = apiHandler(async (request: Request) => {
    const context = await organizationProviderReadContext(
        await actorFrom(request),
    );
    return NextResponse.json({
        providers: await listOrganizationProviders(context),
    });
});

export const POST = apiHandler(async (request: Request) => {
    const context = await organizationProviderManageContext(
        await actorFrom(request),
    );
    const parsed = createSchema.safeParse(
        await request.json().catch(() => null),
    );
    if (!parsed.success) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Invalid request body",
            400,
            { issues: parsed.error.flatten() },
        );
    }
    const body = parsed.data;
    const baseUrlCheck = validateAiBaseUrl(body.baseUrl, {
        isHosted: env.IS_HOSTED,
    });
    if (!baseUrlCheck.ok) {
        throw new AppError(ErrorCode.INVALID_INPUT, baseUrlCheck.message, 400, {
            field: "baseUrl",
        });
    }
    const provider = await createOrganizationProvider(context, {
        provider: body.provider,
        encryptedApiKey: encrypt(body.apiKey),
        baseUrl: body.baseUrl || null,
        defaultModel: body.defaultModel || null,
        rates: parseProviderRates(body),
    });
    return NextResponse.json({ provider });
});
