"use client";

import { useExtracted } from "next-intl";
import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { TranscriptTopicsMenu } from "@/components/dashboard/transcript-topics-menu";
import { Switch } from "@/components/ui/switch";
import {
    type PlaybackState,
    type TranscriptPlayback,
    transcriptReadingLine,
} from "@/hooks/use-transcript-follow";
import { activeTopicIndex, type TranscriptTopic } from "@/lib/topics/timeline";

interface TranscriptChapterBarProps {
    topics: TranscriptTopic[] | null;
    scrollRef: RefObject<HTMLElement | null>;
    canDetect: boolean;
    waitingForReview: boolean;
    detecting: boolean;
    onDetect: () => void;
    onSelect: (index: number) => void;
    hasCorrections: boolean;
    showOriginal: boolean;
    onShowOriginalChange: (show: boolean) => void;
    widgetId: string;
    playback?: TranscriptPlayback;
    getPlaybackMs?: () => number;
    expanded?: boolean;
}

/** Sticky topic navigation and original-text control inside the transcript scroll box. */
export function TranscriptChapterBar({
    topics,
    scrollRef,
    canDetect,
    waitingForReview,
    detecting,
    onDetect,
    onSelect,
    hasCorrections,
    showOriginal,
    onShowOriginalChange,
    widgetId,
    playback,
    getPlaybackMs,
    expanded = true,
}: TranscriptChapterBarProps) {
    const i18n = useExtracted();
    const switchId = useId();
    const barRef = useRef<HTMLDivElement>(null);
    const [readingIndex, setReadingIndex] = useState(0);
    const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
    const [playbackState, setPlaybackState] = useState<PlaybackState>({
        ms: getPlaybackMs?.() ?? 0,
        playing: false,
    });

    const playbackRef = useRef(playback);
    playbackRef.current = playback;
    const subscribed = playback !== undefined;

    useEffect(() => {
        if (!subscribed) return;
        return playbackRef.current?.subscribe((state) => {
            setPlaybackState(state);
            if (state.playing) setSelectedIndex(null);
        });
    }, [subscribed]);

    useEffect(() => {
        const box = scrollRef.current;
        if (!box || !topics?.length || !expanded) return;
        let headings = box.querySelectorAll<HTMLElement>("[data-topic-index]");
        const update = () => {
            const line = transcriptReadingLine(box) + 8;
            let current = 0;
            for (const heading of headings) {
                const rect = heading.getBoundingClientRect();
                if (rect.height === 0) continue;
                if (rect.top > line) break;
                current = Number(heading.dataset.topicIndex);
            }
            setReadingIndex(current);
        };
        update();
        box.addEventListener("scroll", update, { passive: true });
        const read = () => setSelectedIndex(null);
        const onKey = (event: KeyboardEvent) => {
            if (
                [
                    "PageUp",
                    "PageDown",
                    "Home",
                    "End",
                    "ArrowUp",
                    "ArrowDown",
                    " ",
                ].includes(event.key)
            )
                read();
        };
        box.addEventListener("wheel", read, { passive: true });
        box.addEventListener("touchmove", read, { passive: true });
        const onPointerDown = (event: PointerEvent) => {
            if (event.target === box) read();
        };
        box.addEventListener("pointerdown", onPointerDown);
        box.addEventListener("keydown", onKey);
        const observer =
            typeof ResizeObserver === "undefined"
                ? null
                : new ResizeObserver(() => {
                      headings =
                          box.querySelectorAll<HTMLElement>(
                              "[data-topic-index]",
                          );
                      update();
                  });
        observer?.observe(box);
        if (barRef.current) observer?.observe(barRef.current);
        const content = barRef.current?.nextElementSibling;
        if (content) observer?.observe(content);
        return () => {
            box.removeEventListener("scroll", update);
            box.removeEventListener("wheel", read);
            box.removeEventListener("touchmove", read);
            box.removeEventListener("pointerdown", onPointerDown);
            box.removeEventListener("keydown", onKey);
            observer?.disconnect();
        };
    }, [scrollRef, topics, expanded]);

    const activeIndex =
        selectedIndex ??
        (playbackState.playing
            ? Math.max(
                  0,
                  activeTopicIndex(
                      topics ?? [],
                      getPlaybackMs?.() ?? playbackState.ms,
                  ),
              )
            : readingIndex);

    if (!topics?.length && !canDetect && !hasCorrections) return null;

    return (
        <div
            ref={barRef}
            data-chapter-bar
            className={`${expanded ? "sticky top-0 z-20" : ""} flex min-h-12 min-w-0 items-center justify-between gap-3 border-b bg-muted px-4 py-2`}
        >
            <TranscriptTopicsMenu
                widgetId={widgetId}
                topics={topics}
                activeIndex={Math.min(
                    activeIndex,
                    Math.max(0, (topics?.length ?? 0) - 1),
                )}
                canDetect={canDetect}
                waitingForReview={waitingForReview}
                detecting={detecting}
                onDetect={onDetect}
                onSelect={(index) => {
                    onSelect(index);
                    setSelectedIndex(index);
                }}
            />
            {hasCorrections && (
                <label
                    htmlFor={switchId}
                    className="ml-auto flex min-h-7 shrink-0 cursor-pointer items-center gap-2 text-xs text-muted-foreground"
                >
                    <Switch
                        id={switchId}
                        checked={showOriginal}
                        onCheckedChange={onShowOriginalChange}
                        aria-label={i18n("Original text")}
                        className="before:absolute before:inset-x-0 before:-inset-y-1.5 relative"
                    />
                    <span className="hidden @min-[560px]/transcription:inline">
                        {i18n("Original text")}
                    </span>
                    <span className="@min-[560px]/transcription:hidden">
                        {i18n("Original")}
                    </span>
                </label>
            )}
        </div>
    );
}
