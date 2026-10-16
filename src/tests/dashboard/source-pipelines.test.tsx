// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { summaryOptions, transcriptSources, speakerTagMounts } = vi.hoisted(
    () => ({
        summaryOptions: [] as Array<{ summarySource?: string }>,
        transcriptSources: [] as string[],
        speakerTagMounts: [] as string[],
    }),
);

vi.mock("@/hooks/use-transcription-summary", () => ({
    useTranscriptionSummary: (options: { summarySource?: string }) => {
        summaryOptions.push(options);
        return {
            summaryData: null,
            isSummarizing: false,
            summaryProgress: null,
            summaryElapsedMs: 0,
            summaryExpanded: true,
            setSummaryExpanded: vi.fn(),
            summaryPreset: "general",
            setSummaryPreset: vi.fn(),
            summaryPromptOptions: [{ id: "general", name: "General" }],
            handleSummarize: vi.fn(),
            handleDeleteSummary: vi.fn(),
        };
    },
}));

vi.mock("@/components/dashboard/transcript-view", () => ({
    TranscriptView: ({ source }: { source: string }) => {
        transcriptSources.push(source);
        return <div data-testid="transcript-source">{source}</div>;
    },
}));

vi.mock("@/components/people/speaker-tags", async () => {
    const { useEffect } = await import("react");
    return {
        SpeakerTags: ({ source }: { source: string }) => {
            useEffect(() => {
                speakerTagMounts.push(source);
            }, [source]);
            return null;
        },
        confirmedAttributions: () => ({}),
    };
});

vi.mock("@/components/dashboard/transcribe-in-browser-button", () => ({
    TranscribeInBrowserButton: () => null,
}));

vi.mock("@/components/dashboard/markdown-actions", () => ({
    MarkdownActions: () => null,
}));

import { TranscriptionPanel } from "@/components/dashboard/transcription-panel";
import { openWidget } from "@/components/pipeline/workflow-widget";
import type { ItemProcessingPresentation } from "@/lib/pipeline/presentation";

function completedProcessing(): ItemProcessingPresentation {
    const at = "2026-10-16T10:00:00.000Z";
    return {
        itemId: "rec-focus",
        kind: "audio",
        legacy: false,
        manualOnly: false,
        phases: {
            categorize: { state: "done", generation: 1, at },
            transcribe: { state: "done", generation: 1, at },
            learn: { state: "done", generation: 1, at },
            summary: { state: "done", generation: 1, at },
            share: { state: "waiting", generation: 1, at },
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
            },
        },
        placements: [],
        intents: [
            {
                folderId: "folder-1",
                name: "Team",
                path: "Organization › Team",
                confirmationRequired: true,
                confirmed: false,
            },
        ],
        outputs: { transcript: true, learn: true, summary: true },
        processAgain: false,
        processAgainReason: null,
        learnFindingsWaiting: 0,
        taskReviewWaiting: 0,
        jobs: { transcription: null, summary: null },
        failures: [],
    };
}

describe("independent transcript and summary pipelines", () => {
    beforeEach(() => {
        summaryOptions.length = 0;
        transcriptSources.length = 0;
        speakerTagMounts.length = 0;
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                new Response(JSON.stringify({ speakers: [] }), {
                    headers: { "Content-Type": "application/json" },
                }),
            ),
        );
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    describe.each([
        ["transcript", "recording-transcription-rec-focus", "Transcription"],
        ["summary", "recording-summary-rec-focus", "Summary"],
    ] as const)("%s workflow widget", (_name, widgetId, headingName) => {
        it("focuses its heading when opened", async () => {
            HTMLElement.prototype.scrollIntoView = vi.fn();
            vi.stubGlobal(
                "requestAnimationFrame",
                (callback: FrameRequestCallback) =>
                    window.setTimeout(() => callback(0), 0),
            );
            render(
                <TranscriptionPanel
                    recording={{
                        id: "rec-focus",
                        filename: "Meeting.ogg",
                        duration: 60_000,
                        filesize: 1024,
                        startTime: new Date(0).toISOString(),
                        deviceSn: "local",
                    }}
                    transcripts={[
                        {
                            source: "riffado",
                            text: "Custom text",
                            provider: "openai",
                            model: "whisper-1",
                        },
                    ]}
                    isTranscribing={false}
                    onTranscribe={vi.fn()}
                    processing={completedProcessing()}
                />,
            );

            openWidget(widgetId);

            await waitFor(() =>
                expect(screen.getByRole("heading", { name: headingName })).toBe(
                    document.activeElement,
                ),
            );
        });
    });

    it("switches the summary without changing the visible transcript", () => {
        render(
            <TranscriptionPanel
                recording={{
                    id: "rec-1",
                    filename: "Meeting.ogg",
                    duration: 60_000,
                    filesize: 1024,
                    startTime: new Date(0).toISOString(),
                    deviceSn: "SN-1",
                }}
                transcripts={[
                    {
                        source: "plaud",
                        text: "Plaud text",
                        provider: "plaud",
                        model: "plaud-native",
                    },
                    {
                        source: "riffado",
                        text: "Custom text",
                        provider: "openai",
                        model: "whisper-1",
                    },
                ]}
                isTranscribing={false}
                onTranscribe={vi.fn()}
            />,
        );

        expect(screen.getByTestId("transcript-source").textContent).toBe(
            "plaud",
        );
        expect(summaryOptions.at(-1)?.summarySource).toBe("plaud");

        const transcriptSource = screen.getByRole("group", {
            name: "Transcript source",
        });
        const summarySource = screen.getByRole("group", {
            name: "Summary source",
        });
        expect(transcriptSource.className).toBe(summarySource.className);
        expect(
            transcriptSource.querySelector<HTMLButtonElement>(
                'button[aria-pressed="true"]',
            )?.className,
        ).toBe(
            summarySource.querySelector<HTMLButtonElement>(
                'button[aria-pressed="true"]',
            )?.className,
        );

        const customButtons = screen.getAllByRole("button", {
            name: "Custom",
        });
        fireEvent.click(customButtons[1]);

        expect(screen.getByTestId("transcript-source").textContent).toBe(
            "plaud",
        );
        expect(summaryOptions.at(-1)?.summarySource).toBe("riffado");

        fireEvent.click(screen.getAllByRole("button", { name: "Custom" })[0]);
        expect(screen.getByTestId("transcript-source").textContent).toBe(
            "riffado",
        );
        expect(summaryOptions.at(-1)?.summarySource).toBe("riffado");
    });

    it("mounts the speaker tags afresh for a new text, not for a refetch", () => {
        const recording = {
            id: "rec-1",
            filename: "Meeting.ogg",
            duration: 60_000,
            filesize: 1024,
            startTime: new Date(0).toISOString(),
            deviceSn: "SN-1",
        };
        const transcript = (text: string) => [
            {
                source: "riffado",
                text,
                provider: "openai",
                model: "gpt-4o-transcribe-diarize",
            },
        ];
        const panel = (text: string) => (
            <TranscriptionPanel
                recording={recording}
                transcripts={transcript(text)}
                isTranscribing={false}
                onTranscribe={vi.fn()}
            />
        );
        const { rerender } = render(panel("speaker_0: Hi\nspeaker_1: Hello"));
        expect(speakerTagMounts).toEqual(["riffado"]);

        // The same transcript, fetched again.
        rerender(panel("speaker_0: Hi\nspeaker_1: Hello"));
        expect(speakerTagMounts).toEqual(["riffado"]);

        // Re-transcribed: the voices are numbered the other way round.
        rerender(panel("speaker_1: Hi\nspeaker_0: Hello"));
        expect(speakerTagMounts).toEqual(["riffado", "riffado"]);
    });

    it("hides the summary source switch for an uploaded recording", () => {
        render(
            <TranscriptionPanel
                recording={{
                    id: "rec-uploaded",
                    filename: "Uploaded.ogg",
                    duration: 60_000,
                    filesize: 1024,
                    startTime: new Date(0).toISOString(),
                    deviceSn: "local",
                }}
                transcripts={[
                    {
                        source: "riffado",
                        text: "Custom text",
                        provider: "openai",
                        model: "whisper-1",
                    },
                ]}
                isTranscribing={false}
                onTranscribe={vi.fn()}
            />,
        );

        expect(
            screen.queryByRole("group", { name: "Summary source" }),
        ).toBeNull();
        expect(summaryOptions.at(-1)?.summarySource).toBe("riffado");
    });

    it("keeps the summary source switch for Plaud recordings awaiting import", () => {
        render(
            <TranscriptionPanel
                recording={{
                    id: "rec-plaud",
                    filename: "Meeting.ogg",
                    duration: 60_000,
                    filesize: 1024,
                    startTime: new Date(0).toISOString(),
                    deviceSn: "SN-1",
                }}
                transcripts={[
                    {
                        source: "riffado",
                        text: "Custom text",
                        provider: "openai",
                        model: "whisper-1",
                    },
                ]}
                isTranscribing={false}
                onTranscribe={vi.fn()}
            />,
        );

        expect(
            screen.getByRole("group", { name: "Summary source" }),
        ).toBeTruthy();
    });
    it("offers no transcription or summary of a recording the viewer may not change", () => {
        const recording = {
            id: "rec-1",
            filename: "Meeting.ogg",
            duration: 60_000,
            filesize: 1024,
            startTime: new Date(0).toISOString(),
            deviceSn: "SN-1",
        };
        const transcripts = [
            {
                source: "riffado",
                text: "Custom text",
                provider: "openai",
                model: "whisper-1",
            },
        ];
        const { rerender } = render(
            <TranscriptionPanel
                recording={recording}
                transcripts={transcripts}
                isTranscribing={false}
                onTranscribe={vi.fn()}
            />,
        );
        expect(screen.getByRole("button", { name: /Summarize/ })).toBeTruthy();
        expect(
            screen.getByRole("button", { name: /Re-transcribe/ }),
        ).toBeTruthy();

        // Shared: the organization account's to change.
        rerender(
            <TranscriptionPanel
                recording={recording}
                transcripts={transcripts}
                isTranscribing={false}
                onTranscribe={vi.fn()}
                readOnly
            />,
        );
        expect(screen.queryByRole("button", { name: /Summarize/ })).toBeNull();
        expect(
            screen.queryByRole("button", { name: /Re-transcribe/ }),
        ).toBeNull();
    });
});
