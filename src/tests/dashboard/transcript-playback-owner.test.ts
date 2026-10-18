import { describe, expect, it, vi } from "vitest";
import {
    type RecordingPlayerHandle,
    transcriptPlayback,
} from "@/components/dashboard/recording-player";
import type { PlaybackState } from "@/hooks/use-transcript-follow";

function fakePlayer() {
    const listeners = new Set<
        (state: { ms: number; playing: boolean }) => void
    >();
    let ms = 0;
    let playing = false;
    const emit = (next: boolean) => {
        playing = next;
        for (const listener of listeners) listener({ ms, playing });
    };
    const handle: RecordingPlayerHandle = {
        seekTo: (seconds) => {
            ms = seconds * 1000;
        },
        playFrom: (seconds) => {
            ms = seconds * 1000;
            emit(false);
            emit(true);
        },
        getCurrentTime: () => ms / 1000,
        pause: () => emit(false),
        subscribe: (listener) => {
            listeners.add(listener);
            listener({ ms, playing });
            return () => listeners.delete(listener);
        },
    };
    return { ref: { current: handle }, emit };
}

describe("transcript playback owner", () => {
    it("keeps the owner when the view is rebuilt for the same player", () => {
        const { ref } = fakePlayer();
        transcriptPlayback(ref).play(12_000, "evidence-a");

        const seen: PlaybackState[] = [];
        transcriptPlayback(ref).subscribe((state) => seen.push(state));

        expect(seen.at(-1)).toMatchObject({
            playing: true,
            owner: "evidence-a",
        });
    });

    it("drops the owner when playback stops or another control plays", () => {
        const { ref, emit } = fakePlayer();
        const listener = vi.fn();
        transcriptPlayback(ref).subscribe(listener);

        transcriptPlayback(ref).play(12_000, "evidence-a");
        expect(listener).toHaveBeenLastCalledWith(
            expect.objectContaining({ playing: true, owner: "evidence-a" }),
        );

        transcriptPlayback(ref).play(40_000);
        expect(listener).toHaveBeenLastCalledWith(
            expect.objectContaining({ playing: true, owner: null }),
        );

        transcriptPlayback(ref).play(12_000, "evidence-a");
        emit(false);
        expect(listener).toHaveBeenLastCalledWith(
            expect.objectContaining({ playing: false, owner: null }),
        );
    });
});
