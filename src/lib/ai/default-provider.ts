import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { apiCredentials, userSettings, users } from "@/db/schema";
import {
    isEnhancementOnlyProvider,
    isTranscriptionOnlyProvider,
} from "@/lib/ai/provider-presets";
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

type DefaultProviderTransaction = Parameters<
    Parameters<typeof db.transaction>[0]
>[0];

interface SetDefaultProviderOptions {
    transaction?: DefaultProviderTransaction;
    onlyIf?: string;
}

type DefaultProviderCredential = Pick<
    typeof apiCredentials.$inferSelect,
    | "id"
    | "provider"
    | "isDefaultTranscription"
    | "isDefaultEnhancement"
    | "isDefaultLearn"
>;

type DefaultProviderSettings = Pick<
    typeof userSettings.$inferSelect,
    "defaultTranscriptionProviderId" | "defaultProviders"
>;

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

function defaultProviderPointers(
    credentials: DefaultProviderCredential[],
    settings: DefaultProviderSettings | undefined,
): DefaultProviderPointers {
    const legacyTranscription = credentials.find(
        (row) =>
            row.isDefaultTranscription &&
            !isEnhancementOnlyProvider(row.provider),
    )?.id;
    const legacySummary = credentials.find(
        (row) =>
            row.isDefaultEnhancement &&
            !isTranscriptionOnlyProvider(row.provider),
    )?.id;
    const legacyLearn = credentials.find(
        (row) =>
            row.isDefaultLearn && !isTranscriptionOnlyProvider(row.provider),
    )?.id;
    return {
        transcription:
            settings?.defaultTranscriptionProviderId ??
            legacyTranscription ??
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
}

/** Load provider pointers with the credentials and settings used to derive them. */
export async function loadDefaultProviderState(
    userId: string,
    transaction?: DefaultProviderTransaction,
): Promise<DefaultProviderState> {
    const executor = transaction ?? db;
    const credentials = await executor
        .select()
        .from(apiCredentials)
        .where(eq(apiCredentials.userId, userId))
        .limit(1000);
    const [settings] = await executor
        .select()
        .from(userSettings)
        .where(eq(userSettings.userId, userId))
        .limit(1);
    const pointers = defaultProviderPointers(credentials, settings);
    return { pointers, credentials, settings };
}

/** Load authoritative pointers, preserving legacy summary and Learn row flags. */
export async function loadDefaultProviderPointers(
    userId: string,
    transaction?: DefaultProviderTransaction,
): Promise<DefaultProviderPointers> {
    const executor = transaction ?? db;
    const [credentials, settingsRows] = await Promise.all([
        executor
            .select({
                id: apiCredentials.id,
                provider: apiCredentials.provider,
                isDefaultTranscription: apiCredentials.isDefaultTranscription,
                isDefaultEnhancement: apiCredentials.isDefaultEnhancement,
                isDefaultLearn: apiCredentials.isDefaultLearn,
            })
            .from(apiCredentials)
            .where(eq(apiCredentials.userId, userId))
            .limit(1000),
        executor
            .select({
                defaultTranscriptionProviderId:
                    userSettings.defaultTranscriptionProviderId,
                defaultProviders: userSettings.defaultProviders,
            })
            .from(userSettings)
            .where(eq(userSettings.userId, userId))
            .limit(1),
    ]);
    return defaultProviderPointers(credentials, settingsRows[0]);
}

/** Set or clear one authoritative provider pointer and its legacy row mirror. */
export async function setDefaultProvider(
    userId: string,
    role: ProviderRole,
    value: string | null,
    options: SetDefaultProviderOptions = {},
): Promise<boolean> {
    const apply = async (tx: DefaultProviderTransaction): Promise<boolean> => {
        await tx
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, userId))
            .for("update");
        if (options.onlyIf !== undefined) {
            const pointers = await loadDefaultProviderPointers(userId, tx);
            if (pointers[role] !== options.onlyIf) return false;
        }
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

        if (role === "topics" || role === "title") return true;
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
            return true;
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
            return true;
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
        return true;
    };
    if (options.transaction) {
        return apply(options.transaction);
    }
    return db.transaction(apply);
}
