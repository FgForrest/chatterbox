import { afterEach, describe, expect, it, vi } from "vitest";
import type { ItemProcessingPresentation } from "@/lib/pipeline/presentation";
import type { PhaseRecord, PhaseState } from "@/lib/pipeline/types";
import * as workflowStatus from "@/lib/pipeline/workflow-status";
import {
    deriveWorkflowWidgets,
    isWorkflowWidgetLineVisible,
} from "@/lib/pipeline/workflow-widgets";

function presentation(
    overrides: Partial<ItemProcessingPresentation> = {},
): ItemProcessingPresentation {
    return {
        itemId: "item-1",
        kind: "audio",
        legacy: false,
        manualOnly: false,
        phases: {
            categorize: {
                state: "done",
                reason: "categorized",
                generation: 1,
                at: "2026-10-16T00:00:00.000Z",
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
        outputs: { transcript: false, learn: false, summary: false },
        processAgain: false,
        processAgainReason: null,
        learnFindingsWaiting: 0,
        taskReviewWaiting: 0,
        jobs: { transcription: null, summary: null },
        failures: [],
        ...overrides,
    };
}

function phase(state: PhaseState, reason?: string): PhaseRecord {
    return {
        state,
        reason,
        generation: 1,
        at: "2026-10-16T00:00:00.000Z",
    };
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("workflow widgets", () => {
    it("hides future widgets and expands the active pipeline widget", () => {
        const widgets = deriveWorkflowWidgets(
            presentation({
                phases: {
                    categorize: {
                        state: "done",
                        generation: 1,
                        at: "2026-10-16T00:00:00.000Z",
                    },
                    transcribe: {
                        state: "running",
                        generation: 1,
                        at: "2026-10-16T00:01:00.000Z",
                    },
                },
                jobs: { transcription: "running", summary: null },
            }),
        );

        expect(widgets.transcript).toMatchObject({
            visible: true,
            active: true,
            collapsed: false,
            frame: "inline",
        });
        expect(widgets.learn.visible).toBe(false);
        expect(widgets.summary.visible).toBe(false);
        expect(widgets.taskReview.visible).toBe(false);
    });

    it("shows a ready manual step without exposing later phases", () => {
        const widgets = deriveWorkflowWidgets(
            presentation({
                profile: {
                    id: "profile-1",
                    name: "Manual Learn",
                    scope: "personal",
                    revisionId: "revision-1",
                    automatic: {
                        transcribe: true,
                        learn: false,
                        summary: false,
                        taskReview: false,
                    },
                },
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
                        state: "skipped",
                        reason: "profile_off",
                        generation: 1,
                        at: "2026-10-16T00:02:00.000Z",
                    },
                },
                outputs: { transcript: true, learn: false, summary: false },
            }),
        );

        expect(widgets.transcript.collapsed).toBe(false);
        expect(widgets.learn).toMatchObject({
            visible: true,
            active: true,
            frame: "inline",
            action: "run",
        });
        expect(widgets.summary.visible).toBe(false);
    });

    it("restores the Learn run action after its results are erased", () => {
        const widgets = deriveWorkflowWidgets(
            presentation({
                phases: {
                    categorize: phase("done", "categorized"),
                    transcribe: phase("done", "content-available"),
                    learn: phase("skipped", "erased"),
                    summary: phase("done", "completed"),
                    taskReview: phase("done", "reviewed"),
                },
                outputs: { transcript: true, learn: false, summary: true },
            }),
        );

        expect(widgets.workflowVisible).toBe(true);
        expect(widgets.learn).toMatchObject({
            visible: true,
            active: true,
            collapsed: false,
            frame: "inline",
            tone: "next",
            action: "run",
        });
    });

    it("keeps a pipeline review inline and a manual rerun review in a dialog", () => {
        const base = presentation({
            outputs: { transcript: true, learn: false, summary: false },
            learnFindingsWaiting: 2,
        });
        const pipeline = deriveWorkflowWidgets({
            ...base,
            phases: {
                ...base.phases,
                learn: {
                    state: "waiting",
                    reason: "review_pending",
                    generation: 1,
                    at: "2026-10-16T00:02:00.000Z",
                },
            },
        });
        const manual = deriveWorkflowWidgets({
            ...base,
            phases: {
                ...base.phases,
                learn: {
                    state: "waiting",
                    reason: "manual_review_pending",
                    generation: 2,
                    at: "2026-10-16T00:03:00.000Z",
                },
            },
        });

        expect(pipeline.learn.frame).toBe("inline");
        expect(manual.learn.frame).toBe("dialog");
    });

    it("keeps person-started work inline and opens only its task review in a dialog", () => {
        const base = presentation({
            outputs: { transcript: true, learn: true, summary: true },
            taskReviewWaiting: 2,
            phases: {
                categorize: phase("done"),
                transcribe: phase("done"),
                learn: phase("done"),
                summary: phase("done"),
                taskReview: phase("waiting", "review_pending"),
            },
        });
        const pipeline = deriveWorkflowWidgets({
            ...base,
            startedBy: {
                transcription: "pipeline",
                summary: "pipeline",
                topics: "pipeline",
            },
        });
        const person = deriveWorkflowWidgets({
            ...base,
            startedBy: {
                transcription: "person",
                summary: "person",
                topics: "person",
            },
        });

        expect(pipeline.transcript.frame).toBe("inline");
        expect(pipeline.summary.frame).toBe("inline");
        expect(pipeline.taskReview.frame).toBe("inline");
        expect(person.transcript.frame).toBe("inline");
        expect(person.summary.frame).toBe("inline");
        expect(person.taskReview.frame).toBe("dialog");
    });

    it("collapses completed phases while the strip is visible", () => {
        const widgets = deriveWorkflowWidgets(
            presentation({
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
                        state: "done",
                        generation: 1,
                        at: "2026-10-16T00:02:00.000Z",
                    },
                    summary: {
                        state: "running",
                        generation: 1,
                        at: "2026-10-16T00:03:00.000Z",
                    },
                },
                outputs: { transcript: true, learn: true, summary: false },
                jobs: { transcription: null, summary: "running" },
            }),
        );

        expect(widgets.transcript.collapsed).toBe(true);
        expect(widgets.learn.collapsed).toBe(true);
        expect(widgets.summary).toMatchObject({
            active: true,
            collapsed: false,
        });
    });

    it("restores the normal transcript and summary layout after completion", () => {
        const widgets = deriveWorkflowWidgets(
            presentation({
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
                        state: "done",
                        generation: 1,
                        at: "2026-10-16T00:02:00.000Z",
                    },
                    summary: {
                        state: "done",
                        generation: 1,
                        at: "2026-10-16T00:03:00.000Z",
                    },
                    taskReview: {
                        state: "done",
                        generation: 1,
                        at: "2026-10-16T00:04:00.000Z",
                    },
                },
                outputs: { transcript: true, learn: true, summary: true },
            }),
        );

        expect(widgets.workflowVisible).toBe(false);
        expect(widgets.transcript.collapsed).toBe(false);
        expect(widgets.summary.collapsed).toBe(false);
        expect(widgets.taskReview.visible).toBe(false);
    });

    it("shows a mail message and active Learn widget before its future summary", () => {
        const widgets = deriveWorkflowWidgets(
            presentation({
                kind: "mail",
                phases: {
                    categorize: {
                        state: "done",
                        generation: 1,
                        at: "2026-10-16T00:00:00.000Z",
                    },
                    learn: {
                        state: "running",
                        generation: 1,
                        at: "2026-10-16T00:01:00.000Z",
                    },
                },
            }),
        );

        expect(widgets.message.visible).toBe(true);
        expect(widgets.learn).toMatchObject({
            visible: true,
            active: true,
            frame: "inline",
        });
        expect(widgets.summary.visible).toBe(false);
        expect(widgets.taskReview.visible).toBe(false);
    });

    it.each([
        "title",
        "topics",
    ] as const)("marks Summary as a problem when its %s substep fails", (step) => {
        const data = presentation({
            phases: {
                categorize: phase("done"),
                transcribe: phase("done"),
                learn: phase("done"),
                summary: {
                    ...phase("done"),
                    steps: {
                        [step]: phase("failed", "SERVICE_UNAVAILABLE"),
                    },
                },
            },
            outputs: { transcript: true, learn: true, summary: true },
            failures: [
                {
                    phase: "summary",
                    step,
                    reasonCode: "SERVICE_UNAVAILABLE",
                    retryAvailable: true,
                },
            ],
        });

        const workflow = workflowStatus.deriveWorkflowStatus(data, "audio");
        expect(
            workflow.steps.find((candidate) => candidate.id === "summary"),
        ).toMatchObject({ state: "problem", current: true });
        expect(workflow.status).toMatchObject({
            actor: "problem",
            message: "failureUnavailable",
            params: { step: "summary" },
            action: "retry",
        });
    });

    it.each([
        { step: "title", job: "queued", state: "queued" },
        { step: "title", job: "running", state: "working" },
        { step: "topics", job: "queued", state: "queued" },
        { step: "topics", job: "running", state: "working" },
    ] as const)("keeps Summary $state while its $step retry job is $job", ({
        step,
        job,
        state,
    }) => {
        const data = presentation({
            phases: {
                categorize: phase("done"),
                transcribe: phase("done"),
                learn: phase("done"),
                summary: {
                    ...phase("failed", "SERVICE_UNAVAILABLE"),
                    steps: {
                        [step]: phase("failed", "SERVICE_UNAVAILABLE"),
                    },
                },
            },
            outputs: { transcript: true, learn: true, summary: false },
            jobs: { transcription: null, summary: job },
            failures: [
                {
                    phase: "summary",
                    step,
                    reasonCode: "SERVICE_UNAVAILABLE",
                    retryAvailable: true,
                },
            ],
        });

        const workflow = workflowStatus.deriveWorkflowStatus(data, "audio");
        expect(
            workflow.steps.find((candidate) => candidate.id === "summary"),
        ).toMatchObject({ state, current: true });
        expect(deriveWorkflowWidgets(data).summary).toMatchObject({
            active: true,
            tone: "working",
        });
    });
});

describe.each([
    { name: "Learn", widget: "learn", step: "learn" },
    { name: "Summary", widget: "summary", step: "summary" },
] as const)("manual $name widget", ({ widget, step }) => {
    function deriveManualWidget(state: "working" | "queued" | "manual") {
        vi.spyOn(workflowStatus, "deriveWorkflowStatus").mockReturnValue({
            visible: true,
            steps: [{ id: step, state, current: true }],
            status: null,
        });
        return deriveWorkflowWidgets(
            presentation({
                manualOnly: true,
                phases: {
                    categorize: phase("done"),
                    transcribe: phase("done"),
                    ...(widget === "summary" ? { learn: phase("done") } : {}),
                },
                outputs: {
                    transcript: true,
                    learn: widget === "summary",
                    summary: false,
                },
            }),
        )[widget];
    }

    it.each([
        "working",
        "queued",
    ] as const)("offers no run action and keeps the working tone while %s", (state) => {
        expect(deriveManualWidget(state)).toMatchObject({
            action: null,
            frame: "inline",
            tone: "working",
        });
    });

    it("offers run once settled without output", () => {
        expect(deriveManualWidget("manual")).toMatchObject({
            action: "run",
            frame: "inline",
            tone: "next",
        });
    });
});

describe("shared workflow widget line rule", () => {
    it.each([
        {
            name: "collapses a finished step while the workflow is visible",
            input: {
                workflowVisible: true,
                collapsed: true,
                expanded: false,
                working: false,
                frame: "inline" as const,
            },
            expected: true,
        },
        {
            name: "restores the full card after the workflow finishes",
            input: {
                workflowVisible: false,
                collapsed: true,
                expanded: false,
                working: false,
                frame: "inline" as const,
            },
            expected: false,
        },
        {
            name: "keeps a person-expanded workflow step open",
            input: {
                workflowVisible: true,
                collapsed: true,
                expanded: true,
                working: false,
                frame: "inline" as const,
            },
            expected: false,
        },
        {
            name: "leaves a dialog-started run represented by a line",
            input: {
                workflowVisible: false,
                collapsed: false,
                expanded: false,
                working: true,
                frame: "dialog" as const,
            },
            expected: true,
        },
        {
            name: "keeps a pipeline-started run in its full inline card",
            input: {
                workflowVisible: true,
                collapsed: false,
                expanded: false,
                working: true,
                frame: "inline" as const,
            },
            expected: false,
        },
    ])("$name", ({ input, expected }) => {
        expect(isWorkflowWidgetLineVisible(input)).toBe(expected);
    });
});
