import { eq } from "drizzle-orm";
import { db } from "@/db";
import { apiCredentials, userSettings } from "@/db/schema";
import { type AiRate, hasRate, storedRate } from "@/lib/ai/published-rates";
import { topicsProviderId } from "@/lib/ai/topics-provider";
import { isLearnDeploymentAvailable } from "@/lib/knowledge/availability";
import {
    getManagedTranscriptionProvider,
    isRiffadoIncludedProviderId,
} from "@/lib/transcription/included-provider";

export interface ProviderListItem {
    id: string;
    provider: string;
    baseUrl: string | null;
    defaultModel: string | null;
    isDefaultTranscription: boolean;
    isDefaultEnhancement: boolean;
    isDefaultTopics?: boolean;
    /**
     * Whether Learn runs on it; absent where this instance has no Learn,
     * so the list offers the choice only where it means something.
     */
    isDefaultLearn?: boolean;
    /** The price the user set on this card; null leaves the catalog's. */
    rate?: AiRate | null;
    createdAt: Date;
    /** Present and true only for the instance-managed included provider. */
    managed?: boolean;
    /** Managed only: headline monthly capacity in seconds. */
    includedSeconds?: number;
    /** Managed only: whether the current plan can use it right now. */
    available?: boolean;
}

/**
 * List a user's transcription/enhancement providers for the Providers UI.
 *
 * The authoritative transcription default is
 * `userSettings.defaultTranscriptionProviderId` (a credential id, the
 * managed sentinel, or null) — the per-row `isDefaultTranscription`
 * boolean is derived from it here so the UI has a single source of truth.
 * When the instance offers managed transcription, it is prepended as a
 * first-class entry.
 */
export async function listUserProviders(
    userId: string,
): Promise<ProviderListItem[]> {
    const [settings] = await db
        .select({
            pointer: userSettings.defaultTranscriptionProviderId,
            defaultProviders: userSettings.defaultProviders,
        })
        .from(userSettings)
        .where(eq(userSettings.userId, userId))
        .limit(1);
    const pointer = settings?.pointer ?? null;
    const topicsPointer = topicsProviderId(settings?.defaultProviders);

    const rows = await db
        .select({
            id: apiCredentials.id,
            provider: apiCredentials.provider,
            baseUrl: apiCredentials.baseUrl,
            defaultModel: apiCredentials.defaultModel,
            isDefaultEnhancement: apiCredentials.isDefaultEnhancement,
            isDefaultLearn: apiCredentials.isDefaultLearn,
            inputUsdPerMillion: apiCredentials.inputUsdPerMillion,
            outputUsdPerMillion: apiCredentials.outputUsdPerMillion,
            audioUsdPerHour: apiCredentials.audioUsdPerHour,
            createdAt: apiCredentials.createdAt,
        })
        .from(apiCredentials)
        .where(eq(apiCredentials.userId, userId))
        // Postgres has no default order, and an UPDATE rewrites the row,
        // moving it in the heap -- so without this the list reshuffled
        // every time the user clicked "Use for transcription". Oldest
        // first, with id as the tiebreaker for rows created in the same
        // millisecond.
        .orderBy(apiCredentials.createdAt, apiCredentials.id);

    const learn = isLearnDeploymentAvailable();
    const credentials: ProviderListItem[] = rows.map(
        ({
            isDefaultLearn,
            inputUsdPerMillion,
            outputUsdPerMillion,
            audioUsdPerHour,
            ...row
        }) => {
            const rate = storedRate({
                inputUsdPerMillion,
                outputUsdPerMillion,
                audioUsdPerHour,
            });
            return {
                ...row,
                rate: hasRate(rate) ? rate : null,
                isDefaultTranscription: row.id === pointer,
                isDefaultTopics: row.id === topicsPointer,
                ...(learn ? { isDefaultLearn } : {}),
            };
        },
    );

    const managed = await getManagedTranscriptionProvider(
        userId,
        isRiffadoIncludedProviderId(pointer),
    );

    return managed ? [managed, ...credentials] : credentials;
}
