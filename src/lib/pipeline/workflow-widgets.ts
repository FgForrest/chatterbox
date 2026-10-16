import type { ItemProcessingPresentation } from "@/lib/pipeline/presentation";
import {
    deriveWorkflowStatus,
    type WorkflowStep,
    type WorkflowStepId,
} from "@/lib/pipeline/workflow-status";

export type WorkflowWidgetFrame = "inline" | "dialog";
export type WorkflowWidgetTone = "quiet" | "next" | "review" | "working";

export interface WorkflowWidgetState {
    visible: boolean;
    active: boolean;
    collapsed: boolean;
    frame: WorkflowWidgetFrame;
    tone: WorkflowWidgetTone;
    action: "run" | "review" | null;
}

export interface WorkflowWidgets {
    workflowVisible: boolean;
    message: WorkflowWidgetState;
    transcript: WorkflowWidgetState;
    learn: WorkflowWidgetState;
    summary: WorkflowWidgetState;
    taskReview: WorkflowWidgetState;
}

/** Decide whether a summary uses its compact line instead of its full card. */
export function isWorkflowWidgetLineVisible({
    workflowVisible,
    collapsed,
    expanded,
    working,
    frame,
}: {
    workflowVisible: boolean;
    collapsed: boolean;
    expanded: boolean;
    working: boolean;
    frame: WorkflowWidgetFrame;
}): boolean {
    const collapsedDuringWorkflow = workflowVisible && collapsed && !expanded;
    const dialogRunWorking = working && frame === "dialog";
    return collapsedDuringWorkflow || dialogRunWorking;
}

function toneFor(step: WorkflowStep | undefined): WorkflowWidgetTone {
    if (step?.state === "review") return "review";
    if (step?.state === "next" || step?.state === "manual") return "next";
    if (step?.state === "working" || step?.state === "queued") {
        return "working";
    }
    return "quiet";
}

function hasReached(step: WorkflowStep | undefined): boolean {
    return Boolean(step && step.state !== "waiting");
}

function stateFor(
    workflowVisible: boolean,
    step: WorkflowStep | undefined,
    visible: boolean,
    frame: WorkflowWidgetFrame,
    action: WorkflowWidgetState["action"] = null,
): WorkflowWidgetState {
    const active =
        visible &&
        Boolean(
            step?.current ||
                step?.state === "manual" ||
                action === "run" ||
                action === "review",
        );
    let tone: WorkflowWidgetTone = "quiet";
    if (action === "run") tone = "next";
    else if (action === "review") tone = "review";
    else if (active) tone = toneFor(step);
    return {
        visible,
        active,
        collapsed:
            visible &&
            workflowVisible &&
            !active &&
            (step?.state === "done" || step?.state === "skipped"),
        frame,
        tone,
        action,
    };
}

function learnAction(
    step: WorkflowStep | undefined,
    manual: boolean,
    hasOutput: boolean,
): WorkflowWidgetState["action"] {
    if (step?.state === "review") return "review";
    return manualRunAction(step, manual, hasOutput);
}

function manualRunAction(
    step: WorkflowStep | undefined,
    manual: boolean,
    hasOutput: boolean,
): WorkflowWidgetState["action"] {
    if (step?.state === "working" || step?.state === "queued") return null;
    if (manual && !hasOutput) return "run";
    return null;
}

function stepById(
    steps: readonly WorkflowStep[],
    id: WorkflowStepId,
): WorkflowStep | undefined {
    return steps.find((step) => step.id === id);
}

/** Derive the progressive detail widgets from the existing processing projection. */
export function deriveWorkflowWidgets(
    data: ItemProcessingPresentation,
): WorkflowWidgets {
    const workflow = deriveWorkflowStatus(data, data.kind);
    const categorized = data.phases.categorize?.state === "done" || data.legacy;
    const transcriptStep = stepById(workflow.steps, "transcribe");
    const learnStep = stepById(workflow.steps, "learn");
    const summaryStep = stepById(workflow.steps, "summary");
    const taskStep = stepById(workflow.steps, "taskReview");
    const contentReady = data.kind === "mail" || data.outputs.transcript;
    const transcriptVisible =
        data.kind === "audio" &&
        categorized &&
        (data.outputs.transcript || hasReached(transcriptStep));
    const learnManual =
        data.manualOnly || data.profile?.automatic.learn === false;
    const learnVisible =
        categorized &&
        contentReady &&
        (data.outputs.learn || hasReached(learnStep) || learnManual);
    const summaryManual =
        data.manualOnly || data.profile?.automatic.summary === false;
    const learnCompleted =
        data.outputs.learn || data.phases.learn?.state === "done";
    const summaryVisible =
        categorized &&
        contentReady &&
        (data.outputs.summary ||
            (learnCompleted && (hasReached(summaryStep) || summaryManual)));
    const taskVisible =
        data.taskReviewWaiting > 0 &&
        (hasReached(taskStep) || data.outputs.summary);
    const manualLearnRun =
        learnManual ||
        ["manual", "manual_review_pending", "manual_finished"].includes(
            data.phases.learn?.reason ?? "",
        );
    const manualSummaryRun =
        data.manualOnly || data.startedBy?.summary === "person";
    const manualTranscriptionRun =
        data.manualOnly || data.startedBy?.transcription === "person";

    return {
        workflowVisible: workflow.visible,
        message: stateFor(
            workflow.visible,
            stepById(workflow.steps, "receive"),
            data.kind === "mail" && categorized,
            "inline",
        ),
        transcript: stateFor(
            workflow.visible,
            transcriptStep,
            transcriptVisible,
            manualTranscriptionRun ? "dialog" : "inline",
            transcriptStep?.state === "manual" ? "run" : null,
        ),
        learn: stateFor(
            workflow.visible,
            learnStep,
            learnVisible,
            manualLearnRun ? "dialog" : "inline",
            learnAction(learnStep, learnManual, data.outputs.learn),
        ),
        summary: stateFor(
            workflow.visible,
            summaryStep,
            summaryVisible,
            manualSummaryRun ? "dialog" : "inline",
            manualRunAction(summaryStep, summaryManual, data.outputs.summary),
        ),
        taskReview: stateFor(
            workflow.visible,
            taskStep,
            taskVisible,
            manualSummaryRun ? "dialog" : "inline",
            taskVisible ? "review" : null,
        ),
    };
}
