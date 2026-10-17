import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { apiCredentials } from "@/db/schema";
import { loadDefaultProviderPointers } from "@/lib/ai/default-provider";
import { type AiRate, hasRate, storedRate } from "@/lib/ai/published-rates";
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
    isDefaultTitle?: boolean;
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
    disabledAt?: Date | null;
}

interface ListUserProvidersOptions {
    includeDisabled?: boolean;
}

/**
 * List a user's available transcription/enhancement providers.
 *
 * The authoritative transcription default is
 * `userSettings.defaultTranscriptionProviderId` (a credential id, the
 * managed sentinel, or null) — the per-row `isDefaultTranscription`
 * boolean is derived from it here so the UI has a single source of truth.
 * When the instance offers managed transcription, it is prepended as a
 * first-class entry. Disabled credentials are excluded unless the settings
 * card explicitly requests them so the user can enable them again.
 */
export async function listUserProviders(
    userId: string,
    options: ListUserProvidersOptions = {},
): Promise<ProviderListItem[]> {
    const pointers = await loadDefaultProviderPointers(userId);

    const rows = await db
        .select({
            id: apiCredentials.id,
            provider: apiCredentials.provider,
            baseUrl: apiCredentials.baseUrl,
            defaultModel: apiCredentials.defaultModel,
            inputUsdPerMillion: apiCredentials.inputUsdPerMillion,
            outputUsdPerMillion: apiCredentials.outputUsdPerMillion,
            audioUsdPerHour: apiCredentials.audioUsdPerHour,
            createdAt: apiCredentials.createdAt,
            disabledAt: apiCredentials.disabledAt,
        })
        .from(apiCredentials)
        .where(
            options.includeDisabled
                ? eq(apiCredentials.userId, userId)
                : and(
                      eq(apiCredentials.userId, userId),
                      isNull(apiCredentials.disabledAt),
                  ),
        )
        // Postgres has no default order, and an UPDATE rewrites the row,
        // moving it in the heap -- so without this the list reshuffled
        // every time the user clicked "Use for transcription". Oldest
        // first, with id as the tiebreaker for rows created in the same
        // millisecond.
        .orderBy(apiCredentials.createdAt, apiCredentials.id);

    const learn = isLearnDeploymentAvailable();
    const credentials: ProviderListItem[] = rows.map(
        ({
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
                isDefaultTranscription: row.id === pointers.transcription,
                isDefaultEnhancement: row.id === pointers.summary,
                isDefaultTopics: row.id === pointers.topics,
                isDefaultTitle: row.id === pointers.title,
                ...(learn ? { isDefaultLearn: row.id === pointers.learn } : {}),
            };
        },
    );

    const managed = await getManagedTranscriptionProvider(
        userId,
        isRiffadoIncludedProviderId(pointers.transcription),
    );

    return managed ? [managed, ...credentials] : credentials;
}
