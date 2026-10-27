import { and, eq, inArray } from "drizzle-orm";
import type { db } from "@/db";
import { lockProfileRevisionInTx } from "@/db/queries/profile-revision-guard";
import {
    asyncJobs,
    chatterItems,
    itemProcessing,
    recordingFolderAssignments,
    recordingFolders,
} from "@/db/schema";
import { AppError, ErrorCode } from "@/lib/errors";
import { LEARN_JOB_KIND } from "@/lib/learn/learn-job";
import type { ProfileStepName } from "@/lib/pipeline/types";
import {
    resolveChannelDefaultProfile,
    resolveProfileForPlacements,
} from "@/lib/profiles/resolve-for-placement";
import { TITLE_JOB_KIND } from "@/lib/recordings/title-job";
import { recordingJobSubject } from "@/lib/sharing/view";
import { SUMMARY_JOB_KIND } from "@/lib/summary/summary-job";
import { TOPICS_JOB_KIND } from "@/lib/topics/topics-job";
import { TRANSCRIPTION_JOB_KIND } from "@/lib/transcription/transcription-job";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Bind future steps to the current placement while the caller holds the item lock. */
export async function bindPlacementProfileInTx(
    tx: Tx,
    input: { itemId: string; ownerUserId: string; orgUserId: string },
): Promise<void> {
    const [processing] = await tx
        .select()
        .from(itemProcessing)
        .where(
            and(
                eq(itemProcessing.itemId, input.itemId),
                eq(itemProcessing.userId, input.ownerUserId),
                eq(itemProcessing.view, "private"),
            ),
        )
        .for("update")
        .limit(1);
    if (!processing) return;
    const previousChoice = processing.phases.categorize?.profileChoice;
    if (previousChoice === "manual") return;
    const [item] = await tx
        .select({ kind: chatterItems.kind })
        .from(chatterItems)
        .where(
            and(
                eq(chatterItems.id, input.itemId),
                eq(chatterItems.userId, input.ownerUserId),
            ),
        )
        .limit(1);
    if (!item || item.kind === "meeting") return;
    const phases = processing.phases;
    const categorized = phases.categorize ?? {
        state: "pending" as const,
        reason: "placement",
        generation: processing.requestedGeneration,
        at: new Date().toISOString(),
    };
    const placements = await tx
        .select({
            folderId: recordingFolders.id,
            ownerId: recordingFolders.userId,
        })
        .from(recordingFolderAssignments)
        .innerJoin(
            recordingFolders,
            eq(recordingFolders.id, recordingFolderAssignments.folderId),
        )
        .where(
            and(
                eq(recordingFolderAssignments.itemId, input.itemId),
                eq(recordingFolderAssignments.userId, input.ownerUserId),
                inArray(recordingFolders.userId, [
                    input.ownerUserId,
                    input.orgUserId,
                ]),
            ),
        );
    if (!previousChoice && processing.profileId) {
        const automatic = await resolveProfileForPlacements({
            ownerUserId: input.ownerUserId,
            itemId: input.itemId,
            channel: item.kind,
            folderIds: placements
                .filter((row) => row.ownerId === input.ownerUserId)
                .map((row) => row.folderId),
            view: "private",
            executor: tx,
            organizationUserId: input.orgUserId,
            ignoreItemAssignment: true,
            seedProfiles: false,
            throwOnUnavailable: false,
        });
        if (
            automatic.status !== "resolved" ||
            automatic.profile.id !== processing.profileId
        )
            return;
    }
    const shared = placements.some((row) => row.ownerId === input.orgUserId);
    if (!shared && !categorized.placementProfile) return;
    const resolution = await resolveProfileForPlacements({
        ownerUserId: input.ownerUserId,
        itemId: input.itemId,
        channel: item.kind,
        folderIds: placements
            .filter(
                (row) =>
                    row.ownerId ===
                    (shared ? input.orgUserId : input.ownerUserId),
            )
            .map((row) => row.folderId),
        view: shared ? "org" : "private",
        executor: tx,
        organizationUserId: input.orgUserId,
        ignoreItemAssignment: true,
        seedProfiles: false,
        throwOnUnavailable: false,
    });
    if (shared && resolution.status !== "resolved") return;
    const placementProfile =
        resolution.status === "resolved" && resolution.profile.currentRevisionId
            ? {
                  profileId: resolution.profile.id,
                  profileRevisionId: resolution.profile.currentRevisionId,
                  manualOnly: resolution.manualOnly,
              }
            : undefined;
    if (placementProfile && resolution.status === "resolved") {
        try {
            await lockProfileRevisionInTx(
                tx,
                resolution.profile.ownerUserId,
                placementProfile.profileRevisionId,
            );
        } catch (error) {
            if (
                !(error instanceof AppError) ||
                error.code !== ErrorCode.CONFLICT
            )
                throw error;
            console.warn(
                "Placement profile revision disappeared before binding",
                {
                    itemId: input.itemId,
                    profileRevisionId: placementProfile.profileRevisionId,
                },
            );
            return;
        }
    }
    const oldRevision =
        categorized.placementProfile?.profileRevisionId ??
        processing.profileRevisionId ??
        (
            await resolveChannelDefaultProfile({
                ownerUserId: input.ownerUserId,
                channel: item.kind,
                view: "private",
                seedProfiles: false,
                throwOnUnavailable: false,
                executor: tx,
                organizationUserId: input.orgUserId,
            })
        )?.currentRevisionId;
    const heldProfiles = { ...categorized.heldProfiles };
    const jobSteps: Record<string, ProfileStepName> = {
        [SUMMARY_JOB_KIND]: "summary",
        [TOPICS_JOB_KIND]: "topics",
        [TITLE_JOB_KIND]: "title",
        [TRANSCRIPTION_JOB_KIND]: "transcribe",
        [LEARN_JOB_KIND]: "learn",
    };
    const jobs = await tx
        .select({ id: asyncJobs.id, kind: asyncJobs.kind })
        .from(asyncJobs)
        .where(
            and(
                eq(asyncJobs.userId, input.ownerUserId),
                eq(
                    asyncJobs.subjectId,
                    recordingJobSubject(input.itemId, "private"),
                ),
                inArray(asyncJobs.status, ["pending", "processing"]),
                inArray(asyncJobs.kind, Object.keys(jobSteps)),
            ),
        );
    const activeJobIds = new Set(jobs.map((job) => job.id));
    for (const step of Object.values(jobSteps)) {
        const held = heldProfiles[step];
        if (held && !activeJobIds.has(held.jobId)) delete heldProfiles[step];
    }
    for (const job of jobs) {
        const step = jobSteps[job.kind];
        if (step && oldRevision && heldProfiles[step]?.jobId !== job.id) {
            heldProfiles[step] = {
                jobId: job.id,
                profileRevisionId: oldRevision,
            };
        }
    }
    await tx
        .update(itemProcessing)
        .set({
            ...(!processing.profileId && placementProfile
                ? {
                      profileId: placementProfile.profileId,
                      profileRevisionId: placementProfile.profileRevisionId,
                      manualOnly: placementProfile.manualOnly,
                  }
                : {}),
            phases: {
                ...phases,
                categorize: {
                    ...categorized,
                    profileChoice: "placement",
                    placementProfile,
                    heldProfiles,
                },
            },
            updatedAt: new Date(),
        })
        .where(
            and(
                eq(itemProcessing.itemId, input.itemId),
                eq(itemProcessing.userId, input.ownerUserId),
                eq(itemProcessing.view, "private"),
            ),
        );
}
