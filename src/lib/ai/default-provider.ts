import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { apiCredentials, userSettings, users } from "@/db/schema";
import { isRiffadoIncludedProviderId } from "@/lib/transcription/included-provider";

export type ProviderRole =
    | "transcription"
    | "summary"
    | "learn"
    | "topics"
    | "title";

export interface DefaultProviderPointers {
    transcription: string | null;
    summary: string | null;
    learn: string | null;
    topics: string | null;
    title: string | null;
}

export interface DefaultProviderState {
    pointers: DefaultProviderPointers;
    credentials: (typeof apiCredentials.$inferSelect)[];
    settings: typeof userSettings.$inferSelect | undefined;
}

function preferences(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
}

/** Read one provider pointer from `user_settings`. */
export function providerPointer(
    value: unknown,
    role: Exclude<ProviderRole, "transcription">,
): string | null {
    const selected = preferences(value)[role];
    return typeof selected === "string" && selected.length > 0
        ? selected
        : null;
}

/** Load provider pointers with the credentials and settings used to derive them. */
export async function loadDefaultProviderState(
    userId: string,
): Promise<DefaultProviderState> {
    const credentials = await db
        .select()
        .from(apiCredentials)
        .where(eq(apiCredentials.userId, userId))
        .limit(1000);
    const [settings] = await db
        .select()
        .from(userSettings)
        .where(eq(userSettings.userId, userId))
        .limit(1);
    const legacyTranscription = credentials.find(
        (row) => row.isDefaultTranscription,
    )?.id;
    const selectedTranscription =
        legacyTranscription ??
        (credentials.length === 1 &&
        credentials[0] &&
        !Object.hasOwn(credentials[0], "isDefaultTranscription")
            ? credentials[0].id
            : undefined);
    const legacySummary = credentials.find(
        (row) => row.isDefaultEnhancement,
    )?.id;
    const legacyLearn = credentials.find((row) => row.isDefaultLearn)?.id;
    const pointers = {
        transcription:
            settings?.defaultTranscriptionProviderId ??
            selectedTranscription ??
            null,
        summary:
            providerPointer(settings?.defaultProviders, "summary") ??
            legacySummary ??
            null,
        learn:
            providerPointer(settings?.defaultProviders, "learn") ??
            legacyLearn ??
            null,
        topics: providerPointer(settings?.defaultProviders, "topics"),
        title: providerPointer(settings?.defaultProviders, "title"),
    };
    return { pointers, credentials, settings };
}

/** Load authoritative pointers, preserving legacy summary and Learn row flags. */
export async function loadDefaultProviderPointers(
    userId: string,
): Promise<DefaultProviderPointers> {
    return (await loadDefaultProviderState(userId)).pointers;
}

/** Set or clear one authoritative provider pointer and its legacy row mirror. */
export async function setDefaultProvider(
    userId: string,
    role: ProviderRole,
    value: string | null,
): Promise<void> {
    await db.transaction(async (tx) => {
        await tx
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, userId))
            .for("update");
        const [settings] = await tx
            .select({ defaults: userSettings.defaultProviders })
            .from(userSettings)
            .where(eq(userSettings.userId, userId))
            .limit(1);
        const current = preferences(settings?.defaults);
        const next = { ...current };
        if (role !== "transcription") {
            if (value) next[role] = value;
            else delete next[role];
        }
        const settingsValues =
            role === "transcription"
                ? { defaultTranscriptionProviderId: value }
                : { defaultProviders: next };
        await tx
            .insert(userSettings)
            .values({ userId, ...settingsValues })
            .onConflictDoUpdate({
                target: userSettings.userId,
                set: { ...settingsValues, updatedAt: new Date() },
            });

        if (role === "topics" || role === "title") return;
        if (role === "transcription") {
            await tx
                .update(apiCredentials)
                .set({ isDefaultTranscription: false })
                .where(
                    and(
                        eq(apiCredentials.userId, userId),
                        eq(apiCredentials.isDefaultTranscription, true),
                    ),
                );
            if (value && !isRiffadoIncludedProviderId(value)) {
                await tx
                    .update(apiCredentials)
                    .set({ isDefaultTranscription: true })
                    .where(
                        and(
                            eq(apiCredentials.userId, userId),
                            eq(apiCredentials.id, value),
                        ),
                    );
            }
            return;
        }
        if (role === "summary") {
            await tx
                .update(apiCredentials)
                .set({ isDefaultEnhancement: false })
                .where(
                    and(
                        eq(apiCredentials.userId, userId),
                        eq(apiCredentials.isDefaultEnhancement, true),
                    ),
                );
            if (value) {
                await tx
                    .update(apiCredentials)
                    .set({ isDefaultEnhancement: true })
                    .where(
                        and(
                            eq(apiCredentials.userId, userId),
                            eq(apiCredentials.id, value),
                        ),
                    );
            }
            return;
        }
        await tx
            .update(apiCredentials)
            .set({ isDefaultLearn: false })
            .where(
                and(
                    eq(apiCredentials.userId, userId),
                    eq(apiCredentials.isDefaultLearn, true),
                ),
            );
        if (value) {
            await tx
                .update(apiCredentials)
                .set({ isDefaultLearn: true })
                .where(
                    and(
                        eq(apiCredentials.userId, userId),
                        eq(apiCredentials.id, value),
                    ),
                );
        }
    });
}
