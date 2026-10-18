import { describe, expect, it } from "vitest";
import type { ItemProcessingPresentation } from "@/lib/pipeline/presentation";
import type { PhaseRecord } from "@/lib/pipeline/types";
import {
    deriveWorkflowStatus,
    type WorkflowStep,
} from "@/lib/pipeline/workflow-status";

const at = "2026-10-16T08:00:00.000Z";

function phase(state: PhaseRecord["state"], reason?: string): PhaseRecord {
    return { state, reason, generation: 1, at };
}

function processing(
    overrides: Partial<ItemProcessingPresentation> = {},
): ItemProcessingPresentation {
    return {
        itemId: "item-1",
        kind: "audio",
        legacy: false,
        manualOnly: false,
        phases: {
            categorize: phase("done", "categorized"),
            transcribe: phase("done", "transcribed"),
            learn: phase("done", "finished"),
            summary: phase("done", "finished"),
            taskReview: phase("done", "reviewed"),
        },
        profile: {
            id: "profile-1",
            name: "Meetings",
            scope: "personal",
            revisionId: "revision-1",
            automatic: { transcribe: true, learn: true, summary: true },
        },
        placements: [
            {
                id: "folder-1",
                parentId: "private",
                name: "Meetings",
                path: "Private › Meetings",
                scope: "personal",
            },
        ],
        intents: [],
        outputs: { transcript: true, learn: true, summary: true },
        processAgain: false,
        processAgainReason: null,
        learnFindingsWaiting: 0,
        taskReviewWaiting: 0,
        jobs: { transcription: null, summary: null },
        failures: [],
        ...overrides,
    };
}

function stateOf(steps: WorkflowStep[], id: WorkflowStep["id"]) {
    return steps.find((step) => step.id === id)?.state;
}

describe("deriveWorkflowStatus", () => {
    it("maps needs_folder to the filing turn", () => {
        const result = deriveWorkflowStatus(
            processing({
                placements: [],
                phases: { categorize: phase("waiting", "needs_folder") },
                outputs: { transcript: false, learn: false, summary: false },
            }),
            "audio",
        );
        expect(stateOf(result.steps, "categorize")).toBe("next");
        expect(result.status).toMatchObject({
            actor: "yours",
            message: "notFiled",
        });
    });

    it("maps disagreeing profiles to choose profile", () => {
        const result = deriveWorkflowStatus(
            processing({
                phases: { categorize: phase("waiting", "needs_profile") },
            }),
            "audio",
        );
        expect(result.status).toMatchObject({
            actor: "yours",
            message: "profilesDisagree",
            action: "chooseProfile",
        });
    });

    it("maps an unavailable profile to a problem", () => {
        const result = deriveWorkflowStatus(
            processing({
                phases: {
                    categorize: phase("failed", "profile_unavailable"),
                },
                failures: [
                    {
                        phase: "categorize",
                        reasonCode: "profile_unavailable",
                        retryAvailable: false,
                    },
                ],
            }),
            "audio",
        );
        expect(stateOf(result.steps, "categorize")).toBe("problem");
        expect(result.status).toMatchObject({
            actor: "problem",
            message: "profileUnavailable",
            action: "chooseProfile",
        });
    });

    it("maps a curator hold to someone else's turn", () => {
        const result = deriveWorkflowStatus(
            processing({
                phases: {
                    categorize: phase("waiting", "waiting_for_curator"),
                },
            }),
            "audio",
        );
        expect(stateOf(result.steps, "categorize")).toBe("others");
        expect(result.status).toMatchObject({
            actor: "others",
            message: "curatorProfile",
        });
    });

    it("maps a queued transcription job", () => {
        const result = deriveWorkflowStatus(
            processing({
                phases: {
                    categorize: phase("done"),
                    transcribe: phase("running"),
                },
                outputs: { transcript: false, learn: false, summary: false },
                jobs: { transcription: "queued", summary: null },
            }),
            "audio",
        );
        expect(stateOf(result.steps, "transcribe")).toBe("queued");
        expect(result.status).toMatchObject({
            actor: "queued",
            message: "transcriptionQueued",
        });
    });

    it("maps active transcription to working", () => {
        const result = deriveWorkflowStatus(
            processing({
                phases: {
                    categorize: phase("done"),
                    transcribe: phase("running"),
                },
                outputs: { transcript: false, learn: false, summary: false },
                jobs: { transcription: "running", summary: null },
            }),
            "audio",
        );
        expect(stateOf(result.steps, "transcribe")).toBe("working");
        expect(result.status).toMatchObject({
            actor: "working",
            message: "transcribing",
        });
    });

    it("maps an in-flight Learn run to working", () => {
        const result = deriveWorkflowStatus(
            processing({ phases: { learn: phase("running") } }),
            "audio",
        );
        expect(stateOf(result.steps, "learn")).toBe("working");
        expect(result.status).toMatchObject({
            actor: "working",
            message: "learnRunning",
        });
    });

    it.each([
        ["queued", "queued", "learnQueued"],
        ["running", "working", "learnRunning"],
    ] as const)("follows a newer %s Learn run instead of the settled phase", (runStatus, stepState, message) => {
        const result = deriveWorkflowStatus(
            processing({
                latestLearnRun: {
                    status: runStatus,
                    errorCode: null,
                    updatedAt: "2026-10-16T08:01:00.000Z",
                },
            }),
            "audio",
        );

        expect(stateOf(result.steps, "learn")).toBe(stepState);
        expect(result.status).toMatchObject({ message });
    });

    it("shows a newer failed Learn run as the retryable problem", () => {
        const result = deriveWorkflowStatus(
            processing({
                latestLearnRun: {
                    status: "failed",
                    errorCode: "SERVICE_UNAVAILABLE",
                    updatedAt: "2026-10-16T08:01:00.000Z",
                },
            }),
            "audio",
        );

        expect(stateOf(result.steps, "learn")).toBe("problem");
        expect(result.status).toEqual({
            actor: "problem",
            message: "failureUnavailable",
            params: { step: "learn" },
            action: "retry",
        });
    });

    it("keeps the phase result when the latest Learn run is older", () => {
        const result = deriveWorkflowStatus(
            processing({
                latestLearnRun: {
                    status: "failed",
                    errorCode: "SERVICE_UNAVAILABLE",
                    updatedAt: "2026-10-16T07:59:00.000Z",
                },
            }),
            "audio",
        );

        expect(stateOf(result.steps, "learn")).toBe("done");
        expect(result.status).toBeNull();
    });

    it("keeps Learn queued between a finished transcription and its planner tick", () => {
        const result = deriveWorkflowStatus(
            processing({
                phases: {
                    categorize: phase("done", "categorized"),
                    transcribe: phase("done", "content-available"),
                },
                outputs: { transcript: true, learn: false, summary: false },
            }),
            "audio",
        );

        expect(stateOf(result.steps, "learn")).toBe("queued");
        expect(result.visible).toBe(true);
        expect(result.status).toMatchObject({
            actor: "queued",
            message: "learnQueued",
        });
    });

    it("keeps automatic Transcribe queued after categorization", () => {
        const result = deriveWorkflowStatus(
            processing({
                phases: { categorize: phase("done", "categorized") },
                outputs: { transcript: false, learn: false, summary: false },
            }),
            "audio",
        );

        expect(stateOf(result.steps, "transcribe")).toBe("queued");
        expect(result.status?.message).toBe("transcriptionQueued");
    });

    it("keeps Summary queued between Learn release and its planner tick", () => {
        const result = deriveWorkflowStatus(
            processing({
                phases: {
                    categorize: phase("done", "categorized"),
                    transcribe: phase("done", "content-available"),
                    learn: phase("done", "released"),
                },
                outputs: { transcript: true, learn: true, summary: false },
            }),
            "audio",
        );

        expect(stateOf(result.steps, "summary")).toBe("queued");
        expect(result.visible).toBe(true);
        expect(result.status).toMatchObject({
            actor: "queued",
            message: "summaryQueued",
        });
    });

    it("keeps automatic task review queued after Summary", () => {
        const result = deriveWorkflowStatus(
            processing({
                profile: {
                    id: "profile-1",
                    name: "Meetings",
                    scope: "personal",
                    revisionId: "revision-1",
                    automatic: {
                        transcribe: true,
                        learn: true,
                        summary: true,
                        taskReview: true,
                    },
                },
                phases: {
                    categorize: phase("done", "categorized"),
                    transcribe: phase("done", "content-available"),
                    learn: phase("done", "released"),
                    summary: phase("done", "completed"),
                },
            }),
            "audio",
        );

        expect(stateOf(result.steps, "taskReview")).toBe("queued");
        expect(result.status?.message).toBe("taskReviewQueued");
    });

    it("keeps automatic Share queued after its gate is settled", () => {
        const result = deriveWorkflowStatus(
            processing({
                intents: [
                    {
                        folderId: "org-1",
                        name: "Team",
                        path: "Organization › Team",
                        confirmationRequired: false,
                        confirmed: false,
                    },
                ],
                phases: {
                    categorize: phase("done", "categorized"),
                    transcribe: phase("done", "content-available"),
                    learn: phase("done", "released"),
                    summary: phase("done", "completed"),
                    taskReview: phase("done", "reviewed"),
                },
            }),
            "audio",
        );

        expect(stateOf(result.steps, "share")).toBe("queued");
        expect(result.status?.message).toBe("shareQueued");
    });

    it("maps Learn findings to review, never working", () => {
        const result = deriveWorkflowStatus(
            processing({
                phases: { learn: phase("waiting", "review_pending") },
                outputs: { transcript: true, learn: false, summary: false },
                learnFindingsWaiting: 2,
            }),
            "audio",
        );
        expect(stateOf(result.steps, "learn")).toBe("review");
        expect(result.status).toMatchObject({
            actor: "yours",
            message: "learnReview",
            params: { count: 2 },
            action: "reviewLearn",
        });
    });

    it("maps a manually started Learn run to review with no counted findings", () => {
        const result = deriveWorkflowStatus(
            processing({
                phases: {
                    learn: phase("waiting", "manual_review_pending"),
                },
                outputs: { transcript: true, learn: false, summary: false },
                learnFindingsWaiting: 0,
            }),
            "audio",
        );

        expect(stateOf(result.steps, "learn")).toBe("review");
        expect(result.status).toMatchObject({
            actor: "yours",
            message: "manualLearnReview",
            params: { count: 0 },
            action: "reviewLearn",
        });
    });

    it("keeps a timed-out Learn review actionable", () => {
        const result = deriveWorkflowStatus(
            processing({
                phases: {
                    learn: phase("waiting", "review_pending_timeout"),
                },
                learnFindingsWaiting: 3,
            }),
            "audio",
        );
        expect(stateOf(result.steps, "learn")).toBe("review");
        expect(result.status).toMatchObject({
            actor: "yours",
            message: "learnTimedOut",
            action: "reviewLearn",
        });
    });

    it.each([
        ["queued", "queued", "summaryQueued"],
        ["running", "working", "summaryRunning"],
    ] as const)("maps a %s summary job", (job, state, message) => {
        const result = deriveWorkflowStatus(
            processing({
                phases: { summary: phase("running") },
                jobs: { transcription: null, summary: job },
            }),
            "audio",
        );
        expect(stateOf(result.steps, "summary")).toBe(state);
        expect(result.status?.message).toBe(message);
    });

    it("maps task changes to review", () => {
        const result = deriveWorkflowStatus(
            processing({
                phases: { taskReview: phase("waiting", "needs_review") },
                taskReviewWaiting: 4,
            }),
            "audio",
        );
        expect(stateOf(result.steps, "taskReview")).toBe("review");
        expect(result.status).toMatchObject({
            actor: "yours",
            message: "taskReview",
            params: { count: 4 },
            action: "reviewTasks",
        });
    });

    it("keeps automatic Share waiting behind the blocking step", () => {
        const result = deriveWorkflowStatus(
            processing({
                phases: {
                    learn: phase("waiting", "review_pending"),
                    share: phase("waiting", "gated"),
                },
                learnFindingsWaiting: 1,
                intents: [
                    {
                        folderId: "org-1",
                        name: "Team",
                        path: "Organization › Team",
                        confirmationRequired: false,
                        confirmed: false,
                    },
                ],
            }),
            "audio",
        );
        expect(stateOf(result.steps, "share")).toBe("waiting");
        expect(result.status?.message).toBe("learnReview");
    });

    it("maps confirmation-held Share to the person's next action", () => {
        const result = deriveWorkflowStatus(
            processing({
                manualOnly: true,
                intents: [
                    {
                        folderId: "org-1",
                        name: "Team",
                        path: "Organization › Team",
                        confirmationRequired: true,
                        confirmed: false,
                    },
                ],
                phases: { share: phase("waiting", "confirmation_required") },
            }),
            "audio",
        );
        expect(stateOf(result.steps, "share")).toBe("next");
        expect(result.status).toMatchObject({
            actor: "yours",
            message: "shareConfirmation",
            params: { folders: ["Organization › Team"] },
            action: "shareNow",
        });
    });

    it.each([
        ["no_provider", "failureNoProvider"],
        ["NO_TRANSCRIPTION_PROVIDER", "failureNoProvider"],
        ["AI_PROVIDER_NOT_CONFIGURED", "failureNoProvider"],
        ["PROVIDER_ERROR", "failureProvider"],
        ["PROVIDER_FAILED", "failureProvider"],
        ["AI_PROVIDER_API_ERROR", "failureProvider"],
        ["PROVIDER_TIMEOUT", "failureTimeout"],
        ["MYNAH_BUDGET_EXHAUSTED", "failureBudget"],
        ["AI_RATE_LIMITED", "failureRateLimited"],
        ["RATE_LIMITED", "failureRateLimited"],
        ["PLAUD_RATE_LIMITED", "failureRateLimited"],
        ["UPSTREAM_BAD_RESPONSE", "failureUnavailable"],
        ["SERVICE_UNAVAILABLE", "failureUnavailable"],
        ["PLAUD_UPSTREAM_ERROR", "failureUnavailable"],
        ["AI_CONTEXT_LENGTH_EXCEEDED", "failureContextTooLong"],
        ["TRANSCRIPTION_FAILED", "failureTranscription"],
        ["RECORDING_DATA_REAPED", "failureSourceUnavailable"],
        ["RECORDING_NOT_FOUND", "failureSourceUnavailable"],
        ["AUDIO_REAPED", "failureSourceUnavailable"],
        ["STORAGE_ERROR", "failureSourceUnavailable"],
        ["FORBIDDEN", "failureAccess"],
        ["RECORDING_SHARED", "failureAccess"],
        ["INTERNAL_ERROR", "stepFailed"],
        ["JOB_TERMINAL_FAILURE", "stepFailed"],
        ["UNKNOWN_FAILURE", "stepFailed"],
    ] as const)("maps failure code %s to %s", (reasonCode, message) => {
        const result = deriveWorkflowStatus(
            processing({
                phases: { summary: phase("failed", reasonCode) },
                failures: [
                    {
                        phase: "summary",
                        reasonCode,
                        retryAvailable: true,
                    },
                ],
            }),
            "audio",
        );
        expect(stateOf(result.steps, "summary")).toBe("problem");
        expect(result.status).toEqual({
            actor: "problem",
            message,
            params: { step: "summary" },
            action: "retry",
        });
    });

    it("maps a changed profile to outdated with Process again", () => {
        const result = deriveWorkflowStatus(
            processing({
                processAgain: true,
                processAgainReason: "profile_changed",
                phases: { summary: phase("outdated", "profile_changed") },
            }),
            "audio",
        );
        expect(stateOf(result.steps, "summary")).toBe("outdated");
        expect(result.status).toMatchObject({
            actor: "yours",
            message: "profileChanged",
            action: "processAgain",
        });
    });

    it("marks untouched nonautomatic steps manual", () => {
        const result = deriveWorkflowStatus(
            processing({
                profile: {
                    id: "profile-1",
                    name: "Meetings",
                    scope: "personal",
                    revisionId: "revision-1",
                    automatic: {
                        transcribe: true,
                        learn: false,
                        summary: false,
                    },
                },
                phases: {
                    categorize: phase("done"),
                    transcribe: phase("done"),
                },
                outputs: { transcript: true, learn: false, summary: false },
            }),
            "audio",
        );
        expect(stateOf(result.steps, "learn")).toBe("manual");
        expect(stateOf(result.steps, "summary")).toBe("manual");
    });

    it("makes manual Transcribe next when automatic steps need its output", () => {
        const result = deriveWorkflowStatus(
            processing({
                profile: {
                    id: "profile-1",
                    name: "Meetings",
                    scope: "personal",
                    revisionId: "revision-1",
                    automatic: {
                        transcribe: false,
                        learn: true,
                        summary: true,
                    },
                },
                phases: {
                    categorize: phase("done", "categorized"),
                    transcribe: phase("waiting", "needs_transcript"),
                },
                outputs: { transcript: false, learn: false, summary: false },
            }),
            "audio",
        );

        expect(stateOf(result.steps, "transcribe")).toBe("next");
        expect(stateOf(result.steps, "learn")).toBe("waiting");
        expect(result.status).toEqual({
            actor: "yours",
            message: "manualTranscription",
            action: "transcribe",
        });
    });

    it("does not make manual Learn block an automatic Summary", () => {
        const result = deriveWorkflowStatus(
            processing({
                profile: {
                    id: "profile-1",
                    name: "Meetings",
                    scope: "personal",
                    revisionId: "revision-1",
                    automatic: {
                        transcribe: true,
                        learn: false,
                        summary: true,
                    },
                },
                phases: {
                    categorize: phase("done", "categorized"),
                    transcribe: phase("done", "content-available"),
                },
                outputs: { transcript: true, learn: false, summary: false },
            }),
            "audio",
        );

        expect(stateOf(result.steps, "learn")).toBe("manual");
        expect(stateOf(result.steps, "summary")).toBe("queued");
        expect(result.status?.message).toBe("summaryQueued");
    });

    it("keeps skipped reasons", () => {
        const result = deriveWorkflowStatus(
            processing({ phases: { learn: phase("skipped", "hosted") } }),
            "audio",
        );
        expect(result.steps.find((step) => step.id === "learn")).toMatchObject({
            state: "skipped",
            reason: "hosted",
        });
    });

    it("hides when all steps are done, skipped, or untouched manual", () => {
        expect(deriveWorkflowStatus(processing(), "audio").visible).toBe(false);
        expect(
            deriveWorkflowStatus(
                processing({
                    manualOnly: true,
                    phases: {
                        categorize: phase("done"),
                        transcribe: phase("skipped", "manual_only"),
                    },
                    outputs: {
                        transcript: false,
                        learn: false,
                        summary: false,
                    },
                }),
                "audio",
            ).visible,
        ).toBe(false);
    });

    it("hides a Nothing automatic item immediately after categorization", () => {
        const result = deriveWorkflowStatus(
            processing({
                manualOnly: true,
                phases: { categorize: phase("done", "categorized") },
                outputs: { transcript: false, learn: false, summary: false },
            }),
            "audio",
        );

        expect(result.visible).toBe(false);
        expect(result.status).toBeNull();
    });

    it("keeps a Nothing automatic item visible for an unconfirmed Organization intent", () => {
        const result = deriveWorkflowStatus(
            processing({
                manualOnly: true,
                phases: { categorize: phase("done", "categorized") },
                outputs: { transcript: false, learn: false, summary: false },
                intents: [
                    {
                        folderId: "org-1",
                        name: "Team",
                        path: "Organization › Team",
                        confirmationRequired: true,
                        confirmed: false,
                    },
                ],
            }),
            "audio",
        );

        expect(result.visible).toBe(true);
        expect(stateOf(result.steps, "share")).toBe("next");
        expect(result.status?.message).toBe("shareConfirmation");
    });

    it.each([
        [
            "not filed",
            {
                phases: { categorize: phase("waiting", "needs_folder") },
                placements: [],
            },
        ],
        [
            "queued",
            {
                jobs: { transcription: "queued", summary: null },
                phases: { transcribe: phase("running") },
            },
        ],
        ["running", { phases: { learn: phase("running") } }],
        [
            "someone else",
            {
                phases: {
                    categorize: phase("waiting", "waiting_for_curator"),
                },
            },
        ],
        [
            "person",
            {
                phases: { learn: phase("waiting", "review_pending") },
                learnFindingsWaiting: 1,
            },
        ],
        [
            "failed",
            {
                phases: { summary: phase("failed", "x") },
                failures: [
                    { phase: "summary", reasonCode: "x", retryAvailable: true },
                ],
            },
        ],
        [
            "outdated",
            {
                phases: { summary: phase("outdated", "profile_changed") },
                processAgain: true,
                processAgainReason: "profile_changed",
            },
        ],
    ] as const)("is visible while %s", (_name, overrides) => {
        expect(
            deriveWorkflowStatus(
                processing(overrides as Partial<ItemProcessingPresentation>),
                "audio",
            ).visible,
        ).toBe(true);
    });

    it("hides the strip for legacy items", () => {
        expect(
            deriveWorkflowStatus(
                processing({
                    legacy: true,
                    phases: { learn: phase("running") },
                }),
                "audio",
            ).visible,
        ).toBe(false);
    });

    it("orders audio, mail, and Share steps", () => {
        expect(
            deriveWorkflowStatus(processing(), "audio").steps.map(
                (step) => step.id,
            ),
        ).toEqual([
            "record",
            "categorize",
            "transcribe",
            "learn",
            "summary",
            "taskReview",
        ]);
        expect(
            deriveWorkflowStatus(
                processing({ kind: "mail" }),
                "mail",
            ).steps.map((step) => step.id),
        ).toEqual(["receive", "categorize", "learn", "summary", "taskReview"]);
        expect(
            deriveWorkflowStatus(
                processing({
                    intents: [
                        {
                            folderId: "org-1",
                            name: "Team",
                            path: "Organization › Team",
                            confirmationRequired: false,
                            confirmed: true,
                        },
                    ],
                }),
                "audio",
            ).steps.at(-1)?.id,
        ).toBe("share");
    });
});
