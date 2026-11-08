import { describe, expect, it } from "vitest";
import { planAdvance } from "@/lib/pipeline/plan";
import type { PipelineFacts } from "@/lib/pipeline/types";

const content = {
    contentId: "transcript",
    contentSourceId: "riffado",
    contentRevision: 1,
    timed: true,
};
const facts: PipelineFacts = {
    item: { exists: true, deleted: false, kind: "audio", ownerUserId: "owner" },
    view: "private",
    generation: 2,
    content,
    summaryDueAt: null,
    profile: {
        revisionId: "profile",
        automatic: {
            learn: false,
            summary: false,
            topics: false,
            title: false,
        },
    },
    categorization: {
        placementFolderIds: [],
        intendedFolderIds: ["org-folder"],
        profileAssigned: true,
        resolution: "resolved",
    },
    hasEnhancementCredential: false,
    mail: null,
    summary: { exists: true, stale: false, jobActive: false },
    taskReview: { proposals: 0, followUps: 0 },
    share: { problems: [] },
    phases: {
        categorize: {
            state: "done",
            generation: 1,
            at: "2026-11-08T00:00:00Z",
        },
    },
    at: "2026-11-08T00:00:00Z",
};
describe("#327 share planning waits for a cut", () => {
    it.each([
        false,
        true,
    ])("blocks automatic sharing when a cut is active=%s", (active) => {
        const plan = planAdvance({
            ...facts,
            share: { problems: [], cutJobActive: active },
        });
        expect(
            plan.actions.some((action) => action.type === "executeShares"),
        ).toBe(!active);
    });
    it("also blocks a confirmed manual-only share", () => {
        const plan = planAdvance({
            ...facts,
            manualOnly: true,
            share: {
                problems: [],
                cutJobActive: true,
                confirmationRequired: false,
            },
        });
        expect(
            plan.actions.some((action) => action.type === "executeShares"),
        ).toBe(false);
    });
});
