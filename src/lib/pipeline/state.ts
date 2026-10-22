import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
    readProcessingRow,
    updateProcessingPhaseInTx,
} from "@/db/queries/pipeline";
import {
    asyncJobs,
    chatterItems,
    itemProcessing,
    mailContents,
} from "@/db/schema";
import { nudge } from "@/lib/jobs/nudge";
import { pipelineDriver } from "@/lib/pipeline/driver";
import { waitForReason } from "@/lib/pipeline/outcome";
import { automaticTitleSettled } from "@/lib/pipeline/title-step";
import {
    requestAdvanceForViewInTx,
    requestAdvanceInTx,
} from "@/lib/pipeline/trigger";
import type {
    ContentRevisionInput,
    PhaseName,
    PhaseRecord,
    PipelinePhases,
    PipelineView,
    ProfileStepName,
    SummaryStepName,
} from "@/lib/pipeline/types";
import { readPreferredTranscript } from "@/lib/transcription/read-source";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Read an item's processing state for one owner and view. */
export function readProcessing(
    itemId: string,
    view: PipelineView,
    userId: string,
) {
    return readProcessingRow(itemId, view, userId);
}

/** Read private-view phase maps for an owner's item ids in one query. */
export async function readPrivateProcessingForItems(
    itemIds: readonly string[],
    userId: string,
): Promise<Map<string, PipelinePhases>> {
    if (itemIds.length === 0) return new Map();
    const rows = await db
        .select({
            itemId: itemProcessing.itemId,
            phases: itemProcessing.phases,
        })
        .from(itemProcessing)
        .where(
            and(
                inArray(itemProcessing.itemId, [...new Set(itemIds)]),
                eq(itemProcessing.userId, userId),
                eq(itemProcessing.view, "private"),
            ),
        );
    return new Map(rows.map((row) => [row.itemId, row.phases]));
}

/** Write one phase without replacing a record from a higher generation. */
export async function updatePhaseInTx(
    tx: Tx,
    itemId: string,
    view: PipelineView,
    userId: string,
    phase: PhaseName,
    record: PhaseRecord,
): Promise<boolean> {
    view = pipelineDriver(userId).view;
    const [current] = await tx
        .select({ phases: itemProcessing.phases })
        .from(itemProcessing)
        .where(
            and(
                eq(itemProcessing.itemId, itemId),
                eq(itemProcessing.userId, userId),
                eq(itemProcessing.view, view),
            ),
        )
        .for("update")
        .limit(1);
    const previous = current?.phases[phase];
    if (phase === "categorize")
        record = {
            profileChoice: previous?.profileChoice,
            placementProfile: previous?.placementProfile,
            heldProfiles: previous?.heldProfiles,
            ...record,
        };
    if (
        record.state !== "outdated" &&
        !["erased", "scope_changed", "cancelled"].includes(
            record.reason ?? "",
        ) &&
        previous
    ) {
        if (previous.jobId) record = { ...record, ...previous };
        if (previous.steps) {
            const steps = { ...record.steps };
            for (const name of ["summary", "topics", "title"] as const) {
                const step = previous.steps[name];
                if (step?.jobId) steps[name] = step;
            }
            record = {
                ...record,
                steps,
                ...(Object.values(steps).some(
                    (step) => step.jobId && step.state === "running",
                )
                    ? { state: "running" as const }
                    : {}),
            };
        }
    }
    if (
        previous &&
        !record.jobId &&
        record.state !== "outdated" &&
        ["pending", "running"].includes(record.state) &&
        previous.profileRevisionId === record.profileRevisionId &&
        previous.inputs?.contentId === record.inputs?.contentId &&
        previous.inputs?.contentRevision === record.inputs?.contentRevision &&
        previous.inputs?.contentSourceId === record.inputs?.contentSourceId
    ) {
        record = {
            ...record,
            replannedAt: previous.replannedAt,
            replanAttempts: previous.replanAttempts,
        };
        if (record.steps) {
            const steps = { ...record.steps };
            for (const name of ["summary", "topics", "title"] as const) {
                const old = previous.steps?.[name];
                const next = steps[name];
                if (
                    old?.replannedAt &&
                    next &&
                    !next.jobId &&
                    ["pending", "running"].includes(next.state ?? "pending") &&
                    old.contentId === next.contentId &&
                    old.contentRevision === next.contentRevision &&
                    old.contentSourceId === next.contentSourceId &&
                    old.profileRevisionId === next.profileRevisionId
                )
                    steps[name] = {
                        ...next,
                        at: old.at ?? previous.at,
                        replannedAt: old.replannedAt,
                        replanAttempts: old.replanAttempts,
                    };
            }
            record = { ...record, steps };
        }
    }
    if (record.state === "waiting" && !record.jobId) {
        const waitingFor = {
            ...(record.waitingFor ?? waitForReason(record.reason)),
        };
        const learnReview = waitingFor.kind === "learnReview";
        const liveLearnReview =
            learnReview && record.reason === "review_pending";
        if (learnReview && !liveLearnReview) delete waitingFor.until;
        else if (previous?.waitingFor?.kind === waitingFor.kind)
            waitingFor.until ??= previous.waitingFor.until;
        if (phase === "learn" && liveLearnReview) {
            const [item] = await tx
                .select({ dueAt: chatterItems.summaryDueAt })
                .from(chatterItems)
                .where(
                    and(
                        eq(chatterItems.id, itemId),
                        eq(chatterItems.userId, userId),
                    ),
                )
                .limit(1);
            if (item?.dueAt) waitingFor.until = item.dueAt.toISOString();
        }
        record = { ...record, waitingFor };
    }
    const updated = await updateProcessingPhaseInTx(
        tx,
        itemId,
        view,
        userId,
        phase,
        record,
    );
    if (
        updated &&
        holdsProfiles(
            phase === "categorize" ? record : current?.phases.categorize,
        )
    )
        await pruneHeldProfilesInTx(
            tx,
            itemId,
            view,
            userId,
            (phase === "transcribe" || phase === "learn") &&
                ["done", "skipped", "failed"].includes(record.state)
                ? phase
                : undefined,
        );
    return updated;
}

function holdsProfiles(categorize: PhaseRecord | undefined): boolean {
    return Object.keys(categorize?.heldProfiles ?? {}).length > 0;
}

async function pruneHeldProfilesInTx(
    tx: Tx,
    itemId: string,
    view: PipelineView,
    userId: string,
    settledStep?: ProfileStepName,
): Promise<void> {
    const [processing] = await tx
        .select({ phases: itemProcessing.phases })
        .from(itemProcessing)
        .where(
            and(
                eq(itemProcessing.itemId, itemId),
                eq(itemProcessing.userId, userId),
                eq(itemProcessing.view, view),
            ),
        )
        .for("update")
        .limit(1);
    const categorize = processing?.phases.categorize;
    const heldProfiles = { ...categorize?.heldProfiles };
    const entries = Object.entries(heldProfiles);
    if (!categorize || entries.length === 0) return;
    const activeJobs = await tx
        .select({ id: asyncJobs.id })
        .from(asyncJobs)
        .where(
            and(
                eq(asyncJobs.userId, userId),
                inArray(
                    asyncJobs.id,
                    entries.map(([, held]) => held.jobId),
                ),
                inArray(asyncJobs.status, ["pending", "processing"]),
            ),
        );
    const activeIds = new Set(activeJobs.map((job) => job.id));
    const kept = Object.fromEntries(
        entries.filter(
            ([step, held]) => step !== settledStep && activeIds.has(held.jobId),
        ),
    );
    if (Object.keys(kept).length === entries.length) return;
    await updateProcessingPhaseInTx(tx, itemId, view, userId, "categorize", {
        ...categorize,
        heldProfiles: kept,
    });
}

function stepUsesInput(
    step: NonNullable<PhaseRecord["steps"]>[SummaryStepName],
    summary: PhaseRecord,
    input: ContentRevisionInput,
): boolean {
    return (
        step?.contentId === input.contentId &&
        (step.contentSourceId ?? summary.inputs?.contentSourceId) ===
            input.contentSourceId &&
        step.contentRevision === input.contentRevision
    );
}

async function settleSummaryStepInTx(
    tx: Tx,
    input: {
        itemId: string;
        userId: string;
        view: PipelineView;
        step: SummaryStepName;
        content: ContentRevisionInput;
        generation?: number;
        inputFingerprint?: string | null;
        currentInputsVerified?: boolean;
    },
    state: "done" | "skipped",
    reason: string,
): Promise<boolean> {
    input = { ...input, ...pipelineDriver(input.userId) };
    const [processing] = await tx
        .select({ phases: itemProcessing.phases })
        .from(itemProcessing)
        .where(
            and(
                eq(itemProcessing.itemId, input.itemId),
                eq(itemProcessing.userId, input.userId),
                eq(itemProcessing.view, input.view),
            ),
        )
        .for("update")
        .limit(1);
    const storedSummary = processing?.phases.summary;
    const summary = storedSummary ?? {
        state: "pending" as const,
        reason: "step-completed",
        generation: input.generation ?? 0,
        inputs: input.content,
        at: new Date().toISOString(),
    };
    const step = summary?.steps?.[input.step];
    if (step?.jobId) return false;
    const recoveringProfileChange =
        input.currentInputsVerified === true &&
        input.step === "summary" &&
        summary.state === "outdated" &&
        summary.reason === "profile_changed";
    const currentReading =
        summary.staleFingerprint !== undefined &&
        summary.staleFingerprint === input.inputFingerprint;
    if (
        !recoveringProfileChange &&
        ((summary.state === "outdated" &&
            !(summary.reason === "learn_changed" && currentReading)) ||
            (input.step !== "title" &&
                (step
                    ? !stepUsesInput(step, summary, input.content) ||
                      (step.state === "outdated" &&
                          !(step.reason === "learn_changed" && currentReading))
                    : summary.inputs !== undefined &&
                      (summary.inputs.contentId !== input.content.contentId ||
                          summary.inputs.contentSourceId !==
                              input.content.contentSourceId ||
                          summary.inputs.contentRevision !==
                              input.content.contentRevision))))
    ) {
        return false;
    }
    if (
        !recoveringProfileChange &&
        stepUsesInput(step, summary, input.content) &&
        step?.state === state &&
        (input.inputFingerprint === undefined ||
            step.inputFingerprint === input.inputFingerprint)
    ) {
        return false;
    }

    const generation =
        input.generation ??
        (
            await requestAdvanceInTx(tx, {
                itemId: input.itemId,
                userId: input.userId,
                view: input.view,
                reason: input.step === "title" ? "title" : "summary",
            })
        )?.requestedGeneration;
    if (generation === undefined) return false;

    const steps = {
        ...summary.steps,
        [input.step]: {
            ...step,
            contentId: input.content.contentId,
            contentSourceId: input.content.contentSourceId,
            contentRevision: input.content.contentRevision,
            generation,
            state,
            reason,
            inputFingerprint: input.inputFingerprint,
        },
    };
    const summaryForInput = { ...summary, inputs: input.content };
    const currentSteps = Object.values(steps).filter((candidate) =>
        stepUsesInput(candidate, summaryForInput, input.content),
    );
    const done =
        currentSteps.length > 0 &&
        currentSteps.every(
            (candidate) =>
                candidate?.state === "done" || candidate?.state === "skipped",
        );
    const updated = await updatePhaseInTx(
        tx,
        input.itemId,
        input.view,
        input.userId,
        "summary",
        {
            ...summary,
            state: done ? "done" : "pending",
            reason: done
                ? "completed"
                : recoveringProfileChange
                  ? "step-completed"
                  : summary.reason,
            generation,
            inputs:
                input.step === "title" || recoveringProfileChange
                    ? input.content
                    : (summary.inputs ?? input.content),
            at: new Date().toISOString(),
            steps,
        },
    );
    if (updated && holdsProfiles(processing?.phases.categorize))
        await pruneHeldProfilesInTx(
            tx,
            input.itemId,
            input.view,
            input.userId,
            input.step,
        );
    return updated;
}

/** Mark a pipeline-queued Summary step done in its output transaction. */
export function markSummaryStepDoneInTx(
    tx: Tx,
    input: {
        itemId: string;
        userId: string;
        view: PipelineView;
        step: SummaryStepName;
        content: ContentRevisionInput;
        generation?: number;
        inputFingerprint?: string | null;
        /** The summary commit verified both current content and item profile. */
        currentInputsVerified?: boolean;
    },
): Promise<boolean> {
    return settleSummaryStepInTx(tx, input, "done", "generated");
}

/**
 * Skip automatic title generation after a summary: for good when titles are
 * off or the title was edited, until the next summary when the attempt failed.
 */
export async function markAutomaticTitleSkipped(input: {
    itemId: string;
    userId: string;
    content: ContentRevisionInput;
    reason:
        | "first_summary_title_disabled"
        | "first_summary_title_edited"
        | "first_summary_title_failed";
}): Promise<boolean> {
    const marked = await db.transaction(async (tx) => {
        const [processing] = await tx
            .select({ phases: itemProcessing.phases })
            .from(itemProcessing)
            .where(
                and(
                    eq(itemProcessing.itemId, input.itemId),
                    eq(itemProcessing.userId, input.userId),
                    eq(itemProcessing.view, "private"),
                ),
            )
            .for("update")
            .limit(1);
        if (processing && automaticTitleSettled(processing.phases)) {
            return false;
        }
        return settleSummaryStepInTx(
            tx,
            {
                itemId: input.itemId,
                userId: input.userId,
                view: "private",
                step: "title",
                content: input.content,
            },
            "skipped",
            input.reason,
        );
    });
    if (marked) nudge();
    return marked;
}

/** Mark a pipeline-queued Summary step terminal and request the next decision. */
export async function markSummaryStepFailedInTx(
    tx: Tx,
    input: {
        itemId: string;
        userId: string;
        view: PipelineView;
        step: SummaryStepName;
        errorCode: string;
    },
): Promise<boolean> {
    return markStoredSummaryStepFailedInTx(tx, {
        ...input,
        ...pipelineDriver(input.userId),
    });
}

/** Settle a terminal job on the exact stored row selected by legacy maintenance. */
export async function markStoredSummaryStepFailedInTx(
    tx: Tx,
    input: {
        itemId: string;
        userId: string;
        view: PipelineView;
        step: SummaryStepName;
        errorCode: string;
    },
): Promise<boolean> {
    const [processing] = await tx
        .select({ phases: itemProcessing.phases })
        .from(itemProcessing)
        .where(
            and(
                eq(itemProcessing.itemId, input.itemId),
                eq(itemProcessing.userId, input.userId),
                eq(itemProcessing.view, input.view),
            ),
        )
        .for("update")
        .limit(1);
    const summary = processing?.phases.summary;
    const step = summary?.steps?.[input.step];
    if (
        !summary ||
        !step ||
        step.state === "done" ||
        step.state === "failed" ||
        step.state === "skipped" ||
        step.state === "outdated"
    ) {
        return false;
    }
    const advance = await requestAdvanceForViewInTx(tx, {
        itemId: input.itemId,
        userId: input.userId,
        view: input.view,
        reason: "summary-step-failed",
    });
    if (!advance) return false;
    const now = new Date().toISOString();
    if (holdsProfiles(processing?.phases.categorize))
        await pruneHeldProfilesInTx(tx, input.itemId, input.view, input.userId);
    return updateProcessingPhaseInTx(
        tx,
        input.itemId,
        input.view,
        input.userId,
        "summary",
        {
            ...summary,
            generation: advance.requestedGeneration,
            at: now,
            steps: {
                ...summary.steps,
                [input.step]: {
                    ...step,
                    generation: advance.requestedGeneration,
                    state: "failed",
                    reason: input.errorCode,
                },
            },
        },
    );
}

/** Mark a failed Summary step atomically with its pipeline wake-up. */
export async function markSummaryStepFailed(input: {
    itemId: string;
    userId: string;
    view: PipelineView;
    step: SummaryStepName;
    errorCode: string;
}): Promise<boolean> {
    const marked = await db.transaction((tx) =>
        markSummaryStepFailedInTx(tx, input),
    );
    if (marked) nudge();
    return marked;
}

function unsettledState(state: PhaseRecord["state"] | undefined): boolean {
    return (
        state === undefined ||
        state === "pending" ||
        state === "running" ||
        state === "waiting"
    );
}

function sharedSkipSteps(
    step: "transcribe" | SummaryStepName,
): SummaryStepName[] {
    if (step === "transcribe") return [];
    if (step === "summary") return ["summary", "title"];
    return [step];
}

/** Settle automatic work refused because the recording is shared. */
export async function markAutomaticStepShared(input: {
    itemId: string;
    userId: string;
    view: PipelineView;
    step: "transcribe" | SummaryStepName;
}): Promise<boolean> {
    input = { ...input, ...pipelineDriver(input.userId) };
    const marked = await db.transaction(async (tx) => {
        const [processing] = await tx
            .select({ phases: itemProcessing.phases })
            .from(itemProcessing)
            .where(
                and(
                    eq(itemProcessing.itemId, input.itemId),
                    eq(itemProcessing.userId, input.userId),
                    eq(itemProcessing.view, input.view),
                ),
            )
            .for("update")
            .limit(1);
        const transcribe = input.step === "transcribe";
        const phase = transcribe ? "transcribe" : "summary";
        const record = processing?.phases[phase];
        if (!record || record.state === "outdated") return false;
        const steps = { ...record.steps };
        const names = sharedSkipSteps(input.step);
        const hasUnsettledWork = transcribe
            ? unsettledState(record.state)
            : names.some(
                  (name) =>
                      steps[name] !== undefined &&
                      unsettledState(steps[name]?.state),
              );
        if (!hasUnsettledWork) return false;
        const advance = await requestAdvanceInTx(tx, {
            itemId: input.itemId,
            userId: input.userId,
            view: input.view,
            reason: transcribe ? "transcript" : "summary",
        });
        if (!advance) return false;
        const generation = advance.requestedGeneration;
        for (const name of names) {
            const step = steps[name];
            if (!step || !unsettledState(step.state)) continue;
            steps[name] = {
                ...step,
                state: "skipped",
                reason: "shared",
                generation,
            };
        }
        const currentSteps = Object.values(steps).filter(
            (step) =>
                !record.inputs || stepUsesInput(step, record, record.inputs),
        );
        const settled =
            transcribe ||
            (currentSteps.length > 0 &&
                currentSteps.every(
                    (step) => step.state === "done" || step.state === "skipped",
                ));
        return updatePhaseInTx(
            tx,
            input.itemId,
            input.view,
            input.userId,
            phase,
            {
                ...record,
                ...(transcribe ? {} : { steps }),
                state: settled ? "skipped" : record.state,
                reason: settled ? "shared" : record.reason,
                generation,
                at: new Date().toISOString(),
            },
        );
    });
    if (marked) nudge();
    return marked;
}

/**
 * Persist that Learn released the current content, or timed out awaiting review.
 *
 * `generation` must be the requested generation returned by
 * `requestAdvanceInTx` in the same transaction (Task 1.4), so the release is
 * never older than the run that serves it.
 */
export async function markLearnReleasedInTx(
    tx: Tx,
    input: {
        itemId: string;
        userId: string;
        generation: number;
        timedOut?: boolean;
    },
): Promise<boolean> {
    const [processing] = await tx
        .select({ phases: itemProcessing.phases })
        .from(itemProcessing)
        .where(
            and(
                eq(itemProcessing.itemId, input.itemId),
                eq(itemProcessing.userId, input.userId),
                eq(itemProcessing.view, "private"),
            ),
        )
        .for("update")
        .limit(1);
    if (processing?.phases.learn?.state === "failed") return false;
    let content = processing?.phases.learn?.inputs;
    if (!content) {
        const [item] = await tx
            .select({ kind: chatterItems.kind })
            .from(chatterItems)
            .where(
                and(
                    eq(chatterItems.id, input.itemId),
                    eq(chatterItems.userId, input.userId),
                ),
            )
            .limit(1);
        if (item?.kind === "audio") {
            const transcript = await readPreferredTranscript(
                input.itemId,
                input.userId,
                tx,
            );
            if (transcript) {
                content = {
                    contentId: transcript.id,
                    contentSourceId: transcript.source,
                    contentRevision: transcript.revision,
                };
            }
        } else if (item?.kind === "mail") {
            const [mail] = await tx
                .select({
                    id: mailContents.id,
                    revision: mailContents.revision,
                })
                .from(mailContents)
                .where(
                    and(
                        eq(mailContents.itemId, input.itemId),
                        eq(mailContents.userId, input.userId),
                    ),
                )
                .limit(1);
            if (mail) {
                content = {
                    contentId: mail.id,
                    contentSourceId: "mail",
                    contentRevision: mail.revision,
                };
            }
        }
    }
    if (!content) return false;
    return updatePhaseInTx(tx, input.itemId, "private", input.userId, "learn", {
        state: input.timedOut ? "waiting" : "done",
        reason: input.timedOut ? "review_pending_timeout" : "released",
        generation: input.generation,
        inputs: content,
        at: new Date().toISOString(),
    });
}
