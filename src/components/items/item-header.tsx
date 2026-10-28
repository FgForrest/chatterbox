"use client";

import { BookOpen, FolderInput, FolderOutput, Link, Users } from "lucide-react";
import { useExtracted } from "next-intl";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { MetadataSeparator } from "@/components/items/metadata-separator";
import { AiCostSummary } from "@/components/recordings/ai-cost-summary";
import { RecordingTitle } from "@/components/recordings/recording-title";
import {
    OwnerSharingActions,
    usePersonSharing,
} from "@/components/sharing/person-sharing";
import { Button } from "@/components/ui/button";
import { ActionTooltip } from "@/components/ui/tooltip";
import { itemDetailHref } from "@/lib/item-detail";
import type { RecordingView } from "@/lib/sharing/view";
import { cn } from "@/lib/utils";

interface ItemHeaderProps {
    itemId: string;
    kind: "audio" | "mail" | "meeting";
    title: string;
    metadata: ReactNode[];
    folders?: ReactNode;
    view?: RecordingView;
    /** The private item has been shared into the Organization. */
    shared?: boolean;
    isOwn?: boolean;
    ownerName?: string | null;
    readOnly?: boolean;
    onRenamed?: (title: string) => void;
    action?: ReactNode;
    onKnowledge?: () => void;
    knowledgeOpen?: boolean;
    pendingLearnCount?: number;
    retentionNotes?: string[];
}

/** Shared page heading for recordings, mail and meetings. */
export function ItemHeader({
    itemId,
    kind,
    title,
    metadata,
    folders,
    view,
    shared = false,
    isOwn = true,
    ownerName,
    readOnly = false,
    onRenamed,
    action,
    onKnowledge,
    knowledgeOpen = false,
    pendingLearnCount = 0,
    retentionNotes = [],
}: ItemHeaderProps) {
    const i18n = useExtracted();
    const organization = view === "org";
    const personSharing = usePersonSharing();
    const received = view === "received";
    const [shareCount, setShareCount] = useState(0);
    const [shareOpen, setShareOpen] = useState(false);
    const copyLink = async () => {
        try {
            await navigator.clipboard.writeText(
                window.location.origin + itemDetailHref(itemId, { view }),
            );
            toast.success(
                organization || shared
                    ? i18n(
                          "Link copied. Other members of your Organization can open it.",
                      )
                    : personSharing || received
                      ? i18n("Link copied.")
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
                kind === "meeting" &&
                    "rounded-r-lg border-l-2 border-meeting bg-meeting/5 py-2 pl-3",
                organization &&
                    "rounded-r-lg border-l-2 border-organization bg-organization/5 py-2 pl-3",
                received &&
                    "rounded-r-lg border-l-2 border-person-share bg-person-share/5 py-2 pl-3",
            )}
        >
            <div className="min-w-0 flex-1">
                <h1 className="min-w-0">
                    {kind === "meeting" ? (
                        <span className="text-xl font-semibold tracking-tight sm:text-2xl">
                            {title}
                        </span>
                    ) : (
                        <RecordingTitle
                            recordingId={itemId}
                            filename={title}
                            onRenamed={onRenamed}
                            readOnly={readOnly || received}
                            view={view}
                            kind={kind}
                            className="text-xl font-semibold tracking-tight sm:text-2xl"
                        />
                    )}
                </h1>
                <div
                    data-slot="item-metadata"
                    className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground [&>span:first-child>[data-slot=metadata-separator]]:hidden"
                >
                    {metadata.map((part, index) => (
                        <span
                            key={`${index}:${typeof part === "string" ? part : "metadata"}`}
                            className="inline-flex items-center gap-2"
                        >
                            <MetadataSeparator />
                            <span>{part}</span>
                        </span>
                    ))}
                    {kind !== "meeting" &&
                        personSharing &&
                        isOwn &&
                        shareCount > 0 && (
                            <button
                                type="button"
                                onClick={() => setShareOpen(true)}
                                className="inline-flex items-center gap-1 text-person-share"
                            >
                                <MetadataSeparator />
                                <FolderOutput className="size-4" />
                                {i18n(
                                    "Shared with {count, plural, one {# person} other {# people}}",
                                    {
                                        count: shareCount,
                                    },
                                )}
                            </button>
                        )}
                    {kind !== "meeting" && !received && (
                        <AiCostSummary
                            key={`${itemId}:${view ?? "private"}`}
                            recordingId={itemId}
                            view={view}
                        />
                    )}
                    {received && (
                        <span className="inline-flex items-center gap-2 text-person-share">
                            <FolderInput className="size-4" />
                            {i18n("Shared with you by {owner}", {
                                owner: ownerName ?? i18n("a colleague"),
                            })}
                        </span>
                    )}
                    {organization && (
                        <span className="inline-flex items-center gap-2 text-organization">
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
                {folders && <div className="mt-3">{folders}</div>}
                {retentionNotes.map((note) => (
                    <p
                        key={note}
                        className="mt-1 text-xs text-muted-foreground"
                    >
                        {note}
                    </p>
                ))}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-1">
                {kind !== "meeting" && (
                    <ActionTooltip label={i18n("Knowledge")}>
                        <Button
                            type="button"
                            variant="outline"
                            size="icon-sm"
                            className={cn(
                                "relative shrink-0",
                                organization &&
                                    "border-organization/40 bg-organization/10 text-organization hover:bg-organization/20 hover:text-organization",
                            )}
                            aria-pressed={knowledgeOpen}
                            aria-label={i18n("Knowledge")}
                            onClick={onKnowledge}
                        >
                            <BookOpen className="size-4" />
                            {pendingLearnCount > 0 && (
                                <output
                                    className="absolute -right-1 -top-1 min-w-4 rounded-full bg-[var(--step-review)] px-1 text-[10px] leading-4 text-background"
                                    aria-label={i18n("Review ({count})", {
                                        count: String(pendingLearnCount),
                                    })}
                                >
                                    {pendingLearnCount}
                                </output>
                            )}
                        </Button>
                    </ActionTooltip>
                )}
                {kind !== "meeting" && personSharing && isOwn ? (
                    <OwnerSharingActions
                        key={itemId}
                        itemId={itemId}
                        title={title}
                        kind={kind}
                        copyLink={copyLink}
                        shared={shared || organization}
                        open={shareOpen}
                        onOpenChange={setShareOpen}
                        onCountChange={setShareCount}
                    >
                        <ActionTooltip label={i18n("Copy link")}>
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={i18n("Copy link")}
                                onClick={() => void copyLink()}
                            >
                                <Link className="size-4" />
                            </Button>
                        </ActionTooltip>
                    </OwnerSharingActions>
                ) : kind !== "meeting" ? (
                    <ActionTooltip label={i18n("Copy link")}>
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={i18n("Copy link")}
                            onClick={() => void copyLink()}
                        >
                            <Link className="size-4" />
                        </Button>
                    </ActionTooltip>
                ) : null}
                {action}
            </div>
        </header>
    );
}
