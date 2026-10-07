// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
} from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    RecordingPlayer,
    type RecordingPlayerHandle,
} from "@/components/dashboard/recording-player";
import { TranscriptView } from "@/components/dashboard/transcript-view";
import {
    type PlaybackState,
    readingLineFraction,
    sentenceIndexAt,
    type TranscriptPlayback,
} from "@/hooks/use-transcript-follow";
import { sentenceStarts } from "@/lib/topics/timeline";
import type { Recording } from "@/types/recording";

vi.mock("@/hooks/use-waveform", () => ({
    useWaveform: () => ({ peaks: null, status: "idle", decode: vi.fn() }),
}));
vi.mock("@/components/dashboard/recording-player-controls", () => ({
    RecordingPlayerControls: () => null,
}));
vi.mock("@/components/dashboard/recording-player-header", () => ({
    RecordingWaveformStatus: () => null,
}));
vi.mock("@/components/recordings/download-audio-button", () => ({
    DownloadAudioButton: () => null,
}));

const TURNS = [
    {
        speaker: "speaker_0",
        startMs: 0,
        endMs: 10_000,
        text: "First sentence here. Second one follows.",
    },
    {
        speaker: "speaker_1",
        startMs: 12_000,
        endMs: 15_000,
        text: "A reply.",
    },
];
const TEXT = TURNS.map((turn) => `${turn.speaker}: ${turn.text}`).join("\n");

function fakePlayback() {
    let listener: ((state: PlaybackState) => void) | null = null;
    const playback: TranscriptPlayback = {
        play: vi.fn(),
        pause: vi.fn(),
        seek: vi.fn(),
        subscribe: (next) => {
            listener = next;
            return () => {
                listener = null;
            };
        },
    };
    const emit = (state: PlaybackState) => act(() => listener?.(state));
    return { playback, emit };
}

function sentence(text: string): HTMLElement {
    const element = screen.getByText(text).closest("[data-sentence]");
    if (!(element instanceof HTMLElement)) {
        throw new Error(`no sentence around ${text}`);
    }
    return element;
}

describe("sentence timing", () => {
    it("starts the first sentence with the turn and interpolates the rest", () => {
        expect(sentenceStarts(TURNS[0])).toEqual([
            { at: 0, ms: 0 },
            { at: 21, ms: 5250 },
        ]);
    });

    it("finds the sentence playing at a moment", () => {
        expect(sentenceIndexAt([0, 4950, 12_000], 0)).toBe(0);
        expect(sentenceIndexAt([0, 4950, 12_000], 6000)).toBe(1);
        expect(sentenceIndexAt([0, 4950, 12_000], 13_000)).toBe(2);
        expect(sentenceIndexAt([1000], 500)).toBe(-1);
    });

    it("slides the reading line to the ends of the scroll box", () => {
        expect(readingLineFraction(0, 300, 3000)).toBe(0);
        expect(readingLineFraction(1000, 300, 3000)).toBeCloseTo(1 / 3);
        expect(readingLineFraction(2700, 300, 3000)).toBe(1);
    });
});

describe("TranscriptView sentence playback", () => {
    afterEach(cleanup);

    it("plays a clicked sentence from a little before its estimated start", () => {
        const { playback } = fakePlayback();
        render(
            <TranscriptView
                text={TEXT}
                source="riffado"
                model="scribe_v1"
                storedTurns={TURNS}
                onSeekToTurn={vi.fn()}
                playback={playback}
            />,
        );

        fireEvent.click(sentence("Second one follows."));
        expect(playback.play).toHaveBeenCalledWith(4950);

        fireEvent.click(sentence("A reply."));
        expect(playback.play).toHaveBeenLastCalledWith(12_000);
    });

    it("plays a turn from its start with the gutter button", () => {
        const { playback } = fakePlayback();
        render(
            <TranscriptView
                text={TEXT}
                source="riffado"
                model="scribe_v1"
                storedTurns={TURNS}
                onSeekToTurn={vi.fn()}
                playback={playback}
            />,
        );

        fireEvent.click(
            screen.getByRole("button", {
                name: "Play from 00:12, Speaker 1",
            }),
        );
        expect(playback.play).toHaveBeenCalledWith(12_000);
    });

    it("marks the sentence being played, and pauses when it is clicked", () => {
        const { playback, emit } = fakePlayback();
        render(
            <TranscriptView
                text={TEXT}
                source="riffado"
                model="scribe_v1"
                storedTurns={TURNS}
                onSeekToTurn={vi.fn()}
                playback={playback}
            />,
        );
        expect(sentence("Second one follows.").className).not.toContain(
            "bg-primary/20",
        );

        emit({ ms: 6000, playing: true });
        expect(sentence("Second one follows.").className).toContain(
            "bg-primary/20",
        );
        expect(sentence("First sentence here.").className).not.toContain(
            "bg-primary/20",
        );

        fireEvent.click(sentence("Second one follows."));
        expect(playback.pause).toHaveBeenCalledTimes(1);
        expect(playback.play).not.toHaveBeenCalled();

        emit({ ms: 6000, playing: false });
        expect(sentence("Second one follows.").className).toContain(
            "bg-primary/10",
        );
    });

    it("leaves clicks on corrections to the corrections", () => {
        const { playback } = fakePlayback();
        render(
            <TranscriptView
                text={TEXT}
                source="riffado"
                model="scribe_v1"
                storedTurns={TURNS}
                onSeekToTurn={vi.fn()}
                playback={playback}
                corrections={{
                    list: [
                        {
                            id: "c-second",
                            turnIndex: 0,
                            charStart: 21,
                            charEnd: 27,
                            heard: "Second",
                            kind: "correct" as const,
                            replacement: "Sekund",
                            meaning: "Sekund",
                        },
                    ],
                    canUndo: true,
                    onUndo: vi.fn(),
                }}
            />,
        );

        fireEvent.click(
            screen.getByRole("button", {
                name: "Sekund, heard as Second: show undo",
            }),
        );
        expect(playback.play).not.toHaveBeenCalled();
        expect(screen.getByRole("button", { name: /^Undo/ })).toBeDefined();

        fireEvent.click(sentence("one follows."));
        expect(playback.play).toHaveBeenCalledWith(4950);
    });

    it("cuts no sentences without audio", () => {
        const { container } = render(
            <TranscriptView
                text={TEXT}
                source="riffado"
                model="scribe_v1"
                storedTurns={TURNS}
                onSeekToTurn={vi.fn()}
            />,
        );
        expect(container.querySelector("[data-sentence]")).toBeNull();
        expect(
            screen.getByText("First sentence here. Second one follows."),
        ).toBeDefined();
    });
});

describe("RecordingPlayer subscribe", () => {
    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
    });

    it("reports where the audio is as it moves", () => {
        vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(
            () => {},
        );
        let position = 0;
        Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
            configurable: true,
            get: () => position,
            set: (value: number) => {
                position = value;
            },
        });
        const recording: Recording = {
            id: "rec-1",
            filename: "Meeting.ogg",
            duration: 60_000,
            filesize: 1024,
            startTime: new Date(0).toISOString(),
            deviceSn: "local",
        };
        const ref = createRef<RecordingPlayerHandle>();
        render(<RecordingPlayer ref={ref} recording={recording} />);
        position = 2;
        const states: PlaybackState[] = [];
        const unsubscribe = ref.current?.subscribe((state) =>
            states.push(state),
        );
        expect(states.at(-1)).toEqual({ ms: 2000, playing: false });

        const audio = document.querySelector("audio") as HTMLAudioElement;
        position = 7.5;
        audio.dispatchEvent(new Event("seeked"));
        expect(states.at(-1)).toEqual({ ms: 7500, playing: false });

        unsubscribe?.();
        position = 9;
        audio.dispatchEvent(new Event("timeupdate"));
        expect(states.at(-1)?.ms).toBe(7500);
    });
});
