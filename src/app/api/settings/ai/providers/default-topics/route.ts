import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { apiCredentials, userSettings, users } from "@/db/schema";
import { isTranscriptionOnlyProvider } from "@/lib/ai/provider-presets";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";

const bodySchema = z.object({ providerId: z.string().min(1) });

/** Set the provider for Topics independently of summaries. */
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
    const { providerId } = parsed.data;
    const [provider] = await db
        .select({ provider: apiCredentials.provider })
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
            `${provider.provider} transcribes only. Topics need a chat provider.`,
            400,
        );
    }

    await db.transaction(async (tx) => {
        await tx
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, session.user.id))
            .for("update");
        const [settings] = await tx
            .select({ preferences: userSettings.defaultProviders })
            .from(userSettings)
            .where(eq(userSettings.userId, session.user.id))
            .limit(1);
        const current: Record<string, unknown> =
            settings?.preferences &&
            typeof settings.preferences === "object" &&
            !Array.isArray(settings.preferences)
                ? (settings.preferences as Record<string, unknown>)
                : {};
        const preferences = { ...current, topics: providerId };
        await tx
            .insert(userSettings)
            .values({ userId: session.user.id, defaultProviders: preferences })
            .onConflictDoUpdate({
                target: userSettings.userId,
                set: { defaultProviders: preferences, updatedAt: new Date() },
            });
    });
    return NextResponse.json({ success: true });
});

/** Let Topics follow the summary provider again. */
export const DELETE = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);
    await db.transaction(async (tx) => {
        await tx
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, session.user.id))
            .for("update");
        const [settings] = await tx
            .select({ preferences: userSettings.defaultProviders })
            .from(userSettings)
            .where(eq(userSettings.userId, session.user.id))
            .limit(1);
        if (!settings) return;
        const current: Record<string, unknown> =
            settings.preferences &&
            typeof settings.preferences === "object" &&
            !Array.isArray(settings.preferences)
                ? (settings.preferences as Record<string, unknown>)
                : {};
        const { topics: _topics, ...preferences } = current;
        await tx
            .update(userSettings)
            .set({ defaultProviders: preferences, updatedAt: new Date() })
            .where(eq(userSettings.userId, session.user.id));
    });
    return NextResponse.json({ success: true });
});
