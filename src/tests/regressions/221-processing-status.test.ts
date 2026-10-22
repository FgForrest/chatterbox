import { describe, expect, it } from "vitest";
import {
    type ProcessingInput,
    type ProcessingQueueJob,
    projectProcessing,
} from "@/lib/pipeline/processing-status";

const now = new Date("2026-10-23T09:00:00Z");
const base: ProcessingInput = {
    itemId: "item-veln",
    kind: "audio",
    legacy: false,
    manualOnly: false,
    phases: {},
    profile: null,
    placements: [],
    intents: [],
    outputs: { transcript: false, summary: false, learn: false },
    processAgain: false,
    processAgainReason: null,
    learnFindingsWaiting: 2,
    taskReviewWaiting: 1,
    jobs: { transcription: null, summary: null },
    failures: [],
};
const owner = { canChange: true, canFile: true };
function job(
    status: "pending" | "processing",
    stale = false,
): ProcessingQueueJob {
    return {
        id: "job-veln",
        kind: "learn.run",
        status,
        stale,
        retryAt: null,
        position: 3,
        result: null,
        errorCode: null,
    };
}
function bound() {
    return {
        ...base,
        phases: {
            learn: {
                state: "running" as const,
                reason: "started",
                jobId: "job-veln",
                generation: 2,
                at: now.toISOString(),
            },
        },
    };
}
describe("#221 explicit processing response", () => {
    it.each([
        "pending",
        "processing",
    ] as const)("presents a %s job and a five-second check", (status) => {
        const result = projectProcessing(bound(), [job(status)], owner, now);
        expect(result.steps.learn).toMatchObject({
            state: status === "pending" ? "queued" : "running",
            waitingFor: {
                kind: "job",
                status: status === "pending" ? "queued" : "running",
                jobId: "job-veln",
                ...(status === "pending" ? { position: 3 } : {}),
            },
            actions: [],
        });
        expect(result.nextCheckAt).toBe("2026-10-23T09:00:05.000Z");
        expect(result.nextCheckInMs).toBe(5_000);
    });
    it("does not present a queue without a live pending job", () => {
        const result = projectProcessing(bound(), [], owner, now);
        expect(result.steps.learn.state).toBe("pending");
        expect(result.steps.learn.waitingFor?.kind).not.toBe("job");
        expect(result.nextCheckAt).toBe("2026-10-23T09:01:00.000Z");
    });
    it("uses the database staleness verdict", () => {
        expect(
            projectProcessing(bound(), [job("processing", false)], owner, now)
                .steps.learn.state,
        ).toBe("running");
        expect(
            projectProcessing(bound(), [job("processing", true)], owner, now)
                .steps.learn.state,
        ).toBe("stalled");
    });
    it("waits thirty seconds for the reconciler when a job is stalled", () => {
        const result = projectProcessing(
            bound(),
            [job("processing", true)],
            owner,
            now,
        );
        expect(result.nextCheckInMs).toBe(30_000);
    });
    it.each([
        30_000, 90_000,
    ])("waits until a scheduled retry, capped at one minute (%s ms)", (delay) => {
        const retryAt = new Date(now.getTime() + delay).toISOString();
        const result = projectProcessing(
            bound(),
            [{ ...job("pending"), retryAt }],
            owner,
            now,
        );
        expect(result.steps.learn).toMatchObject({
            state: "queued",
            waitingFor: { kind: "job", status: "retry", retryAt },
        });
        expect(result.steps.learn.waitingFor?.position).toBeUndefined();
        expect(result.jobs.transcription).toBeNull();
        expect(result.nextCheckInMs).toBe(Math.min(delay, 60_000));
    });
    it("keeps a scheduled manual retry visible over an earlier output", () => {
        const retryAt = new Date(now.getTime() + 90_000).toISOString();
        const result = projectProcessing(
            {
                ...base,
                manualOnly: true,
                outputs: { ...base.outputs, transcript: true },
            },
            [
                {
                    ...job("pending"),
                    kind: "transcription",
                    unbound: true,
                    retryAt,
                },
            ],
            owner,
            now,
        );
        expect(result.steps.transcribe).toMatchObject({
            state: "queued",
            waitingFor: { status: "retry", retryAt },
        });
        expect(result.nextCheckInMs).toBe(60_000);
    });
    it.each([
        "review_pending_timeout",
        "manual_review_pending",
    ])("clears a carried Learn deadline for %s", (reason) => {
        const until = new Date(now.getTime() + 900_000).toISOString();
        const live = {
            ...base,
            phases: {
                learn: {
                    state: "waiting" as const,
                    reason: "review_pending",
                    waitingFor: { kind: "learnReview", until },
                    generation: 1,
                    at: now.toISOString(),
                },
            },
        };
        expect(
            projectProcessing(live, [], { ...owner, reviewUntil: until }, now)
                .steps.learn.waitingFor?.until,
        ).toBe(until);
        const result = projectProcessing(
            { ...live, phases: { learn: { ...live.phases.learn, reason } } },
            [],
            { ...owner, reviewUntil: until },
            now,
        );
        expect(result.steps.learn.waitingFor?.until).toBeUndefined();
        expect(result.steps.learn.reason).toBe(reason);
        expect(result.nextCheckInMs).toBe(60_000);
    });
    it.each([
        ["completed", "done"],
        ["failed", "failed"],
        ["pending", "queued"],
        ["processing", "running"],
    ] as const)("projects a %s job carrying an old retryable outcome as %s", (status, state) => {
        const result = projectProcessing(
            bound(),
            [
                {
                    ...job("processing"),
                    status,
                    result: {
                        outcome: {
                            kind: "failed",
                            code: "PROVIDER_FAILED",
                            retryable: true,
                        },
                    },
                },
            ],
            owner,
            now,
        );
        expect(result.steps.learn.state).toBe(state);
        expect(result.steps.learn.actions).toEqual(
            status === "failed" ? ["retry"] : [],
        );
    });
    it.each([
        ["learn", "review_pending", "learnReview", "reviewLearn"],
        ["categorize", "needs_folder", "folder", "file"],
        ["categorize", "needs_profile", "profile", "chooseProfile"],
        ["share", "confirmation_required", "shareConfirmation", "shareNow"],
        ["share", "org_unavailable", "organization", null],
        ["share", "gate_blocked", "shareGate", null],
        ["categorize", "waiting_for_curator", "organization", null],
        ["taskReview", "needs_review", "taskReview", "reviewTasks"],
    ] as const)("maps %s / %s with the canonical wait", (phase, reason, kind, action) => {
        const result = projectProcessing(
            {
                ...base,
                phases: {
                    [phase]: {
                        state: "waiting",
                        reason,
                        generation: 1,
                        at: now.toISOString(),
                    },
                },
            },
            [],
            owner,
            now,
        );
        expect(result.steps[phase].waitingFor).toEqual({ kind });
        expect(result.steps[phase].actions).toEqual(action ? [action] : []);
    });
    it.each([
        30_000, 900_000,
    ])("checks at the Learn hold end, capped to ten minutes (%s ms)", (duration) => {
        const until = new Date(now.getTime() + duration).toISOString();
        const result = projectProcessing(
            {
                ...base,
                phases: {
                    learn: {
                        state: "waiting",
                        reason: "review_pending",
                        waitingFor: { kind: "learnReview", until },
                        generation: 1,
                        at: now.toISOString(),
                    },
                },
            },
            [],
            owner,
            now,
        );
        expect(result.steps.learn.waitingFor?.until).toBe(until);
        expect(Date.parse(result.nextCheckAt) - now.getTime()).toBe(
            Math.min(duration, 600_000),
        );
    });
    it.each([
        "PROVIDER_FAILED",
        "lost",
    ])("keeps the failure code %s and authorized retry", (reason) => {
        const data = {
            ...base,
            phases: {
                learn: {
                    state: "failed" as const,
                    reason,
                    generation: 1,
                    at: now.toISOString(),
                },
            },
        };
        expect(
            projectProcessing(data, [], owner, now).steps.learn,
        ).toMatchObject({
            state: "failed",
            reason,
            waitingFor: null,
            actions: ["retry"],
        });
        expect(
            projectProcessing(
                data,
                [],
                { canChange: false, canFile: false },
                now,
            ).steps.learn.actions,
        ).toEqual([]);
    });
    it.each([
        "member",
        "curator",
        "owner",
    ] as const)("filters review and filing actions for %s", (role) => {
        const data: ProcessingInput = {
            ...base,
            phases: {
                categorize: {
                    state: "waiting",
                    reason: "needs_folder",
                    generation: 1,
                    at: now.toISOString(),
                },
                learn: {
                    state: "waiting",
                    reason: "review_pending",
                    generation: 1,
                    at: now.toISOString(),
                },
                summary: {
                    state: "outdated",
                    reason: "profile_changed",
                    generation: 1,
                    at: now.toISOString(),
                },
            },
            processAgain: true,
        };
        const result = projectProcessing(
            data,
            [],
            { canChange: role !== "member", canFile: role === "owner" },
            now,
        );
        expect(result.steps.categorize.actions).toEqual(
            role === "owner" ? ["file"] : [],
        );
        expect(result.steps.learn.actions).toEqual(
            role !== "member" ? ["reviewLearn"] : [],
        );
        expect(result.steps.summary.actions).toEqual(
            role === "owner" ? ["processAgain"] : [],
        );
    });
    it.each([
        "summary",
        "topics",
        "title",
    ] as const)("projects each %s child job, failure and allowed retry", (child) => {
        const data: ProcessingInput = {
            ...base,
            phases: {
                summary: {
                    state: "running",
                    generation: 1,
                    at: now.toISOString(),
                    steps: {
                        [child]: {
                            state: "running",
                            jobId: "job-veln",
                            contentId: "content-veln",
                            contentRevision: 1,
                            generation: 1,
                        },
                    },
                },
            },
        };
        const result = projectProcessing(data, [job("pending")], owner, now);
        expect(result.steps.summary.steps?.[child]?.state).toBe("queued");
        expect(result.steps.summary.waitingFor?.position).toBe(3);
    });
    it("keeps a live unbound manual job visible even when an earlier output exists", () => {
        const queued = {
            ...job("pending"),
            kind: "transcription",
            unbound: true,
        };
        const result = projectProcessing(
            {
                ...base,
                outputs: { ...base.outputs, transcript: true },
                manualOnly: true,
            },
            [queued],
            owner,
            now,
        );
        expect(result.steps.transcribe.state).toBe("queued");
        expect(result.jobs.transcription).toBe("queued");
    });
    it("does not hide a pending companion job behind a provider skip", () => {
        const data: ProcessingInput = {
            ...base,
            phases: {
                summary: {
                    state: "running",
                    generation: 2,
                    at: now.toISOString(),
                    steps: {
                        summary: {
                            state: "skipped",
                            reason: "no_provider",
                            generation: 2,
                            contentId: "content-veln",
                            contentRevision: 1,
                        },
                        topics: {
                            state: "running",
                            jobId: "job-veln",
                            generation: 2,
                            contentId: "content-veln",
                            contentRevision: 1,
                        },
                    },
                },
            },
        };
        const result = projectProcessing(data, [job("pending")], owner, now);
        expect(result.steps.summary.state).toBe("queued");
        expect(result.steps.summary.steps?.summary?.state).toBe("skipped");
    });
    it("does not present another generation's job as this step's queue", () => {
        const stale = {
            ...job("pending"),
            bindings: [{ phase: "learn" as const, generation: 3 }],
        };
        expect(
            projectProcessing(bound(), [stale], owner, now).steps.learn.state,
        ).not.toBe("queued");
    });
});
