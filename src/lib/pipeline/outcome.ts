import type { ShareGateProblem } from "@/lib/sharing/share-gate";
import type { PhaseState } from "./types";

export interface PipelineWait {
    kind: string;
    until?: string;
    jobId?: string;
    status?: "queued" | "running";
    position?: number;
}

/** Use one wait representation for planner decisions and job outcomes. */
export function waitForReason(reason?: string): PipelineWait {
    switch (reason) {
        case "review_pending":
        case "manual_review_pending":
        case "review_pending_timeout":
            return { kind: "learnReview" };
        case "needs_folder":
            return { kind: "folder" };
        case "needs_profile":
            return { kind: "profile" };
        case "confirmation_required":
            return { kind: "shareConfirmation" };
        case "gate_blocked":
            return { kind: "shareGate" };
        case "org_unavailable":
        case "waiting_for_curator":
            return { kind: "organization" };
        case "needs_review":
            return { kind: "taskReview" };
        default:
            return { kind: reason ?? "pending" };
    }
}

export type StepOutcome =
    | { kind: "done"; reason?: string; inputFingerprint?: string | null }
    | { kind: "skipped"; reason: string }
    | {
          kind: "waiting";
          waitingFor: PipelineWait;
          reason?: string;
          problems?: ShareGateProblem[];
      }
    | { kind: "failed"; code: string; retryable: boolean };

export type PipelineJobResult = Record<string, unknown> & {
    outcome: StepOutcome;
    titleOutcome?: StepOutcome;
};

export class StepFailedError extends Error {
    constructor(
        readonly code: string,
        readonly retryable: boolean,
    ) {
        super(code);
        this.name = "StepFailedError";
    }
}

/** Convert a durable outcome to the stored step representation. */
export function outcomeRecord(outcome: StepOutcome): {
    state: PhaseState;
    reason: string;
    retryable?: boolean;
    waitingFor?: PipelineWait;
    inputFingerprint?: string | null;
    problems?: ShareGateProblem[];
} {
    switch (outcome.kind) {
        case "done":
            return {
                state: "done",
                reason: outcome.reason ?? "generated",
                inputFingerprint: outcome.inputFingerprint,
            };
        case "skipped":
            return { state: "skipped", reason: outcome.reason };
        case "waiting":
            return {
                state: "waiting",
                reason: outcome.reason ?? outcome.waitingFor.kind,
                waitingFor: outcome.waitingFor,
                problems: outcome.problems,
            };
        case "failed":
            return {
                state: "failed",
                reason: outcome.code,
                retryable: outcome.retryable,
            };
    }
}
