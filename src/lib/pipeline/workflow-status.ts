import type { PipelineWait } from "@/lib/pipeline/outcome";
import type { ItemProcessingPresentation } from "@/lib/pipeline/presentation";
import type { ProcessingStep } from "@/lib/pipeline/processing-status";
import type { PhaseName } from "@/lib/pipeline/types";

export type WorkflowStepId = "record" | "receive" | PhaseName;

export type WorkflowStepState =
    | "done"
    | "next"
    | "review"
    | "working"
    | "queued"
    | "waiting"
    | "others"
    | "problem"
    | "outdated"
    | "manual"
    | "skipped"
    | "stalled";

export interface WorkflowStep {
    id: WorkflowStepId;
    state: WorkflowStepState;
    reason?: string;
    current: boolean;
    waitingFor?: PipelineWait | null;
    actions?: WorkflowActionCode[];
}

export type WorkflowActor =
    | "yours"
    | "working"
    | "queued"
    | "problem"
    | "others";

export type WorkflowMessageCode =
    | "stalled"
    | "retryScheduled"
    | "shareRunning"
    | "taskReviewRunning"
    | "organizationUnavailable"
    | "waitingForProcessing"
    | "notFiled"
    | "profilesDisagree"
    | "profileUnavailable"
    | "curatorProfile"
    | "transcriptionQueued"
    | "transcribing"
    | "manualTranscription"
    | "learnQueued"
    | "learnRunning"
    | "learnCorrecting"
    | "learnReview"
    | "manualLearnReview"
    | "learnTimedOut"
    | "manualSummary"
    | "summaryQueued"
    | "summaryRunning"
    | "taskReviewQueued"
    | "taskReview"
    | "shareQueued"
    | "shareConfirmation"
    | "failureNoProvider"
    | "failureProvider"
    | "failureTimeout"
    | "failureBudget"
    | "failureRateLimited"
    | "failureUnavailable"
    | "failureContextTooLong"
    | "failureTranscription"
    | "failureSourceUnavailable"
    | "failureInterrupted"
    | "failureAccess"
    | "stepFailed"
    | "profileChanged";

export type WorkflowActionCode =
    | "learn"
    | "file"
    | "chooseProfile"
    | "transcribe"
    | "summarize"
    | "reviewLearn"
    | "reviewTasks"
    | "shareNow"
    | "retry"
    | "processAgain";

export interface WorkflowStatusSentence {
    actor: WorkflowActor;
    message: WorkflowMessageCode;
    params?: {
        count?: number;
        position?: number;
        until?: string;
        retryAt?: string;
        folders?: string[];
        kind?: "audio" | "mail";
        step?: PhaseName;
    };
    action?: WorkflowActionCode;
}

export interface WorkflowStatus {
    visible: boolean;
    steps: WorkflowStep[];
    status: WorkflowStatusSentence | null;
}

const phaseOrder: PhaseName[] = [
    "categorize",
    "transcribe",
    "learn",
    "summary",
    "taskReview",
    "share",
];

function displayState(step: ProcessingStep): WorkflowStepState {
    if (step.state === "queued") return "queued";
    if (step.state === "running") return "working";
    if (step.state === "stalled") return "stalled";
    if (step.state === "failed" || step.state === "not_processed")
        return "problem";
    if (
        step.state === "manual" &&
        ["needs_transcript", "no_provider"].includes(step.reason) &&
        step.actions.some(
            (action) => action === "transcribe" || action === "summarize",
        )
    )
        return "next";
    if (["done", "skipped", "manual", "outdated"].includes(step.state))
        return step.state as "done" | "skipped" | "manual" | "outdated";
    if (step.waitingFor?.kind === "organization") return "others";
    if (
        ["folder", "profile", "shareConfirmation"].includes(
            step.waitingFor?.kind ?? "",
        )
    )
        return "next";
    if (["learnReview", "taskReview"].includes(step.waitingFor?.kind ?? ""))
        return "review";
    return "waiting";
}

function failureMessage(reasonCode: string): WorkflowMessageCode {
    const code = reasonCode.toUpperCase();
    if (code === "LOST") return "failureInterrupted";
    if (
        code === "NO_PROVIDER" ||
        code === "NO_TRANSCRIPTION_PROVIDER" ||
        code === "AI_PROVIDER_NOT_CONFIGURED"
    ) {
        return "failureNoProvider";
    }
    if (code.includes("BUDGET")) return "failureBudget";
    if (code.includes("TIMEOUT")) return "failureTimeout";
    if (code.includes("RATE_LIMIT")) return "failureRateLimited";
    if (code === "AI_CONTEXT_LENGTH_EXCEEDED") {
        return "failureContextTooLong";
    }
    if (
        code === "UPSTREAM_BAD_RESPONSE" ||
        code === "SERVICE_UNAVAILABLE" ||
        code === "PLAUD_UPSTREAM_ERROR"
    ) {
        return "failureUnavailable";
    }
    if (
        code === "AI_PROVIDER_API_ERROR" ||
        code === "PROVIDER_ERROR" ||
        code === "PROVIDER_FAILED"
    ) {
        return "failureProvider";
    }
    if (code === "TRANSCRIPTION_FAILED") return "failureTranscription";
    if (
        code === "RECORDING_DATA_REAPED" ||
        code === "RECORDING_NOT_FOUND" ||
        code === "AUDIO_REAPED" ||
        code === "STORAGE_ERROR"
    ) {
        return "failureSourceUnavailable";
    }
    if (code === "FORBIDDEN" || code === "RECORDING_SHARED") {
        return "failureAccess";
    }
    return "stepFailed";
}

function runningMessage(phase: PhaseName, reason: string): WorkflowMessageCode {
    if (phase === "transcribe") return "transcribing";
    if (phase === "learn")
        return reason === "correcting" ? "learnCorrecting" : "learnRunning";
    if (phase === "share") return "shareRunning";
    if (phase === "taskReview") return "taskReviewRunning";
    return "summaryRunning";
}

function sentence(
    phase: PhaseName,
    step: ProcessingStep,
    data: ItemProcessingPresentation,
): WorkflowStatusSentence | null {
    const action = step.actions[0];
    const withAction = (
        value: WorkflowStatusSentence,
    ): WorkflowStatusSentence => (action ? { ...value, action } : value);
    if (step.waitingFor?.status === "retry")
        return {
            actor: "queued",
            message: "retryScheduled",
            params: { retryAt: step.waitingFor.retryAt },
        };
    if (step.state === "stalled")
        return {
            actor: "problem",
            message: "stalled",
            params: { step: phase },
        };
    if (step.state === "queued") {
        const message: WorkflowMessageCode =
            phase === "transcribe"
                ? "transcriptionQueued"
                : phase === "learn"
                  ? "learnQueued"
                  : phase === "summary"
                    ? "summaryQueued"
                    : phase === "taskReview"
                      ? "taskReviewQueued"
                      : "shareQueued";
        return {
            actor: "queued",
            message,
            params: { position: step.waitingFor?.position },
        };
    }
    if (step.state === "running")
        return {
            actor: "working",
            message: runningMessage(phase, step.reason),
        };
    if (step.reason === "profile_unavailable")
        return withAction({ actor: "problem", message: "profileUnavailable" });
    if (step.state === "failed" || step.state === "not_processed")
        return withAction({
            actor: "problem",
            message: failureMessage(step.reason),
            params: { step: phase },
        });
    if (step.waitingFor?.kind === "folder")
        return withAction({
            actor: "yours",
            message: "notFiled",
            params: { kind: data.kind },
        });
    if (step.waitingFor?.kind === "profile")
        return withAction({ actor: "yours", message: "profilesDisagree" });
    if (step.waitingFor?.kind === "organization")
        return {
            actor: "others",
            message:
                step.reason === "waiting_for_curator"
                    ? "curatorProfile"
                    : "organizationUnavailable",
        };
    if (step.waitingFor?.kind === "learnReview")
        return withAction({
            actor: "yours",
            message:
                step.reason === "review_pending_timeout"
                    ? "learnTimedOut"
                    : step.reason === "manual_review_pending"
                      ? "manualLearnReview"
                      : "learnReview",
            params: {
                count: data.learnFindingsWaiting,
                ...(step.reason === "review_pending" && step.waitingFor.until
                    ? { until: step.waitingFor.until }
                    : {}),
            },
        });
    if (step.waitingFor?.kind === "taskReview")
        return withAction({
            actor: "yours",
            message: "taskReview",
            params: { count: data.taskReviewWaiting },
        });
    if (step.waitingFor?.kind === "shareConfirmation")
        return withAction({
            actor: "yours",
            message: "shareConfirmation",
            params: {
                folders: data.intents
                    .filter(
                        (intent) =>
                            intent.confirmationRequired && !intent.confirmed,
                    )
                    .map((intent) => intent.path),
            },
        });
    if (action === "transcribe" && step.reason === "needs_transcript")
        return { actor: "yours", message: "manualTranscription", action };
    if (action === "summarize" && step.reason === "no_provider")
        return { actor: "yours", message: "manualSummary", action };
    if (step.state === "outdated" && action === "processAgain")
        return withAction({ actor: "yours", message: "profileChanged" });
    if (step.state === "pending" && data.phases[phase])
        return {
            actor: "others",
            message: "waitingForProcessing",
            params: { step: phase },
        };
    return null;
}

/** Map the server's explicit states, waits and allowed actions to presentation only. */
export function deriveWorkflowStatus(
    data: ItemProcessingPresentation,
    kind: "audio" | "mail",
): WorkflowStatus {
    const ids: WorkflowStepId[] = [
        kind === "audio" ? "record" : "receive",
        "categorize",
        ...(kind === "audio" ? ["transcribe" as const] : []),
        "learn",
        "summary",
        ...(data.taskReviewWaiting > 0 ||
        data.phases.taskReview?.state === "failed"
            ? ["taskReview" as const]
            : []),
        ...(data.intents.length > 0 || data.phases.share
            ? ["share" as const]
            : []),
    ];
    const steps = ids.map<WorkflowStep>((id) =>
        id === "record" || id === "receive"
            ? { id, state: "done", current: false }
            : {
                  id,
                  state: displayState(data.steps[id]),
                  reason: data.steps[id].reason,
                  waitingFor: data.steps[id].waitingFor,
                  actions: data.steps[id].actions,
                  current: false,
              },
    );
    const visiblePhases = phaseOrder.filter((phase) => ids.includes(phase));
    const actionable = visiblePhases.map((phase) => ({
        phase,
        step: data.steps[phase],
        status: sentence(phase, data.steps[phase], data),
    }));
    const selected =
        actionable.find(
            ({ phase, status }) => phase === "categorize" && status,
        ) ??
        actionable.find(
            ({ phase, step }) =>
                phase === "transcribe" &&
                ["queued", "running", "stalled"].includes(step.state),
        ) ??
        actionable.find(({ step }) =>
            ["failed", "stalled", "not_processed"].includes(step.state),
        ) ??
        actionable.find(({ status }) => status !== null);
    const status = selected?.status ?? null;
    const current =
        selected?.phase ??
        steps.find(
            (step) => step.state === "manual" && step.reason === "erased",
        )?.id;
    const visible =
        !data.legacy &&
        (status !== null ||
            steps.some(
                (step) => step.state === "skipped" && step.reason === "shared",
            ) ||
            steps.some(
                (step) =>
                    step.state === "outdated" ||
                    (step.state === "manual" && step.reason === "erased"),
            ) ||
            visiblePhases.some(
                (phase) =>
                    data.steps[phase].state === "pending" &&
                    data.profile !== null &&
                    !data.manualOnly,
            ));
    return {
        visible,
        steps: steps.map((step) => ({ ...step, current: step.id === current })),
        status,
    };
}
