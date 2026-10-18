import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { apiCredentials, users } from "@/db/schema";
import {
    loadDefaultProviderPointers,
    setDefaultProvider,
} from "@/lib/ai/default-provider";
import { enhancementModelRequiredMessage } from "@/lib/ai/enhancement-provider";
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
import {
    organizationAccountProviderAuditContext,
    writeOrganizationProviderAudit,
} from "@/lib/profiles/organization-providers";

type IdContext = { params: Promise<{ id: string }> };

// PUT - Update AI provider
export const PUT = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);

    const { id } = await (context as IdContext).params;
    const body = await request.json();
    const {
        apiKey,
        baseUrl,
        defaultModel,
        isDefaultTranscription,
        isDefaultEnhancement,
        disabled,
    } = body;
    const hasRates = [
        "inputUsdPerMillion",
        "outputUsdPerMillion",
        "audioUsdPerHour",
    ].some((field) => Object.hasOwn(body, field));

    // Verify ownership
    const [existing] = await db
        .select()
        .from(apiCredentials)
        .where(
            and(
                eq(apiCredentials.id, id),
                eq(apiCredentials.userId, session.user.id),
            ),
        )
        .limit(1);

    if (!existing) {
        throw new AppError(ErrorCode.NOT_FOUND, "Provider not found", 404);
    }

    const effectiveDisabled =
        typeof disabled === "boolean" ? disabled : existing.disabledAt !== null;
    const effectiveDefaultModel =
        defaultModel === undefined ? existing.defaultModel : defaultModel;
    if (
        !effectiveDisabled &&
        !isTranscriptionOnlyProvider(existing.provider) &&
        (typeof effectiveDefaultModel !== "string" ||
            !effectiveDefaultModel.trim())
    ) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            enhancementModelRequiredMessage(existing.provider),
            400,
            { field: "defaultModel" },
        );
    }

    if (
        isDefaultEnhancement &&
        isTranscriptionOnlyProvider(existing.provider)
    ) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            `${existing.provider} transcribes but cannot write summaries. Pick another provider for summaries.`,
            400,
            { field: "isDefaultEnhancement" },
        );
    }

    if (
        isDefaultTranscription &&
        isEnhancementOnlyProvider(existing.provider)
    ) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            `${existing.provider} writes summaries but cannot transcribe. Pick another provider for transcription.`,
            400,
            { field: "isDefaultTranscription" },
        );
    }

    if (
        effectiveDisabled &&
        ((isDefaultTranscription === true &&
            !existing.isDefaultTranscription) ||
            (isDefaultEnhancement === true && !existing.isDefaultEnhancement))
    ) {
        throw new AppError(
            ErrorCode.CONFLICT,
            `${existing.provider} is disabled. Enable it before assigning a role.`,
            409,
        );
    }

    // On hosted, the app process can't reach the user's machine — reject
    // localhost / loopback baseUrls (e.g. LM Studio, Ollama) with a clear
    // message. Self-host accepts everything.
    if (baseUrl !== undefined) {
        const baseUrlCheck = validateAiBaseUrl(baseUrl, {
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
    const auditContext = await organizationAccountProviderAuditContext({
        userId: session.user.id,
        email: session.user.email,
    });

    // Use a transaction to ensure atomic update of default providers
    await db.transaction(async (tx) => {
        const [before] = await tx
            .select()
            .from(apiCredentials)
            .where(
                and(
                    eq(apiCredentials.id, id),
                    eq(apiCredentials.userId, session.user.id),
                ),
            )
            .for("update")
            .limit(1);
        if (!before) {
            throw new AppError(ErrorCode.NOT_FOUND, "Provider not found", 404);
        }
        // Build update object
        const updateData: Partial<typeof apiCredentials.$inferInsert> = {
            updatedAt: new Date(),
        };

        if (baseUrl !== undefined) updateData.baseUrl = baseUrl || null;
        if (defaultModel !== undefined) {
            updateData.defaultModel = defaultModel || null;
        }
        if (hasRates) Object.assign(updateData, parseProviderRates(body));
        if (typeof disabled === "boolean") {
            updateData.disabledAt = disabled ? new Date() : null;
        }

        // Only update API key if provided
        if (apiKey) {
            updateData.apiKey = encrypt(apiKey);
        }

        // Update provider — re-scope by userId on UPDATE for defense-in-depth.
        const [after] = await tx
            .update(apiCredentials)
            .set(updateData)
            .where(
                and(
                    eq(apiCredentials.id, id),
                    eq(apiCredentials.userId, session.user.id),
                ),
            )
            .returning();
        if (!after) {
            throw new AppError(ErrorCode.NOT_FOUND, "Provider not found", 404);
        }
        if (auditContext) {
            let action = "org_provider.update";
            if (before.disabledAt === null && after.disabledAt !== null) {
                action = "org_provider.disable";
            } else if (
                before.disabledAt !== null &&
                after.disabledAt === null
            ) {
                action = "org_provider.enable";
            }
            await writeOrganizationProviderAudit(tx, {
                context: auditContext,
                action,
                credentialId: id,
                before,
                after,
            });
        }
    });

    if (isDefaultTranscription === true) {
        await setDefaultTranscriptionProvider(session.user.id, id);
    } else if (isDefaultTranscription === false) {
        await setDefaultProvider(session.user.id, "transcription", null, {
            onlyIf: id,
        });
    }
    if (isDefaultEnhancement === true) {
        await setDefaultProvider(session.user.id, "summary", id);
    } else if (isDefaultEnhancement === false) {
        await setDefaultProvider(session.user.id, "summary", null, {
            onlyIf: id,
        });
    }

    return NextResponse.json({ success: true });
});

// DELETE - Remove AI provider
export const DELETE = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);

    const { id } = await (context as IdContext).params;
    const auditContext = await organizationAccountProviderAuditContext({
        userId: session.user.id,
        email: session.user.email,
    });

    if (auditContext) {
        await db.transaction(async (tx) => {
            await tx
                .select({ id: users.id })
                .from(users)
                .where(eq(users.id, session.user.id))
                .for("update");
            const [before] = await tx
                .select()
                .from(apiCredentials)
                .where(
                    and(
                        eq(apiCredentials.id, id),
                        eq(apiCredentials.userId, session.user.id),
                    ),
                )
                .for("update")
                .limit(1);
            const beforeDefaults = before
                ? await loadDefaultProviderPointers(session.user.id, tx)
                : undefined;
            await tx
                .delete(apiCredentials)
                .where(
                    and(
                        eq(apiCredentials.id, id),
                        eq(apiCredentials.userId, session.user.id),
                    ),
                );
            if (before) {
                await writeOrganizationProviderAudit(tx, {
                    context: auditContext,
                    action: "org_provider.delete",
                    credentialId: id,
                    before,
                    after: null,
                    beforeDefaults,
                    afterDefaults: await loadDefaultProviderPointers(
                        session.user.id,
                        tx,
                    ),
                });
            }
        });
    } else {
        await db.transaction(async (tx) => {
            await tx
                .select({ id: users.id })
                .from(users)
                .where(eq(users.id, session.user.id))
                .for("update");
            await tx
                .select({ id: apiCredentials.id })
                .from(apiCredentials)
                .where(
                    and(
                        eq(apiCredentials.id, id),
                        eq(apiCredentials.userId, session.user.id),
                    ),
                )
                .for("update")
                .limit(1);
            await tx
                .delete(apiCredentials)
                .where(
                    and(
                        eq(apiCredentials.id, id),
                        eq(apiCredentials.userId, session.user.id),
                    ),
                );
        });
    }

    return NextResponse.json({ success: true });
});
