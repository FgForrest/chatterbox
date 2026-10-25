"use client";

import { FolderInput, FolderOutput, Link, Users } from "lucide-react";
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
    kind: "audio" | "mail";
    title: string;
    metadata: string[];
    view?: RecordingView;
    /** The private item has been shared into the Organization. */
    shared?: boolean;
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
    shared = false,
    isOwn = true,
    ownerName,
    readOnly = false,
    onRenamed,
    action,
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
                organization &&
                    "rounded-r-lg border-l-2 border-organization bg-organization/5 py-2 pl-3",
                received &&
                    "rounded-r-lg border-l-2 border-person-share bg-person-share/5 py-2 pl-3",
            )}
        >
            <div className="min-w-0 flex-1">
                <h1 className="min-w-0">
                    <RecordingTitle
                        recordingId={itemId}
                        filename={title}
                        onRenamed={onRenamed}
                        readOnly={readOnly || received}
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
                    {personSharing && isOwn && shareCount > 0 && (
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
                    {!received && (
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
                {personSharing && isOwn ? (
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
                ) : (
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
                )}
                {action}
            </div>
        </header>
    );
}
