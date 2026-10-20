import { NextResponse } from "next/server";
import { z } from "zod";
import { loadDefaultProviderPointers } from "@/lib/ai/default-provider";
import { enhancementModelRequiredMessage } from "@/lib/ai/enhancement-provider";
import {
    parseProviderMaxOutputTokens,
    providerMaxOutputTokensSchema,
} from "@/lib/ai/provider-output-tokens";
import { isTranscriptionOnlyProvider } from "@/lib/ai/provider-presets";
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
        apiKey: z.string().min(1).optional(),
        copyKeyFrom: z.string().min(1).optional(),
        baseUrl: z.string().nullable().optional(),
        defaultModel: z.string().max(100).nullable().optional(),
        maxOutputTokens: providerMaxOutputTokensSchema,
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
    .refine((value) => value.apiKey || value.copyKeyFrom, {
        message: "An API key or provider to duplicate is required",
    });

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
    const [providers, defaults] = await Promise.all([
        listOrganizationProviders(context),
        loadDefaultProviderPointers(context.orgUserId),
    ]);
    return NextResponse.json({ providers, defaults });
});

export const POST = apiHandler(async (request: Request) => {
    const context = await organizationProviderManageContext(
        await actorFrom(request),
    );
    const input = await request.json().catch(() => null);
    if (input && typeof input === "object" && "maxOutputTokens" in input) {
        parseProviderMaxOutputTokens(input);
    }
    const parsed = createSchema.safeParse(input);
    if (!parsed.success) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Invalid request body",
            400,
            { issues: parsed.error.flatten() },
        );
    }
    const body = parsed.data;
    if (
        !isTranscriptionOnlyProvider(body.provider) &&
        !body.defaultModel?.trim()
    ) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            enhancementModelRequiredMessage(body.provider),
            400,
            { field: "defaultModel" },
        );
    }
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
        ...(body.apiKey ? { encryptedApiKey: encrypt(body.apiKey) } : {}),
        ...(body.copyKeyFrom ? { copyKeyFrom: body.copyKeyFrom } : {}),
        baseUrl: body.baseUrl || null,
        defaultModel: body.defaultModel || null,
        maxOutputTokens: body.maxOutputTokens ?? null,
        rates: parseProviderRates(body),
        defaults: {
            transcription: body.isDefaultTranscription,
            summary: body.isDefaultEnhancement,
            learn: body.isDefaultLearn,
            topics: body.isDefaultTopics,
            title: body.isDefaultTitle,
        },
    });
    return NextResponse.json({ provider });
});
