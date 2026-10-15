import {
    type AutoLearnOutcome,
    startAutomaticLearn,
} from "@/lib/learn/auto-learn";

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
