import { and, eq, isNull } from "drizzle-orm";
import type { db } from "@/db";
import { lockPipelineTargetsInTx } from "@/db/queries/pipeline-jobs";
import { lockProfileMutation } from "@/db/queries/profile-mutations";
import {
    itemProcessing,
    processingProfiles,
    recordingFolderAssignments,
    recordings,
} from "@/db/schema";
import { AppError } from "@/lib/errors";
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
        allowUnavailableFolder?: boolean;
    },
) {
    const view = input.view ?? "private";
    let folder = input.folder;
    let profile = input.profile;
    if (folder && folder.scope !== "org" && view === "private") {
        try {
            await lockCategorizableFolderInTx(
                tx,
                input.userId,
                folder.folderId,
            );
        } catch (error) {
            if (
                !input.allowUnavailableFolder ||
                !(error instanceof AppError) ||
                error.statusCode !== 404
            )
                throw error;
            folder = null;
            profile = null;
        }
    }
    if (folder && view === "private") {
        if (folder.scope === "org") {
            await recordIntendedPlacementInTx(tx, {
                ownerUserId: input.userId,
                itemId: input.itemId,
                folderId: folder.folderId,
                requestPipeline: false,
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
            manualOnly: input.manualOnly ?? false,
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
