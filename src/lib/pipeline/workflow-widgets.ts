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

function widgetAction(
    step: WorkflowStep | undefined,
): WorkflowWidgetState["action"] {
    if (
        step?.state === "working" ||
        step?.state === "queued" ||
        step?.state === "stalled"
    )
        return null;
    if (
        step?.actions?.some(
            (action) => action === "reviewLearn" || action === "reviewTasks",
        )
    )
        return "review";
    if (
        step?.actions?.some((action) =>
            ["learn", "transcribe", "summarize"].includes(action),
        )
    )
        return "run";
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
    const learnManual = data.steps.learn.state === "manual";
    const learnVisible =
        categorized &&
        contentReady &&
        (data.outputs.learn || hasReached(learnStep) || learnManual);
    const summaryManual = data.steps.summary.state === "manual";
    const learnCompleted =
        data.outputs.learn ||
        data.phases.learn?.state === "done" ||
        data.phases.learn?.state === "skipped";
    const summaryVisible =
        categorized &&
        contentReady &&
        (data.outputs.summary ||
            (learnCompleted &&
                (hasReached(summaryStep) ||
                    summaryManual ||
                    data.phases.learn?.state === "skipped")));
    const taskVisible =
        data.taskReviewWaiting > 0 &&
        (hasReached(taskStep) || data.outputs.summary);
    const manualLearnReview = [
        "manual_review_pending",
        "manual_finished",
    ].includes(data.phases.learn?.reason ?? "");
    const manualSummaryRun =
        data.manualOnly || data.startedBy?.summary === "person";

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
            "inline",
            widgetAction(transcriptStep),
        ),
        learn: stateFor(
            workflow.visible,
            learnStep,
            learnVisible,
            manualLearnReview ? "dialog" : "inline",
            widgetAction(learnStep),
        ),
        summary: stateFor(
            workflow.visible,
            summaryStep,
            summaryVisible,
            "inline",
            widgetAction(summaryStep),
        ),
        taskReview: stateFor(
            workflow.visible,
            taskStep,
            taskVisible,
            manualSummaryRun ? "dialog" : "inline",
            widgetAction(taskStep),
        ),
    };
}
