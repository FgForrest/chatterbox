/**
 * Whether Learn can run: where, for whom, and with what.
 *
 * Learn reads recordings with the provider resolved for the actor and keeps
 * what it learns on this instance, so it exists only on self-hosted instances.
 * Without the embedding service it still runs, matching names by their words
 * only, and says so.
 */

import { env } from "@/lib/env";
import { resolveStepProviderSelection } from "@/lib/profiles/providers";
import type { ProviderPin } from "@/lib/profiles/settings";

/** Learn exists on this deployment: self-hosted. */
export function isLearnDeploymentAvailable(): boolean {
    return !env.IS_HOSTED;
}

/**
 * Learn can run for `userId`: the deployment has it, and the item pin,
 * personal defaults, or Organization defaults resolve to a chat provider.
 */
export async function isLearnAvailableFor(
    userId: string,
    pin: ProviderPin | null = null,
): Promise<boolean> {
    if (!isLearnDeploymentAvailable()) return false;
    try {
        const resolved = await resolveStepProviderSelection({
            step: "learn",
            pin,
            actorUserId: userId,
        });
        return resolved.kind === "credential";
    } catch {
        return false;
    }
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
