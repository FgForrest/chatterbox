import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { chatterItems, mailPendingShares, recordingFolders } from "@/db/schema";
import { retryOnDeadlock } from "@/lib/deadlock-retry";
import { AppError, ErrorCode } from "@/lib/errors";
import {
    assertCategorizableFolder,
    orgTreeChanged,
    shareItemToOrganizationFolderInTx,
} from "@/lib/folders/folders";
import { nudge } from "@/lib/jobs/nudge";
import { getOrgUserId } from "@/lib/org/config";
import { requestAdvanceInTx } from "@/lib/pipeline/trigger";
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
    },
): Promise<void> {
    const folder = await assertCategorizableFolder(
        input.ownerUserId,
        input.folderId,
        tx,
    );
    if (folder.scope !== "org") {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "An intended placement must target an Organization folder",
            400,
        );
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
    const orgUserId = await getOrgUserId();
    if (!orgUserId) return [];
    const intents = await db
        .select({ folderId: mailPendingShares.folderId })
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
        .where(
            and(
                eq(mailPendingShares.userId, ownerUserId),
                eq(mailPendingShares.itemId, itemId),
                eq(chatterItems.userId, ownerUserId),
                eq(recordingFolders.userId, orgUserId),
            ),
        );
    let shared = false;
    for (const intent of intents) {
        const result = await retryOnDeadlock(() =>
            db.transaction(async (tx) => {
                const [current] = await tx
                    .select({ folderId: mailPendingShares.folderId })
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
                    .where(
                        and(
                            eq(mailPendingShares.userId, ownerUserId),
                            eq(mailPendingShares.itemId, itemId),
                            eq(mailPendingShares.folderId, intent.folderId),
                            eq(chatterItems.userId, ownerUserId),
                            eq(recordingFolders.userId, orgUserId),
                        ),
                    )
                    .limit(1);
                if (!current) return { problems: [], shared: false };
                const problems = await shareItemToOrganizationFolderInTx(tx, {
                    ownerUserId,
                    itemId,
                    folderId: current.folderId,
                    orgUserId,
                });
                if (problems.length > 0) return { problems, shared: false };
                await tx
                    .delete(mailPendingShares)
                    .where(
                        and(
                            eq(mailPendingShares.userId, ownerUserId),
                            eq(mailPendingShares.itemId, itemId),
                            eq(mailPendingShares.folderId, current.folderId),
                        ),
                    );
                return { problems: [], shared: true };
            }),
        );
        if (result.problems.length > 0) return result.problems;
        shared ||= result.shared;
    }
    if (shared) {
        nudge();
        await orgTreeChanged();
    }
    return [];
}

/** Withdraw an owner's intended placement without sharing the item. */
export async function cancelIntendedPlacement(
    ownerUserId: string,
    itemId: string,
    folderId: string,
): Promise<void> {
    await db.transaction(async (tx) => {
        await tx
            .delete(mailPendingShares)
            .where(
                and(
                    eq(mailPendingShares.userId, ownerUserId),
                    eq(mailPendingShares.itemId, itemId),
                    eq(mailPendingShares.folderId, folderId),
                ),
            );
        await requestAdvanceInTx(tx, {
            itemId,
            userId: ownerUserId,
            view: "private",
            reason: "placement",
        });
    });
    nudge();
}
