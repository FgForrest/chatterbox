"use client";

import { Users } from "lucide-react";
import { useExtracted } from "next-intl";
import type { ReactNode } from "react";
import { AiCostSummary } from "@/components/recordings/ai-cost-summary";
import { RecordingTitle } from "@/components/recordings/recording-title";
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
                <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                    {metadata.map((part, index) => (
                        <span
                            key={`${index}:${part}`}
                            className="inline-flex items-center gap-2"
                        >
                            {index > 0 && (
                                <span aria-hidden="true" className="opacity-40">
                                    ·
                                </span>
                            )}
                            <span>{part}</span>
                        </span>
                    ))}
                    {organization && (
                        <span className="inline-flex items-center gap-2 text-primary">
                            {metadata.length > 0 && (
                                <span aria-hidden="true" className="opacity-40">
                                    ·
                                </span>
                            )}
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
                <div className="mt-1.5">
                    <AiCostSummary
                        key={`${itemId}:${view ?? "private"}`}
                        recordingId={itemId}
                        kind={kind}
                        view={view}
                    />
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
            {action && <div className="shrink-0">{action}</div>}
        </header>
    );
}
