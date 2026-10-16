import type { ItemProcessingPresentation } from "@/lib/pipeline/presentation";
import type { PhaseName, PhaseRecord } from "@/lib/pipeline/types";

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
    | "skipped";

export interface WorkflowStep {
    id: WorkflowStepId;
    state: WorkflowStepState;
    reason?: string;
    current: boolean;
}

export type WorkflowActor =
    | "yours"
    | "working"
    | "queued"
    | "problem"
    | "others";

export type WorkflowMessageCode =
    | "notFiled"
    | "profilesDisagree"
    | "profileUnavailable"
    | "curatorProfile"
    | "transcriptionQueued"
    | "transcribing"
    | "manualTranscription"
    | "learnQueued"
    | "learnRunning"
    | "learnReview"
    | "manualLearnReview"
    | "learnTimedOut"
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
    | "failureAccess"
    | "stepFailed"
    | "transcriptChanged"
    | "learnChanged"
    | "profileChanged";

export type WorkflowActionCode =
    | "file"
    | "chooseProfile"
    | "transcribe"
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

const phaseOrder = [
    "categorize",
    "transcribe",
    "learn",
    "summary",
    "taskReview",
    "share",
] as const;

function outputExists(
    data: ItemProcessingPresentation,
    phase: PhaseName,
): boolean {
    if (phase === "transcribe") return data.outputs.transcript;
    if (phase === "learn") return data.outputs.learn;
    if (phase === "summary") return data.outputs.summary;
    return false;
}

function isManualPhase(
    data: ItemProcessingPresentation,
    phase: PhaseName,
): boolean {
    if (phase !== "transcribe" && phase !== "learn" && phase !== "summary") {
        return false;
    }
    if (data.manualOnly) return true;
    return data.profile !== null && !data.profile.automatic[phase];
}

function recordState(record: PhaseRecord | undefined): WorkflowStepState {
    switch (record?.state) {
        case "done":
            return "done";
        case "running":
            return "working";
        case "failed":
        case "not_processed":
            return "problem";
        case "outdated":
            return "outdated";
        case "skipped":
            return "skipped";
        default:
            return "waiting";
    }
}

function displayState(
    data: ItemProcessingPresentation,
    phase: PhaseName,
): WorkflowStepState {
    const record = data.phases[phase];
    if (phase === "categorize") {
        if (
            record?.reason === "needs_folder" ||
            record?.reason === "needs_profile"
        ) {
            return "next";
        }
        if (record?.reason === "waiting_for_curator") return "others";
        if (record?.reason === "profile_unavailable") return "problem";
    }
    if (phase === "transcribe" && data.jobs.transcription) {
        return data.jobs.transcription === "queued" ? "queued" : "working";
    }
    if (phase === "learn" && record?.state === "waiting") {
        if (
            data.learnFindingsWaiting > 0 ||
            record.reason === "review_pending" ||
            record.reason === "review_pending_timeout" ||
            record.reason === "manual_review_pending"
        ) {
            return "review";
        }
    }
    if (phase === "summary" && data.jobs.summary) {
        return data.jobs.summary === "queued" ? "queued" : "working";
    }
    if (
        phase === "taskReview" &&
        record?.state === "waiting" &&
        data.taskReviewWaiting > 0
    ) {
        return "review";
    }
    if (
        phase === "share" &&
        data.intents.some(
            (intent) => intent.confirmationRequired && !intent.confirmed,
        )
    ) {
        return "next";
    }
    if (
        record &&
        [
            "done",
            "running",
            "failed",
            "not_processed",
            "outdated",
            "skipped",
        ].includes(record.state)
    ) {
        return recordState(record);
    }
    if (outputExists(data, phase)) {
        return "done";
    }
    if (isManualPhase(data, phase)) {
        if (
            !record ||
            record.state === "pending" ||
            record.state === "waiting" ||
            (record.state === "skipped" &&
                ["manual_only", "profile_off", "disabled"].includes(
                    record.reason ?? "",
                ))
        ) {
            return "manual";
        }
    }
    return recordState(record);
}

function settledState(state: WorkflowStepState | undefined): boolean {
    return state === "done" || state === "skipped";
}

function mayInferQueued(record: PhaseRecord | undefined): boolean {
    return record === undefined || record.state === "pending";
}

function inferUpcomingStates(
    data: ItemProcessingPresentation,
    kind: "audio" | "mail",
    steps: WorkflowStep[],
): void {
    if (data.legacy) return;
    const state = (id: WorkflowStepId) =>
        steps.find((step) => step.id === id)?.state;
    const setState = (id: WorkflowStepId, next: WorkflowStepState) => {
        const step = steps.find((candidate) => candidate.id === id);
        if (step) step.state = next;
    };
    const categorized = settledState(state("categorize"));
    const profile = data.profile;

    if (
        kind === "audio" &&
        categorized &&
        !data.manualOnly &&
        profile !== null &&
        !profile.automatic.transcribe &&
        !data.outputs.transcript &&
        state("transcribe") === "manual" &&
        (profile.automatic.learn || profile.automatic.summary)
    ) {
        setState("transcribe", "next");
    }

    if (data.manualOnly || !categorized || profile === null) return;

    if (
        kind === "audio" &&
        profile.automatic.transcribe &&
        !data.outputs.transcript &&
        state("transcribe") === "waiting" &&
        mayInferQueued(data.phases.transcribe)
    ) {
        setState("transcribe", "queued");
        return;
    }

    const contentReady = kind === "mail" || data.outputs.transcript;
    if (!contentReady) return;

    if (
        profile.automatic.learn &&
        !data.outputs.learn &&
        state("learn") === "waiting" &&
        mayInferQueued(data.phases.learn)
    ) {
        setState("learn", "queued");
        return;
    }

    const learnSettled =
        !profile.automatic.learn ||
        settledState(state("learn")) ||
        data.outputs.learn;
    if (!learnSettled) return;

    if (
        profile.automatic.summary &&
        !data.outputs.summary &&
        state("summary") === "waiting" &&
        mayInferQueued(data.phases.summary)
    ) {
        setState("summary", "queued");
        return;
    }

    const summarySettled =
        settledState(state("summary")) || data.outputs.summary;
    if (!summarySettled) return;

    if (
        profile.automatic.taskReview === true &&
        state("taskReview") === "waiting" &&
        mayInferQueued(data.phases.taskReview)
    ) {
        setState("taskReview", "queued");
        return;
    }

    const taskReviewSettled =
        settledState(state("taskReview")) ||
        profile.automatic.taskReview === false;
    const shareStartsByItself =
        data.intents.length > 0 &&
        data.intents.every(
            (intent) => !intent.confirmationRequired || intent.confirmed,
        );
    if (
        taskReviewSettled &&
        shareStartsByItself &&
        state("share") === "waiting" &&
        mayInferQueued(data.phases.share)
    ) {
        setState("share", "queued");
    }
}

function failureMessage(reasonCode: string): WorkflowMessageCode {
    const code = reasonCode.toUpperCase();
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

function failureStatus(
    data: ItemProcessingPresentation,
): WorkflowStatusSentence | null {
    const failure = phaseOrder.flatMap((phase) =>
        data.failures.filter((candidate) => candidate.phase === phase),
    )[0];
    if (!failure || failure.reasonCode === "profile_unavailable") return null;
    return {
        actor: "problem",
        message: failureMessage(failure.reasonCode),
        params: {
            step: failure.phase,
        },
        ...(failure.retryAvailable ? { action: "retry" as const } : {}),
    };
}

function learnReviewMessage(reason: string | undefined): WorkflowMessageCode {
    if (reason === "review_pending_timeout") return "learnTimedOut";
    if (reason === "manual_review_pending") return "manualLearnReview";
    return "learnReview";
}

function processAgainMessage(
    reason: ItemProcessingPresentation["processAgainReason"],
): WorkflowMessageCode {
    if (reason === "learn_changed") return "learnChanged";
    if (reason === "profile_changed") return "profileChanged";
    return "transcriptChanged";
}

function queuedMessage(step: WorkflowStepId): WorkflowMessageCode {
    switch (step) {
        case "transcribe":
            return "transcriptionQueued";
        case "learn":
            return "learnQueued";
        case "summary":
            return "summaryQueued";
        case "taskReview":
            return "taskReviewQueued";
        default:
            return "shareQueued";
    }
}

function deriveStatus(
    data: ItemProcessingPresentation,
    steps: WorkflowStep[],
): WorkflowStatusSentence | null {
    const categorize = data.phases.categorize;
    if (categorize?.reason === "needs_folder") {
        return {
            actor: "yours",
            message: "notFiled",
            params: { kind: data.kind },
        };
    }
    if (categorize?.reason === "needs_profile") {
        return {
            actor: "yours",
            message: "profilesDisagree",
            action: "chooseProfile",
        };
    }
    if (categorize?.reason === "profile_unavailable") {
        return {
            actor: "problem",
            message: "profileUnavailable",
            action: "chooseProfile",
        };
    }
    if (categorize?.reason === "waiting_for_curator") {
        return { actor: "others", message: "curatorProfile" };
    }

    const failed = failureStatus(data);
    if (failed) return failed;

    if (data.jobs.transcription === "queued") {
        return { actor: "queued", message: "transcriptionQueued" };
    }
    if (data.jobs.transcription === "running") {
        return { actor: "working", message: "transcribing" };
    }
    if (data.phases.learn?.state === "running") {
        return { actor: "working", message: "learnRunning" };
    }
    if (
        data.phases.learn?.state === "waiting" &&
        (data.learnFindingsWaiting > 0 ||
            data.phases.learn.reason === "review_pending" ||
            data.phases.learn.reason === "review_pending_timeout" ||
            data.phases.learn.reason === "manual_review_pending")
    ) {
        return {
            actor: "yours",
            message: learnReviewMessage(data.phases.learn.reason),
            params: { count: data.learnFindingsWaiting },
            action: "reviewLearn",
        };
    }
    if (data.jobs.summary === "queued") {
        return { actor: "queued", message: "summaryQueued" };
    }
    if (data.jobs.summary === "running") {
        return { actor: "working", message: "summaryRunning" };
    }
    if (
        data.phases.taskReview?.state === "waiting" &&
        data.taskReviewWaiting > 0
    ) {
        return {
            actor: "yours",
            message: "taskReview",
            params: { count: data.taskReviewWaiting },
            action: "reviewTasks",
        };
    }
    const confirmationIntents = data.intents.filter(
        (intent) => intent.confirmationRequired && !intent.confirmed,
    );
    if (confirmationIntents.length > 0) {
        return {
            actor: "yours",
            message: "shareConfirmation",
            params: {
                folders: confirmationIntents.map((intent) => intent.path),
            },
            action: "shareNow",
        };
    }
    if (data.processAgain) {
        return {
            actor: "yours",
            message: processAgainMessage(data.processAgainReason),
            action: "processAgain",
        };
    }
    if (steps.find((step) => step.id === "transcribe")?.state === "next") {
        return {
            actor: "yours",
            message: "manualTranscription",
            action: "transcribe",
        };
    }
    const inferredQueued = steps.find((step) => step.state === "queued");
    if (inferredQueued) {
        const message = queuedMessage(inferredQueued.id);
        return { actor: "queued", message };
    }
    return null;
}

function currentStepId(
    steps: WorkflowStep[],
    status: WorkflowStatusSentence | null,
): WorkflowStepId | null {
    if (!status) return null;
    if (status.action === "chooseProfile" || status.message === "notFiled") {
        return "categorize";
    }
    if (
        status.message === "transcriptionQueued" ||
        status.message === "transcribing" ||
        status.message === "manualTranscription"
    ) {
        return "transcribe";
    }
    if (
        status.message === "learnQueued" ||
        status.message === "learnRunning" ||
        status.message === "learnReview" ||
        status.message === "manualLearnReview" ||
        status.message === "learnTimedOut"
    ) {
        return "learn";
    }
    if (
        status.message === "summaryQueued" ||
        status.message === "summaryRunning"
    ) {
        return "summary";
    }
    if (status.message === "taskReview") return "taskReview";
    if (status.message === "taskReviewQueued") return "taskReview";
    if (
        status.message === "shareConfirmation" ||
        status.message === "shareQueued"
    ) {
        return "share";
    }
    if (status.actor === "problem") return status.params?.step ?? null;
    return (
        steps.find((step) => step.state === "outdated")?.id ??
        steps.find((step) =>
            [
                "next",
                "review",
                "working",
                "queued",
                "problem",
                "others",
            ].includes(step.state),
        )?.id ??
        null
    );
}

/** Derive the client-safe workflow strip from one processing presentation. */
export function deriveWorkflowStatus(
    data: ItemProcessingPresentation,
    kind: "audio" | "mail",
): WorkflowStatus {
    const ids: WorkflowStepId[] = [
        kind === "audio" ? "record" : "receive",
        "categorize",
        ...(kind === "audio" ? (["transcribe"] as const) : []),
        "learn",
        "summary",
        "taskReview",
        ...(data.intents.length > 0 ? (["share"] as const) : []),
    ];
    const steps = ids.map<WorkflowStep>((id) => ({
        id,
        state:
            id === "record" || id === "receive"
                ? "done"
                : displayState(data, id),
        ...(id !== "record" && id !== "receive" && data.phases[id]?.reason
            ? { reason: data.phases[id]?.reason }
            : {}),
        current: false,
    }));
    inferUpcomingStates(data, kind, steps);
    const status = deriveStatus(data, steps);
    const current = currentStepId(steps, status);
    const visible =
        !data.legacy &&
        steps.some((step) =>
            [
                "next",
                "review",
                "working",
                "queued",
                "others",
                "problem",
                "outdated",
            ].includes(step.state),
        );
    return {
        visible,
        steps: steps.map((step) => ({
            ...step,
            current: step.id === current,
        })),
        status,
    };
}
