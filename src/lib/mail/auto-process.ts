import { ALL_ITEM_KINDS } from "@/lib/content/item-kinds";
import { env } from "@/lib/env";
import { isLearnAvailableFor } from "@/lib/knowledge/availability";
import { startLearnRun } from "@/lib/learn/learn-job";
import { requestAdvance } from "@/lib/pipeline/trigger";
import { consumeRateLimitBucket } from "@/lib/rate-limit";
import { resolveRecordingAccess } from "@/lib/sharing/access";

/**
 * Request processing after a new mail is stored. Never throws: the mail is
 * stored whatever happens here.
 */
export async function processNewMail(
    ownerUserId: string,
    itemId: string,
): Promise<void> {
    try {
        await requestAdvance({
            itemId,
            userId: ownerUserId,
            view: "private",
            reason: "arrival",
        });
    } catch (error) {
        console.error(
            `[mail] could not queue the processing of mail ${itemId}:`,
            error instanceof Error ? error.message : error,
        );
    }
}

/** Automatic Learn on a new mail, under automatic Learn's hourly cap. */
export async function autoLearnMail(
    ownerUserId: string,
    itemId: string,
): Promise<void> {
    if (!(await isLearnAvailableFor(ownerUserId))) return;
    const access = await resolveRecordingAccess(ownerUserId, itemId, {
        kinds: ALL_ITEM_KINDS,
    });
    // Shared already (a retry merged into a shared item): the
    // Organization's curator runs Learn there.
    if (!access || access.role !== "owner" || access.shared) return;
    const rateLimit = await consumeRateLimitBucket(
        `auto-learn:user:${ownerUserId}`,
        {
            limit: env.AUTO_SUMMARY_RATE_LIMIT_PER_HOUR,
            windowMs: 60 * 60 * 1000,
        },
    );
    if (!rateLimit.allowed) return;
    await startLearnRun({
        access: { ...access, view: "private", contentUserId: ownerUserId },
        actorUserId: ownerUserId,
        source: "riffado",
        trigger: "auto",
    });
}
