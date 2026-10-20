"use client";

import { useExtracted } from "next-intl";
import { formatSpeakerLabel } from "@/lib/transcription/diarization";

/** Localize provider speaker labels while preserving names and numbering. */
export function useSpeakerLabel(): (label: string) => string {
    const i18n = useExtracted();
    return (label) =>
        formatSpeakerLabel(label, (number) =>
            i18n("Speaker {number}", { number }),
        );
}
