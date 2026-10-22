// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
} from "@testing-library/react";
import { createRef, type RefObject } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    RecordingPlayer,
    type RecordingPlayerHandle,
    transcriptPlayback,
} from "@/components/dashboard/recording-player";
import { TranscriptionPanel } from "@/components/dashboard/transcription-panel";
import { PlaybackProvider } from "@/components/playback/playback-context";
import { TaskEvidenceLink } from "@/components/tasks/task-evidence-link";
import { installFakeMedia } from "@/tests/helpers/fake-media";
import type { Recording } from "@/types/recording";

vi.mock("@/hooks/use-waveform", () => ({
    useWaveform: () => ({ peaks: null, status: "idle", decode: vi.fn() }),
}));
vi.mock("@/components/dashboard/recording-player-header", () => ({
    RecordingWaveformStatus: () => null,
}));
vi.mock("@/components/recordings/download-audio-button", () => ({
    DownloadAudioButton: () => null,
}));
vi.mock("@/components/dashboard/transcribe-in-browser-button", () => ({
    TranscribeInBrowserButton: () => null,
}));
vi.mock("@/components/dashboard/markdown-actions", () => ({
    MarkdownActions: () => null,
}));
vi.mock("@/components/summary/summary-widget", () => ({
    SummaryWidget: () => null,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const recording: Recording = {
    id: "rec-1",
    filename: "Meeting.ogg",
    duration: 60_000,
    filesize: 1024,
    startTime: new Date(0).toISOString(),
    deviceSn: "local",
};
const turns = [
    {
        speaker: "speaker_0",
        startMs: 1000,
        endMs: 2000,
        text: "First. Second.",
    },
    { speaker: "speaker_1", startMs: 3000, endMs: 4000, text: "Reply." },
    { speaker: "speaker_0", startMs: 5000, endMs: 6000, text: "Again." },
];

function PlayerAndTranscript({
    playerRef,
}: {
    playerRef: RefObject<RecordingPlayerHandle | null>;
}) {
    return (
        <PlaybackProvider playback={transcriptPlayback(playerRef)}>
            <RecordingPlayer ref={playerRef} recording={recording} />
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
            />
            <TaskEvidenceLink
                currentItemId={recording.id}
                evidence={{
                    itemId: recording.id,
                    itemKind: "audio",
                    audioAvailable: true,
                    startMs: 9000,
                    text: null,
                }}
            />
        </PlaybackProvider>
    );
}

describe("audio playback after speaker and transcript controls", () => {
    let mediaFor: ReturnType<typeof installFakeMedia>;
    beforeEach(() => {
        mediaFor = installFakeMedia();
        vi.stubGlobal(
            "ResizeObserver",
            class {
                observe() {}
                unobserve() {}
                disconnect() {}
            },
        );
        Element.prototype.scrollTo = vi.fn();
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
                                          label: "speaker_0",
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
    });
    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    function media() {
        const audio = document.querySelector("audio");
        if (!audio) throw new Error("Audio missing");
        return mediaFor(audio);
    }
    function audible() {
        expect(media().paused).toBe(false);
        expect(media().element.muted).toBe(false);
        expect(media().element.volume).toBe(0.75);
        expect(
            screen.getAllByRole("button", { name: "Pause" }).length,
        ).toBeGreaterThan(0);
    }
    async function clickMain() {
        await act(async () =>
            fireEvent.click(
                screen.getAllByRole("button", { name: /^(Play|Pause)$/ })[0],
            ),
        );
    }

    it("keeps playing across a parent callback/filename update and the next speaker play", async () => {
        const ref = createRef<RecordingPlayerHandle>();
        const view = render(
            <RecordingPlayer
                ref={ref}
                recording={recording}
                onEnded={() => {}}
            />,
        );
        await clickMain();
        const loads = media().loads;
        await act(async () =>
            view.rerender(
                <RecordingPlayer
                    ref={ref}
                    recording={{ ...recording, filename: "Renamed" }}
                    onEnded={() => {}}
                />,
            ),
        );
        expect(media().loads).toBe(loads);
        await act(async () => ref.current?.playFrom(5));
        audible();
    });

    it("reconciles an interrupted play promise and lets the next click play", async () => {
        render(<RecordingPlayer recording={recording} />);
        media().deferPlay = true;
        await clickMain();
        await act(async () => media().load());
        expect(screen.getByRole("button", { name: "Play" })).toBeDefined();
        await clickMain();
        act(() => media().finishPlay());
        audible();
    });

    it("uses element state for two transport commands in the same event", async () => {
        const ref = createRef<RecordingPlayerHandle>();
        render(<RecordingPlayer ref={ref} recording={recording} />);
        media().deferPlay = true;
        await act(async () => {
            ref.current?.playFrom(1, 2);
            ref.current?.pause();
        });
        expect(media().paused).toBe(true);
        expect(screen.getByRole("button", { name: "Play" })).toBeDefined();
        await clickMain();
        act(() => {
            media().finishPlay();
            media().advance(10);
        });
        audible();
    });

    it("resumes normal playback after a bounded turn without another stop", async () => {
        const ref = createRef<RecordingPlayerHandle>();
        render(<RecordingPlayer ref={ref} recording={recording} />);
        await clickMain();
        await act(async () => ref.current?.playFrom(1, 2));
        act(() => media().advance(2.1));
        expect(media().paused).toBe(true);
        await clickMain();
        act(() => media().advance(30));
        audible();
    });

    it("reconciles a rejected play without a pause event, including evidence ownership", async () => {
        const ref = createRef<RecordingPlayerHandle>();
        render(<PlayerAndTranscript playerRef={ref} />);
        await screen.findByRole("button", { name: "Review" });
        media().deferPlay = true;
        const errorLog = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});
        const errors = vi.mocked(toast.error);
        errors.mockClear();
        await act(async () =>
            fireEvent.click(
                screen.getByRole("button", { name: "Play from 00:09" }),
            ),
        );
        await act(async () => media().interrupt("NotAllowedError"));
        expect(screen.getByRole("button", { name: "Play" })).toBeDefined();
        expect(
            screen
                .getByRole("button", { name: "Play from 00:09" })
                .getAttribute("aria-pressed"),
        ).toBe("false");
        expect(errorLog).toHaveBeenCalledTimes(1);
        expect(errors).toHaveBeenCalledTimes(1);
        await act(async () =>
            fireEvent.click(
                screen.getByRole("button", { name: "Play from 00:09" }),
            ),
        );
        act(() => media().finishPlay());
        audible();
    });

    it("ignores an older AbortError after a newer bounded play starts", async () => {
        const ref = createRef<RecordingPlayerHandle>();
        render(<RecordingPlayer ref={ref} recording={recording} />);
        media().deferPlay = true;
        await act(async () => ref.current?.playFrom(1, 2));
        await act(async () => {
            ref.current?.pause();
            ref.current?.playFrom(5, 6);
            media().finishPlay();
        });
        audible();
        act(() => media().advance(6.1));
        expect(media().paused).toBe(true);
    });

    it("keeps a newer turn boundary when earlier pause and emptied events arrive late", async () => {
        const ref = createRef<RecordingPlayerHandle>();
        render(<RecordingPlayer ref={ref} recording={recording} />);
        await act(async () => ref.current?.playFrom(1, 2));
        await act(async () => {
            ref.current?.pause();
            ref.current?.playFrom(5, 6);
        });
        act(() => {
            media().emit("pause");
            media().emit("emptied");
        });
        audible();
        act(() => media().advance(6.1));
        expect(media().paused).toBe(true);
    });

    it("queues a seek until metadata while requesting play in the same gesture", async () => {
        const ref = createRef<RecordingPlayerHandle>();
        render(<RecordingPlayer ref={ref} recording={recording} />);
        media().autoMetadata = false;
        act(() => media().load());
        media().deferPlay = true;
        act(() => ref.current?.playFrom(5, 6));
        expect(media().pending).toHaveLength(1);
        expect(media().position).toBe(0);
        await act(async () => {
            media().metadata();
            media().finishPlay();
        });
        expect(media().position).toBe(5);
        audible();
        act(() => media().advance(6.1));
        expect(media().paused).toBe(true);
    });

    it("changes source only with the recording id and uses the latest auto-next callback", async () => {
        const ref = createRef<RecordingPlayerHandle>();
        const firstEnded = vi.fn();
        const latestEnded = vi.fn();
        const view = render(
            <RecordingPlayer
                ref={ref}
                recording={recording}
                initialAutoPlayNext
                onEnded={firstEnded}
            />,
        );
        await act(async () => ref.current?.playFrom(1, 2));
        const loads = media().loads;
        await act(async () =>
            view.rerender(
                <RecordingPlayer
                    ref={ref}
                    recording={{ ...recording, id: "rec-2" }}
                    initialAutoPlayNext
                    onEnded={latestEnded}
                />,
            ),
        );
        expect(media().loads).toBe(loads + 1);
        expect(media().element.getAttribute("src")).toBe(
            "/api/recordings/rec-2/audio",
        );
        expect(media().paused).toBe(true);
        await clickMain();
        act(() => media().advance(30));
        audible();
        act(() => {
            media().ended = true;
            media().paused = true;
            media().emit("ended");
        });
        expect(firstEnded).not.toHaveBeenCalled();
        expect(latestEnded).toHaveBeenCalledTimes(1);
    });

    it("preserves user volume and speed through speaker playback, including mute and unmute", async () => {
        const ref = createRef<RecordingPlayerHandle>();
        render(
            <RecordingPlayer
                ref={ref}
                recording={recording}
                initialVolume={35}
                initialPlaybackSpeed={1.5}
            />,
        );
        await act(async () => ref.current?.playFrom(1, 2));
        expect(media().element.volume).toBe(0.35);
        expect(media().element.playbackRate).toBe(1.5);
        fireEvent.click(screen.getByRole("button", { name: "Mute" }));
        await act(async () => ref.current?.playFrom(5));
        expect(media().element.volume).toBe(0);
        fireEvent.click(screen.getByRole("button", { name: "Unmute" }));
        expect(media().element.volume).toBe(0.35);
        expect(media().element.muted).toBe(false);
    });

    it("cancels a bounded turn on an explicit seek", async () => {
        const ref = createRef<RecordingPlayerHandle>();
        render(<RecordingPlayer ref={ref} recording={recording} />);
        await act(async () => ref.current?.playFrom(1, 2));
        await act(async () => ref.current?.seekTo(10));
        audible();
        act(() => media().advance(11));
        audible();
    });

    it("steps transcript chips through turns and moves the playing sentence and scroll", async () => {
        const ref = createRef<RecordingPlayerHandle>();
        render(<PlayerAndTranscript playerRef={ref} />);
        await screen.findByRole("button", { name: "Review" });
        await clickMain();
        for (const [seconds, text] of [
            [1, "First."],
            [5, "Again."],
            [1, "First."],
        ] as const) {
            await act(async () =>
                fireEvent.click(
                    screen.getByRole("button", {
                        name: "Play the next turn of Speaker 0",
                    }),
                ),
            );
            expect(media().position).toBe(seconds);
            expect(
                screen.getByText(text).closest("[data-sentence]")?.className,
            ).toContain("bg-primary/20");
            audible();
            act(() => media().advance(seconds + 1));
            audible();
            expect(
                screen
                    .getByRole("button", {
                        name: "Play the next turn of Speaker 0",
                    })
                    .getAttribute("aria-pressed"),
            ).toBe("false");
        }
        expect(Element.prototype.scrollTo).toHaveBeenCalled();
        act(() => media().advance(20));
        audible();
    });

    it("steps Learn review chips through turns, wraps, and pauses at each end", async () => {
        const ref = createRef<RecordingPlayerHandle>();
        render(<PlayerAndTranscript playerRef={ref} />);
        fireEvent.click(await screen.findByRole("button", { name: "Review" }));
        const chip = await screen.findByRole("button", {
            name: "Play a turn of Speaker 0",
        });
        for (const [start, end] of [
            [1, 2],
            [5, 6],
            [1, 2],
        ]) {
            await act(async () => fireEvent.click(chip));
            expect(media().position).toBe(start);
            expect(media().paused).toBe(false);
            act(() => media().advance(end + 0.1));
            expect(media().paused).toBe(true);
        }
        await act(async () => ref.current?.playFrom(10));
        act(() => media().advance(20));
        expect(media().paused).toBe(false);
    });

    it("clears a turn boundary through sentence, gutter, evidence, and keyboard controls", async () => {
        const ref = createRef<RecordingPlayerHandle>();
        render(<PlayerAndTranscript playerRef={ref} />);
        await screen.findByRole("button", { name: "Review" });
        const actions = [
            () => fireEvent.click(screen.getByText("Again.")),
            () =>
                fireEvent.click(
                    screen.getByRole("button", {
                        name: /^Play from 00:05,/,
                    }),
                ),
            () =>
                fireEvent.click(
                    screen.getByRole("button", {
                        name: "Play from 00:09",
                    }),
                ),
            () => fireEvent.keyDown(document.body, { key: "ArrowRight" }),
        ];
        for (const action of actions) {
            await act(async () => ref.current?.playFrom(1, 2));
            await act(async () => action());
            act(() => media().advance(12));
            audible();
        }
        await act(async () => fireEvent.keyDown(document.body, { key: " " }));
        expect(media().paused).toBe(true);
        await act(async () => fireEvent.keyDown(document.body, { key: " " }));
        audible();
    });
});
