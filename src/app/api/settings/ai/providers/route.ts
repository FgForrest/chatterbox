import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { apiCredentials } from "@/db/schema";
import { listUserProviders } from "@/lib/ai/list-providers";
import {
    isEnhancementOnlyProvider,
    isTranscriptionOnlyProvider,
} from "@/lib/ai/provider-presets";
import { parseProviderRates } from "@/lib/ai/provider-rate-input";
import { setDefaultTranscriptionProvider } from "@/lib/ai/set-default-transcription";
import { validateAiBaseUrl } from "@/lib/ai/validate-base-url";
import { requireApiSession } from "@/lib/auth-server";
import { encrypt } from "@/lib/encryption";
import { env } from "@/lib/env";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { captureServerEvent } from "@/lib/posthog-server";

// GET - List all AI providers for the user
export const GET = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);

    return NextResponse.json({
        providers: await listUserProviders(session.user.id),
    });
});

// POST - Add new AI provider
export const POST = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);

    const body = await request.json();
    const {
        provider,
        apiKey,
        baseUrl,
        defaultModel,
        isDefaultTranscription,
        isDefaultEnhancement,
        copyKeyFrom,
    } = body;
    const rates = parseProviderRates(body);

    if (!provider || (!apiKey && !copyKeyFrom)) {
        throw new AppError(
            ErrorCode.MISSING_REQUIRED_FIELD,
            "Provider and API key are required",
            400,
        );
    }

    // Duplicating a provider: the new row takes the stored key of one the
    // user already has, so a second Claude Code or Codex model needs no
    // fresh token. The key stays encrypted end to end -- the ciphertext is
    // copied, never decrypted, and never reaches the browser. It must come
    // from the same provider: a key is only meaningful to its own vendor.
    let copiedKey: string | null = null;
    if (!apiKey && copyKeyFrom) {
        const [source] = await db
            .select({
                provider: apiCredentials.provider,
                apiKey: apiCredentials.apiKey,
            })
            .from(apiCredentials)
            .where(
                and(
                    eq(apiCredentials.id, String(copyKeyFrom)),
                    eq(apiCredentials.userId, session.user.id),
                ),
            )
            .limit(1);
        if (!source) {
            throw new AppError(
                ErrorCode.NOT_FOUND,
                "The provider to duplicate no longer exists",
                404,
            );
        }
        if (source.provider !== provider) {
            throw new AppError(
                ErrorCode.INVALID_INPUT,
                `A duplicate keeps its provider: ${source.provider}'s key cannot be used for ${provider}.`,
                400,
                { field: "provider" },
            );
        }
        copiedKey = source.apiKey;
    }

    if (isDefaultEnhancement && isTranscriptionOnlyProvider(provider)) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            `${provider} transcribes but cannot write summaries. Pick another provider for summaries.`,
            400,
            { field: "isDefaultEnhancement" },
        );
    }

    if (isDefaultTranscription && isEnhancementOnlyProvider(provider)) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            `${provider} writes summaries but cannot transcribe. Pick another provider for transcription.`,
            400,
            { field: "isDefaultTranscription" },
        );
    }

    // On hosted, the app process can't reach the user's machine — reject
    // localhost / loopback baseUrls (e.g. LM Studio, Ollama) with a clear
    // message. Self-host accepts everything.
    const baseUrlCheck = validateAiBaseUrl(baseUrl, {
        isHosted: env.IS_HOSTED,
    });
    if (!baseUrlCheck.ok) {
        throw new AppError(ErrorCode.INVALID_INPUT, baseUrlCheck.message, 400, {
            field: "baseUrl",
        });
    }

    // Encrypt the API key; a duplicate's is already encrypted
    const encryptedKey = copiedKey ?? encrypt(apiKey);

    // Use a transaction to ensure atomic update of default providers
    const [newProvider] = await db.transaction(async (tx) => {
        // If setting as default, remove default flag from other providers
        if (isDefaultTranscription) {
            await tx
                .update(apiCredentials)
                .set({ isDefaultTranscription: false })
                .where(
                    and(
                        eq(apiCredentials.userId, session.user.id),
                        eq(apiCredentials.isDefaultTranscription, true),
                    ),
                );
        }

        if (isDefaultEnhancement) {
            await tx
                .update(apiCredentials)
                .set({ isDefaultEnhancement: false })
                .where(
                    and(
                        eq(apiCredentials.userId, session.user.id),
                        eq(apiCredentials.isDefaultEnhancement, true),
                    ),
                );
        }

        // Insert new provider
        return await tx
            .insert(apiCredentials)
            .values({
                userId: session.user.id,
                provider,
                apiKey: encryptedKey,
                baseUrl: baseUrl || null,
                defaultModel: defaultModel || null,
                isDefaultTranscription: isDefaultTranscription || false,
                isDefaultEnhancement: isDefaultEnhancement || false,
                ...rates,
            })
            .returning({
                id: apiCredentials.id,
                provider: apiCredentials.provider,
                baseUrl: apiCredentials.baseUrl,
                defaultModel: apiCredentials.defaultModel,
                isDefaultTranscription: apiCredentials.isDefaultTranscription,
                isDefaultEnhancement: apiCredentials.isDefaultEnhancement,
            });
    });

    if (isDefaultTranscription) {
        await setDefaultTranscriptionProvider(session.user.id, newProvider.id);
    }

    // Provider label only -- never baseUrl, which can be a private
    // hostname (homelab Ollama, internal LM Studio, etc.).
    await captureServerEvent({
        distinctId: session.user.id,
        event: "ai_provider_added",
        properties: {
            provider,
            has_custom_base_url: Boolean(baseUrl),
            is_default_transcription: Boolean(isDefaultTranscription),
            duplicated: copiedKey !== null,
        },
    });

    return NextResponse.json({ provider: newProvider });
});
