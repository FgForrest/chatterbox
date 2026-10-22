import { vi } from "vitest";
import type {
    PlaybackState,
    TranscriptPlayback,
} from "@/hooks/use-transcript-follow";

export function createTestPlayback(
    overrides: Partial<TranscriptPlayback> = {},
) {
    let state: PlaybackState = { ms: 0, playing: false, owner: null };
    const listeners = new Set<(state: PlaybackState) => void>();
    const emit = (next: PlaybackState) => {
        state = next;
        for (const listener of listeners) listener(state);
    };
    const playback: TranscriptPlayback = {
        play: vi.fn((ms, owner) => emit({ ms, owner, playing: true })),
        pause: vi.fn(() => emit({ ...state, playing: false, owner: null })),
        seek: vi.fn((ms) => emit({ ...state, ms, owner: null })),
        subscribe: (listener) => {
            listeners.add(listener);
            listener(state);
            return () => {
                listeners.delete(listener);
            };
        },
        ...overrides,
    };
    return { playback, emit };
}
