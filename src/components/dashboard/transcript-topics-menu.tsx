"use client";

import { Loader2, RefreshCw, Sparkles, Tag } from "lucide-react";
import { useExtracted } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { WorkflowWidget } from "@/components/pipeline/workflow-widget";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    activeTopicIndex,
    formatClock,
    type TranscriptTopic,
} from "@/lib/topics/timeline";

interface TranscriptTopicsMenuProps {
    topics: TranscriptTopic[] | null;
    /** The transcript has timings and belongs to the viewer. */
    canDetect: boolean;
    /** Automatic Learn holds them back until its review is finished. */
    waitingForReview?: boolean;
    detecting: boolean;
    onDetect: () => void;
    onSelect: (index: number) => void;
    /** Playback position, to mark the topic being played. */
    getPlaybackMs?: () => number;
    widgetId: string;
}

/**
 * "Topics (n)" beside the transcript's collapse toggle: the chapters of the
 * conversation, each a jump to where it starts. Without topics it offers to
 * detect them, when the transcript has the timings they need.
 */
export function TranscriptTopicsMenu({
    topics,
    canDetect,
    waitingForReview = false,
    detecting,
    onDetect,
    onSelect,
    getPlaybackMs,
    widgetId,
}: TranscriptTopicsMenuProps) {
    const i18n = useExtracted();
    const [open, setOpen] = useState(false);
    const [runOpen, setRunOpen] = useState(false);
    const [active, setActive] = useState(-1);
    // A ref, so a parent passing a fresh function each render does not
    // restart the timer below.
    const playbackRef = useRef(getPlaybackMs);
    playbackRef.current = getPlaybackMs;

    // Follow playback while the list is open, so the highlighted topic is
    // the one playing now rather than the one playing when it was opened.
    useEffect(() => {
        if (!open || !topics?.length) return;
        const update = () => {
            const ms = playbackRef.current?.();
            setActive(ms === undefined ? -1 : activeTopicIndex(topics, ms));
        };
        update();
        const timer = setInterval(update, 1000);
        return () => clearInterval(timer);
    }, [open, topics]);

    const runDetect = () => {
        onDetect();
    };
    let runTitle = i18n("Topic detection");
    let runDescription = i18n("No topics were found.");
    if (detecting) {
        runTitle = i18n("Detecting topics…");
        runDescription = i18n(
            "Topic detection continues in the background; you can close this window.",
        );
    } else if (topics?.length) {
        runTitle = i18n("Topics detected");
        runDescription = i18n("Review the topics found in this transcript.");
    }
    let runBody = (
        <p className="text-sm text-muted-foreground">
            {i18n("No topics were found.")}
        </p>
    );
    if (detecting) {
        runBody = (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
                {i18n("Detecting topics…")}
            </p>
        );
    } else if (topics?.length) {
        runBody = (
            <ol className="space-y-2">
                {topics.map((topic, index) => (
                    <li key={`${topic.fromMs}-${topic.title}`}>
                        <Button
                            type="button"
                            variant="ghost"
                            className="h-auto w-full justify-start gap-3 whitespace-normal text-left"
                            onClick={() => {
                                setRunOpen(false);
                                onSelect(index);
                            }}
                        >
                            <span className="w-5 shrink-0 text-right font-semibold tabular-nums text-primary">
                                {index + 1}.
                            </span>
                            <span className="min-w-0 flex-1 break-words">
                                {topic.title}
                            </span>
                            <span className="shrink-0 font-mono text-xs text-muted-foreground">
                                {formatClock(topic.fromMs)}
                            </span>
                        </Button>
                    </li>
                ))}
            </ol>
        );
    }
    const runDialog = (
        <WorkflowWidget
            id={widgetId}
            frame="dialog"
            tone={detecting ? "working" : "quiet"}
            open={runOpen}
            onOpenChange={setRunOpen}
            title={runTitle}
            description={runDescription}
            dialogWidth="lg"
        >
            {runBody}
        </WorkflowWidget>
    );

    if (!topics?.length) {
        if (!canDetect) return null;
        if (waitingForReview && !detecting) {
            return (
                <span className="flex items-center gap-1 text-sm text-muted-foreground">
                    <Tag className="size-4" />
                    {i18n("Topics follow the Learn review")}
                </span>
            );
        }
        return (
            <>
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-auto px-1.5 py-0.5 text-sm font-medium text-muted-foreground hover:text-primary"
                    onClick={runDetect}
                    disabled={detecting}
                >
                    {detecting ? (
                        <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
                    ) : (
                        <Sparkles className="size-4" />
                    )}
                    {detecting
                        ? i18n("Detecting topics…")
                        : i18n("Detect topics")}
                </Button>
                {runDialog}
            </>
        );
    }

    return (
        <div className="flex items-center gap-2">
            <DropdownMenu open={open} onOpenChange={setOpen}>
                <DropdownMenuTrigger asChild>
                    <button
                        type="button"
                        className="flex items-center gap-1 rounded-sm text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        <Tag className="size-4" />
                        {i18n("Topics ({count, number})", {
                            count: topics.length,
                        })}
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                    align="start"
                    collisionPadding={16}
                    className="max-h-[60vh] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto"
                >
                    <DropdownMenuLabel>
                        {i18n("Conversation topics")}
                    </DropdownMenuLabel>
                    {topics.map((topic, index) => (
                        <DropdownMenuItem
                            key={`${topic.fromMs}-${topic.title}`}
                            onSelect={() => onSelect(index)}
                            className={`items-baseline gap-3 ${index === active ? "bg-primary/10 text-primary" : ""}`}
                        >
                            <span className="w-5 shrink-0 text-right font-semibold tabular-nums text-primary">
                                {index + 1}.
                            </span>
                            <span className="min-w-0 flex-1 break-words">
                                {topic.title}
                            </span>
                            <span className="shrink-0 font-mono text-xs text-muted-foreground">
                                {formatClock(topic.fromMs)}
                            </span>
                        </DropdownMenuItem>
                    ))}
                    {canDetect && (
                        <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                                onSelect={runDetect}
                                disabled={detecting}
                                className="text-muted-foreground"
                            >
                                <RefreshCw />
                                {i18n("Re-detect topics")}
                            </DropdownMenuItem>
                        </>
                    )}
                </DropdownMenuContent>
            </DropdownMenu>
            {detecting && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Loader2 className="size-3 animate-spin" />
                    {i18n("Detecting topics…")}
                </span>
            )}
            {runDialog}
        </div>
    );
}
