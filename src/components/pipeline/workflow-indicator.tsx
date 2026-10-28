"use client";

import { Check, LoaderCircle, Minus, TriangleAlert } from "lucide-react";
import { useExtracted, useLocale } from "next-intl";
import { useLayoutEffect, useRef, useState } from "react";
import { useTimeZone } from "use-intl/react";
import { Button } from "@/components/ui/button";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import type {
    WorkflowActionCode,
    WorkflowStatus,
    WorkflowStep,
} from "@/lib/pipeline/workflow-status";
import { cn } from "@/lib/utils";

interface WorkflowStripProps {
    workflow: WorkflowStatus;
    kind?: "audio" | "mail";
    onAction?: (action: WorkflowActionCode) => void;
    readOnly?: boolean;
}

type WorkflowDensity = "full" | "focused" | "compact";

const STRIP_PADDING = 24;
const FULL_CIRCLE = 28;
const FULL_CONNECTOR = 24;
const FULL_COPY_GAP = 6;
const COMPACT_CIRCLE = 24;
const COMPACT_CONNECTOR = 16;
const COMPACT_COPY_GAP = 4;

function estimateCopyWidth(label: string): number {
    return Math.max(...label.split("|").map((part) => part.length)) * 6;
}

function chooseDensity(
    width: number,
    copyWidths: number[],
    focused: Set<number>,
): WorkflowDensity {
    const connectors = Math.max(copyWidths.length - 1, 0);
    const fullWidth = copyWidths.reduce(
        (sum, copyWidth) => sum + FULL_CIRCLE + FULL_COPY_GAP + copyWidth,
        STRIP_PADDING + connectors * FULL_CONNECTOR,
    );
    if (fullWidth <= width) return "full";
    const focusedWidth = copyWidths.reduce(
        (sum, copyWidth, index) =>
            sum +
            COMPACT_CIRCLE +
            (focused.has(index) ? COMPACT_COPY_GAP + copyWidth : 0),
        STRIP_PADDING + connectors * COMPACT_CONNECTOR,
    );
    return focusedWidth <= width ? "focused" : "compact";
}

function stateColor(state: WorkflowStep["state"]): string {
    switch (state) {
        case "next":
            return "text-primary";
        case "review":
        case "outdated":
            return "text-[var(--step-review)]";
        case "working":
            return "text-[var(--step-working)]";
        case "stalled":
        case "problem":
            return "text-[var(--step-problem)]";
        default:
            return "text-muted-foreground";
    }
}

function StepCircle({
    step,
    number,
    density,
}: {
    step: WorkflowStep;
    number: number;
    density: WorkflowDensity;
}) {
    const compact = density !== "full";
    const base =
        "workflow-step-circle relative flex shrink-0 items-center justify-center rounded-full border text-xs font-medium";
    const size = compact ? "size-6" : "size-7";
    switch (step.state) {
        case "done":
            return (
                <span
                    className={cn(
                        base,
                        size,
                        "border-[var(--step-done)] bg-[var(--step-done)] text-white",
                    )}
                >
                    <Check className="size-4" strokeWidth={2.4} aria-hidden />
                </span>
            );
        case "next":
            return (
                <span
                    className={cn(
                        base,
                        size,
                        "border-primary bg-primary text-primary-foreground",
                    )}
                >
                    {number}
                </span>
            );
        case "review":
            return (
                <span
                    className={cn(
                        base,
                        size,
                        "border-[var(--step-review)] bg-[var(--step-review-tint)] text-[var(--step-review)]",
                    )}
                >
                    {number}
                </span>
            );
        case "working":
            return (
                <span
                    className={cn(
                        base,
                        size,
                        "border-[var(--step-working)] text-[var(--step-working)]",
                    )}
                >
                    <span>{number}</span>
                    <LoaderCircle
                        className={cn(
                            "absolute -inset-px animate-spin motion-reduce:animate-none",
                            size,
                        )}
                        aria-hidden
                    />
                </span>
            );
        case "stalled":
        case "problem":
            return (
                <span
                    className={cn(
                        base,
                        size,
                        "border-[var(--step-problem)] bg-[var(--step-problem)] text-white",
                    )}
                >
                    !
                </span>
            );
        case "outdated":
            return (
                <span
                    className={cn(
                        base,
                        size,
                        "border-[var(--step-review)] bg-[var(--step-review-tint)] text-[var(--step-review)]",
                    )}
                >
                    <TriangleAlert className="size-3.5" aria-hidden />
                </span>
            );
        case "manual":
            return (
                <span
                    className={cn(
                        base,
                        size,
                        "border-dashed border-muted-foreground text-muted-foreground",
                    )}
                >
                    {number}
                </span>
            );
        case "skipped":
            return (
                <span
                    className={cn(
                        base,
                        size,
                        "border-border bg-muted/40 text-muted-foreground",
                    )}
                >
                    <Minus className="size-3.5" aria-hidden />
                </span>
            );
        default:
            return (
                <span
                    className={cn(
                        base,
                        size,
                        "border-border bg-muted/40 text-muted-foreground",
                    )}
                >
                    {number}
                </span>
            );
    }
}

/** A one-row workflow stepper with its current actor and next action. */
export function WorkflowStrip({
    workflow,
    kind = "audio",
    onAction,
    readOnly = false,
}: WorkflowStripProps) {
    const i18n = useExtracted();
    const locale = useLocale();
    const timeZone = useTimeZone();
    const stripRef = useRef<HTMLElement>(null);
    const copyMeasureRefs = useRef<Array<HTMLSpanElement | null>>([]);
    const [density, setDensity] = useState<WorkflowDensity>("compact");

    const stepLabel = (id: WorkflowStep["id"]) => {
        switch (id) {
            case "record":
                return i18n("Record");
            case "receive":
                return i18n("Receive");
            case "categorize":
                return i18n({
                    id: "workflowStepCategorize",
                    message: "Categorize",
                });
            case "transcribe":
                return i18n("Transcribe");
            case "learn":
                return i18n("Learn");
            case "summary":
                return i18n({
                    id: "workflowStepSummarize",
                    message: "Summarize",
                });
            case "taskReview":
                return i18n("Task review");
            case "share":
                return i18n({
                    id: "workflowStepShare",
                    message: "Share",
                });
        }
    };
    const stateLabel = (state: WorkflowStep["state"]) => {
        switch (state) {
            case "done":
                return i18n("Done");
            case "next":
                return i18n({
                    id: "workflowStateNext",
                    message: "Next",
                });
            case "review":
                return i18n("Review needed");
            case "working":
                return i18n({
                    id: "workflowStateRunning",
                    message: "Running",
                });
            case "queued":
                return i18n("Queued");
            case "waiting":
                return i18n("Waiting");
            case "others":
                return i18n("Waiting for a curator");
            case "stalled":
                return i18n("Stalled");
            case "problem":
                return i18n("Failed");
            case "outdated":
                return i18n("Outdated");
            case "manual":
                return i18n("Manual");
            case "skipped":
                return i18n("Skipped");
        }
    };
    const skippedReason = (reason: string | undefined) => {
        switch (reason) {
            case "manual_only":
            case "profile_off":
            case "disabled":
                return i18n("This step is not automatic for this profile.");
            case "hosted":
                return i18n("Learn is available only when self-hosted.");
            case "no_provider":
                return i18n("No provider is available for this step.");
            case "no_timings":
                return i18n("The transcript has no timings.");
            case "content_reaped":
            case "audio_reaped":
                return i18n("The source content is no longer available.");
            case "shared":
                return kind === "mail"
                    ? i18n(
                          "This mail is shared; the Organization processes it.",
                      )
                    : i18n(
                          "This recording is shared; the Organization processes it.",
                      );
            case "machine_sent":
                return i18n("Machine-sent mail is kept but not processed.");
            case "unreadable":
                return i18n("The mail content could not be read.");
            case "cancelled":
                return i18n("The intended share was cancelled.");
            default:
                return i18n("This step was skipped.");
        }
    };
    const actor = () => {
        switch (workflow.status?.actor) {
            case "working":
                return i18n("Working.");
            case "queued":
                return i18n("Queued.");
            case "problem":
                return i18n("Problem.");
            case "others":
                return i18n("Waiting for someone else.");
            default:
                return i18n("Your turn.");
        }
    };
    const shortDateTime = (value: string) =>
        new Date(value).toLocaleString(locale, {
            dateStyle: "short",
            timeStyle: "short",
            timeZone,
        });
    const message = () => {
        const status = workflow.status;
        if (!status) return "";
        if (status.actor === "queued" && status.params?.position !== undefined)
            return i18n("Queued, position {position}", {
                position: String(status.params.position),
            });
        if (status.message === "learnReview" && status.params?.until)
            return i18n("Waiting for Learn review, until {deadline}", {
                deadline: shortDateTime(status.params.until),
            });
        switch (status.message) {
            case "retryScheduled":
                return i18n("Next attempt at {time}", {
                    time: shortDateTime(status.params?.retryAt ?? ""),
                });
            case "shareRunning":
                return i18n("Sharing…");
            case "taskReviewRunning":
                return i18n("Preparing task review…");
            case "stalled":
                return i18n("Processing stalled, recovering");
            case "organizationUnavailable":
                return i18n("Waiting for the Organization to become available");
            case "waitingForProcessing":
                return i18n("Waiting for processing");
            case "notFiled":
                return status.params?.kind === "mail"
                    ? i18n(
                          "Choose a folder and a profile. Nothing is processed until the email is filed.",
                      )
                    : i18n(
                          "Choose a folder and a profile. Nothing is processed until the recording is filed.",
                      );
            case "profilesDisagree":
                return i18n(
                    "The folders suggest different profiles. Choose one to continue.",
                );
            case "profileUnavailable":
                return i18n(
                    "The assigned profile is no longer available. Choose another one.",
                );
            case "curatorProfile":
                return i18n(
                    "A curator has to set this folder's profile first.",
                );
            case "transcriptionQueued":
                return i18n("Queued. Transcription starts shortly.");
            case "transcribing":
                return i18n(
                    "Transcribing. It continues in the background; you can leave this page.",
                );
            case "manualTranscription":
                return i18n(
                    "Transcribe the recording; the next steps then run by themselves.",
                );
            case "learnQueued":
                return i18n("Queued. Learn starts shortly.");
            case "learnRunning":
                return kind === "mail"
                    ? i18n("Learn is reading the message with your Almanac.")
                    : i18n(
                          "Learn is reading the transcript with your Almanac.",
                      );
            case "learnCorrecting":
                return kind === "mail"
                    ? i18n(
                          "Learn is correcting names and terms in the message. The summary follows.",
                      )
                    : i18n(
                          "Learn is correcting misheard words in the transcript. The summary follows.",
                      );
            case "learnReview":
                return i18n(
                    "Learn found {count, plural, one {# suggestion} other {# suggestions}}. The summary waits for your review, at most 3 days.",
                    { count: status.params?.count ?? 0 },
                );
            case "manualLearnReview":
                return i18n(
                    "Learn found {count, plural, one {# suggestion} other {# suggestions}}. Review them to apply what fits.",
                    { count: status.params?.count ?? 0 },
                );
            case "learnTimedOut":
                return i18n(
                    "The summary was written without your Learn review, which waited 3 days. You can still review it.",
                );
            case "manualSummary":
                return i18n("Generate a summary when you are ready.");
            case "summaryQueued":
                return i18n("Queued. Writing starts shortly.");
            case "summaryRunning":
                return kind === "mail"
                    ? i18n("Writing the summary and title.")
                    : i18n("Writing the summary, title and topics.");
            case "taskReviewQueued":
                return i18n("Queued. Task review starts shortly.");
            case "taskReview":
                return i18n(
                    "{count, plural, one {# task change waits} other {# task changes wait}} for your review.",
                    { count: status.params?.count ?? 0 },
                );
            case "shareConfirmation":
                return i18n(
                    "Nothing runs automatically for this item. Share it to {folders} when you are ready.",
                    { folders: status.params?.folders?.join(", ") ?? "" },
                );
            case "shareQueued":
                return i18n("Queued. Sharing starts shortly.");
            case "failureNoProvider":
                return i18n(
                    "No provider is configured for this step. Choose one in Settings, then try again.",
                );
            case "failureProvider":
                return i18n(
                    "The provider rejected the request. Check the provider and model in Settings, then try again.",
                );
            case "failureTimeout":
                return i18n(
                    "The provider took too long to respond. Try again; if it keeps happening, check the provider.",
                );
            case "failureBudget":
                return i18n(
                    "Your included Mynah transcription allowance is used up. Wait for it to reset or add your own provider, then try again.",
                );
            case "failureRateLimited":
                return i18n(
                    "The provider is receiving too many requests. Wait a moment, then try again.",
                );
            case "failureUnavailable":
                return i18n(
                    "The provider is temporarily unavailable. Try again shortly.",
                );
            case "failureContextTooLong":
                return i18n(
                    "This item is too long for the selected model. Choose a model with a larger context window, then try again.",
                );
            case "failureTranscription":
                return i18n(
                    "Transcription failed. Check the transcription provider in Settings, then try again.",
                );
            case "failureSourceUnavailable":
                return i18n(
                    "The source recording or stored content is no longer available. Restore it before trying again.",
                );
            case "failureInterrupted":
                return i18n("Processing was interrupted");
            case "failureAccess":
                return i18n(
                    "This item can no longer be processed here. Check its access and sharing, then try again.",
                );
            case "stepFailed":
                return i18n(
                    "This step failed. Try again; if it keeps failing, check its provider in Settings.",
                );
            case "profileChanged":
                return i18n(
                    "The profile changed after this item was processed.",
                );
        }
    };
    const actionLabel = (action: WorkflowActionCode) => {
        switch (action) {
            case "learn":
                return i18n("Learn");
            case "file":
                return i18n("File it");
            case "chooseProfile":
                return i18n("Choose profile");
            case "transcribe":
                return i18n("Transcribe");
            case "summarize":
                return i18n("Summarize");
            case "reviewLearn":
                return i18n("Review Learn");
            case "reviewTasks":
                return i18n("Review tasks");
            case "shareNow":
                return i18n("Share now");
            case "retry":
                return i18n({ id: "processingRetry", message: "Try again" });
            case "processAgain":
                return i18n("Re-process");
        }
    };
    const labels = workflow.steps.map((step) => ({
        name: stepLabel(step.id),
        state: stateLabel(step.state),
    }));
    const needsPersonIndex = workflow.steps.findIndex((step) =>
        ["next", "review", "outdated"].includes(step.state),
    );
    const markedCurrentIndex = workflow.steps.findIndex((step) => step.current);
    const currentIndex =
        markedCurrentIndex >= 0
            ? markedCurrentIndex
            : Math.max(needsPersonIndex, 0);
    const focusedIndexes = new Set(
        [currentIndex, needsPersonIndex].filter((index) => index >= 0),
    );
    const focusedKey = [...focusedIndexes].join(",");
    const labelsKey = labels
        .map((label) => `${label.name}|${label.state}`)
        .join(";");
    useLayoutEffect(() => {
        const strip = stripRef.current;
        if (!workflow.visible || !strip || !labelsKey) return;
        const focused = new Set(focusedKey.split(",").map(Number));
        const estimates = labelsKey.split(";").map(estimateCopyWidth);
        const measure = (width: number) => {
            const copyWidths = estimates.map((estimate, index) =>
                Math.ceil(
                    copyMeasureRefs.current[index]?.getBoundingClientRect()
                        .width || estimate,
                ),
            );
            setDensity(chooseDensity(width, copyWidths, focused));
        };
        measure(strip.getBoundingClientRect().width);
        if (typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver((entries) => {
            const width = entries[0]?.contentRect.width;
            if (width !== undefined) measure(width);
        });
        observer.observe(strip);
        return () => observer.disconnect();
    }, [focusedKey, labelsKey, workflow.visible]);

    if (!workflow.visible) return null;

    const showCopy = (index: number) =>
        density === "full" ||
        (density === "focused" && focusedIndexes.has(index));
    const currentStep = workflow.steps[currentIndex];
    const currentLabel = labels[currentIndex];

    return (
        <TooltipProvider>
            <section
                ref={stripRef}
                className="workflow-strip relative overflow-hidden rounded-lg border bg-card"
                aria-label={i18n("Workflow")}
                data-density={density}
            >
                <div
                    className="pointer-events-none absolute invisible whitespace-nowrap"
                    aria-hidden
                >
                    {labels.map((label, index) => (
                        <span
                            key={`${workflow.steps[index]?.id}-${index}-measure`}
                            ref={(element) => {
                                copyMeasureRefs.current[index] = element;
                            }}
                            className="block w-max leading-tight"
                        >
                            <span className="block text-[13px]">
                                {label.name}
                            </span>
                            <span className="block text-xs">{label.state}</span>
                        </span>
                    ))}
                </div>
                <ol
                    className="flex flex-nowrap items-start px-3 py-4"
                    aria-label={i18n("Workflow steps")}
                >
                    {workflow.steps.map((step, index) => {
                        const content = (
                            <li
                                key={`${step.id}-${index}`}
                                className={cn(
                                    "workflow-step flex min-w-0 items-start",
                                    index === 0 ? "flex-none" : "flex-auto",
                                    step.state === "skipped" &&
                                        "rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                )}
                                data-current={step.current}
                                aria-current={step.current ? "step" : undefined}
                                aria-label={`${stepLabel(step.id)}, ${stateLabel(step.state)}`}
                                tabIndex={
                                    step.state === "skipped" ? 0 : undefined
                                }
                            >
                                {index > 0 && (
                                    <span
                                        className={cn(
                                            "h-px flex-1 bg-border",
                                            density === "full"
                                                ? "mx-1.5 mt-3.5 min-w-3"
                                                : "mx-1 mt-3 min-w-2",
                                        )}
                                        aria-hidden
                                    />
                                )}
                                <StepCircle
                                    step={step}
                                    number={index + 1}
                                    density={density}
                                />
                                {showCopy(index) && (
                                    <span
                                        className={cn(
                                            "workflow-step-copy whitespace-nowrap leading-tight",
                                            density === "full"
                                                ? "ml-1.5"
                                                : "ml-1",
                                        )}
                                    >
                                        <span className="block text-[13px] font-normal text-foreground">
                                            {labels[index]?.name}
                                        </span>
                                        <span
                                            className={cn(
                                                "mt-1 block text-xs",
                                                stateColor(step.state),
                                            )}
                                        >
                                            {labels[index]?.state}
                                        </span>
                                    </span>
                                )}
                            </li>
                        );
                        return step.state === "skipped" ? (
                            <Tooltip key={`${step.id}-${index}`}>
                                <TooltipTrigger asChild>
                                    {content}
                                </TooltipTrigger>
                                <TooltipContent>
                                    {skippedReason(step.reason)}
                                </TooltipContent>
                            </Tooltip>
                        ) : (
                            content
                        );
                    })}
                </ol>
                {density === "compact" && currentStep && currentLabel && (
                    <p className="-mt-1 px-3 pb-3 text-center text-[13px] leading-tight">
                        <span className="text-foreground">
                            {currentLabel.name}
                        </span>{" "}
                        <span className={stateColor(currentStep.state)}>
                            {currentLabel.state}
                        </span>
                    </p>
                )}
                {workflow.status && (
                    <output
                        className="flex flex-wrap items-center gap-3 border-t px-4 py-3 text-sm"
                        aria-live="polite"
                    >
                        <p className="min-w-0 flex-1 text-muted-foreground">
                            {workflow.status.actor !== "queued" && (
                                <>
                                    <strong className="font-medium text-foreground">
                                        {actor()}
                                    </strong>{" "}
                                </>
                            )}
                            {message()}
                        </p>
                        {workflow.status.action && !readOnly && (
                            <Button
                                type="button"
                                size="sm"
                                className="shrink-0"
                                onClick={() =>
                                    workflow.status?.action &&
                                    onAction?.(workflow.status.action)
                                }
                            >
                                {actionLabel(workflow.status.action)}
                            </Button>
                        )}
                    </output>
                )}
            </section>
        </TooltipProvider>
    );
}
