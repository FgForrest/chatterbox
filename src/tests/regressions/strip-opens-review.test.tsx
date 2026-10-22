// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LearnReview } from "@/components/learn/learn-review";
import { MailLearnCard } from "@/components/mail/mail-learn-card";
import { ItemWorkflow } from "@/components/pipeline/item-workflow";
import { openWidget } from "@/components/pipeline/workflow-widget";
import { SummaryWidget } from "@/components/summary/summary-widget";
import { TaskReviewLink } from "@/components/tasks/task-review-dialog";
import type { RecordingTasksState } from "@/components/tasks/use-recording-tasks";
import type { MailDetail } from "@/lib/mail/detail";
import type { CategorizationPanelPresentation } from "@/lib/pipeline/categorization-presentation";
import type { ItemProcessingPresentation } from "@/lib/pipeline/presentation";
import {
    deriveWorkflowWidgets,
    type WorkflowWidgetFrame,
} from "@/lib/pipeline/workflow-widgets";
import { processingFixture } from "@/tests/pipeline/processing-fixture";
import type { Recording } from "@/types/recording";

vi.mock("@/hooks/use-transcription-summary", () => ({
    useTranscriptionSummary: () => {
        const [summaryExpanded, setSummaryExpanded] = useState(false);
        return {
            summaryData: { summary: "The project is ready for review." },
            summaryLoaded: true,
            isSummarizing: false,
            summaryProgress: null,
            summaryElapsedMs: 0,
            summaryExpanded,
            setSummaryExpanded,
            handleSummarize: vi.fn(),
            recheckSummary: vi.fn(),
        };
    },
}));

vi.mock("@/components/dashboard/markdown-actions", () => ({
    MarkdownActions: () => null,
}));

const review = {
    run: { id: "run-1", status: "ready" },
    available: true,
    names: { "person-1": "Jan", "entity-1": "Orion" },
    types: {},
    relations: { leads: "leads" },
    items: [
        {
            id: "fact-1",
            kind: "fact",
            preTicked: false,
            decision: null,
            choice: null,
            version: 0,
            dependsOnLabel: null,
            payload: {
                subject: { personId: "person-1" },
                relationKey: "leads",
                object: { entityId: "entity-1" },
                startMs: 0,
                endMs: 1_000,
                speakerLabel: null,
                text: { segmentIndex: 0, charStart: 0, charEnd: 16 },
                provenance: null,
            },
        },
    ],
};

const mail = {
    id: "mail-1",
    filename: "Project update",
    duration: 0,
    filesize: 512,
    startTime: "2026-10-19T10:00:00.000Z",
    deviceSn: "mail",
    kind: "mail",
} satisfies Recording;

const detail = {
    unreadable: false,
    participants: [],
    segments: [
        {
            index: 0,
            role: "body",
            depth: 0,
            text: "Jan leads Orion.",
            participantRef: null,
            at: null,
        },
    ],
} as unknown as MailDetail;

function processing(
    kind: "audio" | "mail",
    frame: WorkflowWidgetFrame = "inline",
): ItemProcessingPresentation {
    const at = "2026-10-19T10:00:00.000Z";
    return processingFixture({
        itemId: kind === "mail" ? mail.id : "rec-1",
        kind,
        legacy: false,
        manualOnly: false,
        phases: {
            categorize: { state: "done", generation: 1, at },
            transcribe: { state: "done", generation: 1, at },
            learn: {
                state: "waiting",
                reason:
                    frame === "dialog"
                        ? "manual_review_pending"
                        : "review_pending",
                generation: 1,
                at,
            },
        },
        profile: null,
        placements: [],
        intents: [],
        outputs: { transcript: true, learn: false, summary: false },
        processAgain: false,
        processAgainReason: null,
        learnFindingsWaiting: 1,
        taskReviewWaiting: 0,
        jobs: { transcription: null, summary: null },
        failures: [],
    });
}

function Strip({ data }: { data: ItemProcessingPresentation }) {
    const learnId =
        data.kind === "mail"
            ? `mail-learn-${data.itemId}`
            : `recording-learn-review-${data.itemId}`;
    const summaryId = `${data.kind === "mail" ? "mail" : "recording"}-summary-${data.itemId}`;
    return (
        <ItemWorkflow
            itemId={data.itemId}
            kind={data.kind}
            initialData={data}
            folders={[]}
            folderAssignments={[]}
            onSelectFolder={vi.fn()}
            onAddToFolder={vi.fn()}
            onRemoveFromFolder={vi.fn()}
            onReviewLearn={() => openWidget(learnId)}
            onLearn={() => openWidget(learnId)}
            onSummary={() => openWidget(summaryId)}
            onReviewTasks={() =>
                openWidget(
                    `${data.kind === "mail" ? "mail" : "recording"}-task-review-${data.itemId}`,
                )
            }
        />
    );
}

function LearnDetail({
    kind,
    frame,
}: {
    kind: "audio" | "mail";
    frame: WorkflowWidgetFrame;
}) {
    const data = processing(kind, frame);
    const widgets = deriveWorkflowWidgets(data);
    return (
        <>
            <Strip data={data} />
            {kind === "mail" ? (
                <MailLearnCard
                    mail={mail}
                    detail={detail}
                    canChange
                    widget={widgets.learn}
                    widgetId={`mail-learn-${mail.id}`}
                />
            ) : (
                <LearnReview
                    recordingId={data.itemId}
                    source="riffado"
                    turns={[]}
                    frame={widgets.learn.frame}
                    widgetId={`recording-learn-review-${data.itemId}`}
                    showTrigger={false}
                    collapseReady
                />
            )}
        </>
    );
}

function expectUniqueId(id: string) {
    expect(
        [...document.querySelectorAll("[id]")].filter(
            (element) => element.id === id,
        ),
    ).toHaveLength(1);
}

beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal(
        "matchMedia",
        vi.fn(() => ({ matches: false })),
    );
    vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes("/review")) return Response.json(review);
            if (url.endsWith("/tasks")) {
                return Response.json({
                    canEdit: true,
                    reviewed: true,
                    tasks: [],
                    proposals: [],
                    updates: [],
                    matches: [],
                });
            }
            return Response.json({});
        }),
    );
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe.each(["audio", "mail"] as const)("%s Learn strip action", (kind) => {
    const id =
        kind === "mail" ? "mail-learn-mail-1" : "recording-learn-review-rec-1";

    it.each([
        "inline",
        "dialog",
    ] as const)("opens a collapsed %s review, brings it into view and focuses its heading", async (frame) => {
        render(<LearnDetail kind={kind} frame={frame} />);
        await screen.findByRole("button", { name: "Review" });
        expect(
            screen.queryByRole("checkbox", { name: "Jan — leads — Orion" }),
        ).toBeNull();
        expectUniqueId(id);
        const scroll = vi.mocked(HTMLElement.prototype.scrollIntoView);
        scroll.mockImplementation(function (this: HTMLElement) {
            expect(this).toBe(document.getElementById(id));
            expect(this.classList.contains("contents")).toBe(false);
            expect(
                screen.getByRole("checkbox", { name: "Jan — leads — Orion" }),
            ).toBeTruthy();
        });

        fireEvent.click(screen.getByRole("button", { name: "Review Learn" }));

        const heading = screen.getByRole("heading", {
            name: /Review what Learn found/,
        });
        expect(
            screen.getByRole("checkbox", { name: "Jan — leads — Orion" }),
        ).toBeTruthy();
        expect(document.activeElement).toBe(heading);
        if (frame === "dialog") {
            expect(scroll).not.toHaveBeenCalled();
            expect(
                document.getElementById(id)?.classList.contains("contents"),
            ).toBe(true);
        } else {
            expect(scroll).toHaveBeenLastCalledWith({
                behavior: "smooth",
                block: "start",
            });
        }
        expectUniqueId(id);
        expect(Boolean(screen.queryByRole("dialog"))).toBe(frame === "dialog");
    });

    it("scrolls and refocuses an already expanded inline review without toggling it closed", async () => {
        render(<LearnDetail kind={kind} frame="inline" />);
        fireEvent.click(await screen.findByRole("button", { name: "Review" }));
        await screen.findByRole("checkbox", { name: "Jan — leads — Orion" });
        const heading = screen.getByRole("heading", {
            name: /Review what Learn found/,
        });
        const action = screen.getByRole("button", { name: "Review Learn" });
        action.focus();
        vi.mocked(HTMLElement.prototype.scrollIntoView).mockClear();

        fireEvent.click(action);

        expect(document.activeElement).toBe(heading);
        expect(
            screen.getByRole("checkbox", { name: "Jan — leads — Orion" }),
        ).toBeTruthy();
        expect(
            HTMLElement.prototype.scrollIntoView,
        ).toHaveBeenCalledExactlyOnceWith({
            behavior: "smooth",
            block: "start",
        });
        expectUniqueId(id);
    });
});

it("honors reduced motion when opening a collapsed review", async () => {
    vi.stubGlobal(
        "matchMedia",
        vi.fn(() => ({ matches: true })),
    );
    render(<LearnDetail kind="mail" frame="inline" />);
    await screen.findByRole("button", { name: "Review" });

    fireEvent.click(screen.getByRole("button", { name: "Review Learn" }));

    expect(window.matchMedia).toHaveBeenCalledWith(
        "(prefers-reduced-motion: reduce)",
    );
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({
        behavior: "auto",
        block: "start",
    });
});

describe.each(["audio", "mail"] as const)("%s summary strip action", (kind) => {
    it.each([
        "line",
        "body",
        "expanded",
    ] as const)("reveals a summary from its %s state through the retry strip action", async (mode) => {
        const base = processing(kind);
        const workflowVisible = mode !== "body";
        const data: ItemProcessingPresentation = processingFixture({
            ...base,
            phases: {
                ...base.phases,
                learn: {
                    state: "done",
                    generation: 1,
                    at: "2026-10-19T10:00:00.000Z",
                },
                summary: {
                    state: "failed",
                    reason: "PROVIDER_FAILED",
                    generation: 1,
                    at: "2026-10-19T10:00:00.000Z",
                },
            },
            outputs: { transcript: true, learn: true, summary: true },
            learnFindingsWaiting: 0,
            failures: [
                {
                    phase: "summary",
                    reasonCode: "PROVIDER_FAILED",
                    retryAvailable: true,
                },
            ],
        });
        render(
            <>
                <Strip data={data} />
                <SummaryWidget
                    itemId={data.itemId}
                    kind={kind}
                    canChange
                    contentText="Project notes"
                    workflowVisible={workflowVisible}
                    widget={{
                        visible: true,
                        active: false,
                        collapsed: mode === "line",
                        frame: "inline",
                        tone: "quiet",
                        action: null,
                    }}
                    widgetId={`${kind === "mail" ? "mail" : "recording"}-summary-${data.itemId}`}
                    taskWidgetId={`${kind === "mail" ? "mail" : "recording"}-task-review-${data.itemId}`}
                    taskWidget={{
                        visible: false,
                        active: false,
                        collapsed: false,
                        frame: "inline",
                        tone: "quiet",
                        action: null,
                    }}
                />
            </>,
        );
        if (mode !== "expanded") {
            expect(
                screen.queryByRole("region", { name: "Summary content" }),
            ).toBeNull();
        }

        fireEvent.click(screen.getByRole("button", { name: "Try again" }));

        expect(
            screen.getByRole("region", { name: "Summary content" }).textContent,
        ).toContain("The project is ready for review.");
        await waitFor(() =>
            expect(document.activeElement).toBe(
                screen.getByRole("heading", { name: "Summary" }),
            ),
        );
        expectUniqueId(
            `${kind === "mail" ? "mail" : "recording"}-summary-${data.itemId}`,
        );
    });
});

describe.each([
    "audio",
    "mail",
] as const)("%s task-review strip action", (kind) => {
    it.each([
        "inline",
        "dialog",
    ] as const)("opens the %s review and focuses its heading", async (frame) => {
        const base = processing(kind);
        const data: ItemProcessingPresentation = processingFixture({
            ...base,
            phases: {
                ...base.phases,
                learn: {
                    state: "done",
                    generation: 1,
                    at: "2026-10-19T10:00:00.000Z",
                },
                summary: {
                    state: "done",
                    generation: 1,
                    at: "2026-10-19T10:00:00.000Z",
                },
                taskReview: {
                    state: "waiting",
                    generation: 1,
                    at: "2026-10-19T10:00:00.000Z",
                },
            },
            outputs: { transcript: true, learn: true, summary: true },
            learnFindingsWaiting: 0,
            taskReviewWaiting: 1,
        });
        const state: RecordingTasksState = {
            itemId: data.itemId,
            data: {
                canEdit: true,
                reviewed: false,
                tasks: [],
                proposals: [],
                updates: [],
                matches: [],
            },
            failed: false,
            reviewing: true,
            waiting: 1,
            accepting: false,
            update: vi.fn(),
            add: vi.fn(async () => null),
            merge: vi.fn(async () => true),
            mergeInto: vi.fn(async () => true),
            undoMatch: vi.fn(async () => {}),
            tickUpdate: vi.fn(),
            tickMatch: vi.fn(),
            accept: vi.fn(async () => true),
        };
        const id = `${kind === "mail" ? "mail" : "recording"}-task-review-${data.itemId}`;
        render(
            <>
                <Strip data={data} />
                <TaskReviewLink
                    state={state}
                    speakers={[]}
                    organizationOnly={false}
                    frame={frame}
                    widgetId={id}
                    showTrigger={false}
                />
            </>,
        );
        expectUniqueId(id);

        fireEvent.click(screen.getByRole("button", { name: "Review tasks" }));

        expect(
            screen.getByRole("button", { name: "Apply selected changes" }),
        ).toBeTruthy();
        expect(document.activeElement).toBe(
            screen.getByRole("heading", { name: /Task review/ }),
        );
        expectUniqueId(id);
        expect(Boolean(screen.queryByRole("dialog"))).toBe(frame === "dialog");
    });
});

it.each([
    "audio",
    "mail",
] as const)("focuses the %s filing control after its options finish loading", async (kind) => {
    const base = processing(kind);
    const data: ItemProcessingPresentation = processingFixture({
        ...base,
        phases: {
            categorize: {
                state: "waiting",
                reason: "needs_profile",
                generation: 1,
                at: "2026-10-19T10:00:00.000Z",
            },
        },
        learnFindingsWaiting: 0,
    });
    let resolveOptions: (response: Response) => void = () => {};
    vi.stubGlobal(
        "fetch",
        vi.fn(
            () =>
                new Promise<Response>((resolve) => {
                    resolveOptions = resolve;
                }),
        ),
    );
    vi.stubGlobal(
        "matchMedia",
        vi.fn(() => ({ matches: true })),
    );
    render(<Strip data={data} />);

    fireEvent.click(screen.getByRole("button", { name: "Choose profile" }));
    expect(screen.getByText("Loading filing choices…")).toBeTruthy();
    const panel: CategorizationPanelPresentation = {
        itemId: data.itemId,
        folders: [],
        selectedFolderIds: [],
        profiles: [],
        resolution: { status: "choose", candidates: [] },
        currentProfile: null,
        currentManualOnly: false,
        canCreateOrganizationFolders: false,
    };
    resolveOptions(Response.json(panel));

    const profile = await screen.findByRole("combobox", { name: "Profile" });
    await waitFor(() => expect(document.activeElement).toBe(profile));
    await waitFor(() =>
        expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({
            behavior: "auto",
            block: "start",
        }),
    );
});
