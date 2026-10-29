// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    TranscriptionPanel,
    type TranscriptOption,
} from "@/components/dashboard/transcription-panel";
import { openWidget } from "@/components/pipeline/workflow-widget";
import type { ItemProcessingPresentation } from "@/lib/pipeline/presentation";
import { canChangeItem } from "@/lib/sharing/change-permission";
import { processingFixture } from "@/tests/pipeline/processing-fixture";
import type { Recording } from "@/types/recording";

const mocks = vi.hoisted(() => ({
    summaryData: null as {
        summary: string;
        keyPoints: string[];
        actionItems: string[];
        provider: string;
        model: string;
        multiPass: null;
        stale: boolean;
        scopeChanged: boolean;
    } | null,
    isSummarizing: false,
    handleSummarize: vi.fn(),
}));

vi.mock("@/hooks/use-transcription-summary", () => ({
    useTranscriptionSummary: () => ({
        summaryData: mocks.summaryData,
        isSummarizing: mocks.isSummarizing,
        summaryProgress: null,
        summaryElapsedMs: 0,
        summaryExpanded: true,
        setSummaryExpanded: vi.fn(),
        summaryProfileId: "profile-1",
        setSummaryProfileId: vi.fn(),
        summaryProfileOptions: [{ id: "profile-1", name: "Meeting notes" }],
        summaryProfilesLoading: false,
        handleSummarize: mocks.handleSummarize,
        recheckSummary: vi.fn(),
    }),
}));
vi.mock("@/components/dashboard/transcribe-in-browser-button", () => ({
    TranscribeInBrowserButton: () => (
        <button type="button">Transcribe in browser</button>
    ),
}));
vi.mock("@/components/dashboard/markdown-actions", () => ({
    MarkdownActions: () => null,
}));

const recording: Recording = {
    id: "rec-1",
    filename: "Meeting.ogg",
    duration: 60_000,
    filesize: 1024,
    startTime: new Date(0).toISOString(),
    deviceSn: "local",
};

const personTranscribing: ItemProcessingPresentation = processingFixture({
    itemId: "rec-1",
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
    jobs: { transcription: "running", summary: null },
    startedBy: { transcription: "person", summary: null, topics: null },
    failures: [],
});

const idleProcessing: ItemProcessingPresentation = processingFixture({
    ...personTranscribing,
    jobs: { transcription: null, summary: null },
});

const completedProcessing: ItemProcessingPresentation = processingFixture({
    ...personTranscribing,
    phases: {
        categorize: personTranscribing.phases.categorize,
        transcribe: {
            state: "done",
            generation: 1,
            at: "2026-10-16T00:01:00.000Z",
        },
    },
    outputs: { transcript: true, learn: false, summary: false },
    jobs: { transcription: null, summary: null },
});

const workflowProcessing: ItemProcessingPresentation = processingFixture({
    ...completedProcessing,
    phases: {
        ...completedProcessing.phases,
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
        share: {
            state: "waiting",
            reason: "confirmation_required",
            generation: 1,
            at: "2026-10-16T00:04:00.000Z",
        },
    },
    outputs: { transcript: true, learn: true, summary: true },
    intents: [
        {
            folderId: "folder-1",
            name: "Team",
            path: "Organization › Team",
            confirmationRequired: true,
            confirmed: false,
        },
    ],
});

function panel(
    isTranscribing: boolean,
    processing: ItemProcessingPresentation | null = personTranscribing,
    options: {
        transcripts?: TranscriptOption[];
        onTranscribe?: (
            attributionSource?: string,
            retranscribe?: boolean,
        ) => void;
        onTranscriptStale?: () => void;
    } = {},
) {
    return (
        <TranscriptionPanel
            recording={recording}
            transcripts={
                options.transcripts ?? [{ source: "riffado", text: "Hello." }]
            }
            isTranscribing={isTranscribing}
            onTranscribe={options.onTranscribe ?? vi.fn()}
            onTranscriptStale={options.onTranscriptStale}
            processing={processing}
        />
    );
}

function firstHeaderButton(heading: "Transcription" | "Summary") {
    const header = screen
        .getByRole("heading", { name: heading })
        .closest('[data-slot="card-header"], header');
    if (!(header instanceof HTMLElement)) {
        throw new Error(`Missing ${heading} header`);
    }
    return within(header).getAllByRole("button")[0];
}

describe("transcription dialog", () => {
    beforeEach(() => {
        mocks.summaryData = null;
        mocks.isSummarizing = false;
        mocks.handleSummarize.mockReset();
        vi.stubGlobal(
            "fetch",
            vi.fn(
                async () =>
                    new Response(JSON.stringify({}), {
                        status: 200,
                    }),
            ),
        );
    });

    afterEach(async () => {
        cleanup();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        vi.unstubAllGlobals();
    });

    it("stays closed when the panel mounts on a running person-started transcription", async () => {
        render(panel(true));

        await waitFor(() =>
            expect(screen.getByText("Transcribing audio…")).toBeTruthy(),
        );
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("keeps a person-started transcription inline when it begins while mounted", async () => {
        const { rerender } = render(panel(false, idleProcessing));
        expect(screen.queryByRole("dialog")).toBeNull();

        rerender(panel(true, personTranscribing));

        expect(await screen.findByText("Transcribing audio…")).toBeTruthy();
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("starts a plain transcription without opening a dialog", async () => {
        const onTranscribe = vi.fn();
        const view = render(
            panel(false, null, { transcripts: [], onTranscribe }),
        );

        fireEvent.click(screen.getByRole("button", { name: "Transcribe" }));

        expect(onTranscribe).toHaveBeenCalledWith(undefined, false);
        expect(screen.queryByRole("dialog")).toBeNull();
        view.rerender(
            panel(false, personTranscribing, {
                transcripts: [],
                onTranscribe,
            }),
        );
        expect(await screen.findByText("Transcribing audio…")).toBeTruthy();
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    it.each([
        { view: "private", isOwn: true },
        { view: "org", isOwn: true },
        { view: "private", isOwn: false },
        { view: "org", isOwn: false },
    ] as const)("offers shared recording actions only to its owner (view=$view, isOwn=$isOwn)", ({
        view,
        isOwn,
    }) => {
        const { rerender } = render(
            <TranscriptionPanel
                recording={{ ...recording, view, isOwn }}
                shared
                readOnly={
                    !canChangeItem({
                        view,
                        isOwn,
                        isOrgAccount: false,
                        canCurate: false,
                    })
                }
                transcripts={[]}
                isTranscribing={false}
                onTranscribe={vi.fn()}
            />,
        );
        expect(
            Boolean(screen.queryByRole("button", { name: "Transcribe" })),
        ).toBe(isOwn);
        rerender(
            <TranscriptionPanel
                recording={{ ...recording, view, isOwn }}
                shared
                readOnly={
                    !canChangeItem({
                        view,
                        isOwn,
                        isOrgAccount: false,
                        canCurate: false,
                    })
                }
                transcripts={[{ source: "riffado", text: "Hello." }]}
                isTranscribing={false}
                onTranscribe={vi.fn()}
            />,
        );
        expect(
            Boolean(screen.queryByRole("button", { name: "Re-transcribe" })),
        ).toBe(isOwn);
        expect(
            Boolean(
                screen.queryAllByRole("button", { name: "Summarize" }).length,
            ),
        ).toBe(isOwn);
    });

    it("starts a summary without opening a dialog", async () => {
        const view = render(panel(false, null));

        fireEvent.click(
            screen.getAllByRole("button", { name: "Summarize" })[0],
        );

        expect(mocks.handleSummarize).toHaveBeenCalledOnce();
        expect(screen.queryByRole("dialog")).toBeNull();
        mocks.isSummarizing = true;
        view.rerender(panel(false, null));
        expect(await screen.findByText("Generating summary…")).toBeTruthy();
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    it.each([
        "finished",
        null,
    ])("opens a ready review on another source without starting Learn on the %s source", async (currentStatus) => {
        const fetchMock = vi.mocked(fetch).mockImplementation(async (input) => {
            if (String(input).includes("/review?"))
                return Response.json({
                    run:
                        String(input).includes("source=riffado") ||
                        currentStatus
                            ? {
                                  id: "run",
                                  status: String(input).includes(
                                      "source=riffado",
                                  )
                                      ? "ready"
                                      : currentStatus,
                              }
                            : null,
                    available: true,
                    names: {},
                    types: {},
                    relations: {},
                    items: [],
                });
            return Response.json({});
        });
        render(
            panel(false, null, {
                transcripts: ["plaud", "riffado"].map((source) => ({
                    source,
                    text: `Text from ${source}`,
                    turns: [
                        {
                            speaker: "speaker_0",
                            text: `Text from ${source}`,
                            startMs: 0,
                            endMs: 1000,
                        },
                    ],
                })),
            }),
        );
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/recordings/rec-1/review?source=plaud",
            ),
        );
        await act(async () => {});
        act(() => openWidget("recording-learn-review-rec-1", "riffado"));
        expect(
            await screen.findByRole("heading", {
                name: "Review what Learn found",
            }),
        ).toBeTruthy();
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/recordings/rec-1/review?source=riffado",
        );
        expect(screen.getByText("Text from riffado")).toBeTruthy();
        expect(
            fetchMock.mock.calls.filter(([, init]) => init?.method === "POST"),
        ).toEqual([]);
        expect(
            fetchMock.mock.calls.some(([input]) =>
                String(input).includes("/calendar-events"),
            ),
        ).toBe(false);
        fireEvent.click(
            screen.getByRole("button", { name: "Collapse review" }),
        );
        expect(
            screen.queryByRole("heading", { name: "Review what Learn found" }),
        ).toBeNull();
        act(() => openWidget("recording-learn-review-rec-1", "riffado"));
        expect(
            await screen.findByRole("heading", {
                name: "Review what Learn found",
            }),
        ).toBeTruthy();
    });

    it("uses the server transcription job as its running state", () => {
        render(panel(false, personTranscribing));

        expect(screen.getByText("Transcribing audio…")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Transcribe" })).toBeNull();
    });

    it("reloads transcripts when an unobserved server job finishes", async () => {
        const onTranscriptStale = vi.fn();
        const { rerender } = render(
            panel(false, personTranscribing, {
                transcripts: [],
                onTranscriptStale,
            }),
        );

        rerender(
            panel(false, completedProcessing, {
                transcripts: [],
                onTranscriptStale,
            }),
        );

        await waitFor(() => expect(onTranscriptStale).toHaveBeenCalledOnce());
    });

    it("offers no transcription action when the server reports an output", () => {
        render(
            panel(false, completedProcessing, {
                transcripts: [],
                onTranscriptStale: vi.fn(),
            }),
        );

        expect(screen.queryByRole("button", { name: "Transcribe" })).toBeNull();
        expect(
            screen.queryByRole("button", { name: "Transcribe in browser" }),
        ).toBeNull();
    });

    it("confirms re-transcription before sending the force flag", async () => {
        const onTranscribe = vi.fn();
        render(panel(false, null, { onTranscribe }));

        fireEvent.click(screen.getByRole("button", { name: "Re-transcribe" }));
        expect(
            screen.getByText(
                "This replaces the transcript, then regenerates the summary, title, and topics, and runs Learn again. It also makes a paid call to your transcription provider.",
            ),
        ).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(onTranscribe).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole("button", { name: "Re-transcribe" }));
        const reTranscribeButtons = await screen.findAllByRole("button", {
            name: "Re-transcribe",
        });
        fireEvent.click(reTranscribeButtons.at(-1) as HTMLButtonElement);
        expect(onTranscribe).toHaveBeenCalledWith("riffado", true);
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("uses the shared widget shell for the transcript header, body, and footer", () => {
        render(
            panel(false, null, {
                transcripts: [
                    {
                        source: "riffado",
                        text: "Hello world.",
                        language: "en",
                        provider: "openai",
                        model: "whisper-1",
                    },
                ],
            }),
        );

        const heading = screen.getByRole("heading", {
            name: "Transcription",
        });
        const widget = heading.closest("[data-workflow-widget]");
        expect(widget).toBeTruthy();
        expect(widget?.querySelector("[data-widget-body]")).toBeTruthy();
        const header = heading.closest("header");
        expect(header).toBeTruthy();
        expect(
            within(header as HTMLElement).getByRole("button", {
                name: "Re-transcribe",
            }),
        ).toBeTruthy();
        const collapse = within(header as HTMLElement).getByRole("button", {
            name: "Collapse transcript",
        });
        expect(collapse.getAttribute("aria-expanded")).toBe("true");

        const footer = widget?.querySelector("footer");
        expect(
            footer?.querySelector('[data-testid="transcript-provenance"]'),
        ).toBeTruthy();
        expect(footer?.textContent).not.toContain("Custom");
        expect(footer?.textContent).toContain("openai");
        expect(footer?.textContent).toContain("whisper-1");
        expect(footer?.textContent).toContain("English (detected)");
        expect(footer?.textContent).toContain("2 words");
        expect(footer?.textContent).toContain("12 characters");

        fireEvent.click(collapse);
        expect(
            screen
                .getByRole("button", { name: "Expand transcript" })
                .getAttribute("aria-expanded"),
        ).toBe("false");
        expect(widget?.querySelector("footer")).toBeTruthy();
    });

    it("keeps transcript and summary toggles before the title outside the workflow", () => {
        mocks.summaryData = {
            summary: "Summary text",
            keyPoints: [],
            actionItems: [],
            provider: "openai",
            model: "gpt-4o-mini",
            multiPass: null,
            stale: false,
            scopeChanged: false,
        };
        render(panel(false, null));

        expect(firstHeaderButton("Transcription")).toBe(
            screen.getByRole("button", { name: "Collapse transcript" }),
        );
        expect(firstHeaderButton("Summary")).toBe(
            screen.getByRole("button", { name: "Collapse summary" }),
        );
    });

    it("keeps transcript and summary toggles before the title after workflow expansion", () => {
        mocks.summaryData = {
            summary: "Summary text",
            keyPoints: [],
            actionItems: [],
            provider: "openai",
            model: "gpt-4o-mini",
            multiPass: null,
            stale: false,
            scopeChanged: false,
        };
        render(panel(false, workflowProcessing));

        fireEvent.click(
            screen.getByRole("button", { name: "View transcript" }),
        );
        expect(firstHeaderButton("Transcription")).toBe(
            screen.getByRole("button", { name: "Collapse transcript" }),
        );

        cleanup();
        render(panel(false, workflowProcessing));
        fireEvent.click(screen.getByRole("button", { name: "View summary" }));
        expect(firstHeaderButton("Summary")).toBe(
            screen.getByRole("button", { name: "Collapse summary" }),
        );
    });
});
