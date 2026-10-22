import type { PhaseRecord, PipelinePhases } from "@/lib/pipeline/types";

/** Preserve the synthesized processing state of an item created before the pipeline. */
export function legacyPhases(input: {
    kind: "audio" | "mail";
    hasPlacement: boolean;
    content: { id: string; revision: number } | null;
}): PipelinePhases {
    const at = new Date().toISOString();
    const phases: PipelinePhases = {
        categorize: {
            state: input.hasPlacement ? "done" : "skipped",
            reason: "legacy",
            generation: 0,
            at,
        },
    };
    if (!input.content) return phases;

    const contentInput = {
        contentId: input.content.id,
        contentSourceId: input.kind === "audio" ? "riffado" : "mail",
        contentRevision: input.content.revision,
    };
    const summarySteps: NonNullable<PhaseRecord["steps"]> = {};
    const stepNames =
        input.kind === "audio"
            ? (["title", "topics", "summary"] as const)
            : (["title", "summary"] as const);
    for (const step of stepNames) {
        summarySteps[step] = { ...contentInput, generation: 0 };
    }
    phases.learn = {
        state: "done",
        reason: "legacy",
        generation: 0,
        inputs: contentInput,
        at,
    };
    phases.summary = {
        state: "done",
        reason: "legacy",
        generation: 0,
        inputs: contentInput,
        steps: summarySteps,
        at,
    };
    return phases;
}
