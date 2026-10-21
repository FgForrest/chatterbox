"use client";

import { createContext, useContext } from "react";
import {
    type SpeakerAccent,
    speakerAccent,
} from "@/components/people/speaker-accents";
import { speakerKey } from "@/lib/knowledge/speaker-label-rules";

export const SpeakerAccentContext = createContext<ReadonlyMap<string, number>>(
    new Map(),
);

/** Use the transcript's confirmed colour when a review renders one of its voices. */
export function useSpeakerAccent(
    label: string,
    fallback: SpeakerAccent,
): SpeakerAccent {
    const position = useContext(SpeakerAccentContext).get(speakerKey(label));
    return position === undefined ? fallback : speakerAccent(position);
}
