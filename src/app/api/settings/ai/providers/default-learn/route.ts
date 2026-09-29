import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { apiCredentials, users } from "@/db/schema";
import { isTranscriptionOnlyProvider } from "@/lib/ai/provider-presets";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
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

    const [provider] = await db
        .select({
            id: apiCredentials.id,
            provider: apiCredentials.provider,
        })
        .from(apiCredentials)
        .where(
            and(
                eq(apiCredentials.id, providerId),
                eq(apiCredentials.userId, session.user.id),
            ),
        )
        .limit(1);

    if (!provider) {
        throw new AppError(ErrorCode.NOT_FOUND, "Provider not found", 404);
    }

    if (isTranscriptionOnlyProvider(provider.provider)) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            `${provider.provider} transcribes only. Learn needs an OpenAI-compatible provider.`,
            400,
            { field: "providerId" },
        );
    }

    await db.transaction(async (tx) => {
        // One at a time per user: two requests at once would each clear
        // nothing and mark their own (the unique index would refuse the
        // second instead of letting the last one win).
        await tx
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, session.user.id))
            .for("update");
        await tx
            .update(apiCredentials)
            .set({ isDefaultLearn: false })
            .where(
                and(
                    eq(apiCredentials.userId, session.user.id),
                    eq(apiCredentials.isDefaultLearn, true),
                ),
            );
        await tx
            .update(apiCredentials)
            .set({ isDefaultLearn: true, updatedAt: new Date() })
            .where(
                and(
                    eq(apiCredentials.id, providerId),
                    eq(apiCredentials.userId, session.user.id),
                ),
            );
    });

    return NextResponse.json({ success: true });
});

/** Unmark it: Learn follows the enhancement default again. */
export const DELETE = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);
    await db
        .update(apiCredentials)
        .set({ isDefaultLearn: false })
        .where(
            and(
                eq(apiCredentials.userId, session.user.id),
                eq(apiCredentials.isDefaultLearn, true),
            ),
        );
    return NextResponse.json({ success: true });
});
