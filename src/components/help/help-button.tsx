"use client";

import { CircleHelp } from "lucide-react";
import { useExtracted } from "next-intl";
import { Button } from "@/components/ui/button";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import type { HelpTopic } from "@/lib/help/topics";
import { cn } from "@/lib/utils";
import { useHelp } from "./help-provider";

/**
 * The header's Help button. Without a topic it opens the chapter about the
 * screen it is on.
 */
export function HelpButton({
    topic,
    className,
}: {
    topic?: HelpTopic;
    className?: string;
}) {
    const i18n = useExtracted();
    const { openHelp } = useHelp();
    return (
        <TooltipProvider delayDuration={200}>
            <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        onClick={() => openHelp(topic)}
                        variant="outline"
                        size="sm"
                        className={cn("h-9", className)}
                        aria-label={i18n("Help")}
                    >
                        <CircleHelp className="size-4 sm:mr-2" />
                        <span className="hidden sm:inline">{i18n("Help")}</span>
                    </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                    {i18n("Open the user guide at this screen (h)")}
                </TooltipContent>
            </Tooltip>
        </TooltipProvider>
    );
}

/** A small ? beside a feature's title, opening the guide at that feature. */
export function HelpLink({
    topic,
    label,
    className,
}: {
    topic: HelpTopic;
    /** What the guide explains, for the hover title and screen readers. */
    label: string;
    className?: string;
}) {
    const i18n = useExtracted();
    const { openHelp } = useHelp();
    const text = i18n("Help: {topic}", { topic: label });
    return (
        <button
            type="button"
            onClick={(event) => {
                event.stopPropagation();
                openHelp(topic);
            }}
            aria-label={text}
            title={text}
            className={cn(
                "inline-flex shrink-0 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                className,
            )}
        >
            <CircleHelp className="size-4" aria-hidden="true" />
        </button>
    );
}
