"use client";

import { GraduationCap, ListFilter, Search, X } from "lucide-react";
import { useExtracted } from "next-intl";
import type * as React from "react";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";

export type SortOrder = "newest" | "oldest" | "name" | "duration" | "size";

/** Which kinds of item the pile shows. */
export type KindFilter = "all" | "audio" | "mail";

/** A field the Chatter search reads. */
export type SearchScope = "title" | "content" | "summary";

export function RecordingListToolbar({
    query,
    onQueryChange,
    onEnterSelectFirst,
    searchRef,
    channelCounts,
    sortOrder,
    onSortOrderChange,
    reviewCount = 0,
    needsReviewOnly = false,
    onNeedsReviewOnlyChange,
    showMail,
    kindFilter,
    onKindFilterChange,
    searchScopes,
    onSearchScopesChange,
}: {
    query: string;
    onQueryChange: (next: string) => void;
    onEnterSelectFirst: () => void;
    searchRef: React.RefObject<HTMLInputElement | null>;
    channelCounts: Record<Exclude<KindFilter, "all">, number>;
    sortOrder: SortOrder;
    onSortOrderChange: (next: SortOrder) => void;
    /** Recordings a Learn review waits on; the toggle shows when there are any. */
    reviewCount?: number;
    needsReviewOnly?: boolean;
    onNeedsReviewOnlyChange?: (next: boolean) => void;
    /** Offers the Mail channel; with one channel the menu has no channel choice. */
    showMail: boolean;
    kindFilter: KindFilter;
    onKindFilterChange: (next: KindFilter) => void;
    searchScopes: ReadonlySet<SearchScope>;
    onSearchScopesChange: (next: Set<SearchScope>) => void;
}) {
    const i18n = useExtracted();
    const channels = (
        [
            { value: "audio", label: i18n("Recordings") },
            { value: "mail", label: i18n("Mail") },
        ] as const
    ).filter((channel) => showMail || channel.value !== "mail");
    const showChannelChoice = channels.length > 1;
    const showReviewChoice = reviewCount > 0 && !!onNeedsReviewOnlyChange;
    const scopes = [
        {
            value: "title",
            label: i18n({ id: "chatter-search-titles", message: "Titles" }),
        },
        {
            value: "content",
            label: i18n({
                id: "chatter-search-content",
                message: "Transcripts and message text",
            }),
        },
        {
            value: "summary",
            label: i18n({
                id: "chatter-search-summaries",
                message: "Summaries",
            }),
        },
    ] as const;
    const selectedChannels = new Set<Exclude<KindFilter, "all">>(
        kindFilter === "all"
            ? channels.map((channel) => channel.value)
            : [kindFilter],
    );
    const channelLabel =
        selectedChannels.size === channels.length
            ? i18n("All")
            : channels
                  .filter((channel) => selectedChannels.has(channel.value))
                  .map((channel) => channel.label)
                  .join(", ");
    const nameLabel = i18n({ id: "chatter-sort-name", message: "Name" });
    let sortLabel = nameLabel;
    if (sortOrder === "newest") sortLabel = i18n("Newest");
    if (sortOrder === "oldest") sortLabel = i18n("Oldest");
    if (sortOrder === "duration") sortLabel = i18n("Duration");
    if (sortOrder === "size") sortLabel = i18n("Size");
    const channelsFiltered =
        showChannelChoice && selectedChannels.size < channels.length;
    const reviewFiltered = showReviewChoice && needsReviewOnly;
    const activeFilters = [
        channelsFiltered ? channelLabel : null,
        reviewFiltered ? i18n("Needs review") : null,
    ].filter(Boolean);
    const menuState = [
        showChannelChoice && !channelsFiltered ? channelLabel : null,
        ...activeFilters,
        sortLabel,
    ]
        .filter(Boolean)
        .join(" · ");
    const menuLabel = i18n("Filter and sort: {state}", { state: menuState });
    const toggleChannel = (channel: Exclude<KindFilter, "all">) => {
        const next = new Set(selectedChannels);
        if (next.has(channel)) {
            if (next.size === 1) return;
            next.delete(channel);
        } else {
            next.add(channel);
        }
        if (next.size === channels.length) {
            onKindFilterChange("all");
            return;
        }
        const [only] = next;
        if (only) onKindFilterChange(only);
    };
    const toggleSearchScope = (scope: SearchScope) => {
        const next = new Set(searchScopes);
        if (next.has(scope)) {
            if (next.size === 1) return;
            next.delete(scope);
        } else {
            next.add(scope);
        }
        onSearchScopesChange(next);
    };
    return (
        <div className="flex items-center gap-1.5 border-b p-3">
            <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                    ref={searchRef}
                    value={query}
                    onChange={(e) => onQueryChange(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            onEnterSelectFirst();
                        }
                    }}
                    placeholder={i18n("Search recordings, transcripts...")}
                    className="h-9 pl-8 pr-8"
                    aria-label={i18n("Search recordings")}
                />
                {query && (
                    <button
                        type="button"
                        onClick={() => onQueryChange("")}
                        aria-label={i18n("Clear search")}
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                    >
                        <X className="size-4" />
                    </button>
                )}
            </div>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button
                        variant={
                            activeFilters.length > 0 ? "secondary" : "ghost"
                        }
                        size={activeFilters.length > 0 ? "sm" : "icon-sm"}
                        className={
                            activeFilters.length > 0
                                ? "h-9 max-w-36 shrink-0 px-2 text-xs"
                                : "size-9 shrink-0 text-muted-foreground"
                        }
                        aria-label={menuLabel}
                        title={menuLabel}
                    >
                        <ListFilter className="size-4" />
                        {activeFilters.length > 0 && (
                            <span className="truncate">
                                {activeFilters.join(" · ")}
                            </span>
                        )}
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-64">
                    {(showChannelChoice || showReviewChoice) && (
                        <>
                            <DropdownMenuLabel>
                                {i18n("Show")}
                            </DropdownMenuLabel>
                            {showChannelChoice &&
                                channels.map((channel) => (
                                    <DropdownMenuCheckboxItem
                                        key={channel.value}
                                        checked={selectedChannels.has(
                                            channel.value,
                                        )}
                                        disabled={
                                            selectedChannels.size === 1 &&
                                            selectedChannels.has(channel.value)
                                        }
                                        onCheckedChange={() =>
                                            toggleChannel(channel.value)
                                        }
                                        onSelect={(event) =>
                                            event.preventDefault()
                                        }
                                    >
                                        {channel.label}
                                        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                                            {channelCounts[channel.value]}
                                        </span>
                                    </DropdownMenuCheckboxItem>
                                ))}
                            {showReviewChoice && (
                                <DropdownMenuCheckboxItem
                                    checked={needsReviewOnly}
                                    onCheckedChange={(checked) =>
                                        onNeedsReviewOnlyChange?.(
                                            checked === true,
                                        )
                                    }
                                    onSelect={(event) => event.preventDefault()}
                                >
                                    <GraduationCap className="mr-2 size-3.5" />
                                    {i18n("Needs review ({count})", {
                                        count: String(reviewCount),
                                    })}
                                </DropdownMenuCheckboxItem>
                            )}
                            <DropdownMenuSeparator />
                        </>
                    )}
                    <DropdownMenuLabel>{i18n("Search in")}</DropdownMenuLabel>
                    {scopes.map((scope) => (
                        <DropdownMenuCheckboxItem
                            key={scope.value}
                            checked={searchScopes.has(scope.value)}
                            disabled={
                                searchScopes.size === 1 &&
                                searchScopes.has(scope.value)
                            }
                            onCheckedChange={() =>
                                toggleSearchScope(scope.value)
                            }
                            onSelect={(event) => event.preventDefault()}
                        >
                            {scope.label}
                        </DropdownMenuCheckboxItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>{i18n("Sort")}</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                        value={sortOrder}
                        onValueChange={(v) => onSortOrderChange(v as SortOrder)}
                    >
                        <DropdownMenuRadioItem value="newest">
                            {i18n("Newest")}
                        </DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="oldest">
                            {i18n("Oldest")}
                        </DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="name">
                            {nameLabel}
                        </DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="duration">
                            {i18n("Duration")}
                        </DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="size">
                            {i18n("Size")}
                        </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    );
}
