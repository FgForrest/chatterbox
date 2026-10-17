import type { PipelinePhases } from "@/lib/pipeline/types";
import type { TitleInputFence } from "@/lib/recordings/title-input";

/** Whether the private title step is done for exactly this input fence. */
export function titleStepDoneForFence(
    processing:
        | {
              phases: PipelinePhases;
              profileRevisionId: string | null;
          }
        | undefined,
    fence: TitleInputFence,
): boolean {
    const summary = processing?.phases.summary;
    const step = summary?.steps?.title;
    return (
        step?.state === "done" &&
        step.contentId === fence.contentId &&
        (step.contentSourceId ?? summary?.inputs?.contentSourceId) ===
            fence.contentSourceId &&
        step.contentRevision === fence.contentRevision &&
        (step.profileRevisionId ?? processing?.profileRevisionId ?? null) ===
            fence.profileRevisionId
    );
}
