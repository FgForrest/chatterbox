import { db } from "@/db";
import { meetingFolders } from "@/db/queries/meetings";
import { enhancementChatModel } from "@/lib/ai/enhancement-provider";
import { AppError, ErrorCode } from "@/lib/errors";
import { requireMeetingAccess } from "@/lib/meetings/access";
import { resolveStepProviderSelection } from "@/lib/profiles/providers";
import { resolveProfileForPlacements } from "@/lib/profiles/resolve-for-placement";

/** Resolve the agenda folder's summary role without selecting a replacement provider. */
export async function agendaSuggestionsProvider(userId: string, id: string) {
    const access = await requireMeetingAccess(userId, id, "edit");
    const [folder] = access.agenda.meetingItemId
        ? await meetingFolders(
              db,
              access.agenda.meetingItemId,
              access.agenda.userId,
          )
        : [];
    if (!folder)
        throw new AppError(ErrorCode.NOT_FOUND, "Folder not found", 404);
    const resolution = await resolveProfileForPlacements({
        ownerUserId: userId,
        itemId: access.agenda.meetingItemId ?? id,
        channel: "audio",
        folderIds: [folder.id],
        view: folder.userId === access.viewer.orgUserId ? "org" : "private",
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
        actorUserId: userId,
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
        folder,
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
