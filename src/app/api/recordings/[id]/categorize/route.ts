import { and, eq, inArray, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import {
    itemProcessing,
    mailPendingShares,
    processingProfiles,
    recordingFolderAssignments,
    recordingFolders,
} from "@/db/schema";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import {
    pruneRedundantAssignmentsInTx,
    scheduleFolderExportProjection,
} from "@/lib/folders/folders";
import { nudge } from "@/lib/jobs/nudge";
import { getOrgUserId } from "@/lib/org/config";
import { resolveCategorizationSelection } from "@/lib/pipeline/categorization";
import { loadPrivateCategorizationPanel } from "@/lib/pipeline/categorization-presentation";
import { recordIntendedPlacementInTx } from "@/lib/pipeline/share-intent";
import { updatePhaseInTx } from "@/lib/pipeline/state";
import { requestAdvanceInTx } from "@/lib/pipeline/trigger";
import { resolveSelectedProfile } from "@/lib/profiles/resolve";
import { resolveChannelDefaultProfile } from "@/lib/profiles/resolve-for-placement";
import type { ProfileRecord } from "@/lib/profiles/store";

type IdContext = { params: Promise<{ id: string }> };

const categorizeSchema = z
    .object({
        folderIds: z.array(z.string().min(1)).min(1),
        profileId: z.string().min(1).optional(),
        manualOnly: z.boolean().optional(),
    })
    .strict()
    .refine(({ profileId, manualOnly }) => !(profileId && manualOnly), {
        message: "profileId and manualOnly are mutually exclusive",
    });

function profileSummary(profile: ProfileRecord) {
    return {
        id: profile.id,
        name: profile.name,
        scope: profile.scope,
        channel: profile.channel,
    };
}

async function usableExplicitProfile(input: {
    ownerUserId: string;
    channel: "audio" | "mail";
    profileId: string;
}): Promise<ProfileRecord> {
    const resolved = await resolveSelectedProfile({
        profileId: input.profileId,
        actorUserId: input.ownerUserId,
        view: "private",
    });
    if (!resolved || resolved.profile.channel !== input.channel) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "The profile is not available for this item",
            400,
        );
    }
    return resolved.profile;
}

export const GET = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id: itemId } = await (context as IdContext).params;
    const panel = await loadPrivateCategorizationPanel(session.user.id, itemId);
    if (!panel) throw new AppError(ErrorCode.NOT_FOUND, "Item not found", 404);
    return NextResponse.json(panel, {
        headers: { "Cache-Control": "private, no-store" },
    });
});

export const POST = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const ownerUserId = session.user.id;
    const { id: itemId } = await (context as IdContext).params;
    const parsed = categorizeSchema.safeParse(
        await request.json().catch(() => null),
    );
    if (!parsed.success) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Invalid request body",
            400,
            { issues: parsed.error.issues },
        );
    }

    const {
        item,
        folders,
        resolution: placementResolution,
    } = await resolveCategorizationSelection({
        ownerUserId,
        itemId,
        folderIds: parsed.data.folderIds,
    });
    const personalFolderIds = folders
        .filter(({ scope }) => scope === "personal")
        .map(({ folderId }) => folderId);
    const intendedFolderIds = folders
        .filter(({ scope }) => scope === "org")
        .map(({ folderId }) => folderId);

    const [current] = await db
        .select({
            profileId: itemProcessing.profileId,
            profileRevisionId: itemProcessing.profileRevisionId,
            manualOnly: itemProcessing.manualOnly,
        })
        .from(itemProcessing)
        .where(
            and(
                eq(itemProcessing.itemId, itemId),
                eq(itemProcessing.userId, ownerUserId),
                eq(itemProcessing.view, "private"),
            ),
        )
        .limit(1);
    let selectedProfile: ProfileRecord | null = null;
    let selectedManualOnly: boolean | null = null;
    if (parsed.data.profileId) {
        selectedProfile = await usableExplicitProfile({
            ownerUserId,
            channel: item.kind,
            profileId: parsed.data.profileId,
        });
        selectedManualOnly = false;
    } else if (parsed.data.manualOnly) {
        selectedProfile = await resolveChannelDefaultProfile({
            ownerUserId,
            channel: item.kind,
            view: "private",
        });
        if (!selectedProfile) {
            throw new AppError(
                ErrorCode.CONFLICT,
                "The default processing profile is not available",
                409,
            );
        }
        selectedManualOnly = true;
    } else {
        if (placementResolution.status === "choose") {
            throw new AppError(
                ErrorCode.CONFLICT,
                "Choose a processing profile",
                409,
                {
                    candidates: placementResolution.candidates.map(
                        (candidate) =>
                            candidate.kind === "manual_only"
                                ? { manualOnly: true }
                                : {
                                      ...profileSummary(candidate.profile),
                                      manualOnly: false,
                                  },
                    ),
                },
            );
        }
        if (placementResolution.status !== "resolved") {
            throw new AppError(
                ErrorCode.CONFLICT,
                "A processing profile is not available yet",
                409,
            );
        }
        selectedProfile = placementResolution.profile;
        selectedManualOnly = placementResolution.manualOnly;
    }

    const orgUserId = await getOrgUserId();
    const result = await db.transaction(async (tx) => {
        let profileId = current?.profileId ?? null;
        let profileRevisionId = current?.profileRevisionId ?? null;
        let manualOnly = current?.manualOnly ?? false;
        if (selectedProfile) {
            const [latest] = await tx
                .select({
                    id: processingProfiles.id,
                    revisionId: processingProfiles.currentRevisionId,
                })
                .from(processingProfiles)
                .where(
                    and(
                        eq(processingProfiles.id, selectedProfile.id),
                        eq(
                            processingProfiles.ownerUserId,
                            selectedProfile.ownerUserId,
                        ),
                        eq(processingProfiles.channel, item.kind),
                        isNull(processingProfiles.archivedAt),
                    ),
                )
                .limit(1);
            if (!latest?.revisionId) {
                throw new AppError(
                    ErrorCode.CONFLICT,
                    "The processing profile has no current revision",
                    409,
                );
            }
            profileId = latest.id;
            profileRevisionId = latest.revisionId;
            manualOnly = selectedManualOnly ?? false;
        }

        const existingIntents = await tx
            .select({ folderId: mailPendingShares.folderId })
            .from(mailPendingShares)
            .where(
                and(
                    eq(mailPendingShares.itemId, itemId),
                    eq(mailPendingShares.userId, ownerUserId),
                ),
            );
        const sharedFolderIds = new Set<string>();
        if (orgUserId) {
            const sharedPlacements = await tx
                .select({ folderId: recordingFolderAssignments.folderId })
                .from(recordingFolderAssignments)
                .innerJoin(
                    recordingFolders,
                    and(
                        eq(
                            recordingFolders.id,
                            recordingFolderAssignments.folderId,
                        ),
                        eq(recordingFolders.userId, orgUserId),
                    ),
                )
                .where(
                    and(
                        eq(recordingFolderAssignments.itemId, itemId),
                        eq(recordingFolderAssignments.userId, ownerUserId),
                    ),
                );
            for (const { folderId } of sharedPlacements) {
                sharedFolderIds.add(folderId);
            }
            if (
                sharedPlacements.some(
                    ({ folderId }) => !intendedFolderIds.includes(folderId),
                )
            ) {
                throw new AppError(
                    ErrorCode.CONFLICT,
                    "Unshare it from the Organization folder first",
                    409,
                );
            }
        }
        const requestedIntents = new Set(
            intendedFolderIds.filter(
                (folderId) => !sharedFolderIds.has(folderId),
            ),
        );
        const organizationIntentChanged =
            existingIntents.length !== requestedIntents.size ||
            existingIntents.some(
                ({ folderId }) => !requestedIntents.has(folderId),
            );

        const ownedPlacements = await tx
            .select({ folderId: recordingFolderAssignments.folderId })
            .from(recordingFolderAssignments)
            .innerJoin(
                recordingFolders,
                and(
                    eq(
                        recordingFolders.id,
                        recordingFolderAssignments.folderId,
                    ),
                    eq(recordingFolders.userId, ownerUserId),
                ),
            )
            .where(
                and(
                    eq(recordingFolderAssignments.itemId, itemId),
                    eq(recordingFolderAssignments.userId, ownerUserId),
                ),
            );
        const ownedPlacementIds = ownedPlacements.map(
            ({ folderId }) => folderId,
        );
        if (ownedPlacementIds.length > 0) {
            await tx
                .delete(recordingFolderAssignments)
                .where(
                    and(
                        eq(recordingFolderAssignments.itemId, itemId),
                        eq(recordingFolderAssignments.userId, ownerUserId),
                        inArray(
                            recordingFolderAssignments.folderId,
                            ownedPlacementIds,
                        ),
                    ),
                );
        }
        await tx
            .delete(mailPendingShares)
            .where(
                and(
                    eq(mailPendingShares.itemId, itemId),
                    eq(mailPendingShares.userId, ownerUserId),
                ),
            );
        if (personalFolderIds.length > 0) {
            await tx.insert(recordingFolderAssignments).values(
                personalFolderIds.map((folderId) => ({
                    itemId,
                    userId: ownerUserId,
                    folderId,
                })),
            );
        }
        await pruneRedundantAssignmentsInTx(tx, ownerUserId, itemId);
        for (const folderId of requestedIntents) {
            await recordIntendedPlacementInTx(tx, {
                ownerUserId,
                itemId,
                folderId,
                requestPipeline: false,
            });
        }
        if (orgUserId) {
            await pruneRedundantAssignmentsInTx(tx, orgUserId, itemId);
        }

        const advance = await requestAdvanceInTx(tx, {
            itemId,
            userId: ownerUserId,
            view: "private",
            reason: "categorized",
        });
        if (!advance) {
            throw new AppError(ErrorCode.NOT_FOUND, "Item not found", 404);
        }
        await tx
            .update(itemProcessing)
            .set({
                profileId,
                profileRevisionId,
                manualOnly,
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(itemProcessing.itemId, itemId),
                    eq(itemProcessing.userId, ownerUserId),
                    eq(itemProcessing.view, "private"),
                ),
            );
        await updatePhaseInTx(
            tx,
            itemId,
            "private",
            ownerUserId,
            "categorize",
            {
                state: "done",
                reason: "categorized",
                generation: advance.requestedGeneration,
                at: new Date().toISOString(),
            },
        );
        return { advance, organizationIntentChanged };
    });
    await scheduleFolderExportProjection(ownerUserId);
    if (result.organizationIntentChanged && orgUserId) {
        await scheduleFolderExportProjection(orgUserId);
    }
    nudge();

    return NextResponse.json({
        itemId,
        requestedGeneration: result.advance.requestedGeneration,
    });
});
