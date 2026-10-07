/**
 * What a recording needs before it can join the Organization.
 *
 * Pure, so the share transaction and the client explaining a refusal read
 * the same rules. The share runs it on the Organization's copies, so what
 * gets published is exactly what passed.
 */

import type { AttributionStatus } from "@/lib/knowledge/attribution";

export type ShareGateProblem =
    | { kind: "no_transcript" }
    | { kind: "unresolved_speakers"; source: string; labels: string[] }
    | { kind: "learn_unfinished"; runs: number }
    | { kind: "tasks_unreviewed"; proposals: number };

export interface ShareGateInput {
    transcripts: { id: string; source: string; labels: readonly string[] }[];
    attributions: {
        transcriptionId: string;
        label: string;
        status: AttributionStatus;
        personId: string | null;
        markedUnknown: boolean;
    }[];
    unfinishedLearnRuns: number;
    /** Task proposals of the recording not yet accepted or rejected. */
    waitingTaskProposals?: number;
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
    if (input.unfinishedLearnRuns > 0) {
        problems.push({
            kind: "learn_unfinished",
            runs: input.unfinishedLearnRuns,
        });
    }
    if ((input.waitingTaskProposals ?? 0) > 0) {
        problems.push({
            kind: "tasks_unreviewed",
            proposals: input.waitingTaskProposals ?? 0,
        });
    }
    return problems;
}
