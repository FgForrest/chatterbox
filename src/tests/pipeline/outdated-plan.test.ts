import { describe, expect, it } from "vitest";
import {
    markPhasesOutdatedForProfileChange,
    processAgainPending,
} from "@/lib/pipeline/outdated";
import { planAdvance } from "@/lib/pipeline/plan";
import type { PipelineFacts } from "@/lib/pipeline/types";

const OLD_INPUT = {
    contentId: "transcript-old",
    contentSourceId: "riffado",
    contentRevision: 2,
};
const CURRENT_INPUT = {
    contentId: "transcript-current",
    contentSourceId: "riffado",
    contentRevision: 0,
};

function facts(overrides: Partial<PipelineFacts> = {}): PipelineFacts {
    return {
        item: {
            exists: true,
            deleted: false,
            kind: "audio",
            ownerUserId: "user-1",
        },
        view: "private",
        generation: 8,
        manualOnly: false,
        content: { ...CURRENT_INPUT, timed: true },
        transcription: {
            riffado: { ...CURRENT_INPUT, timed: true },
            plaud: null,
            jobActive: false,
        },
        summaryDueAt: null,
        profile: {
            revisionId: "profile-revision-1",
            transcribe: { automatic: true, plaudTranscript: "use" },
            learn: { automatic: false },
            automatic: {
                learn: false,
                summary: true,
                title: false,
                topics: false,
            },
        },
        categorization: {
            placementFolderIds: ["folder-1"],
            intendedFolderIds: [],
            profileAssigned: true,
            resolution: null,
        },
        hasEnhancementCredential: true,
        learnAvailability: "available",
        learnRunOpen: false,
        mail: null,
        summary: { exists: true, stale: false, jobActive: false },
        taskReview: { proposals: 0, followUps: 0 },
        share: { problems: [] },
        phases: {
            categorize: {
                state: "done",
                reason: "categorized",
                generation: 3,
                at: "2026-10-15T00:00:00.000Z",
            },
            learn: {
                state: "done",
                reason: "manual_finished",
                generation: 3,
                inputs: OLD_INPUT,
                at: "2026-10-15T00:00:00.000Z",
            },
            summary: {
                state: "done",
                reason: "completed",
                generation: 3,
                inputs: OLD_INPUT,
                profileRevisionId: "profile-revision-1",
                steps: {
                    summary: {
                        contentId: OLD_INPUT.contentId,
                        contentRevision: OLD_INPUT.contentRevision,
                        generation: 3,
                        profileRevisionId: "profile-revision-1",
                    },
                },
                at: "2026-10-15T00:00:00.000Z",
            },
        },
        at: "2026-10-15T01:00:00.000Z",
        ...overrides,
    };
}

function handledFacts(
    categorize: NonNullable<PipelineFacts["phases"]["categorize"]>,
): PipelineFacts {
    const current = facts();
    if (!current.profile) throw new Error("Expected profile facts");
    return facts({
        profile: {
            ...current.profile,
            automatic: {
                learn: true,
                summary: true,
                title: true,
                topics: true,
            },
            learn: { automatic: true },
        },
        phases: {
            categorize,
            transcribe: {
                state: "done",
                reason: "content-available",
                generation: 3,
                inputs: CURRENT_INPUT,
                at: "2026-10-15T00:00:00.000Z",
            },
            learn: {
                state: "done",
                reason: "manual_finished",
                generation: 3,
                inputs: CURRENT_INPUT,
                at: "2026-10-15T00:00:00.000Z",
            },
            summary: {
                state: "done",
                reason: "completed",
                generation: 3,
                inputs: CURRENT_INPUT,
                profileRevisionId: "profile-revision-1",
                steps: Object.fromEntries(
                    ["title", "topics", "summary"].map((step) => [
                        step,
                        {
                            contentId: CURRENT_INPUT.contentId,
                            contentSourceId: CURRENT_INPUT.contentSourceId,
                            contentRevision: CURRENT_INPUT.contentRevision,
                            generation: 3,
                            profileRevisionId: "profile-revision-1",
                        },
                    ]),
                ),
                at: "2026-10-15T00:00:00.000Z",
            },
        },
    });
}

function paidActions(plan: ReturnType<typeof planAdvance>) {
    return plan.actions.filter((action) =>
        [
            "queueTranscription",
            "startAutoLearn",
            "queueTitleJob",
            "queueTopics",
            "queueSummary",
        ].includes(action.type),
    );
}

describe("outdated pipeline results", () => {
    it("marks a summary outdated for a replacement transcript and queues its automatic rerun", () => {
        const plan = planAdvance(facts());

        expect(plan.actions).toContainEqual(
            expect.objectContaining({
                type: "markPhase",
                phase: "summary",
                record: expect.objectContaining({
                    state: "outdated",
                    reason: "content_changed",
                }),
            }),
        );
        expect(plan.actions).toContainEqual(
            expect.objectContaining({ type: "queueSummary" }),
        );
    });

    it("does not invalidate finished outputs when the assigned immutable revision did not change", () => {
        const current = facts({
            content: { ...OLD_INPUT, timed: true },
            transcription: {
                riffado: { ...OLD_INPUT, timed: true },
                plaud: null,
                jobActive: false,
            },
        });

        expect(planAdvance(current).actions).not.toContainEqual(
            expect.objectContaining({
                type: "markPhase",
                record: expect.objectContaining({ state: "outdated" }),
            }),
        );
    });

    it("does not repeat handled content when the item is categorized again", () => {
        const plan = planAdvance(
            handledFacts({
                state: "done",
                reason: "categorized",
                generation: 8,
                at: "2026-10-15T01:00:00.000Z",
            }),
        );

        expect(paidActions(plan)).toEqual([]);
    });

    it("does not repeat handled content after its last placement is restored", () => {
        const plan = planAdvance(
            handledFacts({
                state: "waiting",
                reason: "needs_folder",
                generation: 7,
                at: "2026-10-15T00:59:00.000Z",
            }),
        );
        expect(plan.actions).toContainEqual(
            expect.objectContaining({
                type: "markPhase",
                phase: "categorize",
                record: expect.objectContaining({ state: "done" }),
            }),
        );
        expect(paidActions(plan)).toEqual([]);
    });

    it("keeps a newly filed legacy item idle until Process again", () => {
        const changed = markPhasesOutdatedForProfileChange(
            handledFacts({
                state: "done",
                reason: "legacy",
                generation: 0,
                at: "2026-10-15T00:00:00.000Z",
            }).phases,
            8,
            "2026-10-15T01:00:00.000Z",
        );
        const filed = handledFacts({
            state: "done",
            reason: "categorized",
            generation: 8,
            at: "2026-10-15T01:00:00.000Z",
        });
        filed.phases = { ...changed, categorize: filed.phases.categorize };

        expect(processAgainPending(filed.phases)).toBe(true);
        expect(paidActions(planAdvance(filed))).toEqual([]);
    });

    it("waits after re-categorization, then runs automatic steps after Process again", () => {
        const changed = markPhasesOutdatedForProfileChange(
            facts().phases,
            8,
            "2026-10-15T01:00:00.000Z",
        );
        const waiting = facts({ phases: changed });

        expect(processAgainPending(waiting.phases)).toBe(true);
        expect(planAdvance(waiting).actions).toEqual([]);

        const rerun = facts({
            phases: {
                ...changed,
                categorize: {
                    state: "done",
                    reason: "process_again",
                    generation: 9,
                    at: "2026-10-15T01:01:00.000Z",
                },
            },
            generation: 9,
        });
        expect(processAgainPending(rerun.phases)).toBe(false);
        expect(planAdvance(rerun).actions).toContainEqual(
            expect.objectContaining({ type: "queueSummary" }),
        );
    });
});
