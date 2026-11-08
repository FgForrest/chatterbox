"use client";

import { useExtracted } from "next-intl";
import { PlayAtIcon, usePlayAt } from "@/components/playback/play-at-button";
import { formatClock } from "@/lib/topics/timeline";
import {
    type SpeakerSamples,
    speechQuote,
} from "@/lib/transcript/speech-samples";
import { cn } from "@/lib/utils";

/** Bounded speech samples and their active quote, shared by both review frames. */
export function SpeakerClips({
    samples,
    evidence,
}: {
    samples: SpeakerSamples;
    evidence: readonly { ms: number; untilMs: number; quote: string }[];
}) {
    const i18n = useExtracted();
    return (
        <>
            {evidence.length > 0 && (
                <div className="flex flex-col gap-1.5 @min-[560px]/learn:flex-row @min-[560px]/learn:flex-wrap @min-[560px]/learn:items-center">
                    <span className="text-xs text-muted-foreground @min-[560px]/learn:w-28">
                        {i18n("Where the name was heard")}
                    </span>
                    {evidence.map((clip) => (
                        <SpeakerClip key={clip.ms} {...clip} />
                    ))}
                </div>
            )}
            {(samples.samples.length > 0 ||
                (samples.fallback && samples.longestTurnMs > 0)) && (
                <div className="flex flex-col gap-1.5 @min-[560px]/learn:flex-row @min-[560px]/learn:flex-wrap @min-[560px]/learn:items-start">
                    <span className="text-xs text-muted-foreground @min-[560px]/learn:w-28 @min-[560px]/learn:pt-2">
                        {i18n("Speech samples")}
                    </span>
                    <div className="min-w-0 flex-1 space-y-1.5">
                        <div className="flex flex-wrap items-start gap-1.5">
                            {samples.samples.map((sample) => (
                                <SpeakerClip
                                    key={sample.ms}
                                    ms={sample.ms}
                                    untilMs={sample.untilMs}
                                    quote={speechQuote(sample.text)}
                                    sample
                                />
                            ))}
                        </div>
                        {samples.fallback && (
                            <p className="text-xs text-amber-700 dark:text-amber-400">
                                {samples.longestTurnMs < 1000
                                    ? i18n(
                                          "Only very short replies, each under 1 s.",
                                      )
                                    : i18n(
                                          "Only short replies; the longest is {seconds} s.",
                                          {
                                              seconds: String(
                                                  Math.round(
                                                      samples.longestTurnMs /
                                                          1000,
                                                  ),
                                              ),
                                          },
                                      )}
                            </p>
                        )}
                    </div>
                </div>
            )}
        </>
    );
}

function SpeakerClip({
    ms,
    untilMs,
    quote,
    sample = false,
}: {
    ms: number;
    untilMs: number;
    quote: string;
    sample?: boolean;
}) {
    const i18n = useExtracted();
    const play = usePlayAt({ ms, untilMs }, true);
    const time = formatClock(ms);
    const label = sample
        ? i18n("{time} · {seconds} s", {
              time,
              seconds: String(Math.round((untilMs - ms) / 1000)),
          })
        : time;
    if (!play.available)
        return <span className="text-xs text-muted-foreground">{label}</span>;
    return (
        <div className={cn("min-w-0", sample && "contents")}>
            <button
                type="button"
                disabled={!play.available}
                aria-pressed={play.playing}
                aria-label={
                    play.playing
                        ? i18n("Pause at {time}", { time })
                        : i18n("Play from {time}", { time })
                }
                className={cn(
                    "relative inline-flex min-h-9 max-w-full items-center gap-1.5 overflow-hidden rounded-md border px-2 text-left text-xs tabular-nums transition-colors @min-[560px]/learn:min-h-7",
                    sample
                        ? "border-primary/20 bg-primary/5"
                        : "text-muted-foreground",
                    play.playing &&
                        "border-primary bg-primary/15 text-foreground",
                )}
                onClick={() => play.toggle()}
            >
                <PlayAtIcon playing={play.playing} />
                <span className="shrink-0">{label}</span>
                {!sample && (
                    <span className="min-w-0 text-muted-foreground">
                        “{quote}”
                    </span>
                )}
                {play.playing && (
                    <span
                        aria-hidden="true"
                        className="absolute bottom-0 left-0 h-0.5 bg-primary"
                        style={{ width: `${play.progress * 100}%` }}
                    />
                )}
            </button>
            {sample && play.playing && (
                <p className="order-last basis-full text-xs italic text-muted-foreground">
                    “{quote}”
                </p>
            )}
        </div>
    );
}
