import type {
    PhaseName,
    PhaseState,
    PipelinePhases,
} from "@/lib/pipeline/types";

export type PublicProcessing = {
    phase: Exclude<PhaseName, "trim">;
    state: PhaseState;
};

const PROCESSING_PHASES: readonly Exclude<PhaseName, "trim">[] = [
    "categorize",
    "transcribe",
    "learn",
    "summary",
    "taskReview",
    "share",
];

/** Reduce the stored phase records to the public current-phase indicator. */
export function serializeProcessing(
    phases: PipelinePhases | null | undefined,
): PublicProcessing {
    if (!phases) return { phase: "categorize", state: "skipped" };
    for (const phase of PROCESSING_PHASES) {
        if (phase === "learn") {
            const trim = phases.trim?.state;
            if (
                trim === "pending" ||
                trim === "running" ||
                trim === "waiting" ||
                trim === "outdated"
            )
                return {
                    phase: "learn",
                    state: trim === "outdated" ? "pending" : trim,
                };
        }
        const state = phases[phase]?.state;
        if (
            state === "pending" ||
            state === "waiting" ||
            state === "running" ||
            state === "failed"
        ) {
            return { phase, state };
        }
    }
    for (const phase of [...PROCESSING_PHASES].reverse()) {
        const state = phases[phase]?.state;
        if (state) return { phase, state };
    }
    return { phase: "categorize", state: "pending" };
}
