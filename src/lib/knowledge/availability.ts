/**
 * Whether Learn can run: where, for whom, and with what.
 *
 * Learn reads recordings with the person's own chat provider and keeps what
 * it learns on this instance, so it exists only on self-hosted instances.
 * Without the embedding service it still runs, matching names by their words
 * only, and says so.
 */

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { apiCredentials } from "@/db/schema";
import { pickEnhancementCredential } from "@/lib/ai/enhancement-provider";
import { env } from "@/lib/env";

/** Learn exists on this deployment: self-hosted. */
export function isLearnDeploymentAvailable(): boolean {
    return !env.IS_HOSTED;
}

/**
 * Learn can run for `userId`: the deployment has it, and they have a chat
 * provider (a transcription-only one is not enough). On a shared recording
 * that is the organization account's run with the actor's provider, as for
 * summaries, so pass the actor.
 */
export async function isLearnAvailableFor(userId: string): Promise<boolean> {
    if (!isLearnDeploymentAvailable()) return false;
    const configured = await db
        .select({
            provider: apiCredentials.provider,
            isDefaultEnhancement: apiCredentials.isDefaultEnhancement,
        })
        .from(apiCredentials)
        .where(eq(apiCredentials.userId, userId));
    return pickEnhancementCredential(configured) !== undefined;
}

/**
 * Automatic Learn is offered to `userId`: wherever Learn can run for them.
 * It stays off until they turn it on.
 */
export function isAutoLearnOffered(userId: string): Promise<boolean> {
    return isLearnAvailableFor(userId);
}

/** Names can be matched by meaning too: an embedding service is configured. */
export function isEmbeddingAvailable(): boolean {
    return isLearnDeploymentAvailable() && env.EMBEDDING_BASE_URL !== undefined;
}
