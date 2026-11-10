import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { lockPipelineTargetsInTx } from "@/db/queries/pipeline-jobs";
import {
    dropReleasedAudienceInTx,
    notifyRestrictedAudienceInTx,
} from "@/db/queries/restricted-folders";
import { recordWithheldPlacementInTx } from "@/db/queries/withheld-placement";
import {
    asyncJobs,
    chatterItems,
    itemProcessing,
    mailPendingShares,
    recordingFolderAssignments,
    recordingFolders,
} from "@/db/schema";
import { userCuratesOrganizationNow } from "@/lib/authz/curator";
import { retryOnDeadlock } from "@/lib/deadlock-retry";
import { AppError, ErrorCode } from "@/lib/errors";
import {
    assertCategorizableFolder,
    lockItemForFolderMutation,
    lockOrgTree,
    orgTreeChanged,
    shareItemToOrganizationFolderInTx,
} from "@/lib/folders/folders";
import { nudge } from "@/lib/jobs/nudge";
import { lockOrgPeople } from "@/lib/knowledge/org-people";
import { getOrgUserId, isOrgScopeEnabled } from "@/lib/org/config";
import { effectiveManualOnly } from "@/lib/pipeline/effective-profile";
import { updatePhaseInTx } from "@/lib/pipeline/state";
import { requestAdvanceInTx } from "@/lib/pipeline/trigger";
import { RECORDING_CUT_KIND } from "@/lib/recordings/cut";
import { trimHolds } from "@/lib/recordings/trim-proposal";
import type { ShareGateProblem } from "@/lib/sharing/share-gate";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Record an owner's intended placement in a non-root Organization folder. */
export async function recordIntendedPlacementInTx(
    tx: Tx,
    input: {
        ownerUserId: string;
        itemId: string;
        folderId: string;
        requestPipeline?: boolean;
        canCurate?: boolean;
    },
): Promise<void> {
    await lockOrgTree(tx);
    const folder = await assertCategorizableFolder(
        input.ownerUserId,
        input.folderId,
        tx,
        input.canCurate,
    );
    if (folder.scope !== "org") {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "An intended placement must target an Organization folder",
            400,
        );
    }
    const [targetFolder] = await tx
        .select({
            restrictedAt: recordingFolders.restrictedAt,
            restrictingAt: recordingFolders.restrictingAt,
        })
        .from(recordingFolders)
        .where(eq(recordingFolders.id, folder.folderId));
    if (targetFolder?.restrictedAt || targetFolder?.restrictingAt) {
        await recordWithheldPlacementInTx(
            tx,
            input.ownerUserId,
            input.itemId,
            folder.folderId,
            input.canCurate ?? input.ownerUserId === folder.ownerId,
        );
        return;
    }
    const [item] = await tx
        .select({ id: chatterItems.id })
        .from(chatterItems)
        .where(
            and(
                eq(chatterItems.id, input.itemId),
                eq(chatterItems.userId, input.ownerUserId),
                isNull(chatterItems.deletedAt),
            ),
        )
        .limit(1);
    if (!item) {
        throw new AppError(ErrorCode.NOT_FOUND, "Item not found", 404);
    }
    await tx
        .insert(mailPendingShares)
        .values({
            itemId: input.itemId,
            userId: input.ownerUserId,
            folderId: folder.folderId,
        })
        .onConflictDoNothing();
    if (input.requestPipeline !== false) {
        await requestAdvanceInTx(tx, {
            itemId: input.itemId,
            userId: input.ownerUserId,
            view: "private",
            reason: "placement",
        });
    }
}

/**
 * Execute all intended Organization placements whose share gate passes.
 * A refused gate leaves every remaining intent in place and returns its problems.
 */
export async function executeIntendedShares(
    ownerUserId: string,
    itemId: string,
): Promise<ShareGateProblem[]> {
    return (await executeIntendedSharesWithOutcome(ownerUserId, itemId))
        .problems;
}

export interface IntendedShareOutcome {
    problems: ShareGateProblem[];
    shared: boolean;
    remaining: boolean;
    confirmationRequired: boolean;
    waitingForCut?: boolean;
    waitingForTrim?: boolean;
}

/** Execute intended shares and report whether an intent was fulfilled or remains. */
export async function executeIntendedSharesWithOutcome(
    ownerUserId: string,
    itemId: string,
    claim?: { jobId: string; claimToken: string },
): Promise<IntendedShareOutcome> {
    const orgUserId = await getOrgUserId();
    const canCurate = await userCuratesOrganizationNow(ownerUserId);
    if (!orgUserId || !isOrgScopeEnabled()) {
        const [remaining] = await db
            .select({ folderId: mailPendingShares.folderId })
            .from(mailPendingShares)
            .where(
                and(
                    eq(mailPendingShares.userId, ownerUserId),
                    eq(mailPendingShares.itemId, itemId),
                ),
            )
            .limit(1);
        return {
            problems: [],
            shared: false,
            remaining: remaining !== undefined,
            confirmationRequired: false,
        };
    }
    const intents = await db
        .select({
            folderId: mailPendingShares.folderId,
            confirmedAt: mailPendingShares.confirmedAt,
            manualOnly: itemProcessing.manualOnly,
            phases: itemProcessing.phases,
        })
        .from(mailPendingShares)
        .innerJoin(
            chatterItems,
            and(
                eq(chatterItems.id, mailPendingShares.itemId),
                eq(chatterItems.userId, mailPendingShares.userId),
            ),
        )
        .innerJoin(
            recordingFolders,
            eq(recordingFolders.id, mailPendingShares.folderId),
        )
        .leftJoin(
            itemProcessing,
            and(
                eq(itemProcessing.itemId, mailPendingShares.itemId),
                eq(itemProcessing.userId, ownerUserId),
                eq(itemProcessing.view, "private"),
            ),
        )
        .where(
            and(
                eq(mailPendingShares.userId, ownerUserId),
                eq(mailPendingShares.itemId, itemId),
                eq(chatterItems.userId, ownerUserId),
                eq(recordingFolders.userId, orgUserId),
            ),
        );
    if (
        intents.some(
            (intent) =>
                effectiveManualOnly(intent) && intent.confirmedAt === null,
        )
    ) {
        return {
            problems: [],
            shared: false,
            remaining: true,
            confirmationRequired: true,
        };
    }
    let shared = false;
    for (const intent of intents) {
        const result = await retryOnDeadlock(() =>
            db.transaction(async (tx) => {
                await lockOrgTree(tx);
                await lockOrgPeople(tx);
                await lockItemForFolderMutation(tx, itemId, ownerUserId);
                await lockPipelineTargetsInTx(tx, [
                    { itemId, userId: ownerUserId },
                ]);
                if (claim) {
                    await lockPipelineTargetsInTx(tx, [
                        { itemId, userId: ownerUserId },
                    ]);
                    const [job] = await tx
                        .select({ id: asyncJobs.id })
                        .from(asyncJobs)
                        .where(
                            and(
                                eq(asyncJobs.id, claim.jobId),
                                eq(asyncJobs.userId, ownerUserId),
                                eq(asyncJobs.kind, "pipeline.action"),
                                eq(
                                    asyncJobs.subjectId,
                                    `executeShares:${itemId}`,
                                ),
                                eq(asyncJobs.status, "processing"),
                                eq(asyncJobs.claimToken, claim.claimToken),
                            ),
                        )
                        .for("update")
                        .limit(1);
                    if (!job)
                        throw new AppError(
                            ErrorCode.CONFLICT,
                            "The share job is no longer running",
                            409,
                        );
                }
                const [current] = await tx
                    .select({
                        folderId: mailPendingShares.folderId,
                        confirmedAt: mailPendingShares.confirmedAt,
                    })
                    .from(mailPendingShares)
                    .where(
                        and(
                            eq(mailPendingShares.userId, ownerUserId),
                            eq(mailPendingShares.itemId, itemId),
                            eq(mailPendingShares.folderId, intent.folderId),
                        ),
                    )
                    .for("update")
                    .limit(1);
                if (!current) {
                    return {
                        problems: [],
                        shared: false,
                        confirmationRequired: false,
                    };
                }
                const [cut] = await tx
                    .select({ id: asyncJobs.id })
                    .from(asyncJobs)
                    .where(
                        and(
                            eq(asyncJobs.userId, ownerUserId),
                            eq(asyncJobs.subjectId, itemId),
                            eq(asyncJobs.kind, RECORDING_CUT_KIND),
                            inArray(asyncJobs.status, [
                                "pending",
                                "processing",
                            ]),
                        ),
                    )
                    .limit(1);
                if (cut)
                    return {
                        problems: [],
                        shared: false,
                        confirmationRequired: false,
                        waitingForCut: true,
                    };
                const [processing] = await tx
                    .select({
                        manualOnly: itemProcessing.manualOnly,
                        phases: itemProcessing.phases,
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
                if (trimHolds(processing?.phases.trim))
                    return {
                        problems: [],
                        shared: false,
                        confirmationRequired: false,
                        waitingForTrim: true,
                    };
                if (
                    effectiveManualOnly(processing) &&
                    current.confirmedAt === null
                ) {
                    return {
                        problems: [],
                        shared: false,
                        confirmationRequired: true,
                    };
                }
                try {
                    const folder = await assertCategorizableFolder(
                        ownerUserId,
                        current.folderId,
                        tx,
                        canCurate,
                    );
                    if (
                        folder.scope !== "org" ||
                        folder.ownerId !== orgUserId
                    ) {
                        return {
                            problems: [],
                            shared: false,
                            confirmationRequired: false,
                        };
                    }
                } catch (error) {
                    if (error instanceof AppError) {
                        return {
                            problems: [],
                            shared: false,
                            confirmationRequired: false,
                        };
                    }
                    throw error;
                }
                const problems = await shareItemToOrganizationFolderInTx(tx, {
                    ownerUserId,
                    itemId,
                    folderId: current.folderId,
                    orgUserId,
                });
                if (problems.length > 0) {
                    return {
                        problems,
                        shared: false,
                        confirmationRequired: false,
                    };
                }
                await tx
                    .delete(mailPendingShares)
                    .where(
                        and(
                            eq(mailPendingShares.userId, ownerUserId),
                            eq(mailPendingShares.itemId, itemId),
                            eq(mailPendingShares.folderId, current.folderId),
                        ),
                    );
                return {
                    problems: [],
                    shared: true,
                    confirmationRequired: false,
                };
            }),
        );
        if ("waitingForCut" in result && result.waitingForCut) {
            console.info(`[share] waiting item=${itemId} reason=cut`);
            return {
                problems: [],
                shared,
                remaining: true,
                confirmationRequired: false,
                waitingForCut: true,
            };
        }
        if ("waitingForTrim" in result && result.waitingForTrim)
            return {
                problems: [],
                shared,
                remaining: true,
                confirmationRequired: false,
                waitingForTrim: true,
            };
        if (result.shared)
            console.info(
                `[share] filed item=${itemId} folder=${intent.folderId}`,
            );
        if (result.problems.length > 0) {
            return {
                problems: result.problems,
                shared,
                remaining: true,
                confirmationRequired: false,
            };
        }
        if (result.confirmationRequired) {
            return {
                problems: [],
                shared,
                remaining: true,
                confirmationRequired: true,
            };
        }
        shared ||= result.shared;
    }
    if (shared) {
        nudge();
        await orgTreeChanged();
    }
    const [remaining] = await db
        .select({ folderId: mailPendingShares.folderId })
        .from(mailPendingShares)
        .where(
            and(
                eq(mailPendingShares.userId, ownerUserId),
                eq(mailPendingShares.itemId, itemId),
            ),
        )
        .limit(1);
    return {
        problems: [],
        shared,
        remaining: remaining !== undefined,
        confirmationRequired: false,
    };
}

/** Confirm every current intended Organization placement of a manual-only item. */
export async function confirmIntendedPlacements(
    ownerUserId: string,
    itemId: string,
): Promise<number> {
    const confirmed = await db.transaction(async (tx) => {
        await lockItemForFolderMutation(tx, itemId, ownerUserId);
        const [processing] = await tx
            .select({
                manualOnly: itemProcessing.manualOnly,
                phases: itemProcessing.phases,
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
        if (!effectiveManualOnly(processing)) {
            throw new AppError(
                ErrorCode.CONFLICT,
                "Only a manual-only item needs share confirmation",
                409,
            );
        }
        const rows = await tx
            .update(mailPendingShares)
            .set({ confirmedAt: new Date() })
            .where(
                and(
                    eq(mailPendingShares.userId, ownerUserId),
                    eq(mailPendingShares.itemId, itemId),
                    isNull(mailPendingShares.confirmedAt),
                ),
            )
            .returning({ folderId: mailPendingShares.folderId });
        if (rows.length === 0) {
            throw new AppError(
                ErrorCode.CONFLICT,
                "There are no intended placements to confirm",
                409,
            );
        }
        await requestAdvanceInTx(tx, {
            itemId,
            userId: ownerUserId,
            view: "private",
            reason: "placement",
        });
        return rows.length;
    });
    nudge();
    return confirmed;
}

/** Withdraw an owner's intended placement without sharing the item. */
export async function cancelIntendedPlacement(
    ownerUserId: string,
    itemId: string,
    folderId: string,
): Promise<void> {
    await db.transaction(async (tx) => {
        await lockOrgTree(tx);
        await lockItemForFolderMutation(tx, itemId, ownerUserId);
        const deleted = await tx
            .delete(mailPendingShares)
            .where(
                and(
                    eq(mailPendingShares.userId, ownerUserId),
                    eq(mailPendingShares.itemId, itemId),
                    eq(mailPendingShares.folderId, folderId),
                ),
            )
            .returning({ folderId: mailPendingShares.folderId });
        if (deleted.length) {
            await notifyRestrictedAudienceInTx(tx, folderId);
            await tx
                .delete(recordingFolderAssignments)
                .where(
                    and(
                        eq(recordingFolderAssignments.itemId, itemId),
                        eq(recordingFolderAssignments.userId, ownerUserId),
                        eq(recordingFolderAssignments.folderId, folderId),
                        eq(recordingFolderAssignments.withheld, true),
                    ),
                );
            await dropReleasedAudienceInTx(tx, folderId);
        }
        const advance = await requestAdvanceInTx(tx, {
            itemId,
            userId: ownerUserId,
            view: "private",
            reason: "placement",
        });
        if (!advance || deleted.length === 0) return;
        const [remaining] = await tx
            .select({ folderId: mailPendingShares.folderId })
            .from(mailPendingShares)
            .where(
                and(
                    eq(mailPendingShares.userId, ownerUserId),
                    eq(mailPendingShares.itemId, itemId),
                ),
            )
            .limit(1);
        if (!remaining) {
            await updatePhaseInTx(tx, itemId, "private", ownerUserId, "share", {
                state: "skipped",
                reason: "cancelled",
                generation: advance.requestedGeneration,
                at: new Date().toISOString(),
            });
        }
    });
    nudge();
}
