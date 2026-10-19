import type { PhaseStepRecord, PipelinePhases } from "@/lib/pipeline/types";

const FIRST_SUMMARY_SKIP_REASONS = new Set([
    "first_summary_title_disabled",
    "first_summary_title_edited",
]);

/** Whether a title step permanently settled first-summary title generation. */
export function automaticTitleStepSettled(
    title: PhaseStepRecord | undefined,
): boolean {
    return (
        title?.state === "done" ||
        (title?.state === "skipped" &&
            FIRST_SUMMARY_SKIP_REASONS.has(title.reason ?? ""))
    );
}

/** Whether the first summary has permanently settled automatic title generation. */
export function automaticTitleSettled(phases: PipelinePhases): boolean {
    return automaticTitleStepSettled(phases.summary?.steps?.title);
}
