/**
 * What a recording needs before it can join the Organization.
 *
 * Pure, so the share transaction and the client explaining a refusal read
 * the same rules for the owner's content before it is published.
 */

import type { AttributionStatus } from "@/lib/knowledge/attribution";

export type ShareReviewProblem =
    | { kind: "learn_unfinished" }
    | { kind: "tasks_unreviewed"; waiting: "summary" | "review" };

export type ShareGateProblem =
    | ShareReviewProblem
    | { kind: "no_transcript" }
    | { kind: "unresolved_speakers"; source: string; labels: string[] };

/** Whether the gate points to the recording owner's Learn or task review. */
export function isShareReviewProblem(
    problem: ShareGateProblem,
): problem is ShareReviewProblem {
    return (
        problem.kind === "learn_unfinished" ||
        problem.kind === "tasks_unreviewed"
    );
}

export interface ShareGateInput {
    learnUnfinished?: boolean;
    tasksUnreviewed?: boolean;
    summaryUnfinished?: boolean;
    transcripts: { id: string; source: string; labels: readonly string[] }[];
    attributions: {
        transcriptionId: string;
        label: string;
        status: AttributionStatus;
        personId: string | null;
        markedUnknown: boolean;
    }[];
}

/** What still stands between a recording and the Organization; empty when nothing does. */
export function evaluateShareGate(input: ShareGateInput): ShareGateProblem[] {
    const problems: ShareGateProblem[] = [];
    if (input.transcripts.length === 0) {
        problems.push({ kind: "no_transcript" });
    }
    // A person, or a person saying nobody knows: a suggestion, or a legacy
    // confirmed row that lost its person, is no answer.
    const resolved = new Set(
        input.attributions
            .filter(
                (row) =>
                    row.status === "confirmed" &&
                    (row.personId !== null || row.markedUnknown),
            )
            .map((row) => `${row.transcriptionId}\u0000${row.label}`),
    );
    for (const transcript of input.transcripts) {
        const labels = transcript.labels.filter(
            (label) => !resolved.has(`${transcript.id}\u0000${label}`),
        );
        if (labels.length > 0) {
            problems.push({
                kind: "unresolved_speakers",
                source: transcript.source,
                labels,
            });
        }
    }
    if (input.learnUnfinished) problems.push({ kind: "learn_unfinished" });
    if (input.tasksUnreviewed || input.summaryUnfinished)
        problems.push({
            kind: "tasks_unreviewed",
            waiting: input.tasksUnreviewed ? "review" : "summary",
        });
    return problems;
}
