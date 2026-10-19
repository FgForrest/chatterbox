"use client";

import { useExtracted } from "next-intl";
import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { TranscriptTopicsMenu } from "@/components/dashboard/transcript-topics-menu";
import { Switch } from "@/components/ui/switch";
import { transcriptReadingLine } from "@/hooks/use-transcript-follow";
import type { TranscriptTopic } from "@/lib/topics/timeline";

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
}: TranscriptChapterBarProps) {
    const i18n = useExtracted();
    const switchId = useId();
    const barRef = useRef<HTMLDivElement>(null);
    const [activeIndex, setActiveIndex] = useState(0);

    useEffect(() => {
        const box = scrollRef.current;
        if (!box || !topics?.length) return;
        const update = () => {
            const line = transcriptReadingLine(box) + 8;
            let current = 0;
            for (const heading of box.querySelectorAll<HTMLElement>(
                "[data-topic-index]",
            )) {
                const rect = heading.getBoundingClientRect();
                if (rect.height === 0) continue;
                if (rect.top > line) break;
                current = Number(heading.dataset.topicIndex);
            }
            setActiveIndex(current);
        };
        update();
        box.addEventListener("scroll", update, { passive: true });
        window.addEventListener("resize", update);
        const observer =
            typeof ResizeObserver === "undefined"
                ? null
                : new ResizeObserver(update);
        observer?.observe(box);
        if (barRef.current) observer?.observe(barRef.current);
        const content = barRef.current?.nextElementSibling;
        if (content) observer?.observe(content);
        for (const heading of box.querySelectorAll<HTMLElement>(
            "[data-topic-index]",
        ))
            observer?.observe(heading);
        return () => {
            box.removeEventListener("scroll", update);
            window.removeEventListener("resize", update);
            observer?.disconnect();
        };
    }, [scrollRef, topics]);

    if (!topics?.length && !canDetect && !hasCorrections) return null;

    return (
        <div
            ref={barRef}
            data-chapter-bar
            className="sticky top-0 z-20 flex min-h-12 min-w-0 items-center justify-between gap-3 border-b bg-muted px-4 py-2"
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
                onSelect={onSelect}
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
