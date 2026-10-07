/**
 * Per-speaker accents, by the order speakers first speak. Cycles when a
 * recording has more speakers than colours, which is rare and still
 * readable: adjacent turns keep their labels. `soft` and `strong` wash the
 * sentence being played, paused and playing.
 */
const SPEAKER_ACCENTS = [
    {
        dot: "bg-primary",
        text: "text-primary",
        hover: "hover:bg-primary/10",
        soft: "bg-primary/10",
        strong: "bg-primary/20",
    },
    {
        dot: "bg-emerald-500",
        text: "text-emerald-600 dark:text-emerald-400",
        hover: "hover:bg-emerald-500/10",
        soft: "bg-emerald-500/10",
        strong: "bg-emerald-500/20",
    },
    {
        dot: "bg-amber-500",
        text: "text-amber-600 dark:text-amber-400",
        hover: "hover:bg-amber-500/10",
        soft: "bg-amber-500/10",
        strong: "bg-amber-500/20",
    },
    {
        dot: "bg-violet-500",
        text: "text-violet-600 dark:text-violet-400",
        hover: "hover:bg-violet-500/10",
        soft: "bg-violet-500/10",
        strong: "bg-violet-500/20",
    },
    {
        dot: "bg-rose-500",
        text: "text-rose-600 dark:text-rose-400",
        hover: "hover:bg-rose-500/10",
        soft: "bg-rose-500/10",
        strong: "bg-rose-500/20",
    },
    {
        dot: "bg-sky-500",
        text: "text-sky-600 dark:text-sky-400",
        hover: "hover:bg-sky-500/10",
        soft: "bg-sky-500/10",
        strong: "bg-sky-500/20",
    },
] as const;

export type SpeakerAccent = (typeof SPEAKER_ACCENTS)[number];

/** The accent of the speaker at `position` in speaking order; -1 is the first. */
export function speakerAccent(position: number): SpeakerAccent {
    return SPEAKER_ACCENTS[Math.max(0, position) % SPEAKER_ACCENTS.length];
}
