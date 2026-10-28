import { db } from "@/db";
import { meetingFolders } from "@/db/queries/meetings";
import { enhancementChatModel } from "@/lib/ai/enhancement-provider";
import { AppError, ErrorCode } from "@/lib/errors";
import { requireMeetingAccess } from "@/lib/meetings/access";
import { resolveStepProviderSelection } from "@/lib/profiles/providers";
import { resolveProfileForPlacements } from "@/lib/profiles/resolve-for-placement";

/** Resolve placement summary settings; unfiled agendas use their owner's private profile resolution. */
export async function agendaSuggestionsProvider(userId: string, id: string) {
    const access = await requireMeetingAccess(userId, id, "edit");
    const folders = access.agenda.meetingItemId
        ? await meetingFolders(
              db,
              access.agenda.meetingItemId,
              access.agenda.userId,
          )
        : [];
    const profileUserId = folders.length ? userId : access.agenda.userId;
    const resolution = await resolveProfileForPlacements({
        ownerUserId: profileUserId,
        itemId: access.agenda.meetingItemId ?? id,
        channel: "audio",
        folderIds: folders.map((folder) => folder.id),
        view: folders.some(
            (folder) => folder.userId === access.viewer.orgUserId,
        )
            ? "org"
            : "private",
        seedProfiles: false,
        executor: db,
        organizationUserId: access.viewer.orgUserId,
        ignoreItemAssignment: true,
    });
    const profile =
        resolution.status === "resolved" ? resolution.profile : null;
    if (!profile)
        throw new AppError(
            ErrorCode.CONFLICT,
            "Choose a default processing profile before running this step",
            409,
        );
    const pin = profile.settings.steps.summary.provider;
    const selection = await resolveStepProviderSelection({
        step: "summary",
        actorUserId: profileUserId,
        pin,
        readOnly: true,
    });
    if (selection.kind !== "credential")
        throw new AppError(
            ErrorCode.AI_PROVIDER_NOT_CONFIGURED,
            "No AI provider configured",
            400,
        );
    enhancementChatModel(selection.credential);
    return {
        access,
        folders,
        pin,
        outputLanguage: profile.settings.steps.summary.outputLanguage,
    };
}

/** Read-only availability used by the meeting page before enabling its AI action. */
export async function agendaSuggestionsAvailability(
    userId: string,
    id: string,
) {
    try {
        await agendaSuggestionsProvider(userId, id);
        return { available: true as const, reason: null };
    } catch (error) {
        if (!(error instanceof AppError)) throw error;
        return {
            available: false as const,
            reason: error.message,
            errorCode: error.code,
        };
    }
}
