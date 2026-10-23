import { NextResponse } from "next/server";
import { z } from "zod";
import {
    parseProviderMaxOutputTokens,
    providerMaxOutputTokensSchema,
} from "@/lib/ai/provider-output-tokens";
import { parseProviderRates } from "@/lib/ai/provider-rate-input";
import { validateAiBaseUrl } from "@/lib/ai/validate-base-url";
import { requireApiSessionActor } from "@/lib/auth-server";
import { encrypt } from "@/lib/encryption";
import { env } from "@/lib/env";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import {
    deleteOrganizationProvider,
    organizationProviderManageContext,
    organizationProviderMemberDefaultCount,
    updateOrganizationProvider,
} from "@/lib/profiles/organization-providers";

type IdContext = { params: Promise<{ id: string }> };

const updateSchema = z
    .object({
        apiKey: z.string().min(1).optional(),
        baseUrl: z.string().nullable().optional(),
        defaultModel: z.string().max(100).nullable().optional(),
        maxOutputTokens: providerMaxOutputTokensSchema,
        disabled: z.boolean().optional(),
        inputUsdPerMillion: z.unknown().optional(),
        outputUsdPerMillion: z.unknown().optional(),
        audioUsdPerHour: z.unknown().optional(),
        isDefaultTranscription: z.boolean().optional(),
        isDefaultEnhancement: z.boolean().optional(),
        isDefaultLearn: z.boolean().optional(),
        isDefaultTopics: z.boolean().optional(),
        isDefaultTitle: z.boolean().optional(),
    })
    .strict()
    .refine((value) => Object.keys(value).length > 0, {
        message: "At least one provider field is required",
    });

async function contextFor(request: Request) {
    const { session, actor } = await requireApiSessionActor(request);
    return organizationProviderManageContext({
        actor,
        userId: session.user.id,
        email: session.user.email,
    });
}

export const GET = apiHandler<IdContext>(async (request, routeContext) => {
    const context = await contextFor(request);
    const { id } = await (routeContext as IdContext).params;
    return NextResponse.json({
        memberDefaultCount: await organizationProviderMemberDefaultCount(
            context,
            id,
        ),
    });
});

export const PUT = apiHandler<IdContext>(async (request, routeContext) => {
    const context = await contextFor(request);
    const { id } = await (routeContext as IdContext).params;
    const input = await request.json().catch(() => null);
    if (input && typeof input === "object" && "maxOutputTokens" in input) {
        parseProviderMaxOutputTokens(input);
    }
    const parsed = updateSchema.safeParse(input);
    if (!parsed.success) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Invalid request body",
            400,
            { issues: parsed.error.flatten() },
        );
    }
    const body = parsed.data;
    if (body.baseUrl !== undefined) {
        const baseUrlCheck = await validateAiBaseUrl(body.baseUrl, {
            isHosted: env.IS_HOSTED,
        });
        if (!baseUrlCheck.ok) {
            throw new AppError(
                ErrorCode.INVALID_INPUT,
                baseUrlCheck.message,
                400,
                { field: "baseUrl" },
            );
        }
    }
    const hasRates = [
        "inputUsdPerMillion",
        "outputUsdPerMillion",
        "audioUsdPerHour",
    ].some((field) => Object.hasOwn(body, field));
    await updateOrganizationProvider(context, id, {
        ...(body.apiKey ? { encryptedApiKey: encrypt(body.apiKey) } : {}),
        ...(body.baseUrl !== undefined
            ? { baseUrl: body.baseUrl || null }
            : {}),
        ...(body.defaultModel !== undefined
            ? { defaultModel: body.defaultModel || null }
            : {}),
        ...(body.maxOutputTokens !== undefined
            ? { maxOutputTokens: body.maxOutputTokens }
            : {}),
        ...(body.disabled !== undefined ? { disabled: body.disabled } : {}),
        ...(hasRates ? { rates: parseProviderRates(body) } : {}),
        defaults: {
            transcription: body.isDefaultTranscription,
            summary: body.isDefaultEnhancement,
            learn: body.isDefaultLearn,
            topics: body.isDefaultTopics,
            title: body.isDefaultTitle,
        },
    });
    return NextResponse.json({ success: true });
});

export const DELETE = apiHandler<IdContext>(async (request, routeContext) => {
    const context = await contextFor(request);
    const { id } = await (routeContext as IdContext).params;
    await deleteOrganizationProvider(context, id);
    return NextResponse.json({ success: true });
});
