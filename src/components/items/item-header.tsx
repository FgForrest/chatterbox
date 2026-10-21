"use client";

import { Link, Users } from "lucide-react";
import { useExtracted } from "next-intl";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { MetadataSeparator } from "@/components/items/metadata-separator";
import { AiCostSummary } from "@/components/recordings/ai-cost-summary";
import { RecordingTitle } from "@/components/recordings/recording-title";
import { Button } from "@/components/ui/button";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { itemDetailHref } from "@/lib/item-detail";
import type { RecordingView } from "@/lib/sharing/view";
import { cn } from "@/lib/utils";

interface ItemHeaderProps {
    itemId: string;
    kind: "audio" | "mail";
    title: string;
    metadata: string[];
    view?: RecordingView;
    isOwn?: boolean;
    ownerName?: string | null;
    readOnly?: boolean;
    onRenamed?: (title: string) => void;
    action?: ReactNode;
    retentionNotes?: string[];
}

/** Shared page heading for recordings and mail. */
export function ItemHeader({
    itemId,
    kind,
    title,
    metadata,
    view,
    isOwn = true,
    ownerName,
    readOnly = false,
    onRenamed,
    action,
    retentionNotes = [],
}: ItemHeaderProps) {
    const i18n = useExtracted();
    const organization = view === "org";
    const copyLink = async () => {
        try {
            await navigator.clipboard.writeText(
                window.location.origin + itemDetailHref(itemId, { view }),
            );
            toast.success(
                organization
                    ? i18n(
                          "Link copied. Other members of your Organization can open it.",
                      )
                    : i18n("Link copied. Only you can open it."),
            );
        } catch {
            toast.error(i18n("Could not copy the link. Try again."));
        }
    };

    return (
        <header
            className={cn(
                "flex min-w-0 items-start justify-between gap-4 px-1",
                organization &&
                    "rounded-r-lg border-l-2 border-primary bg-primary/5 py-2 pl-3",
            )}
        >
            <div className="min-w-0 flex-1">
                <h1 className="min-w-0">
                    <RecordingTitle
                        recordingId={itemId}
                        filename={title}
                        onRenamed={onRenamed}
                        readOnly={readOnly}
                        view={view}
                        kind={kind}
                        className="text-xl font-semibold tracking-tight sm:text-2xl"
                    />
                </h1>
                <div
                    data-slot="item-metadata"
                    className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground [&>span:first-child>[data-slot=metadata-separator]]:hidden"
                >
                    {metadata.map((part, index) => (
                        <span
                            key={`${index}:${part}`}
                            className="inline-flex items-center gap-2"
                        >
                            <MetadataSeparator />
                            <span>{part}</span>
                        </span>
                    ))}
                    <AiCostSummary
                        key={`${itemId}:${view ?? "private"}`}
                        recordingId={itemId}
                        view={view}
                    />
                    {organization && (
                        <span className="inline-flex items-center gap-2 text-primary">
                            <MetadataSeparator />
                            <Users
                                className="size-4"
                                aria-label={i18n("Organization")}
                            />
                            {!isOwn && (
                                <span>
                                    {i18n("Shared by {owner}", {
                                        owner: ownerName ?? i18n("a colleague"),
                                    })}
                                </span>
                            )}
                        </span>
                    )}
                </div>
                {retentionNotes.map((note) => (
                    <p
                        key={note}
                        className="mt-1 text-xs text-muted-foreground"
                    >
                        {note}
                    </p>
                ))}
            </div>
            <div className="flex shrink-0 items-center gap-1">
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={i18n("Copy link")}
                            onClick={() => void copyLink()}
                        >
                            <Link className="size-4" />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                        {i18n("Copy link")}
                    </TooltipContent>
                </Tooltip>
                {action}
            </div>
        </header>
    );
}
