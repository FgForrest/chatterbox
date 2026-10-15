import {
    type AutoLearnOutcome,
    startAutomaticLearn,
} from "@/lib/learn/auto-learn";
import { requestAdvance } from "@/lib/pipeline/trigger";

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
): Promise<AutoLearnOutcome> {
    return startAutomaticLearn({
        userId: ownerUserId,
        itemId,
        source: "mail",
    });
}
