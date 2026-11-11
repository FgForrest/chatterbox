import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { retryLostPipelineStepsInTx } from "@/db/queries/pipeline-jobs";
import { lockTrimRecording } from "@/db/queries/trim-state";
import { chatterItems, itemProcessing, recordings } from "@/db/schema";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { nudge } from "@/lib/jobs/nudge";
import { effectiveManualOnly } from "@/lib/pipeline/effective-profile";
import { processAgainPending } from "@/lib/pipeline/outdated";
import { updatePhaseInTx } from "@/lib/pipeline/state";
import { requestAdvanceInTx } from "@/lib/pipeline/trigger";
import { resolveItemProfile } from "@/lib/profiles/resolve";
import { requireRecordingView } from "@/lib/sharing/access";
import { authorizeSummaryReplacementInTx } from "@/lib/summary/replacement";

type IdContext = { params: Promise<{ id: string }> };

export const POST = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const userId = session.user.id;
    const { id: itemId } = await (context as IdContext).params;
    await requireRecordingView(userId, itemId, "private", {
        kinds: ["audio", "mail"],
    });
    const profile = await resolveItemProfile(itemId, "private", userId);
    const steps = profile.settings.steps;
    const hasAutomaticStep = Object.values(steps).some(
        (step) => "automatic" in step && step.automatic,
    );

    const advance = await db.transaction(async (tx) => {
        const recording = await lockTrimRecording(tx, userId, itemId);
        if (!recording)
            await tx
                .select({ id: chatterItems.id })
                .from(chatterItems)
                .where(
                    and(
                        eq(chatterItems.id, itemId),
                        eq(chatterItems.userId, userId),
                    ),
                )
                .for("update");
        const [processing] = await tx
            .select({
                manualOnly: itemProcessing.manualOnly,
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
            .for("update")
            .limit(1);
        if (
            processing &&
            (await retryLostPipelineStepsInTx(tx, itemId, userId))
        ) {
            const requested = await requestAdvanceInTx(tx, {
                itemId,
                userId,
                view: "private",
                reason: "process-again",
            });
            if (requested)
                await authorizeSummaryReplacementInTx(tx, {
                    itemId,
                    userId,
                    generation: requested.requestedGeneration,
                });
            return requested;
        }
        if (!hasAutomaticStep)
            throw new AppError(
                ErrorCode.CONFLICT,
                "This profile has no automatic processing steps",
                409,
            );
        if (
            !processing ||
            effectiveManualOnly(processing) ||
            (!processAgainPending(processing.phases) &&
                !processing.phases.trim &&
                !("trim" in steps && steps.trim.automatic))
        ) {
            throw new AppError(
                ErrorCode.CONFLICT,
                "This item is not waiting to be processed again",
                409,
            );
        }
        const requested = await requestAdvanceInTx(tx, {
            itemId,
            userId,
            view: "private",
            reason: "process-again",
        });
        if (!requested) {
            throw new AppError(ErrorCode.NOT_FOUND, "Item not found", 404);
        }
        if (recording) {
            await tx
                .update(recordings)
                .set({ trimProposal: null })
                .where(
                    and(
                        eq(recordings.id, itemId),
                        eq(recordings.userId, userId),
                    ),
                );
            await tx
                .update(itemProcessing)
                .set({
                    phases: {
                        ...processing.phases,
                        trim: {
                            at: new Date().toISOString(),
                            state: "outdated",
                            reason: "process_again",
                            jobId: undefined,
                            generation: requested.requestedGeneration,
                        },
                    },
                })
                .where(
                    and(
                        eq(itemProcessing.itemId, itemId),
                        eq(itemProcessing.userId, userId),
                        eq(itemProcessing.view, "private"),
                    ),
                );
        }
        await updatePhaseInTx(tx, itemId, "private", userId, "categorize", {
            state: "done",
            reason: "process_again",
            generation: requested.requestedGeneration,
            at: new Date().toISOString(),
        });
        await authorizeSummaryReplacementInTx(tx, {
            itemId,
            userId,
            generation: requested.requestedGeneration,
        });
        return requested;
    });
    nudge();
    return NextResponse.json({
        itemId,
        requestedGeneration: advance?.requestedGeneration,
    });
});
