import type { ItemProcessingPresentation } from "@/lib/pipeline/presentation";
import {
    type ProcessingInput,
    type ProcessingQueueJob,
    projectProcessing,
} from "@/lib/pipeline/processing-status";
import type { PipelinePhases } from "@/lib/pipeline/types";

/** Supply explicit server steps and live job snapshots to existing UI fixtures. */
export function processingFixture(
    data: ProcessingInput,
): ItemProcessingPresentation {
    const now = new Date();
    const phases: PipelinePhases = structuredClone(data.phases);
    const jobs: ProcessingQueueJob[] = [];
    for (const phase of ["transcribe", "learn", "summary"] as const) {
        const state =
            phase === "transcribe"
                ? data.jobs.transcription
                : phase === "summary"
                  ? data.jobs.summary
                  : phases.learn?.state === "running"
                    ? "running"
                    : null;
        if (!state) continue;
        const id = `fixture-${phase}`;
        phases[phase] = {
            generation: 1,
            state: "running",
            at: now.toISOString(),
            ...phases[phase],
            jobId: id,
        };
        if (phase === "summary" && phases.summary?.steps) {
            phases.summary.steps = Object.fromEntries(
                Object.entries(phases.summary.steps).map(([name, value]) => [
                    name,
                    { ...value, jobId: id },
                ]),
            );
        }
        jobs.push({
            id,
            kind: phase,
            status: state === "queued" ? "pending" : "processing",
            stale: false,
            retryAt: null,
            position: 1,
            result: null,
            errorCode: null,
        });
    }
    for (const child of ["title", "topics"] as const) {
        const state = data.jobs[child];
        const record = phases.summary?.steps?.[child];
        if (!state || !record) continue;
        const id = `fixture-${child}`;
        record.jobId = id;
        jobs.push({
            id,
            kind: child === "title" ? "title.generate" : child,
            status: state === "queued" ? "pending" : "processing",
            stale: false,
            retryAt: null,
            position: 1,
            result: null,
            errorCode: null,
        });
    }
    if (data.taskReviewWaiting > 0 && phases.taskReview?.state === "waiting")
        phases.taskReview.reason = "needs_review";
    const result = projectProcessing(
        { ...data, phases },
        jobs,
        { canChange: true, canFile: true },
        now,
    );
    return result;
}
