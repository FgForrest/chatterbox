"use client";

import { createContext, type ReactNode, useContext } from "react";
import type { TranscriptPlayback } from "@/hooks/use-transcript-follow";

const PlaybackContext = createContext<TranscriptPlayback | null>(null);

/** Supplies the current item's player, or null when it has no audio. */
export function PlaybackProvider({
    playback,
    children,
}: {
    playback: TranscriptPlayback | null;
    children: ReactNode;
}) {
    return <PlaybackContext value={playback}>{children}</PlaybackContext>;
}

/** Reads the current item's available audio transport. */
export function usePlayback(): TranscriptPlayback | null {
    return useContext(PlaybackContext);
}
