// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    RecordingPlayer,
    type RecordingPlayerHandle,
} from "@/components/dashboard/recording-player";
import { installFakeMedia } from "@/tests/helpers/fake-media";
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
    let mediaFor: ReturnType<typeof installFakeMedia>;
    let play: ReturnType<typeof vi.spyOn>;
    let pause: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        mediaFor = installFakeMedia();
        play = vi.mocked(HTMLMediaElement.prototype.play);
        pause = vi.mocked(HTMLMediaElement.prototype.pause);
    });

    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
    });

    async function playTo(seconds: number) {
        const audio = document.querySelector("audio") as HTMLAudioElement;
        await act(async () => {
            mediaFor(audio).advance(seconds);
        });
    }

    it("pauses at the end it was given, and only there", async () => {
        const ref = createRef<RecordingPlayerHandle>();
        render(<RecordingPlayer ref={ref} recording={recording} />);
        await act(async () => ref.current?.playFrom(3, 4));
        expect(play).toHaveBeenCalledTimes(1);
        await playTo(3.5);
        expect(pause).not.toHaveBeenCalled();
        await playTo(4.1);
        expect(pause).toHaveBeenCalledTimes(1);
    });

    it("plays on without an end", async () => {
        const ref = createRef<RecordingPlayerHandle>();
        render(<RecordingPlayer ref={ref} recording={recording} />);
        await act(async () => ref.current?.playFrom(3));
        await playTo(40);
        expect(pause).not.toHaveBeenCalled();
    });
});
