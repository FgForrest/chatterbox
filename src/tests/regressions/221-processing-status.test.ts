import { describe, expect, it } from "vitest";
import { JOB_STALE_MS } from "@/lib/jobs/timing";
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
function job(status: "pending" | "processing", age = 0): ProcessingQueueJob {
    return {
        id: "job-veln",
        kind: "learn.run",
        status,
        heartbeatAt: new Date(now.getTime() - age),
        startedAt: now,
        updatedAt: now,
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
    });
    it("does not present a queue without a live pending job", () => {
        const result = projectProcessing(bound(), [], owner, now);
        expect(result.steps.learn.state).toBe("pending");
        expect(result.steps.learn.waitingFor?.kind).not.toBe("job");
        expect(result.nextCheckAt).toBe("2026-10-23T09:01:00.000Z");
    });
    it("reports stalled only after the shared heartbeat threshold", () => {
        expect(
            projectProcessing(
                bound(),
                [job("processing", JOB_STALE_MS)],
                owner,
                now,
            ).steps.learn.state,
        ).toBe("running");
        expect(
            projectProcessing(
                bound(),
                [job("processing", JOB_STALE_MS + 1)],
                owner,
                now,
            ).steps.learn.state,
        ).toBe("stalled");
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
