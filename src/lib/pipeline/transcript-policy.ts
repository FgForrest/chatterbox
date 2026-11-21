import { placementKeepsCompletedTranscript } from "@/lib/pipeline/effective-profile";
import type {
    PhaseRecord,
    PipelineFacts,
    PipelinePhases,
    PipelineProfileFacts,
    PlaudTranscriptInput,
} from "@/lib/pipeline/types";

function explicitTranscriptionGeneration(phases: PipelinePhases) {
    const categorize = phases.categorize;
    return categorize?.reason === "process_again"
        ? categorize.generation
        : undefined;
}

/** Minimum generation that satisfies the current processing request. */
export function minimumProcessingGeneration(facts: PipelineFacts) {
    const learn = facts.phases.learn;
    return (
        explicitTranscriptionGeneration(facts.phases) ??
        (facts.legacyContinuation &&
        learn?.state === "done" &&
        learn.reason === "released"
            ? learn.generation
            : undefined)
    );
}

/** Whether a phase belongs to the current transcription request. */
export function currentTranscriptionPhase(
    phases: PipelinePhases,
): PhaseRecord | undefined {
    const phase = phases.transcribe;
    return phase &&
        phase.generation >= (explicitTranscriptionGeneration(phases) ?? 0)
        ? phase
        : undefined;
}

function isTerminal(phase?: PhaseRecord): boolean {
    return (
        phase?.state === "done" ||
        phase?.state === "failed" ||
        phase?.state === "skipped"
    );
}

/** Whether the current profile can use this Plaud input for processing. */
export function canUsePlaudTranscript(input: {
    transcript: PlaudTranscriptInput | null;
    policy: PipelineProfileFacts["transcribe"];
    phases: PipelinePhases;
    manualOnly?: boolean;
    transcriptionBlocked?: boolean;
    hasPriorOutput?: boolean;
}): boolean {
    const { transcript, policy, phases } = input;
    if (!transcript || policy?.plaudTranscript !== "use") return false;

    const phase = currentTranscriptionPhase(phases);
    const settled =
        isTerminal(phase) &&
        !(phase?.state === "skipped" && phase.reason === "shared");
    return (
        !policy.automatic ||
        input.manualOnly === true ||
        input.transcriptionBlocked === true ||
        settled ||
        phases.categorize?.reason === "legacy" ||
        phases.categorize?.arrivalGeneration == null ||
        input.hasPriorOutput === true ||
        [
            phases.trim,
            phases.learn,
            phases.summary,
            phases.taskReview,
            phases.share,
        ].some(isTerminal) ||
        !transcript.timed ||
        !transcript.lacksConfirmableSpeakers()
    );
}

/** Select the content the private pipeline can process. */
export function pipelineContent(
    facts: PipelineFacts,
): PipelineFacts["content"] {
    if (facts.item.kind !== "audio") return facts.content;
    const own = facts.transcription?.riffado ?? facts.content;
    if (own) return own;
    const transcript = facts.transcription?.plaud ?? null;
    const policy = facts.profile?.transcribe;
    if (policy?.plaudTranscript === "use") {
        return canUsePlaudTranscript({
            transcript,
            policy,
            phases: facts.phases,
            manualOnly: facts.manualOnly,
            transcriptionBlocked:
                facts.view !== "private" ||
                facts.transcription?.audioReaped ||
                facts.transcription?.contentReaped ||
                facts.transcription?.sharedReadOnly,
            hasPriorOutput: facts.transcription?.hasPriorOutput,
        })
            ? transcript
            : null;
    }
    return placementKeepsCompletedTranscript(
        facts.phases,
        transcript,
        minimumProcessingGeneration(facts),
    )
        ? transcript
        : null;
}
