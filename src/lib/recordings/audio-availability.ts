type AudioSource = {
    kind?: "audio" | "mail" | null;
    audioReaped?: boolean;
} & (
    | { id: string }
    | {
          audioId: string | null;
          audioReapedAt: Date | null;
          audioDeletedAt: Date | null;
      }
);

/** Whether a listed item or joined recording still has playable audio. */
export function hasAudio(source: AudioSource | null | undefined): boolean {
    if (!source || source.kind === "mail" || source.audioReaped) return false;
    if ("audioId" in source) {
        return (
            source.kind === "audio" &&
            source.audioId !== null &&
            source.audioReapedAt === null &&
            source.audioDeletedAt === null
        );
    }
    return true;
}
