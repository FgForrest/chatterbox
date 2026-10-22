"use client";

import { MessagesSquare } from "lucide-react";
import { useExtracted, useLocale } from "next-intl";
import type * as React from "react";
import {
    useCallback,
    useEffect,
    useImperativeHandle,
    useMemo,
    useRef,
    useState,
} from "react";
import {
    type PendingUpload,
    PendingUploadRow,
} from "@/components/dashboard/pending-upload-row";
import {
    type KindFilter,
    RecordingListToolbar,
    type SearchScope,
    type SortOrder,
} from "@/components/dashboard/recording-list-toolbar";
import { RecordingRow } from "@/components/dashboard/recording-row";
import { Card, CardContent } from "@/components/ui/card";
import { useFolderLabel } from "@/hooks/use-folder-label";
import { folderDisplayPath } from "@/lib/folders/labels";
import { dateGroupLabel } from "@/lib/format-date";
import { snippetBounds } from "@/lib/search/snippets";
import type { DateTimeFormat } from "@/types/common";
import type {
    RecordingFolder,
    RecordingFolderAssignment,
} from "@/types/folder";
import type { Recording } from "@/types/recording";

export type { PendingUpload } from "@/components/dashboard/pending-upload-row";
export type {
    KindFilter,
    SearchScope,
    SortOrder,
} from "@/components/dashboard/recording-list-toolbar";

interface TranscriptionData {
    text?: string;
    /** The text as people read it, when corrections change it. */
    readText?: string;
    language?: string;
}

interface RecordingListProps {
    recordings: Recording[];
    /** Offers the Mail channel; it also shows once the pile holds mail. */
    mailEnabled?: boolean;
    transcriptions: Map<string, TranscriptionData>;
    currentRecording: Recording | null;
    pendingUploads: PendingUpload[];
    inFlightActions: Map<string, "transcribing" | "summarizing">;
    sharedItemIds?: ReadonlySet<string>;
    onSelect: (recording: Recording) => void;
    onDelete: (recording: Recording) => Promise<void>;
    initialDateTimeFormat: DateTimeFormat;
    initialSortOrder: SortOrder;
    initialKindFilter?: KindFilter;
    initialChunkSize: number;
    locationKey?: string;
    header?: React.ReactNode;
    navigationContent?: React.ReactNode;
    onFolderSettings?: () => void;
    canCurate?: boolean;
    isOrgAccount?: boolean;
    onFolderCreated?: (folder: RecordingFolder) => void;
    folder?: RecordingFolder | null;
    folders?: RecordingFolder[];
    rowLocations?: Map<string, RecordingFolder[]>;
    assignments?: RecordingFolderAssignment[];
    onAssignRecording?: (
        recordingId: string,
        folderId: string,
    ) => Promise<void>;
    onMoveRecording?: (
        recordingId: string,
        from: string,
        to: string,
    ) => Promise<void>;
    /** The library the list shows, which the server search reads. */
    searchView?: "private" | "org";
    emptyState?: React.ReactNode;
    resetToRecentKey?: number;
}

export interface RecordingListHandle {
    focusSearch: () => void;
    next: () => void;
    prev: () => void;
}

function persistSetting(field: string, value: unknown) {
    fetch("/api/settings/user", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
    }).catch(() => {});
}

function searchHitSnippet(
    text: string | undefined,
    query: string,
): string | null {
    if (!text) return null;
    const startOfMatch = text.toLowerCase().indexOf(query.toLowerCase());
    if (startOfMatch < 0) return null;
    const endOfMatch = startOfMatch + query.length;
    const { start, end } = snippetBounds(
        text,
        startOfMatch - 60,
        endOfMatch + 80,
        { start: startOfMatch, end: endOfMatch },
    );
    const excerpt = text
        .slice(start, end)
        .replace(/\[[^\]]+\]/g, " ")
        .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!excerpt) return null;
    return `${start > 0 ? "…" : ""}${excerpt}${end < text.length ? "…" : ""}`;
}

export function RecordingList({
    recordings,
    mailEnabled = false,
    transcriptions,
    currentRecording,
    pendingUploads,
    inFlightActions,
    sharedItemIds,
    onSelect,
    onDelete,
    initialDateTimeFormat,
    initialSortOrder,
    initialKindFilter = "all",
    initialChunkSize,
    locationKey = "recent",
    header,
    navigationContent,
    onFolderSettings,
    canCurate,
    isOrgAccount = false,
    onFolderCreated,
    folder = null,
    folders = [],
    rowLocations = new Map(),
    assignments = [],
    onAssignRecording,
    onMoveRecording,
    searchView = "private",
    emptyState,
    resetToRecentKey = 0,
    ref,
}: RecordingListProps & { ref?: React.Ref<RecordingListHandle> }) {
    const i18n = useExtracted();
    const locale = useLocale();
    const folderLabel = useFolderLabel();
    const [dateTimeFormat] = useState<DateTimeFormat>(initialDateTimeFormat);
    const [sortOrder, setSortOrder] = useState<SortOrder>(initialSortOrder);
    const [kindFilter, setKindFilter] = useState<KindFilter>(initialKindFilter);
    const [searchScopes, setSearchScopes] = useState<Set<SearchScope>>(
        () => new Set(["title", "content", "summary"]),
    );
    const searchScopeKey = [...searchScopes].sort().join(",");
    const channelCounts = useMemo(
        () => ({
            audio: recordings.filter((recording) => recording.kind !== "mail")
                .length,
            mail: recordings.filter((recording) => recording.kind === "mail")
                .length,
        }),
        [recordings],
    );
    const showMail = mailEnabled || channelCounts.mail > 0;
    const kindShown = showMail ? kindFilter : "all";
    const [query, setQuery] = useState("");
    // What the server found for the query in what this page does not
    // hold (a mail's text), with the words around each match.
    const [serverHits, setServerHits] = useState<{
        query: string;
        scopeKey: string;
        hits: Map<string, string | null>;
    } | null>(null);
    useEffect(() => {
        const q = query.trim();
        if (q.length < 2) {
            setServerHits(null);
            return;
        }
        const controller = new AbortController();
        const timer = setTimeout(async () => {
            const hits = new Map<string, string | null>();
            let before: string | null = null;
            // A few bounded pages reach well back; a narrower query, further.
            for (let page = 0; page < 5; page++) {
                const params = new URLSearchParams({
                    q,
                    view: searchView,
                    scope: searchScopeKey,
                });
                if (before) params.set("before", before);
                const response = await fetch(`/api/items/search?${params}`, {
                    signal: controller.signal,
                }).catch(() => null);
                if (!response?.ok) return;
                const data = (await response.json()) as {
                    hits: { id: string; snippet: string | null }[];
                    complete: boolean;
                    continueBefore: string | null;
                };
                for (const hit of data.hits) hits.set(hit.id, hit.snippet);
                setServerHits({
                    query: q,
                    scopeKey: searchScopeKey,
                    hits: new Map(hits),
                });
                if (data.complete || !data.continueBefore) return;
                before = data.continueBefore;
            }
        }, 300);
        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [query, searchScopeKey, searchView]);
    // Only the recordings a Learn review waits on.
    const [needsReviewOnly, setNeedsReviewOnly] = useState(false);
    const reviewCount = useMemo(
        () => recordings.filter((r) => r.needsReview).length,
        [recordings],
    );
    const [visibleCount, setVisibleCount] = useState(initialChunkSize);
    const searchRef = useRef<HTMLInputElement>(null);
    const previousLocation = useRef(locationKey);
    const scrollRef = useRef<HTMLDivElement>(null);
    const sentinelRef = useRef<HTMLDivElement>(null);
    const rowRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

    const setSortOrderPersisted = useCallback((next: SortOrder) => {
        setSortOrder(next);
        persistSetting("recordingListSortOrder", next);
    }, []);
    const setKindFilterPersisted = useCallback((next: KindFilter) => {
        setKindFilter(next);
        persistSetting("chatterKindFilter", next);
    }, []);

    const registerRowRef = useCallback(
        (id: string, el: HTMLButtonElement | null) => {
            if (el) rowRefs.current.set(id, el);
            else rowRefs.current.delete(id);
        },
        [],
    );

    const assignedByRecording = useMemo(() => {
        const result = new Map<string, Set<string>>();
        for (const assignment of assignments) {
            const ids = result.get(assignment.recordingId) ?? new Set<string>();
            ids.add(assignment.folderId);
            result.set(assignment.recordingId, ids);
        }
        return result;
    }, [assignments]);

    const firstFolders = useMemo(() => {
        const byId = new Map(folders.map((folder) => [folder.id, folder]));
        const result = new Map<
            string,
            { folder: RecordingFolder; path: string }
        >();
        for (const assignment of assignments) {
            if (result.has(assignment.recordingId)) continue;
            const assigned = byId.get(assignment.folderId);
            if (!assigned || (searchView === "org" && assigned.scope !== "org"))
                continue;
            result.set(assignment.recordingId, {
                folder: assigned,
                path: folderDisplayPath(assigned, byId, folderLabel),
            });
        }
        return result;
    }, [assignments, folders, folderLabel, searchView]);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        const ofKind =
            kindShown === "all"
                ? recordings
                : recordings.filter((r) => (r.kind ?? "audio") === kindShown);
        const pool =
            needsReviewOnly && reviewCount > 0
                ? ofKind.filter((r) => r.needsReview)
                : ofKind;
        const found =
            serverHits &&
            serverHits.query.toLowerCase() === q &&
            serverHits.scopeKey === searchScopeKey
                ? serverHits.hits
                : null;
        const base = q
            ? pool.filter((r) => {
                  if (found?.has(r.id)) return true;
                  if (
                      searchScopes.has("title") &&
                      r.filename.toLowerCase().includes(q)
                  ) {
                      return true;
                  }
                  if (
                      searchScopes.has("content") &&
                      r.mail?.from?.toLowerCase().includes(q)
                  ) {
                      return true;
                  }
                  if (!searchScopes.has("content")) return false;
                  const t = transcriptions.get(r.id);
                  return [t?.readText, t?.text].some(
                      (text) => !!text && text.toLowerCase().includes(q),
                  );
              })
            : pool;

        const sorted = [...base];
        switch (sortOrder) {
            case "newest":
                sorted.sort(
                    (a, b) =>
                        new Date(b.startTime).getTime() -
                        new Date(a.startTime).getTime(),
                );
                break;
            case "oldest":
                sorted.sort(
                    (a, b) =>
                        new Date(a.startTime).getTime() -
                        new Date(b.startTime).getTime(),
                );
                break;
            case "duration":
                sorted.sort(
                    (a, b) =>
                        b.duration - a.duration || a.id.localeCompare(b.id),
                );
                break;
            case "size":
                sorted.sort(
                    (a, b) =>
                        b.filesize - a.filesize || a.id.localeCompare(b.id),
                );
                break;
            case "name":
                sorted.sort((a, b) => a.filename.localeCompare(b.filename));
                break;
        }
        return sorted;
    }, [
        recordings,
        transcriptions,
        query,
        serverHits,
        sortOrder,
        needsReviewOnly,
        reviewCount,
        kindShown,
        searchScopeKey,
        searchScopes,
    ]);

    const visible = filtered.slice(0, visibleCount);

    const grouped = useMemo(() => {
        if (
            sortOrder === "name" ||
            sortOrder === "duration" ||
            sortOrder === "size"
        ) {
            return [{ label: null as string | null, items: visible }];
        }
        const groups: { label: string; items: Recording[] }[] = [];
        for (const r of visible) {
            const label = dateGroupLabel(
                r.startTime,
                {
                    today: i18n("Today"),
                    yesterday: i18n("Yesterday"),
                    thisWeek: i18n("This week"),
                    earlierThisMonth: i18n("Earlier this month"),
                },
                locale,
            );
            const last = groups[groups.length - 1];
            if (last && last.label === label) {
                last.items.push(r);
            } else {
                groups.push({ label, items: [r] });
            }
        }
        return groups;
    }, [i18n, locale, visible, sortOrder]);

    // Reset visibleCount when the filter changes so search results
    // aren't accidentally truncated.
    useEffect(() => {
        if (previousLocation.current !== locationKey)
            scrollRef.current?.scrollTo?.({ top: 0 });
        previousLocation.current = locationKey;
        setVisibleCount(initialChunkSize);
    }, [initialChunkSize, locationKey]);
    useEffect(() => {
        if (resetToRecentKey === 0) return;
        setQuery("");
        setServerHits(null);
        setSortOrder("newest");
        setKindFilter("all");
        setSearchScopes(new Set(["title", "content", "summary"]));
        setNeedsReviewOnly(false);
        setVisibleCount(initialChunkSize);
    }, [initialChunkSize, resetToRecentKey]);
    useEffect(() => {
        setVisibleCount((c) =>
            c > filtered.length
                ? Math.max(initialChunkSize, filtered.length)
                : c,
        );
    }, [filtered.length, initialChunkSize]);

    useEffect(() => {
        const el = sentinelRef.current;
        if (!el) return;
        const media = window.matchMedia?.("(min-width: 1024px)");
        let observer: IntersectionObserver;
        const observe = () => {
            observer?.disconnect();
            observer = new IntersectionObserver(
                (entries) => {
                    if (entries.some((entry) => entry.isIntersecting))
                        setVisibleCount((count) =>
                            Math.min(count + initialChunkSize, filtered.length),
                        );
                },
                {
                    root: media?.matches ? scrollRef.current : null,
                    rootMargin: "200px",
                },
            );
            observer.observe(el);
        };
        observe();
        media?.addEventListener("change", observe);
        return () => {
            observer.disconnect();
            media?.removeEventListener("change", observe);
        };
    }, [filtered.length, initialChunkSize]);

    useImperativeHandle(
        ref,
        () => ({
            focusSearch: () => searchRef.current?.focus(),
            next: () => {
                const list = filtered;
                if (list.length === 0) return;
                const idx = currentRecording
                    ? list.findIndex((r) => r.id === currentRecording.id)
                    : -1;
                const nextIdx = Math.min(idx + 1, list.length - 1);
                const target = list[Math.max(0, nextIdx)];
                if (target) {
                    setVisibleCount((count) =>
                        Math.max(count, list.indexOf(target) + 1),
                    );
                    onSelect(target);
                    rowRefs.current
                        .get(target.id)
                        ?.scrollIntoView({ block: "nearest" });
                }
            },
            prev: () => {
                const list = filtered;
                if (list.length === 0) return;
                const idx = currentRecording
                    ? list.findIndex((r) => r.id === currentRecording.id)
                    : 0;
                const prevIdx = Math.max(0, idx - 1);
                const target = list[prevIdx];
                if (target) {
                    setVisibleCount((count) =>
                        Math.max(count, list.indexOf(target) + 1),
                    );
                    onSelect(target);
                    rowRefs.current
                        .get(target.id)
                        ?.scrollIntoView({ block: "nearest" });
                }
            },
        }),
        [filtered, currentRecording, onSelect],
    );

    const snippetFor = (recording: Recording): string | null => {
        const q = query.trim();
        if (!q) return null;
        const hit =
            serverHits?.query === q && serverHits.scopeKey === searchScopeKey
                ? serverHits.hits.get(recording.id)
                : null;
        if (hit) return hit;
        if (!searchScopes.has("content")) return null;
        const transcript = transcriptions.get(recording.id);
        return (
            searchHitSnippet(transcript?.readText, q) ??
            searchHitSnippet(transcript?.text, q)
        );
    };

    const rowPadding = "px-4 py-3";

    let emptyMessage = i18n("No recordings yet.");
    if (folder) emptyMessage = i18n("This folder is empty");
    if (query) emptyMessage = i18n("No recordings match your search.");

    return (
        <Card
            hasNoPadding
            className="flex h-full min-h-0 flex-col overflow-hidden"
        >
            <div className="shrink-0">
                {header}
                <RecordingListToolbar
                    includesSubfolders={!!folder}
                    onFolderSettings={onFolderSettings}
                    query={query}
                    onQueryChange={setQuery}
                    onEnterSelectFirst={() => {
                        if (filtered.length > 0) onSelect(filtered[0]);
                    }}
                    searchRef={searchRef}
                    filteredCount={filtered.length}
                    channelCounts={channelCounts}
                    sortOrder={sortOrder}
                    onSortOrderChange={setSortOrderPersisted}
                    reviewCount={reviewCount}
                    needsReviewOnly={needsReviewOnly && reviewCount > 0}
                    onNeedsReviewOnlyChange={setNeedsReviewOnly}
                    showMail={showMail}
                    kindFilter={kindShown}
                    onKindFilterChange={setKindFilterPersisted}
                    searchScopes={searchScopes}
                    onSearchScopesChange={setSearchScopes}
                />
            </div>
            <CardContent
                ref={scrollRef}
                className="min-h-0 flex-1 p-0 lg:overflow-y-auto"
                data-library-scroll="true"
            >
                {navigationContent}

                {pendingUploads.length > 0 && (
                    <div className="divide-y bg-muted/30">
                        {pendingUploads.map((p) => (
                            <PendingUploadRow
                                key={p.id}
                                upload={p}
                                rowPadding={rowPadding}
                            />
                        ))}
                    </div>
                )}

                <div>
                    {grouped.map((group, gi) => (
                        <div
                            key={group.label ?? `__ungrouped-${gi.toString()}`}
                        >
                            {group.label && (
                                <div className="sticky top-0 z-10 bg-background/85 px-4 pt-2 pb-0.5 text-[10px] font-semibold uppercase leading-none tracking-wider text-muted-foreground/70 backdrop-blur supports-[backdrop-filter]:bg-background/60">
                                    {group.label}
                                </div>
                            )}
                            <div className="divide-y">
                                {group.items.map((recording) => (
                                    <RecordingRow
                                        key={recording.id}
                                        recording={recording}
                                        isSelected={
                                            currentRecording?.id ===
                                            recording.id
                                        }
                                        inFlight={inFlightActions.get(
                                            recording.id,
                                        )}
                                        snippet={snippetFor(recording)}
                                        firstFolder={firstFolders.get(
                                            recording.id,
                                        )}
                                        isCompact={false}
                                        rowPadding={rowPadding}
                                        dateTimeFormat={dateTimeFormat}
                                        onSelect={onSelect}
                                        onDelete={onDelete}
                                        shared={sharedItemIds?.has(
                                            recording.id,
                                        )}
                                        registerRef={registerRowRef}
                                        folderLocations={rowLocations.get(
                                            recording.id,
                                        )}
                                        sourceFolder={folder}
                                        folders={folders}
                                        assignedIds={assignedByRecording.get(
                                            recording.id,
                                        )}
                                        canCurate={canCurate}
                                        isOrgAccount={isOrgAccount}
                                        onFolderCreated={onFolderCreated}
                                        onAssignRecording={onAssignRecording}
                                        onMoveRecording={onMoveRecording}
                                    />
                                ))}
                            </div>
                        </div>
                    ))}

                    {filtered.length === 0 && pendingUploads.length === 0 && (
                        <div className="flex flex-col items-center justify-center py-10 text-center">
                            <MessagesSquare className="mb-2 size-8 text-muted-foreground" />
                            <p className="text-sm text-muted-foreground">
                                {emptyMessage}
                            </p>
                            {folder && !query && (
                                <p className="mt-2 px-4 text-xs text-muted-foreground">
                                    {i18n(
                                        "Drag a recording onto this folder, or add it from its detail view. Recordings can appear in more than one folder.",
                                    )}
                                </p>
                            )}
                            {emptyState}
                        </div>
                    )}

                    <div ref={sentinelRef} className="h-4" aria-hidden="true" />
                </div>
            </CardContent>
        </Card>
    );
}
