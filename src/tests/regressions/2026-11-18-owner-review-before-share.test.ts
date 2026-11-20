import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { planAdvance } from "@/lib/pipeline/plan";
import type { PipelineFacts } from "@/lib/pipeline/types";
import { evaluateShareGate } from "@/lib/sharing/share-gate";

const at = "2026-11-18T12:00:00.000Z";
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
    profile: {
        revisionId: "revision",
        automatic: { learn: true, summary: false, title: false, topics: false },
    },
    categorization: {
        placementFolderIds: [],
        intendedFolderIds: ["organization-folder"],
        profileAssigned: true,
        resolution: "resolved",
    },
    content,
    summaryDueAt: "2026-11-21T12:00:00.000Z",
    hasEnhancementCredential: true,
    learnRunOpen: true,
    learnRunReadyForReview: true,
    mail: null,
    summary: { exists: false, stale: false, jobActive: false },
    taskReview: { proposals: 1, followUps: 0 },
    phases: {
        categorize: { state: "done", generation: 1, at },
    },
    at,
};

describe("first Organization share of a recording", () => {
    it.each([
        [
            "summaries-and-tasks.md",
            /Only the source item’s owner can undo an accepted match/,
        ],
        [
            "summaries-and-tasks.cs-CZ.md",
            /Přijatou shodu může .* zrušit pouze vlastník zdrojové položky/,
        ],
    ] as const)("documents who can undo a match in %s", (file, wording) => {
        const guide = readFileSync(`content/docs/user-guide/${file}`, "utf8");
        const paragraph = guide
            .split("\n\n")
            .find((text) => wording.test(text));
        expect(paragraph).toBeDefined();
        expect(paragraph).not.toMatch(/curator|kurátor/i);
    });

    it("keeps speaker requirements alongside both owner review requirements", () => {
        expect(
            evaluateShareGate({
                transcripts: [
                    {
                        id: "transcript",
                        source: "riffado",
                        labels: ["Speaker 1"],
                    },
                ],
                attributions: [],
                learnUnfinished: true,
                tasksUnreviewed: true,
            }),
        ).toEqual([
            {
                kind: "unresolved_speakers",
                source: "riffado",
                labels: ["Speaker 1"],
            },
            { kind: "learn_unfinished" },
            { kind: "tasks_unreviewed", waiting: "review" },
        ]);
    });

    it("records the gate while the Learn hold still stops the rest of the workflow", () => {
        const problems = evaluateShareGate({
            transcripts: [{ id: "transcript", source: "riffado", labels: [] }],
            attributions: [],
            learnUnfinished: true,
            tasksUnreviewed: true,
        });
        const plan = planAdvance({ ...facts, share: { problems } });
        expect(plan.actions).toContainEqual({
            type: "markPhase",
            phase: "share",
            record: {
                state: "waiting",
                reason: "gate_blocked",
                generation: 2,
                at,
                problems,
            },
        });
        expect(plan.actions).not.toContainEqual({ type: "executeShares" });
    });

    it("executes the intended share after a later generation clears both reviews", () => {
        const plan = planAdvance({
            ...facts,
            generation: 3,
            summaryDueAt: null,
            learnRunOpen: false,
            learnRunReadyForReview: false,
            taskReview: { proposals: 0, followUps: 0 },
            share: { problems: [] },
            phases: {
                ...facts.phases,
                learn: {
                    state: "done",
                    reason: "review_finished",
                    generation: 3,
                    at,
                    inputs: content,
                },
                share: {
                    state: "waiting",
                    reason: "gate_blocked",
                    generation: 2,
                    at,
                },
            },
        });
        expect(plan.actions).toContainEqual({ type: "executeShares" });
    });

    it("updates the stored share problem when a summary produces proposals", () => {
        const problems = [
            { kind: "tasks_unreviewed", waiting: "review" },
        ] as const;
        const plan = planAdvance({
            ...facts,
            share: { problems: [...problems] },
            phases: {
                ...facts.phases,
                share: {
                    state: "waiting",
                    reason: "gate_blocked",
                    generation: 1,
                    at,
                    problems: [
                        { kind: "tasks_unreviewed", waiting: "summary" },
                    ],
                },
            },
        });
        expect(plan.actions).toContainEqual(
            expect.objectContaining({
                phase: "share",
                record: expect.objectContaining({ problems }),
            }),
        );
    });
});
