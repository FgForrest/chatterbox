// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    RecordingPlayer,
    type RecordingPlayerHandle,
} from "@/components/dashboard/recording-player";
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

const recording: Recording = {
    id: "rec-1",
    filename: "Meeting.ogg",
    duration: 60_000,
    filesize: 1024,
    startTime: new Date(0).toISOString(),
    deviceSn: "local",
};

describe("RecordingPlayer playFrom", () => {
    let position = 0;
    const play = vi.fn(() => Promise.resolve());
    const pause = vi.fn();

    beforeEach(() => {
        position = 0;
        play.mockClear();
        pause.mockClear();
        vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(play);
        vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(pause);
        vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(
            () => {},
        );
        Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
            configurable: true,
            get: () => position,
            set: (value: number) => {
                position = value;
            },
        });
    });

    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
    });

    /** Move playback on, as the audio element reports it. */
    function playTo(seconds: number) {
        const audio = document.querySelector("audio") as HTMLAudioElement;
        position = seconds;
        act(() => {
            audio.dispatchEvent(new Event("seeked"));
            audio.dispatchEvent(new Event("timeupdate"));
        });
    }

    it("pauses at the end it was given, and only there", () => {
        const ref = createRef<RecordingPlayerHandle>();
        render(<RecordingPlayer ref={ref} recording={recording} />);
        act(() => ref.current?.playFrom(3, 4));
        expect(play).toHaveBeenCalledTimes(1);
        playTo(3.5);
        expect(pause).not.toHaveBeenCalled();
        playTo(4.1);
        expect(pause).toHaveBeenCalledTimes(1);
    });

    it("plays on without an end", () => {
        const ref = createRef<RecordingPlayerHandle>();
        render(<RecordingPlayer ref={ref} recording={recording} />);
        act(() => ref.current?.playFrom(3));
        playTo(40);
        expect(pause).not.toHaveBeenCalled();
    });
});
