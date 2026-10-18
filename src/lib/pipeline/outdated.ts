import { automaticTitleStepSettled } from "@/lib/pipeline/title-step";
import type {
    ContentRevisionInput,
    PhaseName,
    PhaseRecord,
    PipelinePhases,
    SummaryStepName,
} from "@/lib/pipeline/types";

export type OutdatedReason =
    | "content_changed"
    | "learn_changed"
    | "profile_changed";

const PROFILE_DOWNSTREAM_PHASES = [
    "transcribe",
    "learn",
    "summary",
    "taskReview",
] as const satisfies readonly PhaseName[];

function sameInput(
    stored: ContentRevisionInput | undefined,
    current: ContentRevisionInput,
): boolean {
    return (
        stored?.contentId === current.contentId &&
        stored.contentSourceId === current.contentSourceId &&
        stored.contentRevision === current.contentRevision
    );
}

function outdatedSteps(
    steps: PhaseRecord["steps"],
    generation: number,
    reason: OutdatedReason,
): PhaseRecord["steps"] {
    if (!steps) return steps;
    return Object.fromEntries(
        Object.entries(steps).map(([name, step]) => {
            if (name === "title" && automaticTitleStepSettled(step)) {
                return [name as SummaryStepName, step];
            }
            return [
                name as SummaryStepName,
                {
                    ...step,
                    state: "outdated" as const,
                    reason,
                    generation,
                },
            ];
        }),
    );
}

function outdatedRecord(
    record: PhaseRecord,
    generation: number,
    at: string,
    reason: OutdatedReason,
): PhaseRecord {
    return {
        ...record,
        state: "outdated",
        reason,
        generation,
        at,
        ...(record.steps
            ? { steps: outdatedSteps(record.steps, generation, reason) }
            : {}),
    };
}

/** Mark every already-started phase affected by assigning another profile. */
export function markPhasesOutdatedForProfileChange(
    phases: PipelinePhases,
    generation: number,
    at: string,
): PipelinePhases {
    const next = { ...phases };
    for (const phase of PROFILE_DOWNSTREAM_PHASES) {
        const record = phases[phase];
        if (record) {
            next[phase] = outdatedRecord(
                record,
                generation,
                at,
                "profile_changed",
            );
        }
    }
    return next;
}

/** Whether re-categorization is waiting for an explicit Process again. */
export function processAgainPending(phases: PipelinePhases): boolean {
    const categorizedGeneration = phases.categorize?.generation ?? -1;
    return PROFILE_DOWNSTREAM_PHASES.some((phase) => {
        const record = phases[phase];
        return (
            record?.state === "outdated" &&
            record.reason === "profile_changed" &&
            record.generation >= categorizedGeneration
        );
    });
}

export interface InputOutdatedResult {
    phases: PipelinePhases;
    changed: PhaseName[];
}

/** Mark outputs made from older content or from the pre-Learn rendering. */
export function markPhasesOutdatedForInputs(
    phases: PipelinePhases,
    input: ContentRevisionInput,
    generation: number,
    at: string,
    summaryStale: boolean,
): InputOutdatedResult {
    const next = { ...phases };
    const changed: PhaseName[] = [];
    const learn = phases.learn;
    if (
        learn?.inputs &&
        !sameInput(learn.inputs, input) &&
        !(learn.state === "outdated" && learn.reason === "content_changed")
    ) {
        next.learn = outdatedRecord(learn, generation, at, "content_changed");
        changed.push("learn");
    }

    const summary = phases.summary;
    const summaryReason =
        summary?.inputs && !sameInput(summary.inputs, input)
            ? "content_changed"
            : summaryStale
              ? "learn_changed"
              : null;
    if (
        summary &&
        summaryReason &&
        !(summary.state === "outdated" && summary.reason === summaryReason)
    ) {
        next.summary = outdatedRecord(summary, generation, at, summaryReason);
        changed.push("summary");
        if (phases.taskReview) {
            next.taskReview = outdatedRecord(
                phases.taskReview,
                generation,
                at,
                summaryReason,
            );
            changed.push("taskReview");
        }
    }
    return { phases: next, changed };
}
