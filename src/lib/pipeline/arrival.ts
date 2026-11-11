import { and, eq, isNull } from "drizzle-orm";
import type { db } from "@/db";
import { lockOrgTree } from "@/db/queries/organization-tree";
import { lockPipelineTargetsInTx } from "@/db/queries/pipeline-jobs";
import { lockProfileMutation } from "@/db/queries/profile-mutations";
import {
    itemProcessing,
    processingProfiles,
    recordingFolderAssignments,
    recordings,
} from "@/db/schema";
import { env } from "@/lib/env";
import { AppError, ErrorCode } from "@/lib/errors";
import {
    type assertCategorizableFolder,
    lockCategorizableFolderInTx,
} from "@/lib/folders/folders";
import { attachArrivingRecordingInTx } from "@/lib/meetings/attachment";
import { recordIntendedPlacementInTx } from "@/lib/pipeline/share-intent";
import { updatePhaseInTx } from "@/lib/pipeline/state";
import { requestAdvanceInTx } from "@/lib/pipeline/trigger";
import type { PipelineView } from "@/lib/pipeline/types";
import { resolveProfileForPlacements } from "@/lib/profiles/resolve-for-placement";
import type { ProfileRecord } from "@/lib/profiles/store";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type ArrivalFolder = Awaited<
    ReturnType<typeof assertCategorizableFolder>
>;

export interface ArrivalProfileResolution {
    profile: ProfileRecord;
    manualOnly: boolean;
}

/** Resolve an unambiguous arrival placement to the profile frozen on the item. */
export async function resolveArrivalProfile(input: {
    ownerUserId: string;
    itemId: string;
    channel: "audio" | "mail";
    folderIds: string[];
}): Promise<ArrivalProfileResolution | null> {
    if (input.folderIds.length === 0) return null;
    const resolution = await resolveProfileForPlacements({
        ...input,
        view: "private",
    });
    return resolution.status === "resolved"
        ? {
              profile: resolution.profile,
              manualOnly: resolution.manualOnly,
          }
        : null;
}

/** Take the tree lock before arrival writes that can change an Organization placement. */
export async function lockArrivalOrganizationTree(
    tx: Tx,
    touchesOrganization = false,
): Promise<void> {
    if (
        touchesOrganization &&
        !env.IS_HOSTED &&
        env.SELF_HOST_MODE === "shared"
    )
        await lockOrgTree(tx);
}

/** Request arrival and freeze a resolved placement profile in the creating transaction. */
export async function requestArrivalInTx(
    tx: Tx,
    input: {
        itemId: string;
        userId: string;
        view?: PipelineView;
        profile?: ProfileRecord | null;
        manualOnly?: boolean;
        folder?: ArrivalFolder | null;
        agendaId?: string;
        allowUnavailableFolder?: boolean;
        canCurate: boolean;
        lockOrganizationTree?: boolean;
    },
) {
    const touchesOrganization =
        input.folder?.scope === "org" || input.lockOrganizationTree === true;
    await lockArrivalOrganizationTree(tx, touchesOrganization);
    const view = input.view ?? "private";
    let folder = input.folder;
    let profile = input.profile;
    let manualOnly = input.manualOnly ?? false;
    if (folder && view === "private") {
        try {
            await lockCategorizableFolderInTx(
                tx,
                input.userId,
                folder.folderId,
                false,
                input.canCurate,
            );
        } catch (error) {
            if (
                !input.allowUnavailableFolder ||
                !(error instanceof AppError) ||
                (error.statusCode !== 404 &&
                    error.code !== ErrorCode.RESTRICTED_FOLDER_NO_ACCESS)
            )
                throw error;
            folder = null;
            profile = null;
            manualOnly = false;
        }
    }
    if (folder && view === "private") {
        if (folder.scope === "org") {
            await recordIntendedPlacementInTx(tx, {
                ownerUserId: input.userId,
                itemId: input.itemId,
                folderId: folder.folderId,
                requestPipeline: false,
                canCurate: input.canCurate,
            });
        } else {
            await tx
                .insert(recordingFolderAssignments)
                .values({
                    itemId: input.itemId,
                    userId: input.userId,
                    folderId: folder.folderId,
                })
                .onConflictDoNothing();
        }
    }
    if (profile && view === "private") {
        const [withheld] = await tx
            .select({ id: recordingFolderAssignments.itemId })
            .from(recordingFolderAssignments)
            .where(
                and(
                    eq(recordingFolderAssignments.userId, input.userId),
                    eq(recordingFolderAssignments.itemId, input.itemId),
                    eq(recordingFolderAssignments.withheld, true),
                ),
            )
            .limit(1);
        if (withheld) {
            const resolution = await resolveProfileForPlacements({
                ownerUserId: input.userId,
                itemId: input.itemId,
                channel: profile.channel,
                folderIds: [],
                view: "private",
                executor: tx,
                isCurator: input.canCurate,
                seedProfiles: false,
                throwOnUnavailable: false,
            });
            profile =
                resolution.status === "resolved" ? resolution.profile : null;
            manualOnly =
                resolution.status === "resolved" && resolution.manualOnly;
        }
    }
    if (view === "private") {
        const [recording] = await tx
            .select({ plaudFileId: recordings.plaudFileId })
            .from(recordings)
            .where(
                and(
                    eq(recordings.id, input.itemId),
                    eq(recordings.userId, input.userId),
                ),
            )
            .limit(1);
        if (recording)
            await attachArrivingRecordingInTx(
                tx,
                input.userId,
                input.itemId,
                recording.plaudFileId,
                input.agendaId,
                input.canCurate,
                touchesOrganization,
            );
    }
    if (profile && view === "private") {
        await lockPipelineTargetsInTx(
            tx,
            [{ itemId: input.itemId, userId: input.userId }],
            true,
        );
        await lockProfileMutation(tx, profile.ownerUserId);
    }
    const advance = await requestAdvanceInTx(tx, {
        itemId: input.itemId,
        userId: input.userId,
        view,
        reason: "arrival",
    });
    if (!advance || !profile || view !== "private") return advance;

    const [latest] = await tx
        .select({
            id: processingProfiles.id,
            revisionId: processingProfiles.currentRevisionId,
        })
        .from(processingProfiles)
        .where(
            and(
                eq(processingProfiles.id, profile.id),
                eq(processingProfiles.ownerUserId, profile.ownerUserId),
                eq(processingProfiles.channel, profile.channel),
                isNull(processingProfiles.deletedAt),
                isNull(processingProfiles.archivedAt),
            ),
        )
        .limit(1);
    if (!latest?.revisionId) return advance;

    await tx
        .update(itemProcessing)
        .set({
            profileId: latest.id,
            profileRevisionId: latest.revisionId,
            manualOnly,
            updatedAt: new Date(),
        })
        .where(
            and(
                eq(itemProcessing.itemId, input.itemId),
                eq(itemProcessing.userId, input.userId),
                eq(itemProcessing.view, view),
            ),
        );
    await updatePhaseInTx(tx, input.itemId, view, input.userId, "categorize", {
        state: "done",
        reason: "categorized",
        profileChoice: "placement",
        generation: advance.requestedGeneration,
        at: new Date().toISOString(),
    });
    return advance;
}
