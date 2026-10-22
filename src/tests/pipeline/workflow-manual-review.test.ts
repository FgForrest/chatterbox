import { describe, expect, it } from "vitest";
import type { ItemProcessingPresentation } from "@/lib/pipeline/presentation";
import { deriveWorkflowStatus } from "@/lib/pipeline/workflow-status";
import { processingFixture } from "@/tests/pipeline/processing-fixture";

function waitingLearn(reason: string): ItemProcessingPresentation {
    return processingFixture({
        itemId: "item-1",
        kind: "audio",
        legacy: false,
        manualOnly: false,
        phases: {
            categorize: {
                state: "done",
                generation: 1,
                at: "2026-10-16T00:00:00.000Z",
            },
            transcribe: {
                state: "done",
                generation: 1,
                at: "2026-10-16T00:01:00.000Z",
            },
            learn: {
                state: "waiting",
                reason,
                generation: 1,
                at: "2026-10-16T00:02:00.000Z",
            },
        },
        profile: {
            id: "profile-1",
            name: "Meeting notes",
            scope: "personal",
            revisionId: "revision-1",
            automatic: {
                transcribe: true,
                learn: true,
                summary: true,
                taskReview: true,
            },
        },
        placements: [],
        intents: [],
        outputs: { transcript: true, learn: false, summary: true },
        processAgain: false,
        processAgainReason: null,
        learnFindingsWaiting: 5,
        taskReviewWaiting: 0,
        jobs: { transcription: null, summary: null },
        failures: [],
    });
}

describe("Learn review workflow copy", () => {
    it("keeps the summary-waiting message for the pipeline review", () => {
        expect(
            deriveWorkflowStatus(waitingLearn("review_pending"), "audio").status
                ?.message,
        ).toBe("learnReview");
    });

    it("uses the independent message for a manual rerun review", () => {
        expect(
            deriveWorkflowStatus(waitingLearn("manual_review_pending"), "audio")
                .status?.message,
        ).toBe("manualLearnReview");
    });
});
