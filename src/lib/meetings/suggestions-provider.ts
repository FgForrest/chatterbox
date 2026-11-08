import { and, inArray } from "drizzle-orm";
import { db } from "@/db";
import { meetingFolderVisibility } from "@/db/queries/meeting-folder-visibility";
import { meetingFolders } from "@/db/queries/meetings";
import { recordingFolders } from "@/db/schema";
import { enhancementChatModel } from "@/lib/ai/enhancement-provider";
import { AppError, ErrorCode } from "@/lib/errors";
import { requireMeetingAccess } from "@/lib/meetings/access";
import { resolveStepProviderSelection } from "@/lib/profiles/providers";
import { resolveProfileForPlacements } from "@/lib/profiles/resolve-for-placement";

/** Resolve visible placement settings and providers under the caller's own account. */
export async function agendaSuggestionsProvider(userId: string, id: string) {
    const access = await requireMeetingAccess(userId, id, "edit");
    const folders = access.agenda.meetingItemId
        ? await meetingFolders(
              db,
              access.agenda.meetingItemId,
              access.agenda.userId,
          )
        : [];
    const profileUserId = userId;
    const visibleFolders =
        access.agenda.userId === userId || !folders.length
            ? folders
            : await db
                  .select({
                      id: recordingFolders.id,
                      userId: recordingFolders.userId,
                  })
                  .from(recordingFolders)
                  .where(
                      and(
                          inArray(
                              recordingFolders.id,
                              folders.map((folder) => folder.id),
                          ),
                          meetingFolderVisibility(
                              userId,
                              access.viewer.orgUserId,
                          ),
                      ),
                  );
    const resolution = await resolveProfileForPlacements({
        ownerUserId: profileUserId,
        itemId: access.agenda.meetingItemId ?? id,
        channel: "audio",
        folderIds: visibleFolders.map((folder) => folder.id),
        view: visibleFolders.some(
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
