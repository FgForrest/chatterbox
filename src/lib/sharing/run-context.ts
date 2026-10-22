import { userCuratesOrganizationNow } from "@/lib/authz/curator";
import { AppError } from "@/lib/errors";
import { getOrgUserId } from "@/lib/org/config";
import {
    type AccessOptions,
    type RecordingView,
    requireRecordingView,
} from "@/lib/sharing/access";
import { isRecordingShared } from "@/lib/sharing/shared";

/**
 * Whose data a transcription or summary run touches.
 *
 * On an unshared recording these are all the owner. While shared
 * they split: the recording and the rows written stay the owner's (a shared
 * recording is one recording), the run follows the Organization's prompts
 * and language, and the provider, model and keys are the actor's, who pays
 * for the run.
 */
export interface ContentRunContext {
    view: Exclude<RecordingView, "received">;
    actorUserId: string;
    ownerUserId: string;
    /** Owner of the transcript/summary rows read and written: the recording's owner. */
    contentUserId: string;
    /** Source of prompts, templates and output language. */
    settingsUserId: string;
    /**
     * Whether the actor may change the recording for the Organization (a
     * curator, or the organization account), decided when the run starts
     * working, not when it was queued.
     */
    actsForOrganization: boolean;
}

/** Private-view context: every role is the owner. */
export function privateRunContext(ownerUserId: string): ContentRunContext {
    return {
        view: "private",
        actorUserId: ownerUserId,
        ownerUserId,
        contentUserId: ownerUserId,
        settingsUserId: ownerUserId,
        actsForOrganization: false,
    };
}

/**
 * Resolve the context for `actorUserId` running on `recordingId`.
 *
 * Returns null when the actor may not use that view, which callers report the
 * same way as a missing recording.
 */
export async function resolveRunContext(
    actorUserId: string,
    recordingId: string,
    view: RecordingView,
    options: AccessOptions = {},
): Promise<ContentRunContext | null> {
    if (view === "received") return null;
    if (view === "private") {
        const context = privateRunContext(actorUserId);
        const orgUserId = await getOrgUserId();
        if (orgUserId && (await isRecordingShared(recordingId, orgUserId))) {
            context.settingsUserId = orgUserId;
        }
        return context;
    }
    try {
        const access = await requireRecordingView(
            actorUserId,
            recordingId,
            view,
            options,
        );
        return {
            view,
            actorUserId,
            ownerUserId: access.ownerUserId,
            contentUserId: access.contentUserId,
            // Never null here: the Organization view requires the account.
            settingsUserId: access.shared
                ? (access.orgUserId ?? access.ownerUserId)
                : access.ownerUserId,
            actsForOrganization:
                view === "org" &&
                (await userCuratesOrganizationNow(actorUserId)),
        };
    } catch (error) {
        if (error instanceof AppError && error.statusCode === 404) return null;
        throw error;
    }
}
