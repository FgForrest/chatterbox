import { type SQLWrapper, sql } from "drizzle-orm";
import type {
    ContentRevisionInput,
    PipelinePhases,
} from "@/lib/pipeline/types";

/** Read the automation policy for steps using the current placement. */
export function effectiveManualOnly(
    processing:
        | {
              manualOnly?: boolean | null;
              phases?: PipelinePhases | null;
          }
        | null
        | undefined,
): boolean {
    return (
        processing?.phases?.categorize?.placementProfile?.manualOnly ??
        processing?.manualOnly ??
        false
    );
}

/** Apply the same placement automation policy inside a database filter. */
export function effectiveManualOnlySql(
    manualOnly: SQLWrapper,
    phases: SQLWrapper,
) {
    return sql<boolean>`coalesce((${phases}->'categorize'->'placementProfile'->>'manualOnly')::boolean, ${manualOnly}, false)`;
}

/** Keep a run valid when automatic placement first assigns its empty base. */
export function itemProfileFenceMatches(
    revisionId: unknown,
    processing:
        | { profileRevisionId?: string | null; phases?: PipelinePhases }
        | null
        | undefined,
): boolean {
    return (
        revisionId === (processing?.profileRevisionId ?? null) ||
        (revisionId === null &&
            processing?.phases?.categorize?.profileChoice === "placement")
    );
}

/** Keep a completed transcript when only the placement's recipe changes. */
export function placementKeepsCompletedTranscript(
    phases: PipelinePhases,
    input: ContentRevisionInput | null,
    minimumGeneration?: number,
): boolean {
    const transcribe = phases.transcribe;
    return Boolean(
        phases.categorize?.placementProfile &&
            input &&
            transcribe?.state === "done" &&
            transcribe.inputs?.contentId === input.contentId &&
            transcribe.inputs.contentSourceId === input.contentSourceId &&
            transcribe.inputs.contentRevision === input.contentRevision &&
            (minimumGeneration === undefined ||
                transcribe.generation >= minimumGeneration),
    );
}
