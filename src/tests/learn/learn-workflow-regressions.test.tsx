// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LearnReview } from "@/components/learn/learn-review";
import { MailLearnCard } from "@/components/mail/mail-learn-card";
import { WorkflowStrip } from "@/components/pipeline/workflow-indicator";
import { useItemProcessing } from "@/hooks/use-item-processing";
import type { MailDetail } from "@/lib/mail/detail";
import { onItemProcessingInvalidated } from "@/lib/pipeline/item-processing-events";
import type { ItemProcessingPresentation } from "@/lib/pipeline/presentation";
import type {
    WorkflowWidgetFrame,
    WorkflowWidgetState,
} from "@/lib/pipeline/workflow-widgets";
import type { TranscriptTurn } from "@/lib/transcription/turns";
import { processingFixture } from "@/tests/pipeline/processing-fixture";
import type { Recording } from "@/types/recording";

vi.mock("next-intl", () => ({
    useExtracted: () => (value: string | { message: string }) =>
        typeof value === "string" ? value : value.message,
    useLocale: () => "en",
}));

vi.mock("sonner", () => ({
    toast: {
        error: vi.fn(),
        info: vi.fn(),
        success: vi.fn(),
        warning: vi.fn(),
    },
}));

const TURNS: TranscriptTurn[] = [
    { speaker: "speaker_0", startMs: 0, endMs: 1_000, text: "Hello" },
];

const IDLE_REVIEW = {
    run: null,
    items: [],
    names: {},
    types: {},
    relations: {},
    available: true,
};

const FAILED_REVIEW = {
    ...IDLE_REVIEW,
    run: { id: "run-1", status: "failed", errorCode: "PROVIDER_FAILED" },
};

const READY_REVIEW = {
    ...IDLE_REVIEW,
    run: { id: "run-1", status: "ready" },
};

const FINISHED_REVIEW = {
    ...IDLE_REVIEW,
    run: { id: "run-1", status: "finished" },
};

const WORKING_REVIEW = {
    ...IDLE_REVIEW,
    run: { id: "run-1", status: "running" },
};

interface LineReview {
    run: {
        id: string;
        status: string;
        errorCode?: string;
    } | null;
    items: unknown[];
    names: Record<string, string>;
    types: Record<string, string>;
    relations: Record<string, string>;
    available: boolean;
}

const REVIEW_PROCESSING: ItemProcessingPresentation = processingFixture({
    itemId: "recording-finish",
    kind: "audio",
    legacy: false,
    manualOnly: false,
    phases: {
        categorize: {
            state: "done",
            reason: "categorized",
            generation: 1,
            at: "2026-10-16T08:00:00.000Z",
        },
        transcribe: {
            state: "done",
            generation: 1,
            at: "2026-10-16T08:01:00.000Z",
        },
        learn: {
            state: "waiting",
            reason: "review_pending",
            generation: 1,
            at: "2026-10-16T08:02:00.000Z",
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

function FinishReviewWorkflow() {
    const { workflow } = useItemProcessing({
        itemId: "recording-finish",
        kind: "audio",
        initialData: REVIEW_PROCESSING,
    });
    return (
        <>
            {workflow && <WorkflowStrip workflow={workflow} />}
            <LearnReview
                recordingId="recording-finish"
                source="riffado"
                turns={TURNS}
                frame="inline"
                showTrigger={false}
            />
        </>
    );
}

const mail = {
    id: "mail-1",
    filename: "Project update",
    duration: 0,
    filesize: 512,
    startTime: "2026-10-16T10:00:00.000Z",
    deviceSn: "mail",
    kind: "mail",
} satisfies Recording;

const detail = {
    unreadable: false,
    participants: [],
    segments: [],
} as unknown as MailDetail;

function widget(frame: WorkflowWidgetFrame): WorkflowWidgetState {
    return {
        visible: true,
        active: true,
        collapsed: false,
        frame,
        tone: "quiet",
        action: null,
    };
}

function renderRecording(frame: WorkflowWidgetFrame, review: LineReview): void {
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(review)),
    );
    render(
        <LearnReview
            recordingId="recording-1"
            source="riffado"
            turns={TURNS}
            frame={frame}
            showTrigger={false}
        />,
    );
}

function renderMail(frame: WorkflowWidgetFrame, review: LineReview): void {
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(review)),
    );
    render(
        <MailLearnCard
            mail={mail}
            detail={detail}
            canChange
            widget={widget(frame)}
            widgetId={`mail-learn-${frame}`}
        />,
    );
}

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

it.each([
    "queued",
    "running",
])("forgets an observed %s Learn run when switching recordings", async (status) => {
    const invalidated = vi.fn();
    const stop = onItemProcessingInvalidated("recording-next", invalidated);
    vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) =>
            Response.json(
                String(input).includes("/recording-first/")
                    ? { ...WORKING_REVIEW, run: { id: "run-first", status } }
                    : IDLE_REVIEW,
            ),
        ),
    );
    try {
        const { rerender } = render(
            <LearnReview
                recordingId="recording-first"
                source="riffado"
                turns={TURNS}
            />,
        );
        await screen.findByRole("button", { name: "Learning…" });

        rerender(
            <LearnReview
                recordingId="recording-next"
                source="riffado"
                turns={TURNS}
            />,
        );

        await screen.findByRole("button", { name: "Learn" });
        expect(invalidated).not.toHaveBeenCalled();
    } finally {
        stop();
    }
});

it("invalidates processing when the observed Learn run settles on the same recording", async () => {
    vi.useFakeTimers();
    const invalidated = vi.fn();
    const stop = onItemProcessingInvalidated("recording-first", invalidated);
    const fetchMock = vi.fn().mockResolvedValue(Response.json(WORKING_REVIEW));
    vi.stubGlobal("fetch", fetchMock);
    try {
        render(
            <LearnReview
                recordingId="recording-first"
                source="riffado"
                turns={TURNS}
            />,
        );
        await act(async () => {});
        expect(screen.getByRole("button", { name: "Learning…" })).toBeTruthy();
        expect(invalidated).not.toHaveBeenCalled();

        fetchMock.mockImplementation(async () => Response.json(READY_REVIEW));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(3_000);
        });

        expect(
            screen.getByRole("button", { name: "Review ({count})" }),
        ).toBeTruthy();
        expect(invalidated).toHaveBeenCalledOnce();
    } finally {
        stop();
        vi.useRealTimers();
    }
});

describe.each(["audio", "mail"] as const)("%s Learn workflow line", (kind) => {
    const renderCase = kind === "audio" ? renderRecording : renderMail;
    const startPath =
        kind === "audio"
            ? "/api/recordings/recording-1/learn?source=riffado"
            : "/api/recordings/mail-1/learn";
    it("uses the expand affordance for finished results", async () => {
        renderCase("dialog", FINISHED_REVIEW);

        const expand = await screen.findByRole("button", {
            name: "View results",
        });
        const line = expand.closest("[data-workflow-widget-line]");
        expect(expand.getAttribute("aria-expanded")).toBe("false");
        expect(expand.querySelector(".lucide-chevron-down")).toBeTruthy();
        expect(
            line?.querySelectorAll("button:not([aria-expanded])"),
        ).toHaveLength(0);
    });

    it("keeps failed results expandable with Try again as the primary action", async () => {
        renderCase("dialog", FAILED_REVIEW);

        const expand = await screen.findByRole("button", {
            name: "View results",
        });
        const retry = screen.getByRole("button", { name: "Try again" });
        const line = expand.closest("[data-workflow-widget-line]");
        expect(expand.getAttribute("aria-expanded")).toBe("false");
        expect(
            Array.from(
                line?.querySelectorAll("button:not([aria-expanded])") ?? [],
            ),
        ).toEqual([retry]);
    });

    it("starts Learn when Try again is clicked", async () => {
        renderCase("dialog", FAILED_REVIEW);
        const fetchMock = vi.mocked(fetch);

        fireEvent.click(
            await screen.findByRole("button", { name: "Try again" }),
        );

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(startPath, {
                method: "POST",
            }),
        );
    });

    it.each([
        { name: "ready to start", review: IDLE_REVIEW, action: "Learn" },
        { name: "waiting for review", review: READY_REVIEW, action: "Review" },
    ])("shows the $action primary action when $name", async ({
        review,
        action,
    }) => {
        renderCase("dialog", review);

        const button = await screen.findByRole("button", { name: action });
        const line = button.closest("[data-workflow-widget-line]");
        expect(button.hasAttribute("aria-expanded")).toBe(false);
        expect(
            Array.from(
                line?.querySelectorAll("button:not([aria-expanded])") ?? [],
            ),
        ).toEqual([button]);
    });

    it("shows no action while working", async () => {
        renderCase("dialog", WORKING_REVIEW);

        await waitFor(() =>
            expect(
                document.querySelector("[data-workflow-widget-line]"),
            ).toBeTruthy(),
        );
        const line = document.querySelector("[data-workflow-widget-line]");
        expect(line?.querySelectorAll("button")).toHaveLength(0);
    });
});

describe.each(["audio", "mail"] as const)("%s Learn failure line", (kind) => {
    const renderCase = kind === "audio" ? renderRecording : renderMail;
    it("offers retry and keeps results reachable", async () => {
        renderCase("inline", FAILED_REVIEW);

        const retry = await screen.findByRole("button", {
            name: "Try again",
        });
        const expand = screen.getByRole("button", { name: "View results" });
        expect(retry.hasAttribute("aria-expanded")).toBe(false);
        expect(expand.getAttribute("aria-expanded")).toBe("false");
    });
});

describe.each([
    "inline",
    "dialog",
] as const)("recording Learn local run in the %s frame", (frame) => {
    it("shows a working line while its POST is pending", async () => {
        const fetchMock = vi.fn(
            (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                if (url.endsWith("/calendar-events")) {
                    return Promise.resolve(Response.json({ events: [] }));
                }
                if (init?.method === "POST") {
                    return new Promise<Response>(() => {});
                }
                return Promise.resolve(Response.json(IDLE_REVIEW));
            },
        );
        vi.stubGlobal("fetch", fetchMock);
        render(
            <LearnReview
                recordingId="recording-running"
                source="riffado"
                turns={TURNS}
                frame={frame}
                showTrigger={false}
            />,
        );
        fireEvent.click(await screen.findByRole("button", { name: "Learn" }));

        expect(
            await screen.findAllByText(/Learn is reading the transcript/),
        ).not.toHaveLength(0);
        await waitFor(() =>
            expect(
                document.querySelector(
                    '[data-workflow-widget][data-tone="working"]',
                ),
            ).toBeTruthy(),
        );
        expect(screen.queryByRole("button", { name: "Learn" })).toBeNull();
    });
});

it("invalidates item processing after finishing a Learn review", async () => {
    let reviewReads = 0;
    const fetchMock = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (init?.method === "POST" && url.includes("/review/finish")) {
                return Response.json({
                    status: "finished",
                    applied: 0,
                    skipped: [],
                });
            }
            if (url.includes("/review")) {
                reviewReads += 1;
                return Response.json(
                    reviewReads === 1
                        ? READY_REVIEW
                        : {
                              ...READY_REVIEW,
                              run: { id: "run-1", status: "finished" },
                          },
                );
            }
            return new Response("{}", { status: 404 });
        },
    );
    vi.stubGlobal("fetch", fetchMock);
    const invalidated = vi.fn();
    const stop = onItemProcessingInvalidated("recording-finish", invalidated);
    render(
        <LearnReview
            recordingId="recording-finish"
            source="riffado"
            turns={TURNS}
            frame="inline"
            showTrigger={false}
        />,
    );
    fireEvent.click(
        await screen.findByRole("button", { name: "Finish review" }),
    );

    await waitFor(() => expect(invalidated).toHaveBeenCalledOnce());
    stop();
});

it("moves the workflow strip off Review Learn after finishing without a reload", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    try {
        let processingReads = 0;
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                if (url.includes("?processing=1")) {
                    processingReads += 1;
                    const processing: ItemProcessingPresentation =
                        processingReads === 1
                            ? REVIEW_PROCESSING
                            : {
                                  ...REVIEW_PROCESSING,
                                  phases: {
                                      ...REVIEW_PROCESSING.phases,
                                      learn: {
                                          state: "running",
                                          reason: "started",
                                          generation: 2,
                                          at: "2026-10-16T08:03:00.000Z",
                                      },
                                  },
                                  learnFindingsWaiting: 0,
                              };
                    return Response.json({
                        processing: {
                            ...processingFixture(processing),
                            nextCheckAt: new Date(
                                Date.now() + 2_000,
                            ).toISOString(),
                        },
                    });
                }
                if (init?.method === "POST" && url.includes("/review/finish")) {
                    return Response.json({
                        status: "finished",
                        applied: 0,
                        skipped: [],
                    });
                }
                if (url.includes("/review")) return Response.json(READY_REVIEW);
                if (url.endsWith("/calendar-events")) {
                    return Response.json({ events: [] });
                }
                return new Response("{}", { status: 404 });
            }),
        );
        render(<FinishReviewWorkflow />);
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(
            screen.getByRole("button", { name: "Review Learn" }),
        ).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Finish review" }));

        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
            vi.advanceTimersByTime(2_000);
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(
            screen.queryByRole("button", { name: "Review Learn" }),
        ).toBeNull();
        expect(
            screen.getByText(
                "Learn is reading the transcript with your Almanac.",
            ),
        ).toBeTruthy();
    } finally {
        vi.useRealTimers();
    }
});
