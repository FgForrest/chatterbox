import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { recordingItemJoin, touchRecording } from "@/db/items";
import {
    chatterItems,
    itemProcessing,
    mailContents,
    recordings,
    transcriptions,
} from "@/db/schema";
import { encryptText } from "@/lib/encryption/fields";
import { nudge } from "@/lib/jobs/nudge";
import { markSummaryStepDoneInTx, updatePhaseInTx } from "@/lib/pipeline/state";
import { requestAdvanceInTx } from "@/lib/pipeline/trigger";
import { titleStepDoneForFence } from "@/lib/recordings/title-fence";
import type { TitleInputFence } from "@/lib/recordings/title-input";
import { contentWriterRefusal, sharingOrgUserId } from "@/lib/sharing/writer";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type GeneratedTitleStoreOptions = {
    skipIfTitleStepDoneForFence?: boolean;
    actsForOrganization?: boolean;
};

async function readTitleProcessingInTx(tx: Tx, userId: string, itemId: string) {
    const [processing] = await tx
        .select({
            phases: itemProcessing.phases,
            profileRevisionId: itemProcessing.profileRevisionId,
        })
        .from(itemProcessing)
        .where(
            and(
                eq(itemProcessing.itemId, itemId),
                eq(itemProcessing.userId, userId),
                eq(itemProcessing.view, "private"),
            ),
        )
        .limit(1);
    return processing;
}

async function titleFenceMatches(
    tx: Tx,
    userId: string,
    itemId: string,
    kind: "audio" | "mail",
    fence: TitleInputFence,
    profileRevisionId: string | null,
): Promise<boolean> {
    if (profileRevisionId !== fence.profileRevisionId) {
        return false;
    }
    if (kind === "mail") {
        const [content] = await tx
            .select({ id: mailContents.id, revision: mailContents.revision })
            .from(mailContents)
            .where(
                and(
                    eq(mailContents.itemId, itemId),
                    eq(mailContents.userId, userId),
                ),
            )
            .limit(1);
        return (
            content?.id === fence.contentId &&
            content.revision === fence.contentRevision &&
            fence.contentSourceId === "mail"
        );
    }
    const [content] = await tx
        .select({ id: transcriptions.id, revision: transcriptions.revision })
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.recordingId, itemId),
                eq(transcriptions.userId, userId),
                eq(transcriptions.source, fence.contentSourceId),
            ),
        )
        .limit(1);
    return (
        content?.id === fence.contentId &&
        content.revision === fence.contentRevision
    );
}

async function requestTitleAfterFenceInTx(
    tx: Tx,
    userId: string,
    itemId: string,
    fence: TitleInputFence,
): Promise<boolean> {
    const [processing] = await tx
        .select({
            profileRevisionId: itemProcessing.profileRevisionId,
            phases: itemProcessing.phases,
        })
        .from(itemProcessing)
        .where(
            and(
                eq(itemProcessing.itemId, itemId),
                eq(itemProcessing.userId, userId),
                eq(itemProcessing.view, "private"),
            ),
        )
        .limit(1);
    if (!processing) return false;
    const advance = await requestAdvanceInTx(tx, {
        itemId,
        userId,
        view: "private",
        reason: "title",
    });
    if (!advance) return false;
    const reason =
        processing.profileRevisionId !== fence.profileRevisionId
            ? "profile_changed"
            : "content_changed";
    const summary = processing.phases.summary;
    await updatePhaseInTx(tx, itemId, "private", userId, "summary", {
        ...(summary ?? {
            state: "outdated",
            generation: advance.requestedGeneration,
            at: new Date().toISOString(),
        }),
        state: "outdated",
        reason,
        generation: advance.requestedGeneration,
        at: new Date().toISOString(),
        steps: {
            ...summary?.steps,
            title: {
                contentId: fence.contentId,
                contentRevision: fence.contentRevision,
                generation: advance.requestedGeneration,
                profileRevisionId: fence.profileRevisionId ?? undefined,
                state: "outdated",
                reason,
            },
        },
    });
    return true;
}

async function markTitleDoneInTx(
    tx: Tx,
    userId: string,
    itemId: string,
    fence: TitleInputFence,
): Promise<boolean> {
    return markSummaryStepDoneInTx(tx, {
        itemId,
        userId,
        view: "private",
        step: "title",
        content: {
            contentId: fence.contentId,
            contentSourceId: fence.contentSourceId,
            contentRevision: fence.contentRevision,
        },
    });
}

/**
 * Store a generated title as the recording's name. Automatic runs preserve
 * a person's edit; an explicit regeneration may replace the edit observed
 * before generation. A newer edit always wins. Returns whether stored.
 *
 * The owner's run generates it, and a recording shared while the title was
 * being generated is the organization account's to change: checked under
 * the recording lock sharing takes, so that share wins too.
 */
export async function storeGeneratedTitle(
    userId: string,
    recordingId: string,
    title: string,
    expectedTitleEditedAt?: Date | null,
    actorUserId = userId,
    fence?: TitleInputFence,
    options?: GeneratedTitleStoreOptions,
): Promise<boolean> {
    // Before the transaction; see `sharingOrgUserId`.
    const orgUserId = await sharingOrgUserId();
    const outcome = await db.transaction(async (tx) => {
        await tx
            .select({ id: recordings.id })
            .from(recordings)
            .where(
                and(
                    eq(recordings.id, recordingId),
                    eq(recordings.userId, userId),
                ),
            )
            .for("update");
        if (
            await contentWriterRefusal(tx, {
                recordingId,
                ownerUserId: userId,
                actorUserId,
                orgUserId,
                actsForOrganization: options?.actsForOrganization,
            })
        ) {
            return { stored: false, advance: false };
        }
        if (fence) {
            const processing = await readTitleProcessingInTx(
                tx,
                userId,
                recordingId,
            );
            if (
                options?.skipIfTitleStepDoneForFence &&
                titleStepDoneForFence(processing, fence)
            ) {
                return { stored: false, advance: false };
            }
            if (
                !(await titleFenceMatches(
                    tx,
                    userId,
                    recordingId,
                    "audio",
                    fence,
                    processing?.profileRevisionId ?? null,
                ))
            ) {
                return {
                    stored: false,
                    advance: await requestTitleAfterFenceInTx(
                        tx,
                        userId,
                        recordingId,
                        fence,
                    ),
                };
            }
        }
        const now = new Date();
        const titleCondition = expectedTitleEditedAt
            ? eq(chatterItems.titleEditedAt, expectedTitleEditedAt)
            : isNull(chatterItems.titleEditedAt);
        const stored = await tx
            .update(chatterItems)
            .set({
                title: encryptText(title),
                ...(expectedTitleEditedAt ? { titleEditedAt: null } : {}),
                updatedAt: now,
            })
            .where(
                and(
                    eq(chatterItems.id, recordingId),
                    eq(chatterItems.userId, userId),
                    isNull(chatterItems.deletedAt),
                    titleCondition,
                ),
            )
            .returning({ id: chatterItems.id });
        if (stored.length === 0) return { stored: false, advance: false };
        await touchRecording(tx, recordingId, userId, now);
        return {
            stored: true,
            advance: fence
                ? await markTitleDoneInTx(tx, userId, recordingId, fence)
                : false,
        };
    });
    if (outcome.advance) nudge();
    return outcome.stored;
}

/** Store a generated mail title unless a person edited it meanwhile. */
export async function storeGeneratedMailTitle(
    userId: string,
    itemId: string,
    title: string,
    expectedTitleEditedAt?: Date | null,
    actorUserId = userId,
    fence?: TitleInputFence,
    options?: GeneratedTitleStoreOptions,
): Promise<boolean> {
    const orgUserId = await sharingOrgUserId();
    const outcome = await db.transaction(async (tx) => {
        const [item] = await tx
            .select({ id: chatterItems.id })
            .from(chatterItems)
            .where(
                and(
                    eq(chatterItems.id, itemId),
                    eq(chatterItems.userId, userId),
                    eq(chatterItems.kind, "mail"),
                    isNull(chatterItems.deletedAt),
                ),
            )
            .for("update")
            .limit(1);
        if (!item) return { stored: false, advance: false };
        if (
            await contentWriterRefusal(tx, {
                recordingId: itemId,
                ownerUserId: userId,
                actorUserId,
                orgUserId,
                actsForOrganization: options?.actsForOrganization,
            })
        ) {
            return { stored: false, advance: false };
        }
        if (fence) {
            const processing = await readTitleProcessingInTx(
                tx,
                userId,
                itemId,
            );
            if (
                options?.skipIfTitleStepDoneForFence &&
                titleStepDoneForFence(processing, fence)
            ) {
                return { stored: false, advance: false };
            }
            if (
                !(await titleFenceMatches(
                    tx,
                    userId,
                    itemId,
                    "mail",
                    fence,
                    processing?.profileRevisionId ?? null,
                ))
            ) {
                return {
                    stored: false,
                    advance: await requestTitleAfterFenceInTx(
                        tx,
                        userId,
                        itemId,
                        fence,
                    ),
                };
            }
        }
        const titleCondition = expectedTitleEditedAt
            ? eq(chatterItems.titleEditedAt, expectedTitleEditedAt)
            : isNull(chatterItems.titleEditedAt);
        const stored = await tx
            .update(chatterItems)
            .set({
                title: encryptText(title),
                ...(expectedTitleEditedAt ? { titleEditedAt: null } : {}),
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(chatterItems.id, itemId),
                    eq(chatterItems.userId, userId),
                    eq(chatterItems.kind, "mail"),
                    isNull(chatterItems.deletedAt),
                    titleCondition,
                ),
            )
            .returning({ id: chatterItems.id });
        if (stored.length === 0) return { stored: false, advance: false };
        return {
            stored: true,
            advance: fence
                ? await markTitleDoneInTx(tx, userId, itemId, fence)
                : false,
        };
    });
    if (outcome.advance) nudge();
    return outcome.stored;
}

/**
 * Whether no person has set the recording's title since a generated one was
 * stored. Read right before the title leaves Riffado, e.g. for Plaud: a
 * rename made meanwhile is kept here, and must not be replaced there.
 */
export async function titleStillGenerated(
    userId: string,
    recordingId: string,
): Promise<boolean> {
    const [row] = await db
        .select({ titleEditedAt: chatterItems.titleEditedAt })
        .from(recordings)
        .innerJoin(chatterItems, recordingItemJoin)
        .where(
            and(eq(recordings.id, recordingId), eq(recordings.userId, userId)),
        )
        .limit(1);
    return row !== undefined && row.titleEditedAt === null;
}
