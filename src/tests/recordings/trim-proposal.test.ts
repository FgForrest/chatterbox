import { describe, expect, it } from "vitest";
import { defaultProviderCandidates } from "@/lib/ai/provider-resolution-order";
import { markPhasesOutdatedForProfileChange } from "@/lib/pipeline/outdated";
import { planAdvance } from "@/lib/pipeline/plan";
import { serializeProcessing } from "@/lib/pipeline/serialize";
import type { PipelineFacts } from "@/lib/pipeline/types";
import {
    defaultProfileSettings,
    parseProfileSettings,
} from "@/lib/profiles/settings";
import {
    trimAnchors,
    trimRange,
    validateTrimOutput,
} from "@/lib/recordings/trim-proposal";
import type { TranscriptTurn } from "@/lib/transcription/turns";

const turns: TranscriptTurn[] = [
    { speaker: "S1", startMs: 0, endMs: 2000, text: "Weekend talk." },
    {
        speaker: "S1",
        startMs: 3000,
        endMs: 6000,
        text: "Jitka Dvořáková sets the project budget.",
    },
    {
        speaker: "S2",
        startMs: 6000,
        endMs: 8000,
        text: "Marek Holub will send it tomorrow.",
    },
    { speaker: "S1", startMs: 9000, endMs: 10000, text: "Unrelated ending." },
];
const anchors = trimAnchors(turns);
const start = {
    firstKeptSentenceId: anchors[1].id,
    startMs: 3000,
    reason: "Unrelated weekend talk",
};
const end = {
    firstRemovedSentenceId: anchors[3].id,
    startMs: 9000,
    reason: "Unrelated ending",
};

describe("whole-transcript trim boundaries", () => {
    it.each([
        { start: null, end: null },
        { start, end: null },
        { start: null, end },
        { start, end },
    ])("validates $start / $end", (edges) => {
        expect(
            validateTrimOutput(edges, anchors, turns, [turns], 10000),
        ).toEqual(edges);
    });
    it.each([
        { start: { ...start, firstKeptSentenceId: "fabricated" }, end },
        { start: { ...start, startMs: 3001 }, end },
        { start: { ...start, startMs: 3.5 }, end },
        { start: { ...start, reason: "" }, end },
        { start: { ...start, reason: "x".repeat(241) }, end },
        { start, end, middle: [] },
        { start: { ...start, arbitrary: 1 }, end },
        {
            start: {
                ...start,
                firstKeptSentenceId: anchors[3].id,
                startMs: 9000,
            },
            end,
        },
        {
            start,
            end: { ...end, firstRemovedSentenceId: anchors[0].id, startMs: 0 },
        },
    ])("rejects unsafe or non-schema output %#", (edges) =>
        expect(() =>
            validateTrimOutput(edges, anchors, turns, [turns], 10000),
        ).toThrow());
    it("rejects a secondary transcript that loses all content", () =>
        expect(() =>
            validateTrimOutput(
                { start, end },
                anchors,
                turns,
                [[turns[0]], turns],
                10000,
            ),
        ).toThrow());
    it("rejects overlapping speech in the preferred transcript", () => {
        const overlapping = [{ ...turns[0], endMs: 4000 }, ...turns.slice(1)];
        expect(() =>
            validateTrimOutput(
                { start, end: null },
                trimAnchors(overlapping),
                overlapping,
                [overlapping],
                10000,
            ),
        ).toThrow("unsafe_overlap");
    });
    it("accepts an edge overlapped only by a secondary transcript", () => {
        const secondary = [{ ...turns[0], endMs: 4000 }, ...turns.slice(1)];
        const edges = { start, end: null };
        expect(
            validateTrimOutput(
                edges,
                anchors,
                turns,
                [turns, secondary],
                10000,
            ),
        ).toEqual(edges);
    });
    it("drops a zero length edge", () =>
        expect(
            validateTrimOutput(
                {
                    start: {
                        ...start,
                        firstKeptSentenceId: anchors[0].id,
                        startMs: 0,
                    },
                    end: null,
                },
                anchors,
                turns,
                [turns],
                10000,
            ),
        ).toEqual({ start: null, end: null }));
    it("selects both edges in one interval and keeps unchecked edges", () => {
        expect(trimRange({ start, end }, 10000)).toEqual({
            startMs: 3000,
            endMs: 9000,
        });
        expect(
            trimRange({ start, end }, 10000, { start: false, end: true }),
        ).toEqual({ startMs: 0, endMs: 9000 });
    });
    it("preserves the whole input and groups corrections crossing raw sentences", () => {
        const raw = [
            {
                speaker: "S1",
                startMs: 0,
                endMs: 9000,
                text: "Wrong. Name. Decision stays.",
                sentenceStartsMs: [0, 2000, 4000],
            },
        ];
        const input = trimAnchors(raw, [
            {
                turnIndex: 0,
                charStart: 0,
                charEnd: 12,
                heard: "Wrong. Name.",
                kind: "correct",
                replacement: "Jitka Dvořáková",
                meaning: "Jitka Dvořáková",
            },
        ]);
        expect(input).toHaveLength(2);
        expect(input[0].text).toContain("Jitka Dvořáková");
        expect(input[1].startMs).toBe(4000);
        expect(input.map((a) => a.text).join("")).toContain("Decision stays.");
    });
    it("keeps duplicate starts as one canonical time and does not round milliseconds", () => {
        const raw = [
            {
                ...turns[0],
                text: "One. Two. Three.",
                sentenceStartsMs: [0, 1001, 1001],
            },
        ];
        expect(trimAnchors(raw).map((a) => a.startMs)).toEqual([0, 1001, 1001]);
    });
});

describe("trim profile defaults and inheritance", () => {
    it("defaults new audio profiles on and keeps mail without trim", () => {
        expect(defaultProfileSettings("audio").steps.trim).toEqual({
            automatic: true,
            provider: null,
        });
        expect(defaultProfileSettings("mail").steps).not.toHaveProperty("trim");
    });
    it("parses old V2 revisions as on without mutating them", () => {
        const { trim: _trim, ...steps } = defaultProfileSettings("audio").steps;
        const old = { schemaVersion: 2, steps };
        expect(parseProfileSettings("audio", old).steps.trim.automatic).toBe(
            true,
        );
        expect(old.steps).not.toHaveProperty("trim");
    });
    it("parses V1 revisions as on and preserves saved opt out", () => {
        const { trim: _trim, ...steps } = defaultProfileSettings("audio").steps;
        const old = {
            schemaVersion: 1,
            steps: Object.fromEntries(
                Object.entries(steps).map(([name, step]) => [
                    name,
                    name === "tasks" ? step : { ...step, enabled: true },
                ]),
            ),
        };
        expect(parseProfileSettings("audio", old).steps.trim.automatic).toBe(
            true,
        );
        const saved = defaultProfileSettings("audio");
        saved.steps.trim.automatic = false;
        expect(parseProfileSettings("audio", saved).steps.trim.automatic).toBe(
            false,
        );
    });
    const choices = [
        "member-trim",
        "pin-title",
        "member-title",
        "pin-summary",
        "member-summary",
        "org-trim",
        "org-title",
        "org-summary",
    ];
    it.each(
        choices.map((_, index) => index),
    )("uses exact priority position %s, including broken explicit choices", (first) => {
        const active = (index: number) =>
            index >= first ? choices[index] : null;
        const empty = { transcription: null, learn: null, topics: null };
        const candidates = defaultProviderCandidates(
            "trim",
            { ...empty, trim: active(0), title: active(2), summary: active(4) },
            { ...empty, trim: active(5), title: active(6), summary: active(7) },
            [],
            [],
            {
                title: active(1)
                    ? { credentialId: choices[1], scope: "personal" }
                    : null,
                summary: active(3)
                    ? { credentialId: choices[3], scope: "organization" }
                    : null,
            },
        );
        expect(candidates).toHaveLength(1);
        expect(candidates[0].providerId).toBe(choices[first]);
    });
});

function facts(): PipelineFacts {
    return {
        item: {
            exists: true,
            deleted: false,
            kind: "audio",
            ownerUserId: "owner",
        },
        view: "private",
        generation: 1,
        content: {
            contentId: "transcript",
            contentSourceId: "riffado",
            contentRevision: 1,
            timed: true,
        },
        summaryDueAt: null,
        profile: {
            revisionId: "recipe",
            trim: { automatic: true },
            automatic: {
                learn: true,
                summary: true,
                title: true,
                topics: true,
            },
        },
        categorization: {
            placementFolderIds: ["folder"],
            intendedFolderIds: ["shared-folder"],
            profileAssigned: true,
            resolution: "resolved",
        },
        hasEnhancementCredential: true,
        mail: null,
        summary: { exists: false, stale: false, jobActive: false },
        taskReview: { proposals: 0, followUps: 0 },
        phases: {
            categorize: {
                state: "done",
                reason: "categorized",
                generation: 1,
                at: "2026-11-08T00:00:00Z",
            },
        },
        at: "2026-11-08T01:00:00Z",
    };
}
describe("trim pipeline gate", () => {
    it("queues trim before Learn, summaries, tasks or sharing", () =>
        expect(planAdvance(facts()).actions.map((a) => a.type)).toEqual([
            "markPhase",
            "queueTrim",
        ]));
    it("accepts a mixed preferred transcript when the recipe accepts existing text", () => {
        const f = facts();
        f.content = null;
        f.profile = {
            ...f.profile,
            revisionId: "recipe",
            automatic: {
                learn: false,
                summary: true,
                title: false,
                topics: false,
            },
            transcribe: { automatic: true, plaudTranscript: "use" },
            trim: { automatic: true },
        };
        f.trimContent = {
            contentId: "mixed-transcript",
            contentSourceId: "mixed",
            contentRevision: 1,
            timed: true,
        };
        expect(planAdvance(f).actions).toContainEqual({
            type: "queueTrim",
            input: f.trimContent,
        });
    });
    it("still queues trim on hosted where Learn is unavailable", () => {
        const f = facts();
        f.learnAvailability = "hosted";
        expect(planAdvance(f).actions.at(-1)?.type).toBe("queueTrim");
    });
    it("does not renew a pending deadline", () => {
        const f = facts();
        f.phases.trim = {
            state: "waiting",
            generation: 1,
            at: f.at,
            waitingFor: { kind: "trimReview", until: "2026-11-08T04:00:00Z" },
        };
        expect(planAdvance(f).actions.map((a) => a.type)).not.toContain(
            "queueTrim",
        );
        expect(planAdvance(f).actions.map((a) => a.type)).not.toContain(
            "executeShares",
        );
    });
    it("releases at exactly four hours with no inference", () => {
        const f = facts();
        f.phases.trim = {
            state: "waiting",
            generation: 1,
            at: f.at,
            waitingFor: { kind: "trimReview", until: f.at },
        };
        expect(planAdvance(f).actions).toContainEqual({
            type: "resolveTrim",
            reason: "timed_out",
        });
    });
    it.each([
        "declined",
        "timed_out",
        "bypassed_manual",
        "no_proposal",
        "cut_applied",
    ])("does not repeat settled %s on incidental generation bumps", (reason) => {
        const f = facts();
        f.generation = 20;
        f.phases.trim = {
            state: "done",
            reason,
            generation: 1,
            inputs: f.content ?? undefined,
            at: f.at,
        };
        expect(planAdvance(f).actions.map((a) => a.type)).not.toContain(
            "queueTrim",
        );
    });
    it("does not reopen a workflow completed before trim on an incidental trigger", () => {
        const f = facts();
        f.phases.summary = {
            state: "done",
            generation: 1,
            at: f.at,
            inputs: f.content ?? undefined,
        };
        expect(planAdvance(f).actions.map((a) => a.type)).not.toContain(
            "queueTrim",
        );
        f.phases.categorize = {
            state: "done",
            reason: "process_again",
            generation: 2,
            at: f.at,
        };
        f.generation = 2;
        expect(planAdvance(f).actions.map((a) => a.type)).toContain(
            "queueTrim",
        );
    });
    it("does not backfill an expired pre-upgrade Learn review on a reconciler wake", () => {
        const f = facts();
        f.phases.transcribe = {
            state: "done",
            reason: "content-available",
            inputs: f.content ?? undefined,
            generation: 1,
            at: f.at,
        };
        f.phases.learn = {
            state: "waiting",
            reason: "review_pending",
            inputs: f.content ?? undefined,
            generation: 1,
            at: "2026-11-04T00:00:00Z",
            waitingFor: { kind: "learnReview", until: "2026-11-07T00:00:00Z" },
        };
        f.learnRunReadyForReview = true;
        f.summaryDueAt = "2026-11-07T00:00:00Z";
        const actions = planAdvance(f).actions.map((a) => a.type);
        expect(actions).not.toContain("queueTrim");
        expect(actions).toContain("releaseLearnTimeout");
    });
    it("grandfathers an unchanged legacy Learn release even with a downstream minimum generation", () => {
        const f = facts();
        f.legacyContinuation = true;
        f.phases.categorize = {
            state: "done",
            reason: "legacy",
            generation: 1,
            at: f.at,
        };
        f.phases.learn = {
            state: "done",
            reason: "released",
            inputs: f.content ?? undefined,
            generation: 2,
            at: f.at,
        };
        expect(planAdvance(f).actions.map((a) => a.type)).not.toContain(
            "queueTrim",
        );
    });
    it.each([
        "learn",
        "summary",
        "taskReview",
    ] as const)("grandfathers every state of an existing %s input, but admits new transcriptions", (phase) => {
        for (const state of [
            "pending",
            "running",
            "waiting",
            "done",
            "skipped",
            "failed",
            "outdated",
        ] as const) {
            const f = facts();
            f.phases[phase] = {
                state,
                inputs: f.content ?? undefined,
                generation: 1,
                at: f.at,
            };
            expect(planAdvance(f).actions.map((a) => a.type)).not.toContain(
                "queueTrim",
            );
            if (f.content) f.content = { ...f.content, contentRevision: 2 };
            expect(planAdvance(f).actions.map((a) => a.type)).toContain(
                "queueTrim",
            );
        }
    });
    it("does not reevaluate unchanged transcript content after audio replacement", () => {
        const f = facts();
        f.phases.trim = {
            state: "done",
            reason: "audio_changed",
            generation: 1,
            at: f.at,
            inputs: f.content ?? undefined,
        };
        expect(
            planAdvance(f).actions.map((action) => action.type),
        ).not.toContain("queueTrim");
    });
    it("suppresses trim for Nothing automatic", () => {
        const f = facts();
        f.manualOnly = true;
        expect(planAdvance(f).actions.map((a) => a.type)).not.toContain(
            "queueTrim",
        );
    });
    it("never queues trim for mail", () => {
        const f = facts();
        f.item.kind = "mail";
        f.content = {
            ...(f.content as NonNullable<PipelineFacts["content"]>),
            contentSourceId: "mail",
        };
        f.mail = { autoGenerated: false, unreadable: false, shared: false };
        expect(planAdvance(f).actions.map((a) => a.type)).not.toContain(
            "queueTrim",
        );
    });
});

describe("trim compatibility and profile changes", () => {
    it.each([
        "waiting",
        "running",
        "pending",
    ] as const)("projects %s into the existing public Learn vocabulary", (state) => {
        expect(
            serializeProcessing({
                trim: { state, generation: 1, at: "2026-11-08T00:00:00Z" },
            }),
        ).toEqual({ phase: "learn", state });
    });
    it("refreshes a pending recipe while keeping the original deadline", () => {
        const before = {
            state: "waiting" as const,
            generation: 1,
            at: "2026-11-08T00:00:00Z",
            waitingFor: {
                kind: "trimReview" as const,
                until: "2026-11-08T04:00:00Z",
            },
        };
        const after = markPhasesOutdatedForProfileChange(
            { trim: before },
            2,
            "2026-11-08T01:00:00Z",
        );
        expect(after.trim).toMatchObject({
            state: "outdated",
            waitingFor: before.waitingFor,
        });
        const f = facts();
        f.phases.trim = after.trim;
        expect(planAdvance(f).actions).toContainEqual(
            expect.objectContaining({
                type: "queueTrim",
                input: expect.objectContaining({ contentId: "transcript" }),
            }),
        );
    });
    it("leaves a resolved decision settled when the profile changes", () => {
        const before = {
            state: "done" as const,
            reason: "declined",
            generation: 1,
            at: "2026-11-08T00:00:00Z",
        };
        expect(
            markPhasesOutdatedForProfileChange(
                { trim: before },
                2,
                "2026-11-08T01:00:00Z",
            ).trim,
        ).toEqual(before);
    });
});
