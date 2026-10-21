// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptionPanel } from "@/components/dashboard/transcription-panel";
import type { Recording } from "@/types/recording";

vi.mock("@/hooks/use-transcription-summary", () => ({
    useTranscriptionSummary: () => ({
        summaryData: null,
        isSummarizing: false,
        summaryProgress: null,
        summaryElapsedMs: 0,
        summaryExpanded: true,
        setSummaryExpanded: vi.fn(),
        summaryPreset: "general",
        setSummaryPreset: vi.fn(),
        summaryPromptOptions: [],
        handleSummarize: vi.fn(),
    }),
}));
vi.mock("@/components/dashboard/transcribe-in-browser-button", () => ({
    TranscribeInBrowserButton: () => null,
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

const turns = [
    { speaker: "speaker_0", startMs: 1000, endMs: 2000, text: "First." },
    { speaker: "speaker_1", startMs: 3000, endMs: 4000, text: "Reply." },
    { speaker: "speaker_0", startMs: 5000, endMs: 6000, text: "Again." },
];

describe("speaker playback navigation", () => {
    beforeEach(() => {
        Element.prototype.scrollTo = vi.fn();
        vi.stubGlobal(
            "fetch",
            vi.fn(
                async (url: string) =>
                    new Response(
                        JSON.stringify(
                            url.includes("/speakers")
                                ? {
                                      transcriptionId: "tx-1",
                                      revision: 1,
                                      speakers: [
                                          {
                                              label: "speaker_1",
                                              personId: "person-1",
                                              personName: "Jan",
                                              status: "confirmed",
                                          },
                                      ],
                                  }
                                : { topics: null },
                        ),
                        { status: 200 },
                    ),
            ),
        );
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it("plays and scrolls through one speaker, then starts another at their first turn", async () => {
        const onPlayFromTurn = vi.fn();
        render(
            <TranscriptionPanel
                recording={recording}
                transcripts={[
                    {
                        source: "riffado",
                        text: turns
                            .map((turn) => `${turn.speaker}: ${turn.text}`)
                            .join("\n"),
                        turns,
                        version: { transcriptionId: "tx-1", revision: 1 },
                    },
                ]}
                isTranscribing={false}
                onTranscribe={vi.fn()}
                onPlayFromTurn={onPlayFromTurn}
            />,
        );

        const firstSpeaker = screen.getByRole("button", { name: "Speaker 0" });
        const secondSpeaker = await screen.findByRole("button", {
            name: "Jan",
        });
        expect(
            screen.queryByText("Right-click a speaker to hear their next turn"),
        ).toBeNull();

        fireEvent.click(
            screen.getByRole("button", {
                name: "Play the next turn of Speaker 0",
            }),
        );
        expect(onPlayFromTurn).toHaveBeenLastCalledWith(1000);
        expect(
            document.querySelector('[data-turn-index="0"]')?.className,
        ).toContain("bg-primary/10");

        fireEvent.contextMenu(firstSpeaker);
        expect(onPlayFromTurn).toHaveBeenLastCalledWith(5000);
        expect(
            document.querySelector('[data-turn-index="2"]')?.className,
        ).toContain("bg-primary/10");

        fireEvent.contextMenu(secondSpeaker);
        expect(onPlayFromTurn).toHaveBeenLastCalledWith(3000);
        expect(
            document.querySelector('[data-turn-index="1"]')?.className,
        ).toContain("bg-primary/10");

        fireEvent.click(
            screen.getByRole("button", { name: "Collapse transcript" }),
        );
        fireEvent.contextMenu(firstSpeaker);
        expect(onPlayFromTurn).toHaveBeenLastCalledWith(1000);
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Collapse transcript" }),
            ).toBeDefined(),
        );
        expect(Element.prototype.scrollTo).toHaveBeenCalled();
    });

    it("plays only the speaker's turn from a review's speaker", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) =>
                Response.json(
                    url.includes("/review")
                        ? {
                              run: { id: "run-1", status: "ready" },
                              available: true,
                              names: { "person-1": "Jan" },
                              types: {},
                              relations: {},
                              items: [
                                  {
                                      id: "i-speaker",
                                      kind: "speaker",
                                      preTicked: false,
                                      decision: null,
                                      choice: null,
                                      version: 0,
                                      dependsOnLabel: null,
                                      payload: {
                                          label: "speaker_1",
                                          personId: "person-1",
                                          evidenceMs: [],
                                          reason: "",
                                      },
                                  },
                              ],
                          }
                        : url.includes("/speakers")
                          ? {
                                transcriptionId: "tx-1",
                                revision: 1,
                                speakers: [],
                            }
                          : { topics: null },
                ),
            ),
        );
        const onPlayFromTurn = vi.fn();
        render(
            <TranscriptionPanel
                recording={recording}
                transcripts={[
                    {
                        source: "riffado",
                        text: turns
                            .map((turn) => `${turn.speaker}: ${turn.text}`)
                            .join("\n"),
                        turns,
                        version: { transcriptionId: "tx-1", revision: 1 },
                    },
                ]}
                isTranscribing={false}
                onTranscribe={vi.fn()}
                onPlayFromTurn={onPlayFromTurn}
            />,
        );
        fireEvent.click(await screen.findByRole("button", { name: "Review" }));
        fireEvent.click(
            await screen.findByRole("button", {
                name: "Play a turn of Speaker 1",
            }),
        );
        expect(onPlayFromTurn).toHaveBeenLastCalledWith(3000, 4000);
    });
});

it("cycles all confirmed voices chronologically with matching transcript colours", async () => {
    Element.prototype.scrollTo = vi.fn();
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
            Response.json(
                url.includes("/speakers")
                    ? {
                          transcriptionId: "tx-1",
                          revision: 1,
                          speakers: ["speaker_0", "speaker_1"].map((label) => ({
                              label,
                              personId: "person-1",
                              personName: "Jan",
                              status: "confirmed",
                          })),
                      }
                    : { topics: null },
            ),
        ),
    );
    const onPlayFromTurn = vi.fn();
    const mixedTurns = [
        turns[0],
        { ...turns[1], startMs: 5000, endMs: 6000 },
        { ...turns[2], startMs: 3000, endMs: 4000 },
    ];
    try {
        render(
            <TranscriptionPanel
                recording={recording}
                transcripts={[
                    {
                        source: "riffado",
                        text: "speaker_0: First.\nspeaker_1: Reply.\nspeaker_0: Again.",
                        turns: mixedTurns,
                        version: { transcriptionId: "tx-1", revision: 1 },
                    },
                ]}
                isTranscribing={false}
                onTranscribe={vi.fn()}
                onPlayFromTurn={onPlayFromTurn}
            />,
        );
        const play = await screen.findByRole("button", {
            name: "Play the next turn of Jan",
        });
        expect(play.className).toContain("text-primary");
        expect(document.querySelectorAll("[data-speaker]")).toHaveLength(1);
        const renderedTurns = document.querySelectorAll("[data-turn-index]");
        expect(renderedTurns).toHaveLength(3);
        for (const turn of renderedTurns) {
            expect(turn.getAttribute("data-accent")).toBe("0");
            expect(turn.querySelector(".text-primary")).toBeTruthy();
        }
        for (const time of [1000, 3000, 5000, 1000]) {
            fireEvent.click(play);
            expect(onPlayFromTurn).toHaveBeenLastCalledWith(time);
        }
        fireEvent.click(screen.getByRole("button", { name: "Jan" }));
        fireEvent.click(
            screen.getByRole("button", {
                name: "Play the next turn of Speaker 1",
            }),
        );
        expect(onPlayFromTurn).toHaveBeenLastCalledWith(5000);
    } finally {
        cleanup();
        vi.unstubAllGlobals();
    }
});
