import { type SQLWrapper, sql } from "drizzle-orm";
import type { PipelinePhases } from "@/lib/pipeline/types";

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
