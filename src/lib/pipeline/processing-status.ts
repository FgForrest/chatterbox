import { JOB_STALE_MS } from "@/lib/jobs/timing";
import {
    outcomeRecord,
    type PipelineWait,
    type StepOutcome,
    waitForReason,
} from "@/lib/pipeline/outcome";
import type { ItemProcessingPresentation } from "@/lib/pipeline/presentation";
import type {
    PhaseName,
    PhaseRecord,
    PhaseState,
    PhaseStepRecord,
    SummaryStepName,
} from "@/lib/pipeline/types";
import type { WorkflowActionCode } from "@/lib/pipeline/workflow-status";

export interface ProcessingStep {
    state: PhaseState | "queued" | "stalled" | "manual";
    reason: string;
    retryable?: boolean;
    waitingFor: PipelineWait | null;
    actions: WorkflowActionCode[];
    steps?: Partial<Record<SummaryStepName, ProcessingStep>>;
}

export interface ProcessingQueueJob {
    id: string;
    kind: string;
    unbound?: boolean;
    bindings?: {
        phase: PhaseName;
        step?: SummaryStepName;
        generation: number;
    }[];
    status: "pending" | "processing" | "completed" | "failed";
    heartbeatAt: Date | null;
    startedAt: Date | null;
    updatedAt: Date;
    position: number;
    result: Record<string, unknown> | null;
    errorCode: string | null;
}

export type ProcessingInput = Omit<
    ItemProcessingPresentation,
    "steps" | "nextCheckAt"
>;

export interface ProcessingPermissions {
    canChange: boolean;
    canFile: boolean;
    reviewUntil?: string;
    canProcessAgain?: boolean;
}

const phaseOrder: PhaseName[] = [
    "categorize",
    "transcribe",
    "learn",
    "summary",
    "taskReview",
    "share",
];

function isActive(step: ProcessingStep): boolean {
    return ["queued", "running", "stalled"].includes(step.state);
}

function projectRecord(
    record: PhaseRecord | PhaseStepRecord | undefined,
    jobs: ProcessingQueueJob[],
    now: Date,
    phase: PhaseName,
    child?: SummaryStepName,
): ProcessingStep {
    const result: ProcessingStep = {
        state: record?.state ?? "pending",
        reason: record?.reason ?? "pending",
        retryable: record?.retryable,
        waitingFor:
            record &&
            ["pending", "running", "waiting"].includes(
                record.state ?? "pending",
            )
                ? (record.waitingFor ?? null)
                : null,
        actions: [],
    };
    const legacyKind =
        child === "title"
            ? "title.generate"
            : (child ??
              (phase === "transcribe"
                  ? "transcription"
                  : phase === "learn"
                    ? "learn.run"
                    : phase));
    const job = record?.jobId
        ? jobs.find(
              (job) =>
                  job.id === record.jobId &&
                  (!job.bindings?.length ||
                      job.bindings.some(
                          (binding) =>
                              binding.phase === phase &&
                              binding.step === child &&
                              binding.generation === record.generation,
                      )),
          )
        : jobs.find(
              (job) =>
                  job.unbound &&
                  (job.kind === legacyKind ||
                      (phase === "learn" &&
                          ["learn.correct", "learn.release"].includes(
                              job.kind,
                          ))) &&
                  ["pending", "processing"].includes(job.status),
          );
    if (job?.status === "pending" || job?.status === "processing") {
        const heartbeat = job.heartbeatAt ?? job.startedAt ?? job.updatedAt;
        result.state =
            job.status === "pending"
                ? "queued"
                : now.getTime() - heartbeat.getTime() > JOB_STALE_MS
                  ? "stalled"
                  : "running";
        result.waitingFor = {
            kind: "job",
            jobId: job.id,
            status: job.status === "pending" ? "queued" : "running",
            ...(job.status === "pending" ? { position: job.position } : {}),
        };
        return result;
    }
    if (job) {
        const recorded = job.result?.outcome as StepOutcome | undefined;
        const outcome =
            recorded?.kind === "failed" && job.status !== "failed"
                ? undefined
                : recorded;
        const terminal =
            outcome ??
            (job.status === "failed"
                ? {
                      kind: "failed" as const,
                      code: job.errorCode ?? "INTERNAL_ERROR",
                      retryable: true,
                  }
                : { kind: "done" as const });
        const settled = outcomeRecord(terminal);
        return {
            ...result,
            state: settled.state,
            reason: settled.reason,
            retryable: settled.retryable,
            waitingFor: settled.waitingFor ?? null,
        };
    }
    if (["pending", "running", "waiting"].includes(result.state)) {
        if (result.state === "running") result.state = "pending";
        result.waitingFor ??= waitForReason(record?.reason);
    }
    return result;
}

function outputExists(data: ProcessingInput, phase: PhaseName): boolean {
    return phase === "transcribe"
        ? data.outputs.transcript
        : phase === "learn"
          ? data.outputs.learn
          : phase === "summary"
            ? data.outputs.summary
            : false;
}

/** Project durable steps and authorized queue snapshots without inventing queued work. */
export function projectProcessing(
    data: ProcessingInput,
    jobs: ProcessingQueueJob[],
    permissions: ProcessingPermissions,
    now = new Date(),
): ItemProcessingPresentation {
    const steps = Object.fromEntries(
        phaseOrder.map((phase) => [
            phase,
            projectRecord(data.phases[phase], jobs, now, phase),
        ]),
    ) as Record<PhaseName, ProcessingStep>;
    const summary = data.phases.summary;
    if (summary?.steps && Object.keys(summary.steps).length > 0) {
        const children = Object.fromEntries(
            Object.entries(summary.steps).map(([step, record]) => [
                step,
                projectRecord(
                    record,
                    jobs.map((job) =>
                        step === "title" && job.result?.titleOutcome
                            ? {
                                  ...job,
                                  result: {
                                      ...job.result,
                                      outcome: job.result.titleOutcome,
                                  },
                              }
                            : job,
                    ),
                    now,
                    "summary",
                    step as SummaryStepName,
                ),
            ]),
        ) as Partial<Record<SummaryStepName, ProcessingStep>>;
        const values = Object.values(children);
        const selected = [
            "stalled",
            "running",
            "queued",
            "failed",
            "waiting",
            "pending",
            "outdated",
        ].flatMap((state) => values.filter((step) => step.state === state))[0];
        steps.summary = {
            ...(selected ??
                (values.every(
                    (child) =>
                        child.state === "done" || child.state === "skipped",
                )
                    ? {
                          state: "done" as const,
                          reason: "completed",
                          waitingFor: null,
                          actions: [],
                      }
                    : steps.summary)),
            steps: children,
            actions: [],
        };
    }
    for (const phase of phaseOrder) {
        const step = steps[phase];
        const record = data.phases[phase];
        const manual =
            ["transcribe", "learn", "summary"].includes(phase) &&
            (data.manualOnly ||
                (data.profile !== null &&
                    data.profile.automatic[
                        phase as "transcribe" | "learn" | "summary"
                    ] === false));
        if (
            !isActive(step) &&
            (!record || step.state === "pending") &&
            outputExists(data, phase)
        ) {
            step.state = "done";
            step.reason = "content-available";
            step.waitingFor = null;
        } else if (
            (manual &&
                !isActive(step) &&
                !["learnReview", "taskReview"].includes(
                    step.waitingFor?.kind ?? "",
                ) &&
                (!record ||
                    ["pending", "waiting"].includes(record.state) ||
                    ["manual_only", "profile_off", "disabled"].includes(
                        record.reason ?? "",
                    ))) ||
            (phase === "learn" && record?.reason === "erased")
        ) {
            step.state = "manual";
            step.waitingFor = null;
        }
        if (step.waitingFor?.kind === "learnReview" && permissions.reviewUntil)
            step.waitingFor = {
                ...step.waitingFor,
                until: permissions.reviewUntil,
            };
        if (
            phase === "share" &&
            data.intents.some(
                (intent) => intent.confirmationRequired && !intent.confirmed,
            ) &&
            !isActive(step)
        ) {
            step.state = "waiting";
            step.reason = "confirmation_required";
            step.waitingFor = waitForReason(step.reason);
        }
        if (
            phase === "learn" &&
            step.state === "skipped" &&
            step.reason === "no_provider" &&
            !data.manualOnly &&
            data.profile?.automatic.learn
        ) {
            step.state = "failed";
            step.waitingFor = null;
        }
        if (
            phase === "summary" &&
            !isActive(step) &&
            !data.outputs.summary &&
            Object.values(step.steps ?? {}).some(
                (child) =>
                    child.state === "skipped" && child.reason === "no_provider",
            )
        ) {
            step.state = "manual";
            step.reason = "no_provider";
            step.waitingFor = null;
        }
        const actions: WorkflowActionCode[] = [];
        if (permissions.canFile && phase === "categorize") {
            if (step.reason === "needs_folder") actions.push("file");
            if (["needs_profile", "profile_unavailable"].includes(step.reason))
                actions.push("chooseProfile");
        }
        if (permissions.canChange) {
            if (
                step.state === "failed" &&
                (step.retryable !== false || step.reason === "lost") &&
                ((step.reason === "lost" &&
                    (permissions.canProcessAgain ?? permissions.canFile)) ||
                    ["transcribe", "learn", "summary"].includes(phase))
            )
                actions.push("retry");
            if (
                step.waitingFor?.kind === "learnReview" &&
                data.learnFindingsWaiting > 0
            )
                actions.push("reviewLearn");
            if (
                step.waitingFor?.kind === "taskReview" &&
                data.taskReviewWaiting > 0
            )
                actions.push("reviewTasks");
            if (
                permissions.canFile &&
                step.waitingFor?.kind === "shareConfirmation"
            )
                actions.push("shareNow");
            if (
                step.state === "outdated" &&
                data.processAgain &&
                (permissions.canProcessAgain ?? permissions.canFile)
            )
                actions.push("processAgain");
            if (step.state === "manual" && !outputExists(data, phase)) {
                if (phase === "transcribe") actions.push("transcribe");
                if (phase === "summary") actions.push("summarize");
                if (phase === "learn") actions.push("learn");
            }
        }
        step.actions = actions;
        for (const child of Object.values(step.steps ?? {}))
            child.actions =
                permissions.canChange &&
                child.state === "failed" &&
                child.retryable !== false
                    ? ["retry"]
                    : [];
    }
    const allSteps = Object.values(steps).flatMap((step) => [
        step,
        ...Object.values(step.steps ?? {}),
    ]);
    const busy = allSteps.some(isActive);
    const holds = allSteps
        .flatMap((step) =>
            step.waitingFor?.kind === "learnReview" && step.waitingFor.until
                ? [Date.parse(step.waitingFor.until)]
                : [],
        )
        .filter((until) => Number.isFinite(until) && until > now.getTime());
    const nextCheckAt = new Date(
        busy
            ? now.getTime() + 5_000
            : holds.length > 0
              ? Math.min(...holds, now.getTime() + 600_000)
              : now.getTime() + 60_000,
    ).toISOString();
    const jobState = (step: ProcessingStep | undefined) =>
        step?.waitingFor?.kind === "job" && step.state !== "stalled"
            ? (step.waitingFor.status ?? null)
            : null;
    return {
        ...data,
        steps,
        nextCheckAt,
        jobs: {
            transcription: jobState(steps.transcribe),
            summary: jobState(
                steps.summary.steps
                    ? steps.summary.steps.summary
                    : steps.summary,
            ),
            topics: jobState(steps.summary.steps?.topics),
            title: jobState(steps.summary.steps?.title),
        },
    };
}
