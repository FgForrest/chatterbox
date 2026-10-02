/**
 * Per-speaker accents, by the order speakers first speak. Cycles when a
 * recording has more speakers than colours, which is rare and still
 * readable: adjacent turns keep their labels.
 */
const SPEAKER_ACCENTS = [
    { dot: "bg-primary", text: "text-primary" },
    { dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400" },
    { dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400" },
    { dot: "bg-violet-500", text: "text-violet-600 dark:text-violet-400" },
    { dot: "bg-rose-500", text: "text-rose-600 dark:text-rose-400" },
    { dot: "bg-sky-500", text: "text-sky-600 dark:text-sky-400" },
] as const;

export type SpeakerAccent = (typeof SPEAKER_ACCENTS)[number];

/** The accent of the speaker at `position` in speaking order; -1 is the first. */
export function speakerAccent(position: number): SpeakerAccent {
    return SPEAKER_ACCENTS[Math.max(0, position) % SPEAKER_ACCENTS.length];
}
