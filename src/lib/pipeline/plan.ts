import {
    markPhasesOutdatedForInputs,
    processAgainPending,
} from "@/lib/pipeline/outdated";
import type {
    ContentRevisionInput,
    PhaseRecord,
    PipelineAction,
    PipelineFacts,
    PipelinePlan,
    SummaryStepName,
} from "@/lib/pipeline/types";

function sameInput(
    record: PhaseRecord | undefined,
    input: ContentRevisionInput,
): boolean {
    return (
        record?.inputs?.contentId === input.contentId &&
        record.inputs.contentSourceId === input.contentSourceId &&
        record.inputs.contentRevision === input.contentRevision
    );
}

function markPhase(
    facts: PipelineFacts,
    phase:
        | "categorize"
        | "transcribe"
        | "learn"
        | "summary"
        | "taskReview"
        | "share",
    state: PhaseRecord["state"],
    reason: string,
    input?: ContentRevisionInput,
): PipelineAction {
    return {
        type: "markPhase",
        phase,
        record: {
            state,
            reason,
            generation: facts.generation,
            ...(input ? { inputs: input } : {}),
            at: facts.at,
            ...(input && facts.profile
                ? { profileRevisionId: facts.profile.revisionId }
                : {}),
        },
    };
}

function phaseMatches(
    record: PhaseRecord | undefined,
    state: PhaseRecord["state"],
    reason: string,
    minimumGeneration: number | undefined,
    input?: ContentRevisionInput,
): boolean {
    return (
        record?.state === state &&
        record.reason === reason &&
        (minimumGeneration === undefined ||
            record.generation >= minimumGeneration) &&
        (!input || sameInput(record, input))
    );
}

function stepRequested(
    record: PhaseRecord | undefined,
    step: SummaryStepName,
    input: ContentRevisionInput,
    minimumGeneration?: number,
): boolean {
    const requested = record?.steps?.[step];
    return (
        requested?.contentId === input.contentId &&
        (requested.contentSourceId ?? record?.inputs?.contentSourceId) ===
            input.contentSourceId &&
        requested.contentRevision === input.contentRevision &&
        requested.state !== "outdated" &&
        (minimumGeneration === undefined ||
            requested.generation >= minimumGeneration)
    );
}

function stepProviderAvailable(
    facts: PipelineFacts,
    step: SummaryStepName,
): boolean {
    return (
        facts.stepAvailability?.[step] === "available" ||
        (facts.stepAvailability?.[step] === undefined &&
            facts.hasEnhancementCredential)
    );
}

function summaryStepMarker(
    facts: PipelineFacts,
    input: ContentRevisionInput,
    step: SummaryStepName,
    steps: NonNullable<PhaseRecord["steps"]>,
    reason: string,
): PipelineAction {
    steps[step] = {
        contentId: input.contentId,
        contentSourceId: input.contentSourceId,
        contentRevision: input.contentRevision,
        generation: facts.generation,
        profileRevisionId: facts.profile?.revisionId,
    };
    return {
        type: "markPhase",
        phase: "summary",
        record: {
            state: "pending",
            reason,
            generation: facts.generation,
            inputs: input,
            at: facts.at,
            steps: { ...steps },
            profileRevisionId: facts.profile?.revisionId,
        },
    };
}

function skippedSummaryStepMarker(
    facts: PipelineFacts,
    input: ContentRevisionInput,
    step: SummaryStepName,
    steps: NonNullable<PhaseRecord["steps"]>,
    reason: string,
): PipelineAction {
    steps[step] = {
        contentId: input.contentId,
        contentSourceId: input.contentSourceId,
        contentRevision: input.contentRevision,
        generation: facts.generation,
        profileRevisionId: facts.profile?.revisionId,
        state: "skipped",
        reason,
    };
    return {
        type: "markPhase",
        phase: "summary",
        record: {
            state: "pending",
            reason,
            generation: facts.generation,
            inputs: input,
            at: facts.at,
            steps: { ...steps },
            profileRevisionId: facts.profile?.revisionId,
        },
    };
}

function summaryFailureRecord(facts: PipelineFacts): PhaseRecord | null {
    const summary = facts.phases.summary;
    if (!summary?.steps || !facts.summary.failed) return null;
    const steps = { ...summary.steps };
    let changed = false;
    for (const step of ["title", "topics", "summary"] as const) {
        const current = steps[step];
        const failed = facts.summary.failed[step];
        if (
            !current ||
            !failed ||
            current.state === "failed" ||
            current.state === "done" ||
            current.state === "skipped" ||
            current.state === "outdated" ||
            Date.parse(failed.completedAt) < Date.parse(summary.at)
        ) {
            continue;
        }
        steps[step] = {
            ...current,
            state: "failed",
            reason: failed.errorCode,
            generation: facts.generation,
        };
        changed = true;
    }
    if (!changed) return null;
    return {
        ...summary,
        generation: facts.generation,
        at: facts.at,
        steps,
    };
}

function planMail(
    facts: PipelineFacts,
    input: ContentRevisionInput,
    minimumGeneration?: number,
): PipelineAction[] {
    const mail = facts.mail;
    if (!mail || mail.autoGenerated) {
        return [];
    }

    const actions: PipelineAction[] = [];
    const steps = { ...facts.phases.summary?.steps };
    if (
        facts.profile?.automatic.title &&
        stepProviderAvailable(facts, "title") &&
        !stepRequested(facts.phases.summary, "title", input, minimumGeneration)
    ) {
        actions.push({ type: "queueTitleJob" });
        actions.push(
            summaryStepMarker(facts, input, "title", steps, "mail-arrival"),
        );
    }
    if (
        facts.profile?.automatic.summary &&
        stepProviderAvailable(facts, "summary") &&
        !stepRequested(
            facts.phases.summary,
            "summary",
            input,
            minimumGeneration,
        )
    ) {
        actions.push({ type: "queueSummary", presetId: null, strict: true });
        actions.push(
            summaryStepMarker(facts, input, "summary", steps, "mail-arrival"),
        );
    }

    return actions;
}

function learnSkipReason(
    facts: PipelineFacts,
    content: NonNullable<PipelineFacts["content"]>,
): "profile_off" | "hosted" | "no_provider" | "no_timings" | null {
    if (facts.item.kind === "audio" && !content.timed) return "no_timings";
    const automatic =
        facts.profile?.learn?.automatic ??
        facts.profile?.automatic.learn ??
        false;
    if (!automatic) return "profile_off";
    const availability =
        facts.learnAvailability ??
        (facts.hasEnhancementCredential ? "available" : "no_provider");
    if (availability !== "available") return availability;
    return null;
}

function learnSkipMatches(
    learn: PhaseRecord | undefined,
    reason: NonNullable<ReturnType<typeof learnSkipReason>>,
    minimumGeneration: number | undefined,
    input: ContentRevisionInput,
): boolean {
    return (
        phaseMatches(learn, "skipped", reason, minimumGeneration, input) ||
        (reason === "profile_off" &&
            phaseMatches(
                learn,
                "skipped",
                "disabled",
                minimumGeneration,
                input,
            ))
    );
}

function sameProblems(
    left: PhaseRecord["problems"],
    right: NonNullable<PipelineFacts["share"]>["problems"],
): boolean {
    return JSON.stringify(left ?? []) === JSON.stringify(right);
}

function planShare(facts: PipelineFacts, actions: PipelineAction[]): void {
    if (facts.categorization.intendedFolderIds.length === 0) return;
    if ((facts.phases.share?.generation ?? -1) >= facts.generation) return;
    const problems = facts.share?.problems ?? [];
    if (problems.length > 0) {
        const current = facts.phases.share;
        if (
            current?.state === "waiting" &&
            current.reason === "gate_blocked" &&
            current.generation >= facts.generation &&
            sameProblems(current.problems, problems)
        ) {
            return;
        }
        const waiting = markPhase(facts, "share", "waiting", "gate_blocked");
        if (waiting.type === "markPhase") waiting.record.problems = problems;
        actions.push(waiting);
        return;
    }
    const summaryQueued = actions.some(
        (action) => action.type === "queueSummary",
    );
    if (
        summaryQueued ||
        (facts.summary.phaseJobActive ?? facts.summary.jobActive)
    ) {
        return;
    }
    actions.push({ type: "executeShares" });
}

function planReleasedAudio(
    facts: PipelineFacts,
    input: ContentRevisionInput,
    releaseGeneration: number,
    minimumGeneration?: number,
): PipelineAction[] {
    const actions: PipelineAction[] = [];
    const steps = { ...facts.phases.summary?.steps };
    const notRequested = (step: SummaryStepName) =>
        !stepRequested(
            facts.phases.summary,
            step,
            input,
            minimumGeneration === undefined
                ? releaseGeneration
                : Math.max(releaseGeneration, minimumGeneration),
        );

    if (
        facts.profile?.automatic.title &&
        stepProviderAvailable(facts, "title") &&
        notRequested("title")
    ) {
        actions.push({ type: "queueTitleJob" });
        actions.push(
            summaryStepMarker(facts, input, "title", steps, "learn-released"),
        );
    }

    if (
        facts.profile?.automatic.topics &&
        stepProviderAvailable(facts, "topics") &&
        notRequested("topics")
    ) {
        actions.push({
            type: "queueTopics",
            strict: true,
            ...(input.contentSourceId === "plaud"
                ? { source: "plaud" as const }
                : {}),
        });
        actions.push(
            summaryStepMarker(facts, input, "topics", steps, "learn-released"),
        );
    }

    if (
        facts.profile?.automatic.summary &&
        stepProviderAvailable(facts, "summary") &&
        !facts.summary.jobActive &&
        (!facts.summary.exists || facts.summary.stale) &&
        notRequested("summary")
    ) {
        actions.push({
            type: "queueSummary",
            presetId: null,
            strict: true,
        });
        actions.push(
            summaryStepMarker(facts, input, "summary", steps, "learn-released"),
        );
    }
    return actions;
}

function planTranscriptAudio(
    facts: PipelineFacts,
    input: ContentRevisionInput & { timed: boolean },
    minimumGeneration?: number,
): PipelineAction[] {
    const actions: PipelineAction[] = [];
    const steps = { ...facts.phases.summary?.steps };

    if (
        facts.profile?.automatic.title &&
        stepProviderAvailable(facts, "title") &&
        !stepRequested(facts.phases.summary, "title", input, minimumGeneration)
    ) {
        actions.push({ type: "queueTitleJob" });
        actions.push(
            summaryStepMarker(facts, input, "title", steps, "transcript"),
        );
    }

    if (!input.timed) {
        if (
            !stepRequested(
                facts.phases.summary,
                "topics",
                input,
                minimumGeneration,
            )
        ) {
            actions.push(
                skippedSummaryStepMarker(
                    facts,
                    input,
                    "topics",
                    steps,
                    "no_timings",
                ),
            );
        }
    } else if (
        facts.profile?.automatic.topics &&
        stepProviderAvailable(facts, "topics") &&
        !stepRequested(facts.phases.summary, "topics", input, minimumGeneration)
    ) {
        actions.push({
            type: "queueTopics",
            strict: true,
            ...(input.contentSourceId === "plaud"
                ? { source: "plaud" as const }
                : {}),
        });
        actions.push(
            summaryStepMarker(facts, input, "topics", steps, "transcript"),
        );
    }

    if (
        facts.profile?.automatic.summary &&
        stepProviderAvailable(facts, "summary") &&
        !stepRequested(
            facts.phases.summary,
            "summary",
            input,
            minimumGeneration,
        )
    ) {
        actions.push({
            type: "queueSummary",
            presetId: null,
            strict: true,
        });
        actions.push(
            summaryStepMarker(facts, input, "summary", steps, "transcript"),
        );
    }
    return actions;
}

function legacyContentAlreadyHandled(facts: PipelineFacts): boolean {
    const categorize = facts.phases.categorize;
    if (categorize?.reason !== "legacy") return false;
    if (!facts.content) return true;
    const input = facts.content;
    const learn = facts.phases.learn;
    if (
        learn?.reason !== "legacy" ||
        learn.state !== "done" ||
        !sameInput(learn, input)
    ) {
        return false;
    }
    const steps =
        facts.item.kind === "audio"
            ? (["title", "topics", "summary"] as const)
            : (["title", "summary"] as const);
    return steps.every((step) =>
        stepRequested(facts.phases.summary, step, input),
    );
}

function taskReviewActions(facts: PipelineFacts): PipelineAction[] {
    if (facts.taskReview.proposals + facts.taskReview.followUps === 0)
        return [];
    if (
        phaseMatches(
            facts.phases.taskReview,
            "waiting",
            "needs_review",
            facts.generation,
        )
    ) {
        return [];
    }
    return [markPhase(facts, "taskReview", "waiting", "needs_review")];
}

function automaticTranscribePhase(
    facts: PipelineFacts,
    state: "running" | "failed",
    reason: string,
): PipelineAction {
    return {
        type: "markPhase",
        phase: "transcribe",
        record: {
            state,
            reason,
            automatic: true,
            generation: facts.generation,
            at: facts.at,
        },
    };
}

/** Decide the work due solely from durable item facts. */
export function planAdvance(facts: PipelineFacts): PipelinePlan {
    if (facts.view === "org") return { actions: [] };
    if (!facts.item.exists || facts.item.deleted) {
        return { actions: [], reason: "gone" };
    }

    if (legacyContentAlreadyHandled(facts)) {
        return {
            actions: facts.legacyFallback
                ? Object.entries(facts.phases).flatMap(([phase, record]) =>
                      record
                          ? [
                                {
                                    type: "markPhase" as const,
                                    phase: phase as keyof PipelineFacts["phases"],
                                    record,
                                },
                            ]
                          : [],
                  )
                : [],
        };
    }

    const mail = facts.mail;
    if (
        facts.item.kind === "mail" &&
        (mail?.autoGenerated || mail?.unreadable)
    ) {
        const reason = mail.autoGenerated ? "machine_sent" : "unreadable";
        if (
            phaseMatches(
                facts.phases.categorize,
                "not_processed",
                reason,
                facts.generation,
            )
        ) {
            return { actions: [] };
        }
        return {
            actions: [markPhase(facts, "categorize", "not_processed", reason)],
        };
    }

    const placementCount =
        facts.categorization.placementFolderIds.length +
        facts.categorization.intendedFolderIds.length;
    const categorize = facts.phases.categorize;
    const legacyCategorized =
        categorize?.state === "done" && categorize.reason === "legacy";
    const categorized =
        facts.legacyContinuation === true ||
        facts.profileUnavailable === true ||
        (categorize?.state === "done" &&
            (legacyCategorized ||
                facts.phases.share?.reason === "cancelled" ||
                (placementCount > 0 && facts.categorization.profileAssigned)));
    const actions: PipelineAction[] = [];
    if (!categorized) {
        if (placementCount === 0) {
            if (
                phaseMatches(
                    categorize,
                    "waiting",
                    "needs_folder",
                    facts.generation,
                )
            ) {
                return { actions: [] };
            }
            return {
                actions: [
                    markPhase(facts, "categorize", "waiting", "needs_folder"),
                ],
            };
        }
        if (!facts.categorization.profileAssigned) {
            const resolved = facts.categorization.resolvedProfile;
            if (resolved) {
                return {
                    actions: [
                        {
                            type: "completeCategorization",
                            ...resolved,
                        },
                    ],
                };
            }
            if (
                phaseMatches(
                    categorize,
                    "waiting",
                    "needs_profile",
                    facts.generation,
                )
            ) {
                return { actions: [] };
            }
            return {
                actions: [
                    markPhase(facts, "categorize", "waiting", "needs_profile"),
                ],
            };
        }
        actions.push(markPhase(facts, "categorize", "done", "categorized"));
    }

    if (facts.profileUnavailable) {
        if (
            !phaseMatches(
                categorize,
                "failed",
                "profile_unavailable",
                undefined,
            )
        ) {
            actions.push(
                markPhase(facts, "categorize", "failed", "profile_unavailable"),
            );
        }
        return { actions };
    }

    const minimumGeneration =
        categorize?.reason === "process_again"
            ? categorize.generation
            : facts.legacyContinuation &&
                facts.phases.learn?.state === "done" &&
                facts.phases.learn.reason === "released"
              ? facts.phases.learn.generation
              : undefined;

    const profileHasAutomaticStep =
        facts.profile?.transcribe?.automatic === true ||
        Object.values(facts.profile?.automatic ?? {}).some(Boolean);
    if (
        processAgainPending(facts.phases) &&
        !facts.manualOnly &&
        profileHasAutomaticStep
    ) {
        planShare(facts, actions);
        return { actions };
    }

    const profileTranscription = facts.profile?.transcribe;
    const riffadoTranscript = facts.transcription?.riffado ?? facts.content;
    const plaudTranscript = facts.transcription?.plaud ?? null;
    const content =
        facts.item.kind === "audio"
            ? (riffadoTranscript ??
              (profileTranscription?.plaudTranscript === "use"
                  ? plaudTranscript
                  : null))
            : facts.content;

    const transcribeSkipReason = facts.transcription?.contentReaped
        ? "content_reaped"
        : facts.transcription?.audioReaped
          ? "audio_reaped"
          : facts.transcription?.shared
            ? "shared"
            : null;
    if (
        facts.item.kind === "audio" &&
        transcribeSkipReason &&
        !phaseMatches(
            facts.phases.transcribe,
            "skipped",
            transcribeSkipReason,
            minimumGeneration,
        )
    ) {
        actions.push(
            markPhase(facts, "transcribe", "skipped", transcribeSkipReason),
        );
    }

    if (!content) {
        if (facts.manualOnly) {
            for (const phase of ["transcribe", "learn", "summary"] as const) {
                const current = facts.phases[phase];
                if (
                    current?.state === "skipped" &&
                    current.reason === "manual_only" &&
                    (minimumGeneration === undefined ||
                        current.generation >= minimumGeneration)
                ) {
                    continue;
                }
                actions.push(markPhase(facts, phase, "skipped", "manual_only"));
            }
            actions.push(...taskReviewActions(facts));
            planShare(facts, actions);
            return { actions };
        }
        if (facts.item.kind === "audio") {
            if (transcribeSkipReason) return { actions };
            if (profileTranscription?.automatic) {
                const transcribe = facts.phases.transcribe;
                const failed = facts.transcription?.failed;
                const completedAfterRun =
                    failed &&
                    transcribe?.state === "running" &&
                    transcribe.reason === "automatic" &&
                    Date.parse(failed.completedAt) >= Date.parse(transcribe.at);
                if (completedAfterRun) {
                    actions.push(
                        automaticTranscribePhase(
                            facts,
                            "failed",
                            failed.errorCode,
                        ),
                    );
                } else if (transcribe?.state === "failed") {
                    return { actions };
                } else if (!facts.transcription?.jobActive) {
                    actions.push({ type: "queueTranscription" });
                    actions.push(
                        automaticTranscribePhase(facts, "running", "automatic"),
                    );
                } else if (
                    !phaseMatches(
                        facts.phases.transcribe,
                        "running",
                        "automatic",
                        minimumGeneration,
                    )
                ) {
                    actions.push(
                        automaticTranscribePhase(facts, "running", "automatic"),
                    );
                }
            } else if (
                !phaseMatches(
                    facts.phases.transcribe,
                    "waiting",
                    "needs_transcript",
                    minimumGeneration,
                )
            ) {
                actions.push(
                    markPhase(
                        facts,
                        "transcribe",
                        "waiting",
                        "needs_transcript",
                    ),
                );
            }
        } else if (
            !phaseMatches(
                facts.phases.learn,
                "waiting",
                "needs_content",
                minimumGeneration,
            )
        ) {
            actions.push(markPhase(facts, "learn", "waiting", "needs_content"));
        }
        return { actions };
    }

    if (
        facts.item.kind === "audio" &&
        content.contentSourceId !== "riffado" &&
        content.contentSourceId !== "plaud"
    ) {
        return { actions: [], reason: "gone" };
    }

    const input = {
        contentId: content.contentId,
        contentSourceId: content.contentSourceId,
        contentRevision: content.contentRevision,
    };
    const outdated = markPhasesOutdatedForInputs(
        facts.phases,
        input,
        facts.generation,
        facts.at,
        facts.summary.stale,
    );
    for (const phase of outdated.changed) {
        const record = outdated.phases[phase];
        if (record) actions.push({ type: "markPhase", phase, record });
    }
    facts = { ...facts, phases: outdated.phases };
    const failedSummary = summaryFailureRecord(facts);
    if (failedSummary) {
        actions.push({
            type: "markPhase",
            phase: "summary",
            record: failedSummary,
        });
        facts = {
            ...facts,
            phases: { ...facts.phases, summary: failedSummary },
        };
    }

    if (facts.manualOnly) {
        for (const phase of ["transcribe", "learn", "summary"] as const) {
            const current = facts.phases[phase];
            if (current?.state === "outdated") continue;
            if (
                current?.state === "skipped" &&
                current.reason === "manual_only" &&
                (minimumGeneration === undefined ||
                    current.generation >= minimumGeneration)
            ) {
                continue;
            }
            actions.push(markPhase(facts, phase, "skipped", "manual_only"));
        }
        actions.push(...taskReviewActions(facts));
        planShare(facts, actions);
        return { actions };
    }
    if (facts.item.kind === "mail") {
        if (
            !phaseMatches(
                facts.phases.transcribe,
                "skipped",
                "not-applicable",
                minimumGeneration,
            )
        ) {
            actions.push(
                markPhase(facts, "transcribe", "skipped", "not-applicable"),
            );
        }
    } else {
        const transcribeReason =
            content.contentSourceId === "plaud"
                ? "plaud-transcript"
                : "content-available";
        if (
            !transcribeSkipReason &&
            !phaseMatches(
                facts.phases.transcribe,
                "done",
                transcribeReason,
                minimumGeneration,
                input,
            )
        ) {
            actions.push(
                markPhase(facts, "transcribe", "done", transcribeReason, input),
            );
        }
    }

    const learn = facts.phases.learn;
    const timedOut =
        learn?.state === "waiting" &&
        learn.reason === "review_pending_timeout" &&
        sameInput(learn, input);
    const planSummary = () => {
        if (facts.item.kind === "mail") {
            actions.push(...planMail(facts, input, minimumGeneration));
        } else if (
            learn?.state === "done" &&
            learn.reason === "released" &&
            sameInput(learn, input)
        ) {
            actions.push(
                ...planReleasedAudio(
                    facts,
                    input,
                    learn.generation,
                    minimumGeneration,
                ),
            );
        } else {
            actions.push(
                ...planTranscriptAudio(facts, content, minimumGeneration),
            );
        }
        actions.push(...taskReviewActions(facts));
        planShare(facts, actions);
    };

    if (timedOut) {
        if (!facts.learnRunOpen) {
            actions.push(
                markPhase(
                    facts,
                    "learn",
                    "done",
                    "review_finished_after_timeout",
                    input,
                ),
            );
        }
        planSummary();
        return { actions };
    }

    if (facts.summaryDueAt) {
        if (Date.parse(facts.summaryDueAt) < Date.parse(facts.at)) {
            actions.push({ type: "releaseLearnTimeout" });
            return { actions };
        }
        if (
            !phaseMatches(
                learn,
                "waiting",
                "review_pending",
                minimumGeneration,
                input,
            )
        ) {
            actions.push(
                markPhase(facts, "learn", "waiting", "review_pending", input),
            );
        }
        return { actions };
    }

    if (facts.learnRunOpen) {
        if (
            !phaseMatches(learn, "running", "manual", minimumGeneration, input)
        ) {
            actions.push(markPhase(facts, "learn", "running", "manual", input));
        }
        planSummary();
        return { actions };
    }

    if (
        learn?.state === "running" &&
        learn.reason === "manual" &&
        sameInput(learn, input) &&
        (minimumGeneration === undefined ||
            learn.generation >= minimumGeneration)
    ) {
        actions.push(
            markPhase(facts, "learn", "done", "manual_finished", input),
        );
        planSummary();
        return { actions };
    }

    if (
        learn?.state === "done" &&
        sameInput(learn, input) &&
        (minimumGeneration === undefined ||
            learn.generation >= minimumGeneration)
    ) {
        planSummary();
        return { actions };
    }

    const skipReason = learnSkipReason(facts, content);
    if (skipReason) {
        if (
            learn?.state !== "outdated" &&
            !learnSkipMatches(learn, skipReason, minimumGeneration, input)
        ) {
            actions.push(
                markPhase(facts, "learn", "skipped", skipReason, input),
            );
        }
        planSummary();
        return { actions };
    }
    if (
        learn !== undefined &&
        learn.state === "skipped" &&
        ["gone", "shared", "start_failed"].includes(learn.reason ?? "") &&
        sameInput(learn, input) &&
        (minimumGeneration === undefined ||
            learn.generation >= minimumGeneration)
    ) {
        planSummary();
        return { actions };
    }

    actions.push({
        type: "startAutoLearn",
        input,
        source:
            facts.item.kind === "mail"
                ? "mail"
                : content.contentSourceId === "plaud"
                  ? "plaud"
                  : "riffado",
    });
    return { actions };
}
